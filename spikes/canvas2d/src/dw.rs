//! DirectWrite glyph masks, one glyph at a time at its pen position, as Skia's DirectWrite scaler makes them.
//! SPIKE_DW is `<rendering mode>,<grid fit>,<antialias>`: modes 3 GDI natural, 4 natural, 5 natural symmetric;
//! grid fit 0 default, 1 disabled, 2 enabled; antialias 0 ClearType (averaged to gray), 1 grayscale.

use super::{Run, Variant, snap_x};
use anyhow::{Context, Result, bail};
use std::{ptr, sync::Arc};
use winapi::{
    Interface,
    um::{
        dcommon::DWRITE_MEASURING_MODE_NATURAL, dwrite::*, dwrite_2::IDWriteFactory2,
        dwrite_3::DWRITE_FONT_AXIS_VALUE,
    },
};

#[allow(clippy::too_many_arguments)]
pub fn coverage(
    mask: &mut [u8],
    width: u32,
    height: u32,
    data: &Arc<Vec<u8>>,
    weight: Option<f32>,
    size: f32,
    run: &Run,
    x: f32,
    y: f32,
    variant: Variant,
) -> Result<()> {
    let settings: Vec<u32> = std::env::var("SPIKE_DW")
        .unwrap_or_else(|_| "5,1,1".into())
        .split(',')
        .map(|v| v.parse().unwrap_or(0))
        .collect();
    let (mode, grid, aa) = (settings[0], settings[1], settings[2]);
    let file = dwrote::FontFile::new_from_data(data.clone()).context("font file")?;
    let mut face = file
        .create_face(0, DWRITE_FONT_SIMULATIONS_NONE)
        .map_err(|hr| anyhow::anyhow!("face {hr:x}"))?;
    if let Some(weight) = weight {
        face = face
            .create_font_face_with_variations(
                DWRITE_FONT_SIMULATIONS_NONE,
                &[DWRITE_FONT_AXIS_VALUE { axisTag: u32::from_le_bytes(*b"wght"), value: weight }],
            )
            .context("variation")?;
    }
    unsafe {
        let mut factory: *mut IDWriteFactory2 = ptr::null_mut();
        let hr = DWriteCreateFactory(
            DWRITE_FACTORY_TYPE_SHARED,
            &IDWriteFactory2::uuidof(),
            &mut factory as *mut _ as *mut _,
        );
        if hr != 0 {
            bail!("factory {hr:x}");
        }
        for &(id, gx, gy) in &run.glyphs {
            let px = snap_x(x + gx, variant);
            let py = y + gy;
            let indices = [id as u16];
            let advances = [0f32];
            let offsets = [DWRITE_GLYPH_OFFSET { advanceOffset: 0.0, ascenderOffset: 0.0 }];
            let glyph_run = DWRITE_GLYPH_RUN {
                fontFace: face.as_ptr(),
                fontEmSize: size,
                glyphCount: 1,
                glyphIndices: indices.as_ptr(),
                glyphAdvances: advances.as_ptr(),
                glyphOffsets: offsets.as_ptr(),
                isSideways: 0,
                bidiLevel: 0,
            };
            let mut analysis: *mut IDWriteGlyphRunAnalysis = ptr::null_mut();
            let hr = (*factory).CreateGlyphRunAnalysis(
                &glyph_run,
                ptr::null(),
                mode,
                DWRITE_MEASURING_MODE_NATURAL,
                grid,
                aa,
                px,
                py,
                &mut analysis,
            );
            if hr != 0 {
                bail!("analysis {hr:x}");
            }
            let texture = if aa == 1 { DWRITE_TEXTURE_ALIASED_1x1 } else { DWRITE_TEXTURE_CLEARTYPE_3x1 };
            let mut rect = std::mem::zeroed();
            (*analysis).GetAlphaTextureBounds(texture, &mut rect);
            let (w, h) = ((rect.right - rect.left).max(0) as usize, (rect.bottom - rect.top).max(0) as usize);
            if w > 0 && h > 0 {
                let bpp = if aa == 1 { 1 } else { 3 };
                let mut bytes = vec![0u8; w * h * bpp];
                (*analysis).CreateAlphaTexture(texture, &rect, bytes.as_mut_ptr(), bytes.len() as u32);
                for row in 0..h {
                    let ty = rect.top + row as i32;
                    if ty < 0 || ty >= height as i32 {
                        continue;
                    }
                    for col in 0..w {
                        let tx = rect.left + col as i32;
                        if tx < 0 || tx >= width as i32 {
                            continue;
                        }
                        let a = if bpp == 1 {
                            bytes[row * w + col] as u32
                        } else {
                            let p = &bytes[(row * w + col) * 3..][..3];
                            (p[0] as u32 + p[1] as u32 + p[2] as u32 + 1) / 3
                        };
                        let m = &mut mask[ty as usize * width as usize + tx as usize];
                        *m = (*m as u32 + a - (*m as u32 * a + 127) / 255).min(255) as u8;
                    }
                }
            }
            (*analysis).Release();
        }
        (*factory).Release();
    }
    Ok(())
}
