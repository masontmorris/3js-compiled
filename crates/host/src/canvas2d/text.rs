//! Text layout as Chromium does it for canvas: each character takes the first font in the list that has it, then
//! a font Windows' fallback picks for it, runs shape with HarfBuzz's rules at 16.16 fixed point, and the font
//! metrics come from the first font, rounded as Blink rounds them.

use super::fonts::{FaceId, Fonts, STANDARD};
use harfrust::{ShaperInstance, UnicodeBuffer, Variation};
use serde::Deserialize;
use skrifa::{
    GlyphId, MetadataProvider,
    instance::{LocationRef, Size},
    raw::TableProvider,
};
use std::collections::HashMap;

/// The code point ranges of a `unicode-range` descriptor, inclusive.
pub type Ranges = Vec<[u32; 2]>;

/// A face the page loaded with `FontFace`, with the weight range its descriptor declares.
#[derive(Deserialize, Clone, Debug)]
pub struct LoadedFace {
    pub id: FaceId,
    pub weight: [f32; 2],
    /// Its `unicode-range`; none means every character.
    #[serde(default)]
    pub ranges: Option<Ranges>,
}

/// One family of a CSS font list, as the page's script resolved it.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Family {
    Face(LoadedFace),
    /// A generic family or a Windows font by name.
    System(String),
    /// A generic family keyword, which the host maps to a Windows family.
    Generic(String),
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
    /// The `wght` value for a variable face.
    pub weight: Option<f32>,
    pub coords: Vec<i16>,
    /// Whether the glyphs draw emboldened, as for a bold font whose face is not bold.
    pub synthetic_bold: bool,
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

/// CSS synthesizes bold when the font asks for 600 or more and the face is lighter.
fn synthesizes_bold(asked: f32, face_weight: f32) -> bool {
    asked >= 600.0 && face_weight < 600.0
}

/// An instance at `weight`, within the face's declared `range` and its `wght` axis.
fn instance(fonts: &Fonts, face: FaceId, weight: f32, range: Option<[f32; 2]>) -> Instance {
    let font = fonts.get(face);
    let declared = range.map_or(weight, |[min, max]| weight.clamp(min, max));
    let axis_weight = font.weight_axis.map(|(min, max)| declared.clamp(min, max));
    let coords = match axis_weight {
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
    let synthetic_bold = match range {
        Some([_, max]) => synthesizes_bold(weight, max),
        None => font.simulated_bold,
    };
    Instance {
        face,
        weight: axis_weight,
        coords,
        synthetic_bold,
    }
}

/// The fonts a text draws with: the font list's available faces, or the standard font when none is, then the
/// faces Windows' fallback picked for characters those lack, in the order the text needed them.
pub struct Chain {
    pub instances: Vec<Instance>,
    /// How many of the instances come from the font list, or are the standard font in its place.
    listed: usize,
    /// The `unicode-range` of each listed instance that has one, by index.
    ranges: Vec<Option<Ranges>>,
    spec: (f32, bool),
}

impl Chain {
    /// CSS's first available font, whose metrics the text uses: the first listed font whose range holds a space.
    pub fn primary(&self) -> Option<&Instance> {
        self.instances.get(self.primary_index()?)
    }

    fn primary_index(&self) -> Option<usize> {
        (0..self.listed).find(|&index| self.allows(index, ' '))
    }

    /// Whether the instance at `index` may draw `c`: its `unicode-range` holds it, or it has none.
    fn allows(&self, index: usize, c: char) -> bool {
        self.ranges
            .get(index)
            .and_then(Option::as_ref)
            .is_none_or(|ranges| {
                ranges
                    .iter()
                    .any(|&[min, max]| (min..=max).contains(&(c as u32)))
            })
    }
}

pub fn chain(fonts: &mut Fonts, spec: &FontSpec) -> Chain {
    let mut instances: Vec<Instance> = Vec::new();
    let mut ranges = Vec::new();
    let mut faces: Vec<(FaceId, Option<[f32; 2]>, Option<Ranges>)> = Vec::new();
    for family in &spec.families {
        match family {
            Family::Face(loaded) => {
                faces.push((loaded.id, Some(loaded.weight), loaded.ranges.clone()))
            }
            Family::System(name) => faces.extend(
                fonts
                    .family(name, spec.weight, spec.italic)
                    .map(|face| (face, None, None)),
            ),
            Family::Generic(name) => faces.extend(
                fonts
                    .generic(name, spec.weight, spec.italic)
                    .map(|face| (face, None, None)),
            ),
        }
    }
    if faces.is_empty() {
        faces.extend(
            fonts
                .family(STANDARD, spec.weight, spec.italic)
                .map(|face| (face, None, None)),
        );
    }
    // When every listed face's range leaves out a space, the standard font follows them as CSS's default font.
    let holds_space = |ranges: &Option<Ranges>| {
        ranges
            .as_ref()
            .is_none_or(|ranges| ranges.iter().any(|&[min, max]| (min..=max).contains(&0x20)))
    };
    if !faces.iter().any(|(.., ranges)| holds_space(ranges)) {
        faces.extend(
            fonts
                .family(STANDARD, spec.weight, spec.italic)
                .map(|face| (face, None, None)),
        );
    }
    for (face, weight, face_ranges) in faces {
        if !instances.iter().any(|known| known.face == face) {
            instances.push(instance(fonts, face, spec.weight, weight));
            ranges.push(face_ranges);
        }
    }
    Chain {
        listed: instances.len(),
        instances,
        ranges,
        spec: (spec.weight, spec.italic),
    }
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

/// The families Chromium tries on Windows for a character in a script the font list lacks, before Windows'
/// own fallback, in its order. Edge 157 picked these for each script (`CSS.getPlatformFontsForNode`).
fn script_families(c: char) -> &'static [&'static str] {
    match c as u32 {
        0x3040..=0x30FF | 0x31F0..=0x31FF | 0xFF65..=0xFF9F => {
            &["meiryo", "yu gothic", "ms pgothic"]
        }
        0x3400..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0xF900..=0xFAFF
        | 0x20000..=0x2FFFF
        | 0x3000..=0x303F
        | 0xFF00..=0xFF64 => &["microsoft yahei", "simsun"],
        0x1100..=0x11FF | 0x3130..=0x318F | 0xAC00..=0xD7AF => &["malgun gothic", "gulim"],
        0x0E00..=0x0E7F => &["tahoma", "leelawadee ui"],
        0x0900..=0x097F => &["nirmala ui", "mangal"],
        0x1F000..=0x1FAFF => &["segoe ui emoji"],
        0x2190..=0x2BFF => &["segoe ui symbol"],
        _ => &[],
    }
}

/// Picks a fallback face for each character no listed font has, as Blink does for each character on its own:
/// the standard font, then the script's families, then Windows' fallback,
/// each at the font's weight and style. Returns the chain index of each such character's face.
fn add_fallbacks(fonts: &mut Fonts, chain: &mut Chain, text: &str) -> HashMap<char, usize> {
    let (weight, italic) = chain.spec;
    let covers =
        |fonts: &Fonts, face: FaceId, c: char| fonts.get(face).font().charmap().map(c).is_some();
    let mut chosen = HashMap::new();
    // Marks get a face too: layout keeps a mark with its base, so the face here draws only a mark that starts a
    // segment.
    for c in text.chars() {
        if chosen.contains_key(&c)
            || chain.instances[..chain.listed]
                .iter()
                .enumerate()
                .any(|(index, instance)| chain.allows(index, c) && covers(fonts, instance.face, c))
        {
            continue;
        }
        let mut found = None;
        for family in [STANDARD].iter().chain(script_families(c)) {
            if let Some(face) = fonts.family(family, weight, italic)
                && covers(fonts, face, c)
            {
                found = Some(face);
                break;
            }
        }
        let Some(face) = found.or_else(|| fonts.fallback(c, weight, italic)) else {
            continue;
        };
        let index = match chain.instances.iter().position(|known| known.face == face) {
            Some(index) => index,
            None => {
                chain.instances.push(instance(fonts, face, weight, None));
                chain.instances.len() - 1
            }
        };
        chosen.insert(c, index);
    }
    chosen
}

/// Unicode's default-ignorable code points, which the shaper hides.
fn default_ignorable(c: char) -> bool {
    matches!(c as u32, 0xAD | 0x34F | 0x61C | 0x115F..=0x1160 | 0x17B4..=0x17B5 | 0x180B..=0x180F | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x206F | 0x3164 | 0xFE00..=0xFE0F | 0xFEFF | 0xFFA0 | 0xFFF0..=0xFFF8 | 0x1BCA0..=0x1BCA3 | 0x1D173..=0x1D17A | 0xE0000..=0xE0FFF)
}

/// CJK and fullwidth punctuation, which takes the font of the text around it.
fn common_cjk(c: char) -> bool {
    matches!(c as u32, 0x3000..=0x303F | 0xFF00..=0xFF0F | 0xFF1A..=0xFF20)
}

fn words(run: &str) -> Vec<&str> {
    run.split_inclusive(' ')
        .flat_map(|word| match word.strip_suffix(' ') {
            Some(rest) => [rest, " "],
            None => [word, ""],
        })
        .filter(|segment| !segment.is_empty())
        .collect()
}

/// The text's words and spaces in visual order. Blink shapes each word and each space on its own, so no kerning or
/// ligature crosses a space, and the bidi algorithm reverses the words of a right-to-left run.
fn visual_segments(text: &str) -> Vec<&str> {
    let bidi = unicode_bidi::BidiInfo::new(text, Some(unicode_bidi::Level::ltr()));
    let Some(paragraph) = bidi.paragraphs.first().filter(|_| bidi.has_rtl()) else {
        return words(text);
    };
    let (levels, runs) = bidi.visual_runs(paragraph, paragraph.range.clone());
    let mut segments = Vec::new();
    for run in runs {
        let mut run_words = words(&text[run.clone()]);
        if levels[run.start].is_rtl() {
            run_words.reverse();
        }
        segments.extend(run_words);
    }
    segments
}

/// Shapes `text`, a run per stretch of characters that the same font draws.
pub fn layout(fonts: &mut Fonts, chain: &mut Chain, text: &str, size: f32) -> Layout {
    let chosen = add_fallbacks(fonts, chain, text);
    let fonts = &*fonts;
    let charmaps: Vec<_> = chain
        .instances
        .iter()
        .map(|instance| fonts.get(instance.face).font().charmap())
        .collect();
    // Each piece's face, and whether it draws missing glyphs.
    let mut pieces: Vec<((usize, bool), &str)> = Vec::new();
    for segment in visual_segments(text) {
        let mut start = 0;
        let mut current = None;
        for (at, c) in segment.char_indices() {
            let keeps = current.is_some_and(|(index, _): (usize, bool)| {
                continues_cluster(c)
                    || common_cjk(c) && index >= chain.listed && charmaps[index].map(c).is_some()
            });
            let index = if keeps {
                current
            } else {
                // A character no font may draw draws as the first available font's missing glyph, as Edge does.
                Some(
                    charmaps[..chain.listed]
                        .iter()
                        .enumerate()
                        .position(|(index, charmap)| {
                            chain.allows(index, c) && charmap.map(c).is_some()
                        })
                        .or_else(|| chosen.get(&c).copied())
                        .map_or_else(
                            || {
                                // Only a face that maps the character outside its range needs it swapped out;
                                // otherwise shaping the character itself gives the missing glyph, or nothing for
                                // a default-ignorable one, as before.
                                let first = chain.primary_index().unwrap_or(0);
                                (
                                    first,
                                    !chain.allows(first, c) && charmaps[first].map(c).is_some(),
                                )
                            },
                            |index| (index, false),
                        ),
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
    for ((index, missing), piece) in pieces {
        let Some(instance) = chain.instances.get(index) else {
            continue;
        };
        let face = fonts.get(instance.face);
        let Ok(font) = harfrust::FontRef::from_index(&face.data, face.index) else {
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
        if missing {
            // No font maps U+10FFFF, so a character the face maps outside its range shapes as the missing glyph.
            // The rest, such as a variation selector, shape as themselves.
            let swapped: String = piece
                .chars()
                .map(|c| {
                    let excluded = !default_ignorable(c)
                        && !chain.allows(index, c)
                        && charmaps[index].map(c).is_some();
                    if excluded { '\u{10ffff}' } else { c }
                })
                .collect();
            buffer.push_str(&swapped);
        } else {
            buffer.push_str(piece);
        }
        // A right-to-left script shapes right to left, and its glyphs come out in visual order.
        buffer.guess_segment_properties();
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

#[cfg(test)]
mod tests {
    use super::*;

    const NUNITO: &[u8] = include_bytes!("../../../../examples/canvas2d/fonts/Nunito-wght.ttf");

    /// The face that draws "a" when the font list is a loaded Nunito face with `ranges`, then Courier New.
    fn face_for_a(ranges: Option<Ranges>) -> (FaceId, FaceId) {
        let mut fonts = Fonts::default();
        let nunito = fonts.load(NUNITO).unwrap();
        let spec = FontSpec {
            families: vec![
                Family::Face(LoadedFace {
                    id: nunito,
                    weight: [400.0, 400.0],
                    ranges,
                }),
                Family::System("courier new".into()),
            ],
            size: 32.0,
            weight: 400.0,
            italic: false,
        };
        let mut chain = chain(&mut fonts, &spec);
        let layout = layout(&mut fonts, &mut chain, "a", 32.0);
        (layout.runs[0].instance.face, nunito)
    }

    /// The chain for a loaded Nunito face limited to Cyrillic, then `rest`.
    fn cyrillic_nunito_then(rest: Vec<Family>) -> (Fonts, Chain, FaceId) {
        let mut fonts = Fonts::default();
        let nunito = fonts.load(NUNITO).unwrap();
        let mut families = vec![Family::Face(LoadedFace {
            id: nunito,
            weight: [400.0, 400.0],
            ranges: Some(vec![[0x400, 0x4ff]]),
        })];
        families.extend(rest);
        let spec = FontSpec {
            families,
            size: 32.0,
            weight: 400.0,
            italic: false,
        };
        let chain = chain(&mut fonts, &spec);
        (fonts, chain, nunito)
    }

    #[cfg(windows)]
    #[test]
    fn the_metrics_font_is_the_first_whose_range_holds_a_space() {
        let (_, chain, nunito) = cyrillic_nunito_then(vec![Family::System("courier new".into())]);
        assert_ne!(chain.primary().unwrap().face, nunito);
        assert_eq!(chain.primary().unwrap().face, chain.instances[1].face);
        // With no listed font for a space, the standard font steps in, as CSS's default font does.
        let (_, chain, nunito) = cyrillic_nunito_then(Vec::new());
        assert_ne!(chain.primary().unwrap().face, nunito);
    }

    #[cfg(windows)]
    #[test]
    fn a_face_alone_does_not_draw_a_character_outside_its_range() {
        let (mut fonts, mut chain, nunito) = cyrillic_nunito_then(Vec::new());
        let layout = layout(&mut fonts, &mut chain, "a", 32.0);
        assert!(!layout.runs.is_empty());
        assert!(layout.runs.iter().all(|run| run.instance.face != nunito));
    }

    #[cfg(windows)]
    #[test]
    fn a_mark_that_starts_a_segment_skips_a_face_whose_range_excludes_it() {
        let mut fonts = Fonts::default();
        let nunito = fonts.load(NUNITO).unwrap();
        let spec = FontSpec {
            families: vec![Family::Face(LoadedFace {
                id: nunito,
                weight: [400.0, 400.0],
                ranges: Some(vec![[0, 0xff]]),
            })],
            size: 32.0,
            weight: 400.0,
            italic: false,
        };
        let mut chain = chain(&mut fonts, &spec);
        // Nunito maps U+0301, but its range leaves it out, so the acute comes from a fallback face, as in Edge.
        let layout = layout(&mut fonts, &mut chain, "\u{301}", 32.0);
        assert!(!layout.runs.is_empty());
        assert!(layout.runs.iter().all(|run| run.instance.face != nunito));
    }

    #[cfg(windows)]
    #[test]
    fn a_character_no_allowed_face_has_draws_the_missing_glyph() {
        let mut fonts = Fonts::default();
        let nunito = fonts.load(NUNITO).unwrap();
        let spec = FontSpec {
            families: vec![Family::Face(LoadedFace {
                id: nunito,
                weight: [400.0, 400.0],
                ranges: Some(vec![[0, 0xff]]),
            })],
            size: 32.0,
            weight: 400.0,
            italic: false,
        };
        let mut chain = chain(&mut fonts, &spec);
        // Nunito maps the private-use U+F8FF and no Windows font does. Its range leaves it out, so Edge draws the
        // first available font's missing glyph.
        let layout = layout(&mut fonts, &mut chain, "\u{f8ff}", 32.0);
        assert_eq!(layout.runs.len(), 1);
        assert_eq!(layout.runs[0].instance.face, nunito);
        assert!(layout.runs[0].glyphs.iter().all(|&(glyph, ..)| glyph == 0));
        // A variation selector after it stays invisible, as it does after any glyph.
        let selected = super::layout(&mut fonts, &mut chain, "\u{f8ff}\u{fe0f}", 32.0);
        assert_eq!(selected.width, layout.width);
        let visible = |layout: &Layout| {
            layout
                .runs
                .iter()
                .map(|run| run.glyphs.iter().filter(|&&(glyph, ..)| glyph == 0).count())
                .sum::<usize>()
        };
        assert_eq!(visible(&selected), visible(&layout));
    }

    #[cfg(windows)]
    #[test]
    fn a_loaded_face_draws_only_the_characters_in_its_unicode_range() {
        let (face, nunito) = face_for_a(None);
        assert_eq!(face, nunito);
        let (face, nunito) = face_for_a(Some(vec![[0x400, 0x4ff]]));
        assert_ne!(face, nunito);
        let (face, nunito) = face_for_a(Some(vec![[0x20, 0x7e], [0x400, 0x4ff]]));
        assert_eq!(face, nunito);
    }
}
