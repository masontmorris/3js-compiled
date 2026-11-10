// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

pub mod place;
pub mod reply;

use std::io::{self, Read, Write};

/// Largest message payload either side writes or accepts.
pub const MAX_PAYLOAD: usize = 1 << 20;
/// Largest JSON text a `Patch` or `Events` message carries: the payload minus an `Events`
/// message's tag, sequence number, viewport size and length prefix.
pub const MAX_JSON: usize = MAX_PAYLOAD - 21;

#[derive(Debug, Clone, PartialEq)]
pub enum Msg {
    /// Fence handles are already duplicated into the ui-host's handle table.
    Hello {
        ready_fence: u64,
        done_fence: u64,
        ready_base: u64,
        width: u32,
        height: u32,
    },
    /// The game's full UI state. The host sends one only after `Ready`.
    Patch {
        seq: u64,
        json: String,
    },
    /// From game frame `first_frame` on, the game samples publication `pub_id`.
    Picked {
        pub_id: u64,
        first_frame: u64,
    },
    Pointer(place::Pointer),
    Resize {
        width: u32,
        height: u32,
    },
    Shutdown,
    /// The host has duplicated or skipped the handles of ring `generation`.
    SlotsImported {
        generation: u64,
    },
    /// Shared NT handles of the ring textures, valid in the ui-host's handle table until
    /// the host answers with `SlotsImported`.
    Slots {
        generation: u64,
        handles: Vec<u64>,
        width: u32,
        height: u32,
    },
    /// Publication `pub_id` lives in `slot`; readable once the ready fence reaches `ready_value`.
    FrameReady {
        slot: u8,
        pub_id: u64,
        ready_value: u64,
    },
    /// Result of `__bridge.tick` for patch `seq`, or for a poll of the current state when
    /// `seq` is 0, with the viewport size the page was laid out at.
    Events {
        seq: u64,
        width: u32,
        height: u32,
        json: String,
    },
    /// ui-host evaluates the next patch as soon as it arrives.
    Ready,
    Report {
        text: String,
    },
}

fn put_u32(b: &mut Vec<u8>, v: u32) {
    b.extend_from_slice(&v.to_le_bytes());
}
fn put_u64(b: &mut Vec<u8>, v: u64) {
    b.extend_from_slice(&v.to_le_bytes());
}
fn put_f32(b: &mut Vec<u8>, v: f32) {
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
    fn f32(&mut self) -> io::Result<f32> {
        Ok(f32::from_le_bytes(self.take(4)?.try_into().unwrap()))
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
            Msg::Hello {
                ready_fence,
                done_fence,
                ready_base,
                width,
                height,
            } => {
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
            Msg::Picked {
                pub_id,
                first_frame,
            } => {
                b.push(3);
                put_u64(&mut b, *pub_id);
                put_u64(&mut b, *first_frame);
            }
            Msg::Shutdown => b.push(4),
            Msg::Pointer(pointer) => {
                b.push(5);
                b.push(pointer.action);
                put_f32(&mut b, pointer.x);
                put_f32(&mut b, pointer.y);
                b.extend_from_slice(&pointer.button.to_le_bytes());
                let (tag, rect, offset) = match pointer.at {
                    place::At::Rect { rect, offset } => (0, rect, offset),
                    place::At::Beside { rect, offset } => (1, rect, offset),
                };
                b.push(tag);
                put_u32(&mut b, rect);
                put_f32(&mut b, offset.0);
                put_f32(&mut b, offset.1);
            }
            Msg::Resize { width, height } => {
                b.push(6);
                put_u32(&mut b, *width);
                put_u32(&mut b, *height);
            }
            Msg::SlotsImported { generation } => {
                b.push(7);
                put_u64(&mut b, *generation);
            }
            Msg::Slots {
                generation,
                handles,
                width,
                height,
            } => {
                b.push(10);
                put_u64(&mut b, *generation);
                put_u32(&mut b, handles.len() as u32);
                for h in handles {
                    put_u64(&mut b, *h);
                }
                put_u32(&mut b, *width);
                put_u32(&mut b, *height);
            }
            Msg::FrameReady {
                slot,
                pub_id,
                ready_value,
            } => {
                b.push(11);
                b.push(*slot);
                put_u64(&mut b, *pub_id);
                put_u64(&mut b, *ready_value);
            }
            Msg::Events {
                seq,
                width,
                height,
                json,
            } => {
                b.push(12);
                put_u64(&mut b, *seq);
                put_u32(&mut b, *width);
                put_u32(&mut b, *height);
                put_str(&mut b, json);
            }
            Msg::Report { text } => {
                b.push(13);
                put_str(&mut b, text);
            }
            Msg::Ready => b.push(14),
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
            2 => Msg::Patch {
                seq: c.u64()?,
                json: c.string()?,
            },
            3 => Msg::Picked {
                pub_id: c.u64()?,
                first_frame: c.u64()?,
            },
            4 => Msg::Shutdown,
            5 => Msg::Pointer(place::Pointer {
                action: c.u8()?,
                x: c.f32()?,
                y: c.f32()?,
                button: i16::from_le_bytes(c.take(2)?.try_into().unwrap()),
                at: {
                    let (tag, rect, offset) = (c.u8()?, c.u32()?, (c.f32()?, c.f32()?));
                    match tag {
                        0 => place::At::Rect { rect, offset },
                        1 => place::At::Beside { rect, offset },
                        _ => {
                            return Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                format!("bad pointer target {tag}"),
                            ));
                        }
                    }
                },
            }),
            6 => Msg::Resize {
                width: c.u32()?,
                height: c.u32()?,
            },
            7 => Msg::SlotsImported {
                generation: c.u64()?,
            },
            10 => {
                let generation = c.u64()?;
                let n = c.u32()? as usize;
                if n > c.0.len().saturating_sub(8) / 8 {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "invalid slot count",
                    ));
                }
                let handles = (0..n).map(|_| c.u64()).collect::<io::Result<Vec<_>>>()?;
                Msg::Slots {
                    generation,
                    handles,
                    width: c.u32()?,
                    height: c.u32()?,
                }
            }
            11 => Msg::FrameReady {
                slot: c.u8()?,
                pub_id: c.u64()?,
                ready_value: c.u64()?,
            },
            12 => Msg::Events {
                seq: c.u64()?,
                width: c.u32()?,
                height: c.u32()?,
                json: c.string()?,
            },
            13 => Msg::Report { text: c.string()? },
            14 => Msg::Ready,
            tag => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("bad tag {tag}"),
                ));
            }
        })
    }
}

/// The size of the ring ui-host creates after reading `requested` sizes in one batch: the
/// last one, unless its current ring already has that size. A batch of resizes therefore
/// gets at most one `Slots`, and a resize and a resize back get none.
pub fn next_ring_size(
    current: (u32, u32),
    requested: impl IntoIterator<Item = (u32, u32)>,
) -> Option<(u32, u32)> {
    requested.into_iter().last().filter(|&size| size != current)
}

pub fn write_msg(w: &mut impl Write, msg: &Msg) -> io::Result<()> {
    let bytes = msg.encode();
    if bytes.len() - 4 > MAX_PAYLOAD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("message of {} bytes exceeds {MAX_PAYLOAD}", bytes.len() - 4),
        ));
    }
    w.write_all(&bytes)?;
    w.flush()
}

pub fn read_msg(r: &mut impl Read) -> io::Result<Msg> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_PAYLOAD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("message of {len} bytes exceeds {MAX_PAYLOAD}"),
        ));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    Msg::decode(&payload)
}
