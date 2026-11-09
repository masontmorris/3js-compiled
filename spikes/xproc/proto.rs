//! Wire protocol shared by `xproc-game` and `ui-host` (included into both via `#[path]`, so the
//! two crates keep independent Cargo graphs).
//!
//! Framing: `u32 LE payload length`, then payload = `u8 tag` + fields (LE integers, strings as
//! `u32 len + UTF-8`). Two one-way named pipes carry it: `<name>-down` (game -> ui-host) and
//! `<name>-up` (ui-host -> game). One-way pipes avoid Windows serializing a blocking read and a
//! blocking write on the same synchronous handle.

use std::io::{self, Read, Write};

#[derive(Debug, Clone)]
pub enum Msg {
    // ── game -> ui-host ──
    /// Fence handles are already duplicated into the ui-host's handle table.
    Hello { ready_fence: u64, done_fence: u64, ready_base: u64, width: u32, height: u32 },
    /// One bridge round trip: ui-host runs `__bridge.tick(json)` and answers with `Events`.
    Patch { seq: u64, json: String },
    /// From game frame `first_frame` on, the game samples publication `pub_id`.
    Picked { pub_id: u64, first_frame: u64 },
    Shutdown,
    // ── ui-host -> game ──
    /// Shared NT handles of the ring textures, valid in the ui-host's handle table.
    Slots { handles: Vec<u64>, width: u32, height: u32 },
    /// Publication `pub_id` lives in `slot`; readable once the ready fence reaches `ready_value`.
    FrameReady { slot: u8, pub_id: u64, ready_value: u64 },
    /// Result of `__bridge.tick` for patch `seq`.
    Events { seq: u64, json: String },
    Report { text: String },
}

fn put_u32(b: &mut Vec<u8>, v: u32) {
    b.extend_from_slice(&v.to_le_bytes());
}
fn put_u64(b: &mut Vec<u8>, v: u64) {
    b.extend_from_slice(&v.to_le_bytes());
}
fn put_str(b: &mut Vec<u8>, s: &str) {
    put_u32(b, s.len() as u32);
    b.extend_from_slice(s.as_bytes());
}

struct Cursor<'a>(&'a [u8]);
impl Cursor<'_> {
    fn take(&mut self, n: usize) -> io::Result<&[u8]> {
        if self.0.len() < n {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "short message"));
        }
        let (head, tail) = self.0.split_at(n);
        self.0 = tail;
        Ok(head)
    }
    fn u8(&mut self) -> io::Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> io::Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> io::Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn string(&mut self) -> io::Result<String> {
        let n = self.u32()? as usize;
        String::from_utf8(self.take(n)?.to_vec())
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }
}

impl Msg {
    pub fn encode(&self) -> Vec<u8> {
        let mut b = vec![0u8; 4];
        match self {
            Msg::Hello { ready_fence, done_fence, ready_base, width, height } => {
                b.push(1);
                put_u64(&mut b, *ready_fence);
                put_u64(&mut b, *done_fence);
                put_u64(&mut b, *ready_base);
                put_u32(&mut b, *width);
                put_u32(&mut b, *height);
            }
            Msg::Patch { seq, json } => {
                b.push(2);
                put_u64(&mut b, *seq);
                put_str(&mut b, json);
            }
            Msg::Picked { pub_id, first_frame } => {
                b.push(3);
                put_u64(&mut b, *pub_id);
                put_u64(&mut b, *first_frame);
            }
            Msg::Shutdown => b.push(4),
            Msg::Slots { handles, width, height } => {
                b.push(10);
                put_u32(&mut b, handles.len() as u32);
                for h in handles {
                    put_u64(&mut b, *h);
                }
                put_u32(&mut b, *width);
                put_u32(&mut b, *height);
            }
            Msg::FrameReady { slot, pub_id, ready_value } => {
                b.push(11);
                b.push(*slot);
                put_u64(&mut b, *pub_id);
                put_u64(&mut b, *ready_value);
            }
            Msg::Events { seq, json } => {
                b.push(12);
                put_u64(&mut b, *seq);
                put_str(&mut b, json);
            }
            Msg::Report { text } => {
                b.push(13);
                put_str(&mut b, text);
            }
        }
        let len = (b.len() - 4) as u32;
        b[..4].copy_from_slice(&len.to_le_bytes());
        b
    }

    fn decode(payload: &[u8]) -> io::Result<Msg> {
        let mut c = Cursor(payload);
        Ok(match c.u8()? {
            1 => Msg::Hello {
                ready_fence: c.u64()?,
                done_fence: c.u64()?,
                ready_base: c.u64()?,
                width: c.u32()?,
                height: c.u32()?,
            },
            2 => Msg::Patch { seq: c.u64()?, json: c.string()? },
            3 => Msg::Picked { pub_id: c.u64()?, first_frame: c.u64()? },
            4 => Msg::Shutdown,
            10 => {
                let n = c.u32()? as usize;
                let handles = (0..n).map(|_| c.u64()).collect::<io::Result<Vec<_>>>()?;
                Msg::Slots { handles, width: c.u32()?, height: c.u32()? }
            }
            11 => Msg::FrameReady { slot: c.u8()?, pub_id: c.u64()?, ready_value: c.u64()? },
            12 => Msg::Events { seq: c.u64()?, json: c.string()? },
            13 => Msg::Report { text: c.string()? },
            tag => return Err(io::Error::new(io::ErrorKind::InvalidData, format!("bad tag {tag}"))),
        })
    }
}

pub fn write_msg(w: &mut impl Write, msg: &Msg) -> io::Result<()> {
    w.write_all(&msg.encode())?;
    w.flush()
}

pub fn read_msg(r: &mut impl Read) -> io::Result<Msg> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let mut payload = vec![0u8; u32::from_le_bytes(len) as usize];
    r.read_exact(&mut payload)?;
    Msg::decode(&payload)
}
