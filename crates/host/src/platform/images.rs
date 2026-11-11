//! Image decoding for `Image` and `createImageBitmap`.

use anyhow::{Result, bail};

/// Straight-alpha RGBA8 pixels, top row first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pixels {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

/// Decodes a PNG, JPEG or WebP image by its signature. Like Edge with `colorSpaceConversion: "none"`, it applies
/// no embedded color profile or gamma, and it keeps the stored orientation.
pub fn decode(bytes: &[u8]) -> Result<Pixels> {
    let format = image::guess_format(bytes)?;
    if !matches!(
        format,
        image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP
    ) {
        bail!("unsupported image format {format:?}");
    }
    let image = image::load_from_memory_with_format(bytes, format)?.into_rgba8();
    Ok(Pixels {
        width: image.width(),
        height: image.height(),
        data: image.into_raw(),
    })
}
