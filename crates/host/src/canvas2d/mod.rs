//! Canvas 2D for `packages/three-native/src/platform/canvas2d.js`. A canvas's pixels live in the page's script as
//! premultiplied RGBA8, and each draw call passes them to an op here, which shapes text, rasterizes and composites
//! in place. The ops keep the fonts the page loaded and a renderer the canvases share.

#[cfg(windows)]
mod dwrite;
mod fonts;
mod paint;
mod text;

use deno_core::{OpState, op2};
use deno_error::JsErrorBox;
use paint::{Painter, StrokeStyle, Style, Surface};
use serde::{Deserialize, Serialize};
use text::FontSpec;
use vello_cpu::kurbo::Rect;

pub use fonts::Fonts;

#[derive(Default)]
pub struct Canvas2d {
    fonts: Fonts,
    painter: Painter,
}

fn surface(data: &mut [u8], width: u32, height: u32) -> Result<Surface<'_>, JsErrorBox> {
    let (Ok(w), Ok(h)) = (u16::try_from(width), u16::try_from(height)) else {
        return Err(JsErrorBox::range_error(format!(
            "a {width}x{height} canvas is larger than the host draws"
        )));
    };
    if data.len() != width as usize * height as usize * 4 {
        return Err(JsErrorBox::type_error(
            "canvas pixels do not match its size",
        ));
    }
    Ok(Surface {
        data,
        width: w,
        height: h,
    })
}

/// Loads a TrueType, OpenType, WOFF or WOFF2 font for `FontFace` and returns its face ID.
#[op2(fast)]
fn op_canvas2d_font_load(state: &mut OpState, #[buffer] bytes: &[u8]) -> Result<u32, JsErrorBox> {
    state
        .borrow_mut::<Canvas2d>()
        .fonts
        .load(bytes)
        .map_err(|error| JsErrorBox::generic(format!("{error:#}")))
}

#[derive(Deserialize)]
struct RectDraw {
    /// x, y, width, height.
    rect: [f64; 4],
    style: Style,
}

#[op2]
fn op_canvas2d_fill_rect(
    state: &mut OpState,
    #[buffer] pixels: &mut [u8],
    width: u32,
    height: u32,
    #[serde] draw: RectDraw,
) -> Result<(), JsErrorBox> {
    let mut surface = surface(pixels, width, height)?;
    let [x, y, w, h] = draw.rect;
    state.borrow_mut::<Canvas2d>().painter.fill_rect(
        &mut surface,
        &draw.style,
        Rect::new(x, y, x + w, y + h),
    );
    Ok(())
}

#[op2]
fn op_canvas2d_clear_rect(
    state: &mut OpState,
    #[buffer] pixels: &mut [u8],
    width: u32,
    height: u32,
    #[serde] draw: RectDraw,
) -> Result<(), JsErrorBox> {
    let mut surface = surface(pixels, width, height)?;
    let [x, y, w, h] = draw.rect;
    state.borrow_mut::<Canvas2d>().painter.clear_rect(
        &mut surface,
        draw.style.transform,
        Rect::new(x, y, x + w, y + h),
    );
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageDraw {
    width: u32,
    height: u32,
    premultiplied: bool,
    /// Whole pixels inside the image: x, y, width, height.
    source: [u32; 4],
    dest: [f64; 4],
    smoothing: bool,
    style: Style,
}

#[op2]
fn op_canvas2d_draw_image(
    state: &mut OpState,
    #[buffer] pixels: &mut [u8],
    width: u32,
    height: u32,
    #[buffer] image: &[u8],
    #[serde] draw: ImageDraw,
) -> Result<(), JsErrorBox> {
    let mut surface = surface(pixels, width, height)?;
    let [sx, sy, sw, sh] = draw.source;
    // The dimension limits come first, so the byte count cannot overflow.
    if draw.width > u16::MAX as u32
        || draw.height > u16::MAX as u32
        || image.len() != draw.width as usize * draw.height as usize * 4
        || sw == 0
        || sh == 0
        || sx.checked_add(sw).is_none_or(|end| end > draw.width)
        || sy.checked_add(sh).is_none_or(|end| end > draw.height)
    {
        return Err(JsErrorBox::type_error(
            "image pixels do not match the source rectangle",
        ));
    }
    let [dx, dy, dw, dh] = draw.dest;
    state.borrow_mut::<Canvas2d>().painter.draw_image(
        &mut surface,
        &draw.style,
        image,
        draw.width as u16,
        draw.premultiplied,
        (sx as u16, sy as u16, sw as u16, sh as u16),
        Rect::new(dx, dy, dx + dw, dy + dh),
        draw.smoothing,
    );
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextDraw {
    text: String,
    font: FontSpec,
    x: f64,
    y: f64,
    align: String,
    baseline: String,
    max_width: Option<f64>,
    style: Style,
    stroke: Option<StrokeStyle>,
}

#[op2]
fn op_canvas2d_text(
    state: &mut OpState,
    #[buffer] pixels: &mut [u8],
    width: u32,
    height: u32,
    #[serde] draw: TextDraw,
) -> Result<(), JsErrorBox> {
    let mut surface = surface(pixels, width, height)?;
    let Canvas2d { fonts, painter } = state.borrow_mut::<Canvas2d>();
    let mut chain = text::chain(fonts, &draw.font);
    let Some(primary) = chain.primary().cloned() else {
        return Ok(());
    };
    let size = text::used_size(draw.font.size);
    let layout = text::layout(fonts, &mut chain, &draw.text, size);
    let metrics = text::font_metrics(fonts, &primary, size);
    let x_scale = match draw.max_width {
        Some(max) if layout.width > max && layout.width > 0.0 => max.max(0.0) / layout.width,
        _ => 1.0,
    };
    let x = draw.x - align_offset(&draw.align, layout.width * x_scale);
    let y = draw.y + text::baseline_shift(&metrics, &draw.baseline);
    painter.draw_text(
        &mut surface,
        fonts,
        &layout,
        size,
        (x, y),
        x_scale,
        &draw.style,
        draw.stroke,
    );
    Ok(())
}

/// How far left of x the text starts, for a left-to-right `textAlign`.
fn align_offset(align: &str, width: f64) -> f64 {
    match align {
        "center" => width / 2.0,
        "right" | "end" => width,
        _ => 0.0,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Measure {
    text: String,
    font: FontSpec,
    align: String,
    baseline: String,
}

/// `TextMetrics`, relative to the text's `textAlign` point and `textBaseline`.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    width: f64,
    actual_bounding_box_left: f64,
    actual_bounding_box_right: f64,
    actual_bounding_box_ascent: f64,
    actual_bounding_box_descent: f64,
    font_bounding_box_ascent: f64,
    font_bounding_box_descent: f64,
    em_height_ascent: f64,
    em_height_descent: f64,
    hanging_baseline: f64,
    alphabetic_baseline: f64,
    ideographic_baseline: f64,
}

fn measure(fonts: &mut Fonts, measure: &Measure) -> Metrics {
    let mut chain = text::chain(fonts, &measure.font);
    let size = text::used_size(measure.font.size);
    let Some(primary) = chain.primary().cloned() else {
        return Metrics {
            width: 0.0,
            actual_bounding_box_left: 0.0,
            actual_bounding_box_right: 0.0,
            actual_bounding_box_ascent: 0.0,
            actual_bounding_box_descent: 0.0,
            font_bounding_box_ascent: 0.0,
            font_bounding_box_descent: 0.0,
            em_height_ascent: 0.0,
            em_height_descent: 0.0,
            hanging_baseline: 0.0,
            alphabetic_baseline: 0.0,
            ideographic_baseline: 0.0,
        };
    };
    let layout = text::layout(fonts, &mut chain, &measure.text, size);
    let font = text::font_metrics(fonts, &primary, size);
    let shift = text::baseline_shift(&font, &measure.baseline);
    let dx = align_offset(&measure.align, layout.width);
    let [left, top, right, bottom] = text::ink_bounds(fonts, &layout, size).unwrap_or([0.0; 4]);
    Metrics {
        width: layout.width,
        actual_bounding_box_left: dx - left,
        actual_bounding_box_right: right - dx,
        actual_bounding_box_ascent: -top - shift,
        actual_bounding_box_descent: bottom + shift,
        font_bounding_box_ascent: font.ascent - shift,
        font_bounding_box_descent: font.descent + shift,
        em_height_ascent: font.em_ascent - shift,
        em_height_descent: font.em_descent + shift,
        hanging_baseline: font.ascent * 0.8 - shift,
        alphabetic_baseline: -shift,
        ideographic_baseline: -font.descent - shift,
    }
}

#[op2]
#[serde]
fn op_canvas2d_measure(state: &mut OpState, #[serde] request: Measure) -> Metrics {
    measure(&mut state.borrow_mut::<Canvas2d>().fonts, &request)
}

/// Copies premultiplied pixels to straight alpha, for uploads and `getImageData`.
#[op2(fast)]
fn op_canvas2d_unpremultiply(#[buffer] from: &[u8], #[buffer] to: &mut [u8]) {
    for (source, target) in from
        .as_chunks::<4>()
        .0
        .iter()
        .zip(to.as_chunks_mut::<4>().0)
    {
        let a = source[3] as u32;
        if a == 0 {
            target.fill(0);
            continue;
        }
        for c in 0..3 {
            target[c] = ((source[c] as u32 * 255 + a / 2) / a).min(255) as u8;
        }
        target[3] = source[3];
    }
}

deno_core::extension!(
    canvas2d_ext,
    ops = [
        op_canvas2d_font_load,
        op_canvas2d_fill_rect,
        op_canvas2d_clear_rect,
        op_canvas2d_draw_image,
        op_canvas2d_text,
        op_canvas2d_measure,
        op_canvas2d_unpremultiply
    ],
    state = |state| state.put(Canvas2d::default())
);
pub use canvas2d_ext as extension;

#[cfg(test)]
mod boundary_tests {
    use deno_core::{JsRuntime, RuntimeOptions};

    #[test]
    fn overflowing_image_rectangle_returns_a_type_error() {
        let mut runtime = JsRuntime::new(RuntimeOptions {
            extensions: vec![super::extension::init()],
            ..Default::default()
        });
        runtime.execute_script("image", r#"
          const draw = {width: 1, height: 1, premultiplied: false, source: [4294967295, 0, 1, 1],
            dest: [0, 0, 1, 1], smoothing: false,
            style: {paint: {kind: 'color', rgba: [0, 0, 0, 1]}, alpha: 1, transform: [1, 0, 0, 1, 0, 0]}};
          let error;
          try { Deno.core.ops.op_canvas2d_draw_image(new Uint8Array(4), 1, 1, new Uint8Array(4), draw); }
          catch (e) { error = e; }
          if (!(error instanceof TypeError)) throw new Error('expected a TypeError');
        "#).unwrap();
    }

    #[test]
    fn huge_image_dimensions_return_a_type_error() {
        let mut runtime = JsRuntime::new(RuntimeOptions {
            extensions: vec![super::extension::init()],
            ..Default::default()
        });
        runtime.execute_script("image", r#"
          const draw = {width: 4294967295, height: 4294967295, premultiplied: false, source: [0, 0, 1, 1],
            dest: [0, 0, 1, 1], smoothing: false,
            style: {paint: {kind: 'color', rgba: [0, 0, 0, 1]}, alpha: 1, transform: [1, 0, 0, 1, 0, 0]}};
          let error;
          try { Deno.core.ops.op_canvas2d_draw_image(new Uint8Array(4), 1, 1, new Uint8Array(4), draw); }
          catch (e) { error = e; }
          if (!(error instanceof TypeError)) throw new Error('expected a TypeError');
        "#).unwrap();
    }

    /// Draws "I" in 32 px Arial at (10, 40) under scale(4, 4) on a 200x220 canvas, filled or stroked 10 wide with
    /// miter joins and a miter limit of 1, and returns the painted pixels' box: left, top, right, bottom.
    #[cfg(windows)]
    fn scaled_text_box(stroke: bool) -> [i64; 4] {
        let mut runtime = JsRuntime::new(RuntimeOptions {
            extensions: vec![super::extension::init()],
            ..Default::default()
        });
        let stroke = if stroke {
            "{width: 10, miterLimit: 1, join: 'miter'}"
        } else {
            "null"
        };
        let script = format!(
            r#"
          const pixels = new Uint8Array(200 * 220 * 4);
          Deno.core.ops.op_canvas2d_text(pixels, 200, 220, {{text: 'I', x: 10, y: 40, align: 'start',
            baseline: 'alphabetic', maxWidth: null, stroke: {stroke},
            font: {{families: [{{system: 'Arial'}}], size: 32, weight: 400, italic: false}},
            style: {{paint: {{kind: 'color', rgba: [0, 0, 0, 1]}}, alpha: 1, transform: [4, 0, 0, 4, 0, 0]}}}});
          const box = [200, 220, -1, -1];
          for (let i = 0; i < 200 * 220; i++) {{
            if (!pixels[i * 4 + 3]) continue;
            const x = i % 200, y = Math.floor(i / 200);
            box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y);
            box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
          }}
          JSON.stringify(box);
        "#
        );
        let value = runtime.execute_script("text", script).unwrap();
        deno_core::scope!(scope, runtime);
        let text = deno_core::v8::Local::new(scope, value).to_rust_string_lossy(scope);
        serde_json::from_str(&text).unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn a_stroke_under_a_scale_keeps_its_scaled_width() {
        let fill = scaled_text_box(false);
        let stroke = scaled_text_box(true);
        // The stroke reaches half its width, 5 px scaled by 4, past the outline on every side.
        let reach = [
            fill[0] - stroke[0],
            fill[1] - stroke[1],
            stroke[2] - fill[2],
            stroke[3] - fill[3],
        ];
        assert!(
            reach.iter().all(|&r| r >= 18),
            "fill {fill:?}, stroke {stroke:?}"
        );
    }

    /// Fills "Hi" in 32 px Arial at `x` on a 100x60 canvas and returns the canvas's summed alpha. With
    /// `refuse_directwrite`, DirectWrite fails to open every face.
    #[cfg(windows)]
    fn text_alpha(x: f64, refuse_directwrite: bool) -> u64 {
        let mut runtime = JsRuntime::new(RuntimeOptions {
            extensions: vec![super::extension::init()],
            ..Default::default()
        });
        if refuse_directwrite {
            let state = runtime.op_state();
            let mut state = state.borrow_mut();
            state
                .borrow_mut::<super::Canvas2d>()
                .painter
                .refuse_directwrite_faces();
        }
        let script = format!(
            r#"
          const pixels = new Uint8Array(100 * 60 * 4);
          Deno.core.ops.op_canvas2d_text(pixels, 100, 60, {{text: 'Hi', x: {x}, y: 40, align: 'start',
            baseline: 'alphabetic', maxWidth: null, stroke: null,
            font: {{families: [{{system: 'Arial'}}], size: 32, weight: 400, italic: false}},
            style: {{paint: {{kind: 'color', rgba: [0, 0, 0, 1]}}, alpha: 1, transform: [1, 0, 0, 1, 0, 0]}}}});
          let alpha = 0;
          for (let i = 3; i < pixels.length; i += 4) alpha += pixels[i];
          alpha;
        "#
        );
        let value = runtime.execute_script("text", script).unwrap();
        deno_core::scope!(scope, runtime);
        deno_core::v8::Local::new(scope, value)
            .integer_value(scope)
            .unwrap() as u64
    }

    #[cfg(windows)]
    #[test]
    fn text_far_off_the_canvas_draws_nothing() {
        assert!(text_alpha(10.0, false) > 0);
        assert_eq!(text_alpha(1e12, false), 0);
        assert_eq!(text_alpha(-1e12, false), 0);
    }

    #[test]
    fn a_fractional_source_rectangle_samples_inside_its_bounds() {
        let mut runtime = JsRuntime::new(RuntimeOptions {
            extensions: vec![super::extension::init()],
            ..Default::default()
        });
        // A red and a blue pixel. The source starts three quarters into the red one, so a 4 px wide copy of a
        // 1 px source takes red for its first pixel only.
        let value = runtime
            .execute_script(
                "image",
                r#"
          const pixels = new Uint8Array(4 * 4);
          const image = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]);
          Deno.core.ops.op_canvas2d_draw_image(pixels, 4, 1, image, {width: 2, height: 1, premultiplied: true,
            source: [0.75, 0, 1, 1], dest: [0, 0, 4, 1], smoothing: false,
            style: {paint: {kind: 'color', rgba: [0, 0, 0, 1]}, alpha: 1, transform: [1, 0, 0, 1, 0, 0]}});
          [0, 1, 2, 3].map(i => pixels[i * 4] ? 'r' : pixels[i * 4 + 2] ? 'b' : '-').join('');
        "#,
            )
            .unwrap();
        deno_core::scope!(scope, runtime);
        let colors = deno_core::v8::Local::new(scope, value).to_rust_string_lossy(scope);
        assert_eq!(colors, "rbbb");
    }

    #[cfg(windows)]
    #[test]
    fn text_draws_when_directwrite_cannot_open_its_face() {
        assert!(text_alpha(10.0, true) > 0);
    }
}
