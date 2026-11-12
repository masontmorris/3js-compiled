//! Text layout as Chromium does it for canvas: each character takes the first font in the list that has it, then
//! the fallback fonts, runs shape with HarfBuzz's rules at 16.16 fixed point, and the font metrics come from the
//! first font, rounded as Blink rounds them.

use super::fonts::{EMOJI, FALLBACK, FaceId, Fonts, STANDARD, generic};
use harfrust::{ShaperInstance, UnicodeBuffer, Variation};
use serde::Deserialize;
use skrifa::{
    GlyphId, MetadataProvider,
    instance::{LocationRef, Size},
    raw::TableProvider,
};

/// One family of a CSS font list, as the page's script resolved it.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Family {
    /// A face the page loaded with `FontFace`.
    Face(FaceId),
    /// A generic family or a Windows font by name.
    System(String),
}

#[derive(Deserialize, Clone, Debug)]
pub struct FontSpec {
    pub families: Vec<Family>,
    pub size: f32,
    pub weight: f32,
    pub italic: bool,
}

/// A face at the weight the font asks for.
#[derive(Clone, Debug, PartialEq)]
pub struct Instance {
    pub face: FaceId,
    /// The `wght` value for a variable face, clamped to its axis.
    pub weight: Option<f32>,
    pub coords: Vec<i16>,
}

pub struct Run {
    pub instance: Instance,
    /// Glyph IDs and pen positions in pixels from the start of the text on the alphabetic baseline, y down.
    pub glyphs: Vec<(u32, f64, f64)>,
}

pub struct Layout {
    pub runs: Vec<Run>,
    pub width: f64,
}

/// Blink's metrics for the first font, in pixels: the rounded ascent and descent, and the em box's ascent and
/// descent, normalized to the font size and rounded to 1/64 pixel.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FontMetrics {
    pub ascent: f64,
    pub descent: f64,
    pub em_ascent: f64,
    pub em_descent: f64,
}

fn instance(fonts: &Fonts, face: FaceId, weight: f32) -> Instance {
    let font = fonts.get(face);
    let weight = font.weight_axis.map(|(min, max)| weight.clamp(min, max));
    let coords = match weight {
        Some(weight) => font
            .font()
            .axes()
            .location([("wght", weight)])
            .coords()
            .iter()
            .map(|coord| coord.to_bits())
            .collect(),
        None => Vec::new(),
    };
    Instance {
        face,
        weight,
        coords,
    }
}

/// The fonts a text draws with: the font list's available faces, or the standard font when none is, then, once a
/// character needs them, the fallback fonts, with the emoji font last.
pub struct Chain {
    pub instances: Vec<Instance>,
    /// How many of the instances come from the font list, or are the standard font in its place.
    listed: usize,
    emoji: Option<usize>,
    spec: (f32, bool),
    fallback: bool,
}

impl Chain {
    /// The first font, whose metrics the text uses.
    pub fn primary(&self) -> Option<&Instance> {
        self.instances.first()
    }

    /// The order to try the fonts in for `c`: the listed fonts, then the emoji font for an emoji, then the rest.
    fn order(&self, c: char) -> impl Iterator<Item = usize> + '_ {
        let emoji = self.emoji.filter(|_| is_emoji(c));
        (0..self.listed)
            .chain(emoji)
            .chain((self.listed..self.instances.len()).filter(move |index| Some(*index) != emoji))
    }

    /// Adds the fallback fonts, which load from disk the first time any text needs them.
    fn add_fallback(&mut self, fonts: &mut Fonts) {
        if self.fallback {
            return;
        }
        self.fallback = true;
        let (weight, italic) = self.spec;
        let bold = weight >= 600.0;
        let faces: Vec<FaceId> = FALLBACK
            .iter()
            .filter_map(|name| fonts.system(name, bold, italic))
            .collect();
        for face in faces {
            if !self.instances.iter().any(|known| known.face == face) {
                self.instances.push(instance(fonts, face, weight));
            }
        }
        if let Some(face) = fonts.system(EMOJI, false, false) {
            self.emoji = Some(
                self.instances
                    .iter()
                    .position(|known| known.face == face)
                    .unwrap_or_else(|| {
                        self.instances.push(instance(fonts, face, weight));
                        self.instances.len() - 1
                    }),
            )
            .filter(|index| *index >= self.listed);
        }
    }
}

pub fn chain(fonts: &mut Fonts, spec: &FontSpec) -> Chain {
    let bold = spec.weight >= 600.0;
    let mut faces = Vec::new();
    for family in &spec.families {
        let face = match family {
            Family::Face(id) => Some(*id),
            Family::System(name) => fonts.system(generic(name).unwrap_or(name), bold, spec.italic),
        };
        faces.extend(face);
    }
    if faces.is_empty() {
        faces.extend(fonts.system(STANDARD, bold, spec.italic));
    }
    let mut instances: Vec<Instance> = Vec::new();
    for face in faces {
        if !instances.iter().any(|known| known.face == face) {
            instances.push(instance(fonts, face, spec.weight));
        }
    }
    Chain {
        listed: instances.len(),
        instances,
        emoji: None,
        spec: (spec.weight, spec.italic),
        fallback: false,
    }
}

/// Characters Windows draws from its emoji font: pictographs, dingbats and the other symbols with an emoji
/// presentation.
fn is_emoji(c: char) -> bool {
    matches!(c as u32, 0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0x2300..=0x23FF | 0x2B00..=0x2BFF | 0x3030 | 0x303D | 0x3297 | 0x3299)
}

/// The size Blink draws and measures a font at: the CSS size truncated to 1/100 pixel.
pub fn used_size(size: f32) -> f32 {
    ((size as f64 * 100.0 + 1e-4).floor() / 100.0) as f32
}

/// Characters that stay in the run of the character before them: joiners, variation selectors, emoji modifiers
/// and tags, and combining marks.
fn continues_cluster(c: char) -> bool {
    matches!(c as u32, 0x200C | 0x200D | 0xFE00..=0xFE0F | 0x1F3FB..=0x1F3FF | 0xE0020..=0xE007F | 0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x20D0..=0x20FF)
}

/// Shapes `text` left to right, a run per stretch of characters that the same font draws.
pub fn layout(fonts: &mut Fonts, chain: &mut Chain, text: &str, size: f32) -> Layout {
    if !chain.fallback {
        let listed: Vec<_> = chain
            .instances
            .iter()
            .map(|instance| fonts.get(instance.face).font().charmap())
            .collect();
        let missing = text.chars().any(|c| {
            !continues_cluster(c) && !listed.iter().any(|charmap| charmap.map(c).is_some())
        });
        if missing {
            chain.add_fallback(fonts);
        }
    }
    let fonts = &*fonts;
    let charmaps: Vec<_> = chain
        .instances
        .iter()
        .map(|instance| fonts.get(instance.face).font().charmap())
        .collect();
    // Blink shapes each word and each space on its own, so no kerning or ligature crosses a space.
    let mut pieces: Vec<(usize, &str)> = Vec::new();
    for segment in text
        .split_inclusive(' ')
        .flat_map(|word| match word.strip_suffix(' ') {
            Some(rest) => [rest, " "],
            None => [word, ""],
        })
    {
        let mut start = 0;
        let mut current = None;
        for (at, c) in segment.char_indices() {
            let index = if continues_cluster(c) && current.is_some() {
                current
            } else {
                // A character no font has draws as the first font's missing glyph, as Edge does.
                Some(
                    chain
                        .order(c)
                        .find(|index| charmaps[*index].map(c).is_some())
                        .unwrap_or(0),
                )
            };
            if index != current {
                if let Some(index) = current {
                    pieces.push((index, &segment[start..at]));
                }
                start = at;
                current = index;
            }
        }
        if let Some(index) = current {
            pieces.push((index, &segment[start..]));
        }
    }
    let mut pen = 0.0;
    let mut runs = Vec::new();
    for (index, piece) in pieces {
        let Some(instance) = chain.instances.get(index) else {
            continue;
        };
        let face = fonts.get(instance.face);
        let Ok(font) = harfrust::FontRef::new(&face.data) else {
            continue;
        };
        let variations: Vec<Variation> = instance
            .weight
            .map(|value| Variation {
                tag: harfrust::Tag::new(b"wght"),
                value,
            })
            .into_iter()
            .collect();
        let shaper_instance = ShaperInstance::from_variations(&font, &variations);
        let shaper = face
            .shaper
            .shaper(&font)
            .instance(Some(&shaper_instance))
            .build();
        let mut buffer = UnicodeBuffer::new();
        buffer.push_str(piece);
        buffer.guess_segment_properties();
        buffer.set_direction(harfrust::Direction::LeftToRight);
        // Blink shapes at 16.16 fixed point, so advances keep their fractions.
        let scale = (size as f64 * 65536.0).round() as i32;
        let shaped = shaper.shape(buffer, harfrust::ShapeOptions::new().scale(Some(scale)));
        let mut glyphs = Vec::with_capacity(shaped.len());
        for (info, position) in shaped.glyph_infos().iter().zip(shaped.glyph_positions()) {
            glyphs.push((
                info.glyph_id,
                pen + position.x_offset as f64 / 65536.0,
                -position.y_offset as f64 / 65536.0,
            ));
            pen += position.x_advance as f64 / 65536.0;
        }
        runs.push(Run {
            instance: instance.clone(),
            glyphs,
        });
    }
    Layout { runs, width: pen }
}

/// Blink's `SimpleFontData` metrics: the ascent and descent rounded to whole pixels, and the em box normalized from
/// the typographic ascent and descent, else the ascent and descent, to sum to the font size.
pub fn font_metrics(fonts: &Fonts, instance: &Instance, size: f32) -> FontMetrics {
    let face = fonts.get(instance.face);
    let font = face.font();
    let upem = font
        .head()
        .map_or(1000.0, |head| head.units_per_em() as f64);
    let scale = size as f64 / upem;
    // DirectWrite takes a Windows font's ascent and descent from its OS/2 Windows metrics, and Skia takes a web
    // font's from hhea.
    let windows = font
        .os2()
        .ok()
        .filter(|_| face.system)
        .map(|os2| (os2.us_win_ascent() as f64, os2.us_win_descent() as f64));
    let (mut ascent, mut descent) = windows
        .or_else(|| {
            font.hhea().ok().map(|hhea| {
                (
                    hhea.ascender().to_i16() as f64,
                    -(hhea.descender().to_i16() as f64),
                )
            })
        })
        .unwrap_or((0.8 * upem, 0.2 * upem));
    let typo = font.os2().ok().map(|os2| {
        (
            os2.s_typo_ascender() as f64,
            -(os2.s_typo_descender() as f64),
        )
    });
    if let Ok(os2) = font.os2()
        && os2.fs_selection().bits() & (1 << 7) != 0
    {
        ascent = os2.s_typo_ascender() as f64;
        descent = -(os2.s_typo_descender() as f64);
    }
    let (em_ascent, em_descent) = match typo {
        Some((a, d)) if a + d > 0.0 => (a, d),
        _ => (ascent, descent),
    };
    let em_ascent_px = ((em_ascent / (em_ascent + em_descent)) * size as f64 * 64.0).round() / 64.0;
    FontMetrics {
        ascent: (ascent * scale).round(),
        descent: (descent * scale).round(),
        em_ascent: em_ascent_px,
        em_descent: ((size as f64 * 64.0).round() / 64.0 - em_ascent_px),
    }
}

/// How far below the requested y the alphabetic baseline sits for each `textBaseline`.
pub fn baseline_shift(metrics: &FontMetrics, baseline: &str) -> f64 {
    match baseline {
        "top" => metrics.em_ascent,
        "hanging" => metrics.ascent * 0.8,
        "middle" => (metrics.em_ascent - metrics.em_descent) / 2.0,
        "ideographic" => -metrics.descent,
        "bottom" => -metrics.em_descent,
        _ => 0.0,
    }
}

/// The ink bounds of the laid-out glyphs, in pixels from the pen start on the baseline, y down: left, top, right,
/// bottom. Each glyph's are Skia's glyph mask bounds, its outline's rounded out to whole pixels and a pixel wider
/// on the left for subpixel positioning, at the glyph's pen position. `None` for text with no ink.
pub fn ink_bounds(fonts: &Fonts, layout: &Layout, size: f32) -> Option<[f64; 4]> {
    let mut bounds: Option<[f64; 4]> = None;
    for run in &layout.runs {
        let font = fonts.get(run.instance.face).font();
        let coords: Vec<_> = run
            .instance
            .coords
            .iter()
            .map(|bits| skrifa::instance::NormalizedCoord::from_bits(*bits))
            .collect();
        let metrics = font.glyph_metrics(Size::new(size), LocationRef::new(&coords));
        for &(id, x, y) in &run.glyphs {
            let Some(b) = metrics.bounds(GlyphId::new(id)) else {
                continue;
            };
            if b.x_min >= b.x_max || b.y_min >= b.y_max {
                continue;
            }
            // A thousandth of a pixel absorbs the outline's float error before rounding out.
            let out = |v: f32, up: bool| {
                if up {
                    (v as f64 - 1e-3).ceil()
                } else {
                    (v as f64 + 1e-3).floor()
                }
            };
            let glyph = [
                x + out(b.x_min, false) - 1.0,
                y - out(b.y_max, true),
                x + out(b.x_max, true),
                y - out(b.y_min, false),
            ];
            bounds = Some(match bounds {
                None => glyph,
                Some(old) => [
                    old[0].min(glyph[0]),
                    old[1].min(glyph[1]),
                    old[2].max(glyph[2]),
                    old[3].max(glyph[3]),
                ],
            });
        }
    }
    bounds
}
