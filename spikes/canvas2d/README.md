# Canvas 2D rasterizer

Which canvas 2D pipeline draws folio's text closest to Edge? The spike replays the calls Edge made for folio's canvases through two whole pipelines and compares each result with Edge's pixels.

## Candidates

Both shape with harfrust 0.12.0, the Rust port of HarfBuzz, which Chromium shapes with. They differ in how they turn glyphs into pixels.

- **tiny-skia.** skrifa 0.44.0 outlines each glyph, optionally hinted by skrifa's autohinter, and tiny-skia 0.11.4 fills the outlines and composites. tiny-skia is a Rust port of a subset of Skia, Chromium's 2D library, so its fills and blending follow Skia's.
- **vello.** vello_cpu 0.2.0 draws glyph runs through glifo 0.3.0, which outlines, hints and caches glyphs with the same skrifa, and composites. Servo's canvas uses vello_cpu, and its rasterizer computes exact area coverage, as Skia's analytic anti-aliasing does.

Each candidate runs with and without hinting, and with glyph pens placed exactly or as Skia places horizontal text, at quarter pixels on a whole-pixel baseline. A third pass puts each pipeline's glyph coverage through Skia's glyph mask gamma (`SkTMaskGamma_build_correcting_lut`) before it blends.

## Cases

`examples/canvas2d/src/folio-canvases.js` copies the drawing code of folio's ten canvas textures and four more of its text canvases. `edge.html` runs them in headless Edge 157, records each call with the drawing state it saw, and saves the canvas. `src/main.rs` replays the calls and compares the RGBA of every pixel: the mean difference as a fraction of full scale, the share of pixels where a channel differs by more than 2 of 255, and the signed mean, where negative means darker than Edge.

```
node spikes/canvas2d/edge.mjs <dir> [--no-gpu]
cargo run --release --manifest-path spikes/canvas2d/Cargo.toml -- <dir> examples/canvas2d/fonts
SPIKE_GAMMA=2.3 SPIKE_CONTRAST=1 cargo run --release --manifest-path spikes/canvas2d/Cargo.toml -- <dir> examples/canvas2d/fonts
```

`SPIKE_X` (`exact`, `round`, `floor`, `half`, `quarter-floor`) and `SPIKE_Y` (`exact`, `floor`) override the pen placement.

## Results

Over the twelve text canvases, against Edge, with Skia's pen placement. Edge with the GPU flags the lanes use drew them to the same bytes as with `--no-gpu`, except `altar.png`, where 9 pixels differ by 1, so the table holds for both:

| Pipeline | Hinted | Mask gamma | Mean difference | Pixels over 2/255 |
|---|---|---|---|---|
| tiny-skia | no | no | 0.92% | 5.50% |
| tiny-skia | yes | no | 0.83% | 5.31% |
| vello | no | no | 0.88% | 5.54% |
| vello | yes | no | 0.80% | 5.35% |
| tiny-skia | yes | 2.3, contrast 1 | 0.51% | 4.88% |
| vello | yes | 2.3, contrast 1 | **0.44%** | 5.05% |

- The signed mean was negative on every text canvas, nearly equal to the mean: Edge's glyph edges are brighter. A white-on-black pixel that is a quarter covered shows at about 140 of 255 in Edge. Fitting Skia's mask gamma table to the white text gave gamma 2.3, where contrast has no effect. Contrast 1 then fit the green altar text best.
- Quarter-pixel pens on a whole-pixel baseline beat every other placement for both pipelines.
- Widths from harfrust match Edge's to 0.0002 px for Amatic SC. Nunito at its fractional sizes missed by up to 0.03 px. The host closes that gap as Blink does, by shaping at 16.16 fixed point and truncating the font size to 1/100 px.
- The two gradient canvases differ by under 0.2% in either pipeline, with no pixel over 2/255.

Vello with glifo is the closer pipeline, so E6 keeps it, with the mask gamma. tiny-skia ports Skia's older supersampling rasterizer, while Skia now uses analytic coverage, as vello_cpu does.
