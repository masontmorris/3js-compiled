use threejsc_host::platform::images::{Colors, decode};

/// `fixtures/alpha.rgba` holds the bytes Edge's WebGPU `copyExternalImageToTexture` gives for `fixtures/alpha.png`
/// with `premultipliedAlpha: false`, from `tools/platform/image-reference.mjs`. Its alpha column includes 0 and 1,
/// where a decoder that premultiplies loses the color.
#[test]
fn a_png_with_alpha_decodes_to_edges_bytes() {
    let png = include_bytes!("fixtures/alpha.png");
    let reference = include_bytes!("fixtures/alpha.rgba");
    let pixels = decode(png, Colors::Keep).expect("the fixture decodes");
    assert_eq!((pixels.width, pixels.height), (7, 5));
    assert_eq!(pixels.data.len(), reference.len());
    let differing: Vec<usize> = (0..reference.len())
        .filter(|&i| pixels.data[i] != reference[i])
        .collect();
    assert!(
        differing.is_empty(),
        "bytes {differing:?} differ from Edge's"
    );
}

#[test]
fn other_formats_and_broken_files_fail_to_decode() {
    assert!(decode(b"GIF89a\x01\x00\x01\x00", Colors::Convert).is_err());
    assert!(decode(b"\x89PNG\r\n\x1a\n broken", Colors::Convert).is_err());
    assert!(decode(b"", Colors::Convert).is_err());
}

/// `fixtures/color/reference.json` holds what Edge gives at the center of each 16x16 block of each fixture from
/// `tools/platform/color_fixtures.py`, read back by `tools/platform/color-reference.mjs`: from an image element and
/// from `createImageBitmap` with `colorSpaceConversion` `default`, which convert to sRGB, and with `none`, which keeps
/// the stored bytes.
#[test]
fn embedded_color_profiles_convert_as_edge_converts_them() {
    let reference: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/color/reference.json")).expect("the reference parses");
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/color");
    let mut worst = Vec::new();
    for (name, paths) in reference["samples"].as_object().expect("samples") {
        let bytes = std::fs::read(dir.join(name)).expect("the fixture exists");
        for (path, colors) in [("image", Colors::Convert), ("bitmapDefault", Colors::Convert), ("bitmapNone", Colors::Keep)] {
            let pixels = decode(&bytes, colors).expect("the fixture decodes");
            for (block, expected) in paths[path].as_array().expect("samples").iter().enumerate() {
                let (x, y) = ((block % 4) * 16 + 8, (block / 4) * 16 + 8);
                let at = (y * 64 + x) * 4;
                let difference = (0..4)
                    .map(|c| (i64::from(pixels.data[at + c]) - expected[c].as_i64().expect("a byte")).abs())
                    .max()
                    .unwrap_or(0);
                if difference > 1 {
                    worst.push(format!("{name} {path} block {block}: {:?} against Edge's {expected}", &pixels.data[at..at + 4]));
                }
            }
        }
    }
    assert!(worst.is_empty(), "{}", worst.join("\n"));
}
