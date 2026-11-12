//! Replays the canvas calls Edge recorded for folio's canvases through two rasterizer pipelines, saves each result,
//! and compares it with Edge's pixels.
//!
//! Both pipelines shape with harfrust, the Rust port of HarfBuzz that Chromium shapes with. Pipeline `tiny-skia`
//! draws skrifa's glyph outlines as tiny-skia paths and composites with tiny-skia. Pipeline `vello` draws glyphs
//! through vello_cpu's glyph runs, which glifo outlines, caches and hints, and composites with vello_cpu.
//!
//!   cargo run --release -- <spike dir> <fonts dir>

mod dw;

use anyhow::{Context, Result, bail};
use harfrust::{ShaperData, ShaperInstance, UnicodeBuffer, Variation};
use serde_json::Value;
use skrifa::{
    FontRef, GlyphId, MetadataProvider,
    instance::{LocationRef, Size},
    outline::{DrawSettings, HintingInstance, HintingOptions, OutlinePen, SmoothMode, Target},
};
use std::{collections::BTreeMap, path::Path, sync::Arc};

struct Font {
    data: Arc<Vec<u8>>,
    weight: Option<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Pipeline {
    TinySkia,
    Vello,
    /// DirectWrite glyph masks, composited by tiny-skia.
    DWrite,
}
#[derive(Clone, Copy, Debug)]
struct Variant {
    pipeline: Pipeline,
    /// Rounds the baseline to whole pixels and the pen to quarter pixels, as Skia does for horizontal text.
    snap: bool,
    hint: bool,
    gamma: Option<f32>,
    contrast: f32,
}

/// A run of positioned glyphs in canvas pixels.
struct Run {
    glyphs: Vec<(u32, f32, f32)>,
    width: f32,
}

fn shape(font: &Font, text: &str, size: f32) -> Result<(Run, Vec<skrifa::instance::NormalizedCoord>)> {
    let font_ref = harfrust::FontRef::new(&font.data).context("parse font for shaping")?;
    let data = ShaperData::new(&font_ref);
    let variations: Vec<Variation> = font
        .weight
        .map(|w| Variation { tag: harfrust::Tag::new(b"wght"), value: w })
        .into_iter()
        .collect();
    let instance = ShaperInstance::from_variations(&font_ref, &variations);
    let shaper = data.shaper(&font_ref).instance(Some(&instance)).build();
    let mut buffer = UnicodeBuffer::new();
    buffer.push_str(text);
    buffer.guess_segment_properties();
    let shaped = shaper.shape(buffer, harfrust::ShapeOptions::new());
    let scale = size / shaper.units_per_em() as f32;
    let mut pen = 0.0;
    let mut glyphs = Vec::new();
    for (info, position) in shaped.glyph_infos().iter().zip(shaped.glyph_positions()) {
        glyphs.push((
            info.glyph_id,
            pen + position.x_offset as f32 * scale,
            -position.y_offset as f32 * scale,
        ));
        pen += position.x_advance as f32 * scale;
    }
    let skrifa_font = FontRef::new(&font.data)?;
    let location = skrifa_font
        .axes()
        .location(font.weight.map(|w| ("wght", w)).into_iter().collect::<Vec<_>>());
    Ok((Run { glyphs, width: pen }, location.coords().to_vec()))
}

struct Paths(tiny_skia::PathBuilder);
impl OutlinePen for Paths {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.move_to(x, -y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.0.line_to(x, -y);
    }
    fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
        self.0.quad_to(cx0, -cy0, x, -y);
    }
    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        self.0.cubic_to(cx0, -cy0, cx1, -cy1, x, -y);
    }
    fn close(&mut self) {
        self.0.close();
    }
}

fn color(text: &str) -> Result<[u8; 4]> {
    let hex = text.strip_prefix('#').context("only #rrggbb colors")?;
    if hex.len() != 6 {
        bail!("color {text}");
    }
    let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16);
    Ok([byte(0)?, byte(2)?, byte(4)?, 255])
}

/// Parses Edge's serialization of `font`, such as `700 64px "Amatic SC"`.
fn parse_font(text: &str) -> Result<(f32, f32, String)> {
    let mut weight = 400.0;
    let mut size = None;
    let mut rest = text;
    for part in text.split(' ') {
        rest = &rest[part.len()..].trim_start();
        if let Some(px) = part.strip_suffix("px") {
            size = Some(px.parse()?);
            break;
        }
        if let Ok(w) = part.parse() {
            weight = w;
        }
    }
    Ok((weight, size.context("font size")?, rest.trim_matches('"').to_string()))
}

/// What a recorded draw uses from the state Edge saw.
struct Draw<'a> {
    op: &'a str,
    text: String,
    x: f32,
    y: f32,
    font: &'a Font,
    size: f32,
    paint: &'a Value,
    line_width: f32,
    /// Edge's offset from the requested y to the alphabetic baseline, so the pipelines draw where Edge did.
    baseline: f32,
    align: &'a str,
}

fn gradient_stops(paint: &Value) -> Result<Vec<(f32, [u8; 4])>> {
    paint["stops"]
        .as_array()
        .context("stops")?
        .iter()
        .map(|stop| Ok((stop[0].as_f64().context("offset")? as f32, color(stop[1].as_str().context("stop")?)?)))
        .collect()
}

trait Canvas {
    fn clear(&mut self, rect: [f32; 4]);
    fn fill_rect(&mut self, rect: [f32; 4], paint: &Value) -> Result<()>;
    fn text(&mut self, draw: &Draw, run: &Run, coords: &[skrifa::instance::NormalizedCoord], variant: Variant) -> Result<()>;
    /// Straight-alpha RGBA8.
    fn pixels(&mut self) -> Vec<u8>;
}

struct TinySkia(tiny_skia::Pixmap);
impl TinySkia {
    fn paint(paint: &Value) -> Result<tiny_skia::Paint<'static>> {
        let mut out = tiny_skia::Paint::default();
        out.anti_alias = true;
        if let Some(text) = paint.as_str() {
            let [r, g, b, a] = color(text)?;
            out.set_color_rgba8(r, g, b, a);
        } else {
            let line = &paint["linear"];
            let point = |i: usize| tiny_skia::Point::from_xy(line[i].as_f64().unwrap_or(0.0) as f32, line[i + 1].as_f64().unwrap_or(0.0) as f32);
            let stops = gradient_stops(paint)?
                .into_iter()
                .map(|(offset, [r, g, b, a])| tiny_skia::GradientStop::new(offset, tiny_skia::Color::from_rgba8(r, g, b, a)))
                .collect();
            out.shader = tiny_skia::LinearGradient::new(point(0), point(2), stops, tiny_skia::SpreadMode::Pad, tiny_skia::Transform::identity())
                .context("gradient")?;
        }
        Ok(out)
    }
}
impl Canvas for TinySkia {
    fn clear(&mut self, [x, y, w, h]: [f32; 4]) {
        let rect = tiny_skia::Rect::from_xywh(x, y, w, h).unwrap();
        let mut paint = tiny_skia::Paint::default();
        paint.blend_mode = tiny_skia::BlendMode::Clear;
        self.0.fill_rect(rect, &paint, tiny_skia::Transform::identity(), None);
    }
    fn fill_rect(&mut self, [x, y, w, h]: [f32; 4], paint: &Value) -> Result<()> {
        let rect = tiny_skia::Rect::from_xywh(x, y, w, h).context("rect")?;
        self.0.fill_rect(rect, &Self::paint(paint)?, tiny_skia::Transform::identity(), None);
        Ok(())
    }
    fn text(&mut self, draw: &Draw, run: &Run, coords: &[skrifa::instance::NormalizedCoord], variant: Variant) -> Result<()> {
        let font = FontRef::new(&draw.font.data)?;
        let outlines = font.outline_glyphs();
        let location = LocationRef::new(coords);
        let hinting = variant
            .hint
            .then(|| HintingInstance::new(&outlines, Size::new(draw.size), location, HintingOptions { engine: skrifa::outline::Engine::AutoFallback, target: Target::Smooth { mode: SmoothMode::Light, symmetric_rendering: true, preserve_linear_metrics: true } }))
            .transpose()?;
        let paint = Self::paint(draw.paint)?;
        let (origin_x, origin_y) = origin(draw, run, variant);
        let mut mask = tiny_skia::Mask::new(self.0.width(), self.0.height()).context("mask")?;
        if variant.pipeline == Pipeline::DWrite {
            let (w, h) = (self.0.width(), self.0.height());
            dw::coverage(mask.data_mut(), w, h, &draw.font.data, draw.font.weight, draw.size, run, origin_x, origin_y, variant)?;
            preblend(mask.data_mut(), draw.paint, variant);
            let rect = tiny_skia::Rect::from_xywh(0.0, 0.0, w as f32, h as f32).context("rect")?;
            self.0.fill_rect(rect, &paint, tiny_skia::Transform::identity(), Some(&mask));
            return Ok(());
        }
        for &(id, gx, gy) in &run.glyphs {
            let glyph = outlines.get(GlyphId::new(id)).context("glyph")?;
            let mut pen = Paths(tiny_skia::PathBuilder::new());
            let settings = match &hinting {
                Some(instance) => DrawSettings::hinted(instance, false),
                None => DrawSettings::unhinted(Size::new(draw.size), location),
            };
            glyph.draw(settings, &mut pen)?;
            let Some(path) = pen.0.finish() else { continue };
            let x = snap_x(origin_x + gx, variant);
            let transform = tiny_skia::Transform::from_translate(x, origin_y + gy);
            let path = if draw.op == "strokeText" {
                let stroke = tiny_skia::Stroke { width: draw.line_width, line_join: tiny_skia::LineJoin::Miter, miter_limit: 10.0, ..Default::default() };
                match path.stroke(&stroke, 1.0) { Some(p) => p, None => continue }
            } else {
                path
            };
            mask.fill_path(&path, tiny_skia::FillRule::Winding, true, transform);
        }
        preblend(mask.data_mut(), draw.paint, variant);
        let rect = tiny_skia::Rect::from_xywh(0.0, 0.0, self.0.width() as f32, self.0.height() as f32).context("rect")?;
        self.0.fill_rect(rect, &paint, tiny_skia::Transform::identity(), Some(&mask));
        Ok(())
    }
    fn pixels(&mut self) -> Vec<u8> {
        unpremultiply(self.0.data())
    }
}

/// Skia's mask gamma for an A8 glyph mask: SkTMaskGamma_build_correcting_lut for the paint's luminance,
/// quantized to 3 bits, with the gamma and contrast from SPIKE_GAMMA and SPIKE_CONTRAST.
fn preblend(coverage: &mut [u8], paint: &Value, variant: Variant) {
    let Some(gamma) = variant.gamma else { return };
    let contrast = variant.contrast;
    let [r, g, b, _] = paint.as_str().and_then(|c| color(c).ok()).unwrap_or([255, 255, 255, 255]);
    let luminance = (r as u32 * 54 + g as u32 * 183 + b as u32 * 19) >> 8;
    let level = luminance >> 5;
    let src_i = (level << 5) | (level << 2) | (level >> 1);
    let src = src_i as f32 / 255.0;
    let lin_src = src.powf(gamma);
    let dst = 1.0 - src;
    let lin_dst = dst.powf(gamma);
    let adjusted = contrast * lin_dst;
    let table: Vec<u8> = (0..256)
        .map(|i| {
            let raw = i as f32 / 255.0;
            let a = raw + (1.0 - raw) * adjusted * raw;
            if (src - dst).abs() < 1.0 / 256.0 {
                return (255.0 * a).round() as u8;
            }
            let lin = lin_src * a + (1.0 - a) * lin_dst;
            let out = lin.powf(1.0 / gamma);
            (255.0 * (out - dst) / (src - dst)).round().clamp(0.0, 255.0) as u8
        })
        .collect();
    for c in coverage {
        *c = table[*c as usize];
    }
}

fn origin(draw: &Draw, run: &Run, variant: Variant) -> (f32, f32) {
    let x = match draw.align {
        "center" => draw.x - run.width / 2.0,
        "right" | "end" => draw.x - run.width,
        _ => draw.x,
    };
    let y = draw.y + draw.baseline;
    let y = match std::env::var("SPIKE_Y").as_deref() {
        Ok("exact") => y,
        Ok("floor") => y.floor(),
        _ if variant.snap => y.round(),
        _ => y,
    };
    (x, y)
}

fn snap_x(x: f32, variant: Variant) -> f32 {
    match std::env::var("SPIKE_X").as_deref() {
        Ok("exact") => x,
        Ok("round") => x.round(),
        Ok("floor") => x.floor(),
        Ok("half") => (x * 2.0).round() / 2.0,
        Ok("quarter-floor") => (x * 4.0).floor() / 4.0,
        _ if variant.snap => (x * 4.0).round() / 4.0,
        _ => x,
    }
}

fn unpremultiply(data: &[u8]) -> Vec<u8> {
    let mut out = data.to_vec();
    for pixel in out.chunks_exact_mut(4) {
        let a = pixel[3] as u32;
        if a != 0 && a != 255 {
            for c in &mut pixel[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
    out
}

struct Vello {
    context: vello_cpu::RenderContext,
    resources: vello_cpu::Resources,
    width: u16,
    height: u16,
    pixmap: vello_cpu::Pixmap,
}
impl Vello {
    fn new(width: u16, height: u16) -> Self {
        Self {
            context: vello_cpu::RenderContext::new(width, height),
            resources: vello_cpu::Resources::new(),
            width,
            height,
            pixmap: vello_cpu::Pixmap::new(width, height),
        }
    }
    fn set_paint(&mut self, paint: &Value) -> Result<()> {
        use vello_cpu::color::{AlphaColor, Srgb};
        let rgba = |[r, g, b, a]: [u8; 4]| AlphaColor::<Srgb>::from_rgba8(r, g, b, a);
        if let Some(text) = paint.as_str() {
            self.context.set_paint(rgba(color(text)?));
        } else {
            let line = &paint["linear"];
            let point = |i: usize| (line[i].as_f64().unwrap_or(0.0), line[i + 1].as_f64().unwrap_or(0.0));
            let stops: Vec<(f32, AlphaColor<Srgb>)> = gradient_stops(paint)?.into_iter().map(|(o, c)| (o, rgba(c))).collect();
            self.context.set_paint(vello_cpu::peniko::Gradient::new_linear(point(0), point(2)).with_stops(stops.as_slice()));
        }
        Ok(())
    }
    /// Draws what the context holds over the pixels so far, so a clear can act on the result.
    fn flush(&mut self) {
        self.context.flush();
        let mut layer = vello_cpu::Pixmap::new(self.width, self.height);
        self.context.render(&mut layer, &mut self.resources);
        self.context.reset();
        for (dst, src) in self.pixmap.data_as_u8_slice_mut().chunks_exact_mut(4).zip(layer.data_as_u8_slice().chunks_exact(4)) {
            let inverse = 255 - src[3] as u32;
            for c in 0..4 {
                dst[c] = (src[c] as u32 + (dst[c] as u32 * inverse + 127) / 255) as u8;
            }
        }
    }
}
impl Canvas for Vello {
    fn clear(&mut self, [x, y, w, h]: [f32; 4]) {
        self.flush();
        let width = self.width as usize;
        let data = self.pixmap.data_as_u8_slice_mut();
        for row in (y.max(0.0) as usize)..((y + h) as usize).min(self.height as usize) {
            for column in (x.max(0.0) as usize)..((x + w) as usize).min(width) {
                data[(row * width + column) * 4..][..4].fill(0);
            }
        }
    }
    fn fill_rect(&mut self, [x, y, w, h]: [f32; 4], paint: &Value) -> Result<()> {
        self.set_paint(paint)?;
        self.context.fill_rect(&vello_cpu::kurbo::Rect::new(x as f64, y as f64, (x + w) as f64, (y + h) as f64));
        Ok(())
    }
    fn text(&mut self, draw: &Draw, run: &Run, coords: &[skrifa::instance::NormalizedCoord], variant: Variant) -> Result<()> {
        self.set_paint(draw.paint)?;
        let (x, y) = origin(draw, run, variant);
        let glyphs: Vec<vello_cpu::Glyph> = run
            .glyphs
            .iter()
            .map(|&(id, gx, gy)| {
                vello_cpu::Glyph { id, x: snap_x(x + gx, variant), y: y + gy }
            })
            .collect();
        let coords: Vec<i16> = coords.iter().map(|c| c.to_bits()).collect();
        let font = vello_cpu::peniko::FontData::new(vello_cpu::peniko::Blob::new(draw.font.data.clone()), 0);
        let mut layer = vello_cpu::RenderContext::new(self.width, self.height);
        layer.set_paint(vello_cpu::color::AlphaColor::<vello_cpu::color::Srgb>::from_rgba8(255, 255, 255, 255));
        if draw.op == "strokeText" {
            layer.set_stroke(vello_cpu::kurbo::Stroke::new(draw.line_width as f64).with_join(vello_cpu::kurbo::Join::Miter).with_miter_limit(10.0));
            layer.glyph_run(&mut self.resources, &font).font_size(draw.size).hint(variant.hint).normalized_coords(&coords).stroke_glyphs(glyphs.into_iter());
        } else {
            layer.glyph_run(&mut self.resources, &font).font_size(draw.size).hint(variant.hint).normalized_coords(&coords).fill_glyphs(glyphs.into_iter());
        }
        layer.flush();
        let mut coverage = vello_cpu::Pixmap::new(self.width, self.height);
        layer.render(&mut coverage, &mut self.resources);
        let mut alpha: Vec<u8> = coverage.data_as_u8_slice().chunks_exact(4).map(|p| p[3]).collect();
        preblend(&mut alpha, draw.paint, variant);
        let mut mask_pixels = vello_cpu::Pixmap::new(self.width, self.height);
        for (pixel, a) in mask_pixels.data_as_u8_slice_mut().chunks_exact_mut(4).zip(alpha) {
            pixel.fill(a);
        }
        self.context.set_mask(vello_cpu::Mask::new_alpha(&mask_pixels));
        self.context.fill_rect(&vello_cpu::kurbo::Rect::new(0.0, 0.0, self.width as f64, self.height as f64));
        self.context.reset_mask();
        Ok(())
    }
    fn pixels(&mut self) -> Vec<u8> {
        self.flush();
        unpremultiply(self.pixmap.data_as_u8_slice())
    }
}

fn read_png(path: &Path) -> Result<(u32, u32, Vec<u8>)> {
    let decoder = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path)?));
    let mut reader = decoder.read_info()?;
    let mut data = vec![0; reader.output_buffer_size().context("png size")?];
    let info = reader.next_frame(&mut data)?;
    if info.color_type != png::ColorType::Rgba {
        bail!("{} is {:?}", path.display(), info.color_type);
    }
    data.truncate(info.buffer_size());
    Ok((info.width, info.height, data))
}

fn write_png(path: &Path, width: u32, height: u32, data: &[u8]) -> Result<()> {
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(std::fs::File::create(path)?), width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header()?.write_image_data(data)?;
    Ok(())
}

/// The mean absolute difference over the RGBA channels as a fraction of full scale, the share of pixels where a
/// channel differs by more than 2 of 255, and the signed mean of the color channels where Edge's pixel has coverage.
fn compare(edge: &[u8], ours: &[u8]) -> (f64, f64, f64) {
    let mut sum = 0u64;
    let mut differing = 0usize;
    let mut signed = 0i64;
    for (a, b) in edge.chunks_exact(4).zip(ours.chunks_exact(4)) {
        let mut most = 0;
        for c in 0..4 {
            let d = (a[c] as i32 - b[c] as i32).abs();
            sum += d as u64;
            most = most.max(d);
        }
        signed += b[0] as i64 + b[1] as i64 + b[2] as i64 - a[0] as i64 - a[1] as i64 - a[2] as i64;
        if most > 2 {
            differing += 1;
        }
    }
    let pixels = (edge.len() / 4) as f64;
    (sum as f64 / (pixels * 4.0 * 255.0), differing as f64 / pixels, signed as f64 / (pixels * 3.0 * 255.0))
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let dir = std::path::PathBuf::from(args.next().context("spike dir")?);
    let fonts_dir = std::path::PathBuf::from(args.next().context("fonts dir")?);
    let fonts: BTreeMap<&str, Font> = [
        ("Amatic SC", Font { data: Arc::new(std::fs::read(fonts_dir.join("AmaticSC-Bold.ttf"))?), weight: None }),
        ("Nunito", Font { data: Arc::new(std::fs::read(fonts_dir.join("Nunito-wght.ttf"))?), weight: Some(700.0) }),
    ]
    .into();
    let recorded: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("cases.json"))?)?;
    let gamma = std::env::var("SPIKE_GAMMA").ok().map(|g| g.parse()).transpose()?;
    let contrast = std::env::var("SPIKE_CONTRAST").ok().map(|c| c.parse()).transpose()?.unwrap_or(0.0);
    if let Ok(only) = std::env::var("SPIKE_ONLY") {
        let pipeline = match only.as_str() { "dwrite" => Pipeline::DWrite, "vello" => Pipeline::Vello, _ => Pipeline::TinySkia };
        return run_variants(&dir, &fonts, &recorded, &[Variant { pipeline, snap: true, hint: pipeline == Pipeline::Vello, gamma, contrast }]);
    }
    let variants = [
        Variant { pipeline: Pipeline::TinySkia, snap: true, hint: false, gamma, contrast },
        Variant { pipeline: Pipeline::TinySkia, snap: true, hint: true, gamma, contrast },
        Variant { pipeline: Pipeline::Vello, snap: true, hint: false, gamma, contrast },
        Variant { pipeline: Pipeline::Vello, snap: true, hint: true, gamma, contrast },
    ];
    run_variants(&dir, &fonts, &recorded, &variants)
}

fn run_variants(dir: &Path, fonts: &BTreeMap<&str, Font>, recorded: &Value, variants: &[Variant]) -> Result<()> {
    let mut widths = Vec::new();
    println!("variant\tcase\tmean\tdiffering\tsigned");
    for &variant in variants {
        let dw = std::env::var("SPIKE_DW").unwrap_or_default();
        let name = format!("{:?}{}{}{}{}", variant.pipeline, if variant.pipeline == Pipeline::DWrite { format!("-{dw}") } else { String::new() }, if variant.snap { "-snap" } else { "" }, if variant.hint { "-hint" } else { "" }, variant.gamma.map_or(String::new(), |g| format!("-g{g}-c{}", variant.contrast))).to_lowercase();
        std::fs::create_dir_all(dir.join(&name))?;
        let (mut total, mut total_differing, mut text_pixels) = (0.0, 0.0, 0.0);
        for case in recorded["cases"].as_array().context("cases")? {
            let case_name = case["name"].as_str().context("name")?;
            let (width, height) = (case["width"].as_u64().context("width")? as u32, case["height"].as_u64().context("height")? as u32);
            let mut canvas: Box<dyn Canvas> = match variant.pipeline {
                Pipeline::TinySkia | Pipeline::DWrite => Box::new(TinySkia(tiny_skia::Pixmap::new(width, height).context("pixmap")?)),
                Pipeline::Vello => Box::new(Vello::new(width as u16, height as u16)),
            };
            for op in case["ops"].as_array().context("ops")? {
                let kind = op["op"].as_str().context("op")?;
                let args: Vec<f32> = op["args"].as_array().map(|a| a.iter().filter_map(Value::as_f64).map(|v| v as f32).collect()).unwrap_or_default();
                match kind {
                    "fillRect" => canvas.fill_rect([args[0], args[1], args[2], args[3]], &op["state"]["fillStyle"])?,
                    "clearRect" => canvas.clear([args[0], args[1], args[2], args[3]]),
                    "fillText" | "strokeText" | "measureText" => {
                        let state = &op["state"];
                        let font_text = if kind == "measureText" { op["font"].as_str() } else { state["font"].as_str() }.context("font")?;
                        let (_, size, family) = parse_font(font_text)?;
                        let Some(font) = fonts.get(family.as_str()) else {
                            if kind == "measureText" {
                                continue;
                            }
                            bail!("font {family}");
                        };
                        let text = if kind == "measureText" { op["text"].as_str().context("text")?.to_string() } else { match &op["args"][0] { Value::String(s) => s.clone(), other => other.to_string() } };
                        let (run, coords) = shape(font, &text, size)?;
                        let metrics = &op["metrics"];
                        if variant.pipeline == Pipeline::TinySkia && !variant.hint {
                            widths.push(format!("{case_name}\t{text}\t{font_text}\tedge {}\tours {}", metrics["width"], run.width));
                        }
                        if kind == "measureText" {
                            continue;
                        }
                        let paint = if kind == "fillText" { &state["fillStyle"] } else { &state["strokeStyle"] };
                        let draw = Draw {
                            op: kind,
                            text,
                            x: op["args"][1].as_f64().context("x")? as f32,
                            y: op["args"][2].as_f64().context("y")? as f32,
                            font,
                            size,
                            paint,
                            line_width: state["lineWidth"].as_f64().unwrap_or(1.0) as f32,
                            baseline: metrics["alphabeticBaseline"].as_f64().map_or(0.0, |b| -b as f32),
                            align: state["textAlign"].as_str().unwrap_or("start"),
                        };
                        let _ = &draw.text;
                        canvas.text(&draw, &run, &coords, variant)?;
                    }
                    _ => {}
                }
            }
            let ours = canvas.pixels();
            write_png(&dir.join(&name).join(format!("{case_name}.png")), width, height, &ours)?;
            let (edge_width, edge_height, edge) = read_png(&dir.join("edge").join(format!("{case_name}.png")))?;
            if (edge_width, edge_height) != (width, height) {
                bail!("{case_name}: Edge is {edge_width}x{edge_height}");
            }
            let (mean, differing, signed) = compare(&edge, &ours);
            println!("{name}\t{case_name}\t{mean:.6}\t{differing:.6}\t{signed:+.6}");
            if !case_name.starts_with("gradient") {
                let pixels = (width * height) as f64;
                total += mean * pixels;
                total_differing += differing * pixels;
                text_pixels += pixels;
            }
        }
        println!("{name}\tALL TEXT\t{:.6}\t{:.6}", total / text_pixels, total_differing / text_pixels);
    }
    for line in widths {
        println!("width\t{line}");
    }
    Ok(())
}
