//! Drawing onto a canvas's pixels: premultiplied RGBA8, top row first, which the page's script owns. vello_cpu
//! rasterizes rectangles, gradients, images and glyphs. Fills and images composite onto the pixels with vello's
//! source-over. Text renders its coverage into a scratch layer first, so the compositor here can correct it with
//! Skia's glyph mask gamma before it blends, as Edge's glyphs are.

use super::fonts::Fonts;
use super::text::{Layout, Run};
use serde::Deserialize;
use skrifa::{
    GlyphId, MetadataProvider,
    instance::{LocationRef, NormalizedCoord, Size},
};
use std::sync::Arc;
use vello_cpu::{
    Pixmap, PixmapMut, RenderContext, RenderMode, Resources,
    color::{AlphaColor, Srgb},
    kurbo::{Affine, Join, Rect, Stroke},
    peniko::{self, Extend, Gradient, ImageQuality, ImageSampler},
};

#[derive(Deserialize, Clone, Debug)]
pub struct Stop {
    pub offset: f32,
    /// Straight-alpha RGBA, 0 to 1.
    pub rgba: [f32; 4],
}

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Paint {
    Color {
        rgba: [f32; 4],
    },
    Linear {
        from: [f64; 2],
        to: [f64; 2],
        stops: Vec<Stop>,
    },
    Radial {
        from: [f64; 3],
        to: [f64; 3],
        stops: Vec<Stop>,
    },
}

/// The drawing state a fill uses.
#[derive(Deserialize, Clone, Debug)]
pub struct Style {
    pub paint: Paint,
    pub alpha: f32,
    /// The canvas transform as `[a, b, c, d, e, f]`.
    pub transform: [f64; 6],
}

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StrokeStyle {
    pub width: f64,
    pub miter_limit: f64,
    pub join: LineJoin,
}

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub enum LineJoin {
    Miter,
    Round,
    Bevel,
}

pub struct Surface<'a> {
    pub data: &'a mut [u8],
    pub width: u16,
    pub height: u16,
}

/// A run's covered box on the surface and its coverage, which the caller blends in.
type Coverage = ((u16, u16, u16, u16), Vec<u8>);

/// Skia's glyph mask gamma for Edge on Windows, Windows' display gamma, fitted to Edge's canvas text
/// (`spikes/canvas2d`).
const MASK_GAMMA: f32 = 2.2;
const MASK_CONTRAST: f32 = 1.0;

/// The renderer the canvases share, reused between draws.
pub struct Painter {
    context: RenderContext,
    resources: Resources,
    /// The coverage table for each paint luminance, Skia's 8 levels.
    tables: [[u8; 256]; 8],
    #[cfg(windows)]
    glyphs: super::dwrite::Rasterizer,
}

impl Default for Painter {
    fn default() -> Self {
        Self {
            context: RenderContext::new(1, 1),
            resources: Resources::new(),
            tables: std::array::from_fn(|level| mask_gamma_table(level as u32)),
            #[cfg(windows)]
            glyphs: super::dwrite::Rasterizer::default(),
        }
    }
}

/// SkTMaskGamma_build_correcting_lut for one of the 3-bit luminance levels Skia quantizes a paint's color to.
fn mask_gamma_table(level: u32) -> [u8; 256] {
    let src_i = (level << 5) | (level << 2) | (level >> 1);
    let src = src_i as f32 / 255.0;
    let lin_src = src.powf(MASK_GAMMA);
    let dst = 1.0 - src;
    let lin_dst = dst.powf(MASK_GAMMA);
    let contrast = MASK_CONTRAST * lin_dst;
    std::array::from_fn(|i| {
        let raw = i as f32 / 255.0;
        let a = raw + (1.0 - raw) * contrast * raw;
        if (src - dst).abs() < 1.0 / 256.0 {
            return (255.0 * a).round() as u8;
        }
        let out = (lin_src * a + (1.0 - a) * lin_dst).powf(1.0 / MASK_GAMMA);
        (255.0 * (out - dst) / (src - dst))
            .round()
            .clamp(0.0, 255.0) as u8
    })
}

/// The luminance Skia gives a paint for its glyph masks: a color's own, and mid gray for a gradient.
fn luminance_level(paint: &Paint) -> usize {
    let [r, g, b] = match paint {
        Paint::Color { rgba } => [rgba[0], rgba[1], rgba[2]].map(|c| (c * 255.0).round() as u32),
        _ => [0x7f, 0x80, 0x7f],
    };
    (((r * 54 + g * 183 + b * 19) >> 8) >> 5) as usize
}

fn color([r, g, b, a]: [f32; 4]) -> AlphaColor<Srgb> {
    AlphaColor::new([r, g, b, a])
}

fn gradient(kind: Gradient, stops: &[Stop]) -> Gradient {
    let stops: Vec<(f32, AlphaColor<Srgb>)> = stops
        .iter()
        .map(|stop| (stop.offset, color(stop.rgba)))
        .collect();
    let mut gradient = kind.with_stops(stops.as_slice());
    gradient.extend = Extend::Pad;
    gradient.interpolation_alpha_space = peniko::InterpolationAlphaSpace::Unpremultiplied;
    gradient
}

fn affine(transform: [f64; 6]) -> Affine {
    Affine::new(transform)
}

/// Whether the transform only moves, so pixel snapping and the fast paths apply.
fn translation(transform: [f64; 6]) -> Option<(f64, f64)> {
    (transform[0] == 1.0 && transform[1] == 0.0 && transform[2] == 0.0 && transform[3] == 1.0)
        .then_some((transform[4], transform[5]))
}

/// The pixel box a user-space rectangle covers under a transform, clipped to the surface: x, y, width, height.
fn device_box(
    transform: [f64; 6],
    rect: Rect,
    width: u16,
    height: u16,
) -> Option<(u16, u16, u16, u16)> {
    let bounds = affine(transform).transform_rect_bbox(rect);
    let x0 = bounds.x0.floor().max(0.0);
    let y0 = bounds.y0.floor().max(0.0);
    let x1 = bounds.x1.ceil().min(width as f64);
    let y1 = bounds.y1.ceil().min(height as f64);
    (x1 > x0 && y1 > y0 && x1.is_finite() && y1.is_finite()).then_some((
        x0 as u16,
        y0 as u16,
        (x1 - x0) as u16,
        (y1 - y0) as u16,
    ))
}

/// Sets every pixel of the surface's box to `pixel`.
fn fill_area(surface: &mut Surface, (x, y, w, h): (u16, u16, u16, u16), pixel: [u8; 4]) {
    for row in y as usize..(y + h) as usize {
        let start = (row * surface.width as usize + x as usize) * 4;
        for target in surface.data[start..start + w as usize * 4]
            .as_chunks_mut::<4>()
            .0
        {
            *target = pixel;
        }
    }
}

/// Blends premultiplied `source` pixels, `alpha` times, over the surface's box at (x, y).
fn blend(
    surface: &mut Surface,
    (x, y, w, h): (u16, u16, u16, u16),
    source: impl Fn(usize) -> [u8; 4],
    alpha: f32,
) {
    let alpha = (alpha.clamp(0.0, 1.0) * 255.0).round() as u32;
    for row in 0..h as usize {
        let start = ((y as usize + row) * surface.width as usize + x as usize) * 4;
        for column in 0..w as usize {
            let s = source(row * w as usize + column);
            if s[3] == 0 {
                continue;
            }
            let d = &mut surface.data[start + column * 4..][..4];
            let sa = div255(s[3] as u32 * alpha);
            let keep = 255 - sa;
            for c in 0..4 {
                d[c] = (div255(s[c] as u32 * alpha) + div255(d[c] as u32 * keep)).min(255) as u8;
            }
        }
    }
}

fn div255(v: u32) -> u32 {
    (v + 128 + ((v + 128) >> 8)) >> 8
}

impl Painter {
    fn begin(&mut self, width: u16, height: u16) {
        self.context.reset_and_resize(width, height);
    }

    fn set_paint(&mut self, paint: &Paint) {
        match paint {
            Paint::Color { rgba } => self.context.set_paint(color(*rgba)),
            Paint::Linear { from, to, stops } => self.context.set_paint(gradient(
                Gradient::new_linear((from[0], from[1]), (to[0], to[1])),
                stops,
            )),
            Paint::Radial { from, to, stops } => self.context.set_paint(gradient(
                Gradient::new_two_point_radial(
                    (from[0], from[1]),
                    from[2] as f32,
                    (to[0], to[1]),
                    to[2] as f32,
                ),
                stops,
            )),
        }
    }

    /// Renders what the context holds over the surface.
    fn finish(&mut self, surface: &mut Surface) {
        self.context.flush();
        let target = PixmapMut::new(surface.width, surface.height, surface.data)
            .expect("the surface holds width * height pixels");
        let settings = vello_cpu::RasterizerSettings {
            render_mode: RenderMode::OptimizeSpeed,
            composite_mode: vello_cpu::CompositeMode::SrcOver,
            ..Default::default()
        };
        self.context
            .render_with(target, &mut self.resources, settings);
    }

    /// Renders what the context holds, alone, into a new layer of the given size.
    fn layer(&mut self, width: u16, height: u16) -> Pixmap {
        self.context.flush();
        let mut layer = Pixmap::new(width, height);
        self.context.render(&mut layer, &mut self.resources);
        layer
    }

    pub fn fill_rect(&mut self, surface: &mut Surface, style: &Style, rect: Rect) {
        let rect = Rect::from_points((rect.x0, rect.y0), (rect.x1, rect.y1));
        if let (Paint::Color { rgba }, Some((tx, ty))) =
            (&style.paint, translation(style.transform))
        {
            let moved = rect + vello_cpu::kurbo::Vec2::new(tx, ty);
            if [moved.x0, moved.y0, moved.x1, moved.y1]
                .iter()
                .all(|v| v.fract() == 0.0)
            {
                let Some(area) = device_box(style.transform, rect, surface.width, surface.height)
                else {
                    return;
                };
                let a = rgba[3].clamp(0.0, 1.0);
                let premultiplied =
                    [rgba[0] * a, rgba[1] * a, rgba[2] * a, a].map(|c| (c * 255.0).round() as u8);
                if premultiplied[3] == 255 && style.alpha >= 1.0 {
                    fill_area(surface, area, premultiplied);
                } else {
                    blend(surface, area, |_| premultiplied, style.alpha);
                }
                return;
            }
        }
        self.begin(surface.width, surface.height);
        self.context.set_transform(affine(style.transform));
        self.set_paint(&style.paint);
        if style.alpha < 1.0 {
            self.context.push_opacity_layer(style.alpha);
        }
        self.context.fill_rect(&rect);
        if style.alpha < 1.0 {
            self.context.pop_layer();
        }
        self.finish(surface);
    }

    pub fn clear_rect(&mut self, surface: &mut Surface, transform: [f64; 6], rect: Rect) {
        let rect = Rect::from_points((rect.x0, rect.y0), (rect.x1, rect.y1));
        let Some((x, y, w, h)) = device_box(transform, rect, surface.width, surface.height) else {
            return;
        };
        if let Some((tx, ty)) = translation(transform)
            && [rect.x0 + tx, rect.y0 + ty, rect.x1 + tx, rect.y1 + ty]
                .iter()
                .all(|v| v.fract() == 0.0)
        {
            fill_area(surface, (x, y, w, h), [0; 4]);
            return;
        }
        self.begin(w, h);
        self.context
            .set_transform(Affine::translate((-(x as f64), -(y as f64))) * affine(transform));
        self.context.set_paint(color([1.0; 4]));
        self.context.fill_rect(&rect);
        let coverage = self.layer(w, h);
        let coverage = coverage.data_as_u8_slice();
        for row in 0..h as usize {
            let start = ((y as usize + row) * surface.width as usize + x as usize) * 4;
            for column in 0..w as usize {
                let keep = 255 - coverage[(row * w as usize + column) * 4 + 3] as u32;
                for value in &mut surface.data[start + column * 4..][..4] {
                    *value = div255(*value as u32 * keep) as u8;
                }
            }
        }
    }

    /// Draws the `source` rectangle of an image into the `dest` rectangle. `pixels` are RGBA8, premultiplied when
    /// `premultiplied` says so, and the source rectangle is in whole pixels inside the image.
    #[allow(clippy::too_many_arguments)]
    pub fn draw_image(
        &mut self,
        surface: &mut Surface,
        style: &Style,
        pixels: &[u8],
        width: u16,
        premultiplied: bool,
        source: (u16, u16, u16, u16),
        dest: Rect,
        smoothing: bool,
    ) {
        let (sx, sy, sw, sh) = source;
        let mut data = Vec::with_capacity(sw as usize * sh as usize);
        for row in sy as usize..(sy + sh) as usize {
            for &[r, g, b, a] in pixels[(row * width as usize + sx as usize) * 4..]
                [..sw as usize * 4]
                .as_chunks::<4>()
                .0
            {
                data.push(if premultiplied {
                    vello_cpu::color::PremulRgba8 { r, g, b, a }
                } else {
                    let m = |c: u8| div255(c as u32 * a as u32) as u8;
                    vello_cpu::color::PremulRgba8 {
                        r: m(r),
                        g: m(g),
                        b: m(b),
                        a,
                    }
                });
            }
        }
        let image = vello_cpu::Image {
            image: vello_cpu::ImageSource::Pixmap(Arc::new(Pixmap::from_parts(data, sw, sh))),
            sampler: ImageSampler {
                x_extend: Extend::Pad,
                y_extend: Extend::Pad,
                quality: if smoothing {
                    ImageQuality::Medium
                } else {
                    ImageQuality::Low
                },
                alpha: 1.0,
            },
        };
        self.begin(surface.width, surface.height);
        self.context.set_transform(affine(style.transform));
        self.context.set_paint(image);
        self.context.set_paint_transform(
            Affine::translate((dest.x0, dest.y0))
                * Affine::scale_non_uniform(dest.width() / sw as f64, dest.height() / sh as f64),
        );
        // vello_cpu 0.2 does not apply a sampler's alpha to images, so global alpha goes through a layer.
        if style.alpha < 1.0 {
            self.context.push_opacity_layer(style.alpha);
        }
        self.context.fill_rect(&dest);
        if style.alpha < 1.0 {
            self.context.pop_layer();
        }
        self.finish(surface);
    }

    /// Draws laid-out text with its pen start at (x, y) on the alphabetic baseline, filled or stroked, and
    /// squeezed horizontally by `x_scale` to fit a maximum width.
    #[allow(clippy::too_many_arguments)]
    pub fn draw_text(
        &mut self,
        surface: &mut Surface,
        fonts: &Fonts,
        layout: &Layout,
        size: f32,
        (x, y): (f64, f64),
        x_scale: f64,
        style: &Style,
        stroke: Option<StrokeStyle>,
    ) {
        let level = luminance_level(&style.paint);
        for run in &layout.runs {
            self.draw_run(
                surface,
                fonts,
                run,
                size,
                (x, y),
                x_scale,
                style,
                stroke,
                level,
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_run(
        &mut self,
        surface: &mut Surface,
        fonts: &Fonts,
        run: &Run,
        size: f32,
        (x, y): (f64, f64),
        x_scale: f64,
        style: &Style,
        stroke: Option<StrokeStyle>,
        level: usize,
    ) {
        let face = fonts.get(run.instance.face);
        // Under a transform that only moves and scales, Skia positions glyphs at quarter pixels on a whole-pixel
        // baseline, and hints them only when unscaled.
        let [a, b, c, d, e, f] = style.transform;
        let snapped = (b == 0.0 && c == 0.0 && a > 0.0 && d > 0.0).then_some((a * x_scale, d));
        let place = |gx: f64, gy: f64| match snapped {
            Some(_) => (
                ((e + a * (x + gx * x_scale)) * 4.0).round() / 4.0,
                (f + d * y).round() + d * gy,
            ),
            None => (x + gx * x_scale, y + gy),
        };
        let (glyph_x_scale, glyph_y_scale) = snapped.unwrap_or((x_scale, 1.0));
        let upright = snapped == Some((1.0, 1.0));
        let matrix = match snapped {
            Some((sx, sy)) => (!upright).then_some([sx as f32, 0.0, 0.0, sy as f32]),
            None => Some([
                (a * x_scale) as f32,
                (b * x_scale) as f32,
                c as f32,
                d as f32,
            ]),
        };
        let glyphs: Vec<vello_cpu::Glyph> = run
            .glyphs
            .iter()
            .map(|&(id, gx, gy)| {
                let (px, py) = place(gx, gy);
                vello_cpu::Glyph {
                    id,
                    x: px as f32,
                    y: py as f32,
                }
            })
            .collect();
        let Some(first) = glyphs.first() else { return };
        let last = glyphs.last().expect("a run with a first glyph has a last");
        // The layer covers the glyphs' outlines, two pixels more for hinting and anti-aliasing, and the stroke,
        // which the glyph transform scales with the outlines. A color glyph can paint past its outline, so it gets a
        // margin of the font size.
        let coords: Vec<_> = run
            .instance
            .coords
            .iter()
            .map(|bits| NormalizedCoord::from_bits(*bits))
            .collect();
        let metrics = face
            .font()
            .glyph_metrics(Size::new(size), LocationRef::new(&coords));
        let mut ink = Rect::new(first.x as f64, first.y as f64, last.x as f64, last.y as f64);
        for (glyph, &(id, ..)) in glyphs.iter().zip(&run.glyphs) {
            if let Some(b) = metrics.bounds(GlyphId::new(id)) {
                ink = ink.union(Rect::new(
                    glyph.x as f64 + b.x_min as f64 * glyph_x_scale,
                    glyph.y as f64 - b.y_max as f64 * glyph_y_scale,
                    glyph.x as f64 + b.x_max as f64 * glyph_x_scale,
                    glyph.y as f64 - b.y_min as f64 * glyph_y_scale,
                ));
            }
        }
        let stroke_reach = stroke.map_or(0.0, |s| s.width * s.miter_limit.max(1.0) / 2.0)
            * glyph_x_scale.max(glyph_y_scale);
        let margin = 2.0 + stroke_reach + if face.color { size as f64 } else { 0.0 };
        let ink = ink.inflate(margin, margin);
        let user_to_device = if snapped.is_some() {
            [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
        } else {
            style.transform
        };
        #[cfg(windows)]
        if !face.color && stroke.is_none() && self.glyphs.available() {
            let placed: Vec<(f64, f64)> = glyphs.iter().map(|g| (g.x as f64, g.y as f64)).collect();
            if let Some((area, coverage)) = self.dwrite_coverage(
                surface,
                fonts,
                run,
                size,
                style,
                &placed,
                snapped.is_some(),
                matrix,
            ) {
                self.blend_coverage(surface, area, &coverage, style, level);
            }
            return;
        }
        let Some((bx, by, bw, bh)) = device_box(user_to_device, ink, surface.width, surface.height)
        else {
            return;
        };
        let to_layer = Affine::translate((-(bx as f64), -(by as f64))) * affine(user_to_device);

        self.begin(bw, bh);
        self.context.set_transform(to_layer);
        let glyph_paint = match (&style.paint, face.color) {
            (Paint::Color { rgba }, true) => color(*rgba),
            _ => color([1.0; 4]),
        };
        self.context.set_paint(glyph_paint);
        let font = peniko::FontData::new(peniko::Blob::new(face.data.clone()), face.index);
        let glyph_transform = (glyph_x_scale != 1.0 || glyph_y_scale != 1.0)
            .then(|| Affine::scale_non_uniform(glyph_x_scale, glyph_y_scale));
        if let Some(s) = stroke {
            let join = match s.join {
                LineJoin::Miter => Join::Miter,
                LineJoin::Round => Join::Round,
                LineJoin::Bevel => Join::Bevel,
            };
            self.context.set_stroke(
                Stroke::new(s.width)
                    .with_join(join)
                    .with_miter_limit(s.miter_limit),
            );
        }
        let mut builder = self
            .context
            .glyph_run(&mut self.resources, &font)
            .font_size(size)
            .hint(upright)
            .normalized_coords(&run.instance.coords);
        if let Some(transform) = glyph_transform {
            builder = builder.glyph_transform(transform);
        }
        if stroke.is_some() {
            builder.stroke_glyphs(glyphs.into_iter());
        } else {
            builder.fill_glyphs(glyphs.into_iter());
        }
        let glyph_layer = self.layer(bw, bh);
        let glyph_pixels = glyph_layer.data_as_u8_slice();
        let area = (bx, by, bw, bh);

        if face.color {
            blend(
                surface,
                area,
                |i| glyph_pixels[i * 4..][..4].try_into().expect("4 bytes"),
                style.alpha,
            );
            return;
        }
        let coverage: Vec<u8> = glyph_pixels
            .as_chunks::<4>()
            .0
            .iter()
            .map(|p| p[3])
            .collect();
        self.blend_coverage(surface, area, &coverage, style, level);
    }

    /// Blends the paint over the surface's box through glyph `coverage`, corrected by Skia's mask gamma.
    fn blend_coverage(
        &mut self,
        surface: &mut Surface,
        area: (u16, u16, u16, u16),
        coverage: &[u8],
        style: &Style,
        level: usize,
    ) {
        let (bx, by, bw, bh) = area;
        let table = self.tables[level];
        match &style.paint {
            Paint::Color { rgba } => {
                let a = rgba[3].clamp(0.0, 1.0);
                let paint = [rgba[0] * a, rgba[1] * a, rgba[2] * a, a].map(|c| c * 255.0);
                blend(
                    surface,
                    area,
                    |i| {
                        let coverage = table[coverage[i] as usize] as f32 / 255.0;
                        paint.map(|c| (c * coverage).round() as u8)
                    },
                    style.alpha,
                );
            }
            paint => {
                self.begin(bw, bh);
                self.context
                    .set_transform(Affine::translate((-(bx as f64), -(by as f64))));
                self.context.set_paint_transform(affine(style.transform));
                self.set_paint(paint);
                self.context.fill_rect(&Rect::new(
                    bx as f64,
                    by as f64,
                    (bx + bw) as f64,
                    (by + bh) as f64,
                ));
                let paint_layer = self.layer(bw, bh);
                let paint_pixels = paint_layer.data_as_u8_slice();
                blend(
                    surface,
                    area,
                    |i| {
                        let coverage = table[coverage[i] as usize] as u32;
                        let p = &paint_pixels[i * 4..][..4];
                        [0, 1, 2, 3].map(|c| div255(p[c] as u32 * coverage) as u8)
                    },
                    style.alpha,
                );
            }
        }
    }

    /// Glyph coverage from DirectWrite for a run's fill, in the box its glyph masks cover on the surface. `placed`
    /// holds device positions when `snapped`, else user positions under the style's transform, and `matrix` scales,
    /// rotates or skews each glyph.
    #[cfg(windows)]
    #[allow(clippy::too_many_arguments)]
    fn dwrite_coverage(
        &mut self,
        surface: &Surface,
        fonts: &Fonts,
        run: &Run,
        size: f32,
        style: &Style,
        placed: &[(f64, f64)],
        snapped: bool,
        matrix: Option<[f32; 4]>,
    ) -> Option<Coverage> {
        let face = fonts.get(run.instance.face);
        let [a, b, c, d, e, f] = style.transform;
        let device = |(x, y): (f64, f64)| {
            if snapped {
                (x, y)
            } else {
                (a * x + c * y + e, b * x + d * y + f)
            }
        };
        let instance = &run.instance;
        let mut pieces = Vec::with_capacity(run.glyphs.len());
        for (&(id, ..), &point) in run.glyphs.iter().zip(placed) {
            let (dx, dy) = device(point);
            // A surface is at most u16 wide, so a glyph this far off it cannot reach it, and its mask offsets would
            // overflow i32.
            if dx.abs() > 1e9 || dy.abs() > 1e9 {
                continue;
            }
            let (ix, iy) = (dx.floor(), dy.floor());
            let offset = ((dx - ix) as f32, (dy - iy) as f32);
            let glyph = id as u16;
            if let Some(mask) = self.glyphs.glyph(
                instance.face,
                face,
                instance.weight,
                instance.synthetic_bold,
                size,
                glyph,
                offset,
                matrix,
            ) {
                pieces.push((
                    glyph,
                    offset,
                    ix as i32 + mask.left,
                    iy as i32 + mask.top,
                    mask.width as i32,
                    mask.height as i32,
                ));
            }
        }
        let x0 = pieces.iter().map(|p| p.2).min()?.max(0);
        let y0 = pieces.iter().map(|p| p.3).min()?.max(0);
        let x1 = pieces
            .iter()
            .map(|p| p.2 + p.4)
            .max()?
            .min(surface.width as i32);
        let y1 = pieces
            .iter()
            .map(|p| p.3 + p.5)
            .max()?
            .min(surface.height as i32);
        if x1 <= x0 || y1 <= y0 {
            return None;
        }
        let (bw, bh) = ((x1 - x0) as usize, (y1 - y0) as usize);
        let mut coverage = vec![0u8; bw * bh];
        for &(glyph, offset, left, top, width, height) in &pieces {
            let Some(mask) = self.glyphs.glyph(
                instance.face,
                face,
                instance.weight,
                instance.synthetic_bold,
                size,
                glyph,
                offset,
                matrix,
            ) else {
                continue;
            };
            for row in 0..height {
                let y = top + row - y0;
                if y < 0 || y >= bh as i32 {
                    continue;
                }
                for column in 0..width {
                    let x = left + column - x0;
                    if x < 0 || x >= bw as i32 {
                        continue;
                    }
                    let a = mask.alpha[(row * width + column) as usize] as u32;
                    let target = &mut coverage[y as usize * bw + x as usize];
                    *target = (*target as u32 + a - div255(*target as u32 * a)) as u8;
                }
            }
        }
        Some(((x0 as u16, y0 as u16, bw as u16, bh as u16), coverage))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn surface(data: &mut [u8], width: u16, height: u16) -> Surface<'_> {
        Surface {
            data,
            width,
            height,
        }
    }
    const IDENTITY: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

    #[test]
    fn the_mask_gamma_keeps_its_ends_and_lifts_white_text_edges() {
        let painter = Painter::default();
        for table in &painter.tables {
            assert_eq!((table[0], table[255]), (0, 255));
            assert!(table.windows(2).all(|pair| pair[0] <= pair[1]), "{table:?}");
        }
        // White on black: Edge shows a quarter-covered pixel at about 140 of 255 (spikes/canvas2d).
        assert!(
            (135..=150).contains(&painter.tables[7][64]),
            "{}",
            painter.tables[7][64]
        );
    }

    #[test]
    fn a_rectangle_blends_over_the_pixels_with_global_alpha() {
        let mut painter = Painter::default();
        let mut pixels = vec![0u8; 4 * 4 * 4];
        let red = Style {
            paint: Paint::Color {
                rgba: [1.0, 0.0, 0.0, 1.0],
            },
            alpha: 1.0,
            transform: IDENTITY,
        };
        painter.fill_rect(
            &mut surface(&mut pixels, 4, 4),
            &red,
            Rect::new(0.0, 0.0, 4.0, 4.0),
        );
        let blue = Style {
            paint: Paint::Color {
                rgba: [0.0, 0.0, 1.0, 1.0],
            },
            alpha: 0.5,
            transform: IDENTITY,
        };
        painter.fill_rect(
            &mut surface(&mut pixels, 4, 4),
            &blue,
            Rect::new(1.0, 1.0, 2.0, 2.0),
        );
        assert_eq!(&pixels[0..4], &[255, 0, 0, 255]);
        assert_eq!(&pixels[(4 + 1) * 4..][..4], &[127, 0, 128, 255]);
        assert_eq!(&pixels[(3 * 4 + 3) * 4..][..4], &[255, 0, 0, 255]);
    }

    #[test]
    fn a_fractional_rectangle_covers_its_edge_pixels_in_part() {
        let mut painter = Painter::default();
        let mut pixels = vec![0u8; 4 * 4];
        let white = Style {
            paint: Paint::Color { rgba: [1.0; 4] },
            alpha: 1.0,
            transform: IDENTITY,
        };
        painter.fill_rect(
            &mut surface(&mut pixels, 4, 1),
            &white,
            Rect::new(0.5, 0.0, 2.5, 1.0),
        );
        let alphas: Vec<u8> = pixels.as_chunks::<4>().0.iter().map(|p| p[3]).collect();
        assert_eq!(alphas[1], 255);
        assert!(
            (120..=135).contains(&alphas[0]) && (120..=135).contains(&alphas[2]),
            "{alphas:?}"
        );
        assert_eq!(alphas[3], 0);
    }

    #[test]
    fn clearing_a_rectangle_leaves_transparent_pixels_under_a_transform() {
        let mut painter = Painter::default();
        let mut pixels = vec![255u8; 8 * 8 * 4];
        painter.clear_rect(
            &mut surface(&mut pixels, 8, 8),
            [2.0, 0.0, 0.0, 2.0, 2.0, 2.0],
            Rect::new(0.0, 0.0, 2.0, 2.0),
        );
        assert_eq!(&pixels[(2 * 8 + 2) * 4..][..4], &[0, 0, 0, 0]);
        assert_eq!(&pixels[(5 * 8 + 5) * 4..][..4], &[0, 0, 0, 0]);
        assert_eq!(&pixels[(6 * 8 + 6) * 4..][..4], &[255, 255, 255, 255]);
    }

    #[test]
    fn an_image_draws_at_half_global_alpha() {
        let mut painter = Painter::default();
        let mut pixels = vec![0u8; 4 * 4 * 4];
        let red = [255u8, 0, 0, 255].repeat(4);
        let style = Style {
            paint: Paint::Color {
                rgba: [0.0, 0.0, 0.0, 1.0],
            },
            alpha: 0.5,
            transform: IDENTITY,
        };
        painter.draw_image(
            &mut surface(&mut pixels, 4, 4),
            &style,
            &red,
            2,
            false,
            (0, 0, 2, 2),
            Rect::new(0.0, 0.0, 4.0, 4.0),
            true,
        );
        let pixel = &pixels[(4 + 1) * 4..][..4];
        assert!(
            (126..=129).contains(&pixel[0]) && pixel[1] == 0 && (126..=129).contains(&pixel[3]),
            "{pixel:?}"
        );
    }

    #[test]
    fn a_linear_gradient_runs_between_its_stops() {
        let mut painter = Painter::default();
        let mut pixels = vec![0u8; 16 * 4];
        let stops = vec![
            Stop {
                offset: 0.0,
                rgba: [0.0, 0.0, 0.0, 1.0],
            },
            Stop {
                offset: 1.0,
                rgba: [1.0, 1.0, 1.0, 1.0],
            },
        ];
        let style = Style {
            paint: Paint::Linear {
                from: [0.0, 0.0],
                to: [0.0, 16.0],
                stops,
            },
            alpha: 1.0,
            transform: IDENTITY,
        };
        painter.fill_rect(
            &mut surface(&mut pixels, 1, 16),
            &style,
            Rect::new(0.0, 0.0, 1.0, 16.0),
        );
        let reds: Vec<u8> = pixels.as_chunks::<4>().0.iter().map(|p| p[0]).collect();
        assert!(reds.windows(2).all(|pair| pair[0] < pair[1]), "{reds:?}");
        assert!(reds[0] < 16 && reds[15] > 239, "{reds:?}");
    }
}
