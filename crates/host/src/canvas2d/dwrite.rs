//! DirectWrite, which Edge's text goes through on Windows: the system font collection that resolves family names,
//! the system font fallback that picks a font for characters a page's fonts lack, and the glyph rasterizer.
//!
//! Glyph masks follow Skia's DirectWrite scaler as Edge 157 uses it for canvas text: natural symmetric rendering,
//! DirectWrite's default grid fitting, and the ClearType texture averaged to gray. `spikes/canvas2d` chose these
//! against Edge's pixels.

use super::fonts::{Face, FaceId};
use std::{borrow::Cow, collections::HashMap, path::PathBuf, ptr};
use winapi::{
    Interface,
    um::{
        dcommon::DWRITE_MEASURING_MODE_NATURAL,
        dwrite::{
            DWRITE_FACTORY_TYPE_SHARED, DWRITE_FONT_SIMULATIONS_BOLD, DWRITE_FONT_SIMULATIONS_NONE,
            DWRITE_GLYPH_OFFSET, DWRITE_GLYPH_RUN, DWRITE_MATRIX, DWRITE_READING_DIRECTION,
            DWRITE_READING_DIRECTION_LEFT_TO_RIGHT, DWRITE_RENDERING_MODE_NATURAL_SYMMETRIC,
            DWRITE_TEXTURE_CLEARTYPE_3x1, DWriteCreateFactory, IDWriteGlyphRunAnalysis,
        },
        dwrite_1::DWRITE_TEXT_ANTIALIAS_MODE_CLEARTYPE,
        dwrite_2::{DWRITE_GRID_FIT_MODE_DEFAULT, IDWriteFactory2},
        dwrite_3::DWRITE_FONT_AXIS_VALUE,
    },
};
use wio::com::ComPtr;

/// A Windows font file and the face in it.
pub struct Found {
    pub path: PathBuf,
    pub index: u32,
    /// Whether DirectWrite emboldens a lighter face because the family has none at the weight asked for.
    pub simulated_bold: bool,
}

pub struct System {
    collection: dwrote::FontCollection,
    fallback: Option<dwrote::FontFallback>,
}

fn weight_of(weight: f32) -> dwrote::FontWeight {
    dwrote::FontWeight::from_u32(weight.round().clamp(1.0, 999.0) as u32)
}

fn style_of(italic: bool) -> dwrote::FontStyle {
    if italic {
        dwrote::FontStyle::Italic
    } else {
        dwrote::FontStyle::Normal
    }
}

fn found(font: dwrote::Font) -> Option<Found> {
    let simulated_bold = font.simulations() as u32 & DWRITE_FONT_SIMULATIONS_BOLD != 0;
    let face = font.create_font_face();
    let path = face.files().ok()?.first()?.font_file_path().ok()?;
    Some(Found {
        path,
        index: face.get_index(),
        simulated_bold,
    })
}

struct Locale;
impl dwrote::TextAnalysisSourceMethods for Locale {
    fn get_locale_name(&self, _: u32) -> (Cow<'_, str>, u32) {
        // Edge falls back as for its UI language, which a page without `lang` gets.
        (Cow::Borrowed("en-us"), u32::MAX)
    }
    fn get_paragraph_reading_direction(&self) -> DWRITE_READING_DIRECTION {
        DWRITE_READING_DIRECTION_LEFT_TO_RIGHT
    }
}

impl System {
    pub fn new() -> Self {
        Self {
            collection: dwrote::FontCollection::system(),
            fallback: dwrote::FontFallback::get_system_fallback(),
        }
    }

    /// The installed face DirectWrite matches for a family name, weight and style.
    pub fn family(&self, name: &str, weight: f32, italic: bool) -> Option<Found> {
        let family = self.collection.font_family_by_name(name).ok()??;
        let font = family
            .first_matching_font(
                weight_of(weight),
                dwrote::FontStretch::Normal,
                style_of(italic),
            )
            .ok()?;
        found(font)
    }

    /// The face Windows' font fallback picks for a character, as Skia asks for it on Edge's behalf.
    pub fn fallback(&self, c: char, weight: f32, italic: bool) -> Option<Found> {
        let fallback = self.fallback.as_ref()?;
        let mut units = [0u16; 2];
        let text: Vec<u16> = c.encode_utf16(&mut units).to_vec();
        let length = text.len() as u32;
        let source = dwrote::TextAnalysisSource::from_text(Box::new(Locale), Cow::Owned(text));
        let result = fallback.map_characters(
            &source,
            0,
            length,
            &self.collection,
            None,
            weight_of(weight),
            style_of(italic),
            dwrote::FontStretch::Normal,
        );
        found(result.mapped_font?)
    }
}

/// A glyph's coverage, 0 to 255, with its top-left corner relative to the whole pixel at its pen position.
pub struct Mask {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
    pub alpha: Vec<u8>,
}

#[derive(Hash, PartialEq, Eq, Clone)]
struct MaskKey {
    face: FaceId,
    weight: Option<u32>,
    bold: bool,
    size: u32,
    glyph: u16,
    /// The pen's offset from its whole pixel, and the transform, as bits.
    offset: (u32, u32),
    matrix: Option<[u32; 4]>,
}

/// The masks a page draws often stay cached; past this many, the cache starts over.
const MASK_CACHE: usize = 8192;

pub struct Rasterizer {
    factory: Option<ComPtr<IDWriteFactory2>>,
    faces: HashMap<(FaceId, Option<u32>, bool), Option<dwrote::FontFace>>,
    masks: HashMap<MaskKey, Option<Mask>>,
    /// Makes every face fail to open, as for a font DirectWrite rejects.
    #[cfg(test)]
    pub refuse_faces: bool,
}

impl Default for Rasterizer {
    fn default() -> Self {
        let factory = unsafe {
            let mut factory: *mut IDWriteFactory2 = ptr::null_mut();
            let hr = DWriteCreateFactory(
                DWRITE_FACTORY_TYPE_SHARED,
                &IDWriteFactory2::uuidof(),
                &mut factory as *mut _ as *mut _,
            );
            (hr == 0 && !factory.is_null()).then(|| ComPtr::from_raw(factory))
        };
        Self {
            factory,
            faces: HashMap::new(),
            masks: HashMap::new(),
            #[cfg(test)]
            refuse_faces: false,
        }
    }
}

impl Rasterizer {
    pub fn available(&self) -> bool {
        self.factory.is_some()
    }

    fn face(
        &mut self,
        id: FaceId,
        face: &Face,
        weight: Option<f32>,
        bold: bool,
    ) -> Option<&dwrote::FontFace> {
        #[cfg(test)]
        if self.refuse_faces {
            return None;
        }
        self.faces
            .entry((id, weight.map(f32::to_bits), bold))
            .or_insert_with(|| {
                let file = dwrote::FontFile::new_from_buffer(face.data.clone())?;
                let simulations = if bold {
                    DWRITE_FONT_SIMULATIONS_BOLD
                } else {
                    DWRITE_FONT_SIMULATIONS_NONE
                };
                let created = file.create_face(face.index, simulations).ok()?;
                match weight {
                    Some(value) => created.create_font_face_with_variations(
                        simulations,
                        &[DWRITE_FONT_AXIS_VALUE {
                            axisTag: u32::from_le_bytes(*b"wght"),
                            value,
                        }],
                    ),
                    None => Some(created),
                }
            })
            .as_ref()
    }

    /// The mask of one glyph with its pen at `offset` from a whole pixel, under a 2x2 `matrix` when not upright.
    #[allow(clippy::too_many_arguments)]
    pub fn glyph(
        &mut self,
        id: FaceId,
        face: &Face,
        weight: Option<f32>,
        bold: bool,
        size: f32,
        glyph: u16,
        offset: (f32, f32),
        matrix: Option<[f32; 4]>,
    ) -> Option<&Mask> {
        let key = MaskKey {
            face: id,
            weight: weight.map(f32::to_bits),
            bold,
            size: size.to_bits(),
            glyph,
            offset: (offset.0.to_bits(), offset.1.to_bits()),
            matrix: matrix.map(|m| m.map(f32::to_bits)),
        };
        if !self.masks.contains_key(&key) {
            if self.masks.len() >= MASK_CACHE {
                self.masks.clear();
            }
            let mask = self.render(id, face, weight, bold, size, glyph, offset, matrix);
            self.masks.insert(key.clone(), mask);
        }
        self.masks.get(&key)?.as_ref()
    }

    #[allow(clippy::too_many_arguments)]
    fn render(
        &mut self,
        id: FaceId,
        face: &Face,
        weight: Option<f32>,
        bold: bool,
        size: f32,
        glyph: u16,
        offset: (f32, f32),
        matrix: Option<[f32; 4]>,
    ) -> Option<Mask> {
        let font_face = unsafe { self.face(id, face, weight, bold)?.as_ptr() };
        let factory = self.factory.as_ref()?;
        let indices = [glyph];
        let advances = [0f32];
        let offsets = [DWRITE_GLYPH_OFFSET {
            advanceOffset: 0.0,
            ascenderOffset: 0.0,
        }];
        let run = DWRITE_GLYPH_RUN {
            fontFace: font_face,
            fontEmSize: size,
            glyphCount: 1,
            glyphIndices: indices.as_ptr(),
            glyphAdvances: advances.as_ptr(),
            glyphOffsets: offsets.as_ptr(),
            isSideways: 0,
            bidiLevel: 0,
        };
        let transform = matrix.map(|[m11, m12, m21, m22]| DWRITE_MATRIX {
            m11,
            m12,
            m21,
            m22,
            dx: 0.0,
            dy: 0.0,
        });
        unsafe {
            let mut analysis: *mut IDWriteGlyphRunAnalysis = ptr::null_mut();
            let hr = factory.CreateGlyphRunAnalysis(
                &run,
                transform.as_ref().map_or(ptr::null(), |t| t as *const _),
                DWRITE_RENDERING_MODE_NATURAL_SYMMETRIC,
                DWRITE_MEASURING_MODE_NATURAL,
                DWRITE_GRID_FIT_MODE_DEFAULT,
                DWRITE_TEXT_ANTIALIAS_MODE_CLEARTYPE,
                offset.0,
                offset.1,
                &mut analysis,
            );
            if hr != 0 || analysis.is_null() {
                return None;
            }
            let analysis = ComPtr::from_raw(analysis);
            let mut rect = std::mem::zeroed();
            if analysis.GetAlphaTextureBounds(DWRITE_TEXTURE_CLEARTYPE_3x1, &mut rect) != 0 {
                return None;
            }
            let (width, height) = (
                (rect.right - rect.left).max(0) as u32,
                (rect.bottom - rect.top).max(0) as u32,
            );
            if width == 0 || height == 0 {
                return None;
            }
            let mut texture = vec![0u8; width as usize * height as usize * 3];
            if analysis.CreateAlphaTexture(
                DWRITE_TEXTURE_CLEARTYPE_3x1,
                &rect,
                texture.as_mut_ptr(),
                texture.len() as u32,
            ) != 0
            {
                return None;
            }
            let alpha = texture
                .as_chunks::<3>()
                .0
                .iter()
                .map(|[r, g, b]| ((*r as u32 + *g as u32 + *b as u32 + 1) / 3) as u8)
                .collect();
            Some(Mask {
                left: rect.left,
                top: rect.top,
                width,
                height,
                alpha,
            })
        }
    }
}
