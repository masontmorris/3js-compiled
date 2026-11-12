use std::{error::Error, fmt};

/// The stream format version. It changes whenever the same bytes would replay differently.
pub const VERSION: u16 = 10;
const HEADER_LEN: usize = 20;
const RECORD_LEN: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Record<'a> {
    pub opcode: u16,
    pub payload: &'a [u8],
}

/// A decoded stream. `frame` is the recorder's frame index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stream<'a> {
    pub frame: u32,
    pub records: Vec<Record<'a>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    Truncated,
    Magic,
    Version { found: u16 },
    Flags,
    Length,
    Opcode,
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Version { found } => write!(
                f,
                "GPU command stream version {found} is not supported: this host replays version {VERSION}, so build the game with the three-native package from the same release as the host"
            ),
            _ => write!(f, "invalid GPU command stream: {self:?}"),
        }
    }
}

impl Error for DecodeError {}

fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

pub fn decode(bytes: &[u8]) -> Result<Stream<'_>, DecodeError> {
    if bytes.len() < HEADER_LEN {
        return Err(DecodeError::Truncated);
    }
    if &bytes[..4] != b"3JSC" {
        return Err(DecodeError::Magic);
    }
    let version = u16_at(bytes, 4);
    if version != VERSION {
        return Err(DecodeError::Version { found: version });
    }
    if u16_at(bytes, 6) != 0 {
        return Err(DecodeError::Flags);
    }
    if u32_at(bytes, 8) as usize != bytes.len() {
        return Err(DecodeError::Length);
    }
    let frame = u32_at(bytes, 12);
    let count = u32_at(bytes, 16) as usize;
    if count > (bytes.len() - HEADER_LEN) / RECORD_LEN {
        return Err(DecodeError::Truncated);
    }
    let mut records = Vec::with_capacity(count);
    let mut offset = HEADER_LEN;
    for _ in 0..count {
        let header = bytes
            .get(offset..offset + RECORD_LEN)
            .ok_or(DecodeError::Truncated)?;
        let opcode = u16_at(header, 0);
        if !(1..=56).contains(&opcode) {
            return Err(DecodeError::Opcode);
        }
        if u16_at(header, 2) != 0 {
            return Err(DecodeError::Flags);
        }
        let len = u32_at(header, 4) as usize;
        offset += RECORD_LEN;
        let end = offset.checked_add(len).ok_or(DecodeError::Length)?;
        let payload = bytes.get(offset..end).ok_or(DecodeError::Truncated)?;
        records.push(Record { opcode, payload });
        offset = end;
    }
    if offset != bytes.len() {
        return Err(DecodeError::Length);
    }
    Ok(Stream { frame, records })
}
mod executor;
mod pipeline;
pub use executor::{Executor, Response, Trailer};

/// WebGPU's feature names, in the order the specification lists them.
const WEBGPU_FEATURES: [&str; 21] = [
    "core-features-and-limits",
    "depth-clip-control",
    "depth32float-stencil8",
    "texture-compression-bc",
    "texture-compression-bc-sliced-3d",
    "texture-compression-etc2",
    "texture-compression-astc",
    "texture-compression-astc-sliced-3d",
    "timestamp-query",
    "indirect-first-instance",
    "shader-f16",
    "rg11b10ufloat-renderable",
    "bgra8unorm-storage",
    "float32-filterable",
    "float32-blendable",
    "clip-distances",
    "dual-source-blending",
    "subgroups",
    "texture-formats-tier1",
    "texture-formats-tier2",
    "primitive-index",
];

/// The WebGPU features a device from an adapter with `adapter` features can be given, as a browser's `GPUAdapter`
/// reports them: those whose names wgpu parses and the adapter has, and WebGPU's core features, which every wgpu
/// device has. A `REQUEST_DEVICE` that names any other feature fails.
pub fn webgpu_features(adapter: wgpu::Features) -> Vec<&'static str> {
    WEBGPU_FEATURES
        .into_iter()
        .filter(|name| {
            *name == "core-features-and-limits"
                || name
                    .parse::<wgpu::Features>()
                    .is_ok_and(|feature| adapter.contains(feature))
        })
        .collect()
}
