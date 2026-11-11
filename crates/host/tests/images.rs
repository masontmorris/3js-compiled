use threejsc_host::platform::images::decode;

/// `fixtures/alpha.rgba` holds the bytes Edge's WebGPU `copyExternalImageToTexture` gives for `fixtures/alpha.png`
/// with `premultipliedAlpha: false`, from `tools/platform/image-reference.mjs`. Its alpha column includes 0 and 1,
/// where a decoder that premultiplies loses the color.
#[test]
fn a_png_with_alpha_decodes_to_edges_bytes() {
    let png = include_bytes!("fixtures/alpha.png");
    let reference = include_bytes!("fixtures/alpha.rgba");
    let pixels = decode(png).expect("the fixture decodes");
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
    assert!(decode(b"GIF89a\x01\x00\x01\x00").is_err());
    assert!(decode(b"\x89PNG\r\n\x1a\n broken").is_err());
    assert!(decode(b"").is_err());
}
