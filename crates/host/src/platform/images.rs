//! Image decoding for `Image` and `createImageBitmap`, with the color management Edge applies.

use anyhow::{Result, bail};
use image::{DynamicImage, ImageDecoder, ImageFormat};
use moxcms::{
    Chromaticity, CicpColorPrimaries, CicpProfile, ColorPrimaries, ColorProfile, Layout,
    MatrixCoefficients, ToneReprCurve, TransferCharacteristics, TransformOptions,
};
use std::io::Cursor;

/// Straight-alpha RGBA8 pixels, top row first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pixels {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

/// What a decode does with the color space an image declares. Edge converts to sRGB for an image element and for
/// `createImageBitmap` with `colorSpaceConversion: 'default'`, and keeps the stored values with `'none'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Colors {
    Convert,
    Keep,
}

/// Decodes a PNG, JPEG or WebP image by its signature, converting its declared color space to sRGB when `colors`
/// says so. Edge reads a PNG's color space from cICP, else iCCP, else sRGB, else gAMA with cHRM, and a JPEG's or
/// WebP's from its ICC profile. A profile that does not parse, or that is not RGB, leaves the values as stored.
pub fn decode(bytes: &[u8], colors: Colors) -> Result<Pixels> {
    let format = image::guess_format(bytes)?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        bail!("unsupported image format {format:?}");
    }
    let mut decoder = image::ImageReader::with_format(Cursor::new(bytes), format).into_decoder()?;
    let icc = match colors {
        Colors::Convert => decoder.icc_profile().ok().flatten(),
        Colors::Keep => None,
    };
    let image = DynamicImage::from_decoder(decoder)?.into_rgba8();
    let (width, height) = image.dimensions();
    let mut data = image.into_raw();
    if colors == Colors::Convert
        && let Some(profile) = source_profile(bytes, format, icc.as_deref())
    {
        let transform = profile.create_transform_8bit(
            Layout::Rgba,
            &ColorProfile::new_srgb(),
            Layout::Rgba,
            TransformOptions::default(),
        )?;
        let source = data.clone();
        transform.transform(&source, &mut data)?;
    }
    Ok(Pixels {
        width,
        height,
        data,
    })
}

/// The PNG chunks before the image data that declare its color space.
#[derive(Default)]
struct PngColor {
    cicp: Option<[u8; 4]>,
    srgb: bool,
    gamma: Option<u32>,
    chromaticities: Option<[u32; 8]>,
}

fn png_color(bytes: &[u8]) -> PngColor {
    let mut color = PngColor::default();
    let mut at = 8;
    while at + 8 <= bytes.len() {
        let length =
            u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize;
        let kind = &bytes[at + 4..at + 8];
        let Some(data) = bytes.get(at + 8..at + 8 + length) else {
            break;
        };
        let word = |i: usize| {
            u32::from_be_bytes([
                data[i * 4],
                data[i * 4 + 1],
                data[i * 4 + 2],
                data[i * 4 + 3],
            ])
        };
        match kind {
            b"IDAT" => break,
            b"cICP" if length == 4 => color.cicp = Some([data[0], data[1], data[2], data[3]]),
            b"sRGB" => color.srgb = true,
            b"gAMA" if length == 4 => color.gamma = Some(word(0)),
            b"cHRM" if length == 32 => color.chromaticities = Some(std::array::from_fn(word)),
            _ => {}
        }
        at += 12 + length;
    }
    color
}

/// The color space to convert from, or `None` when the image is sRGB or declares nothing Edge uses.
fn source_profile(bytes: &[u8], format: ImageFormat, icc: Option<&[u8]>) -> Option<ColorProfile> {
    let from_icc = |icc: &[u8]| {
        ColorProfile::new_from_slice(icc)
            .ok()
            .filter(|profile| profile.color_space == moxcms::DataColorSpace::Rgb)
    };
    if format != ImageFormat::Png {
        return icc.and_then(from_icc);
    }
    let png = png_color(bytes);
    if let Some([primaries, transfer, matrix, full_range]) = png.cicp {
        if primaries == 1 && transfer == 13 {
            return None;
        }
        let cicp = CicpProfile {
            color_primaries: CicpColorPrimaries::try_from(primaries).ok()?,
            transfer_characteristics: TransferCharacteristics::try_from(transfer).ok()?,
            matrix_coefficients: MatrixCoefficients::try_from(matrix).ok()?,
            full_range: full_range != 0,
        };
        return Some(ColorProfile::new_from_cicp(cicp));
    }
    if let Some(icc) = icc {
        return from_icc(icc);
    }
    if png.srgb {
        return None;
    }
    let gamma = png.gamma.filter(|gamma| *gamma > 0)?;
    let mut profile = ColorProfile::new_srgb();
    if let Some(c) = png.chromaticities {
        let at = |i: usize| Chromaticity::new(c[i] as f32 / 100_000.0, c[i + 1] as f32 / 100_000.0);
        profile.update_rgb_colorimetry(
            at(0).to_xyyb(),
            ColorPrimaries {
                red: at(2),
                green: at(4),
                blue: at(6),
            },
        );
    }
    let curve = ToneReprCurve::Parametric(vec![100_000.0 / gamma as f32]);
    profile.red_trc = Some(curve.clone());
    profile.green_trc = Some(curve.clone());
    profile.blue_trc = Some(curve);
    profile.cicp = None;
    Some(profile)
}
