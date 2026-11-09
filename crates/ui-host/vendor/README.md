# Patched Servo crates

ui-host builds two Servo 0.7.0 crates from this directory instead of crates.io. `[patch.crates-io]` in `crates/ui-host/Cargo.toml` selects them. Each copy is the published crate with the changes below. `servo-fonts` leaves out its `tests/` directory, which holds 14 MB of test fonts.

Check the copies against crates.io:

```sh
python tools/check-servo-vendor.py
```

The script reads each `.crate` from the Cargo cache or from static.crates.io, checks its SHA-256 against the crates.io checksum, and requires the difference to equal `servo-script.patch` and `servo-fonts.patch`. After you change a vendored file, run it with `--write` and review the patch files.

## servo-script: release script records

`maybe_associate_with_script` (classic scripts, including every `WebView::evaluate_javascript` call) and `ModuleTree::compile_module_script` pass `Rc::into_raw` to `SetScriptPrivate` and `SetModulePrivate`. SpiderMonkey's `setPrivate` also calls Servo's add-ref hook, which takes a second reference, and the release hook drops only that one when the script's source object is finalized. Each compiled script therefore leaks one `ModuleScript`, and each module script also keeps its `GlobalScope` alive through the record's `Trusted` owner.

The patch passes `Rc::as_ptr` so that the hook holds the only reference. With it, eval records are freed at each GC and module records are freed after navigation.

Upstream issue: not filed yet. The same code is on Servo main at ced24a6 (2026-11-09).

## servo-fonts: bound the shaped text cache

`Font::shape_text` caches every shaped string in a per-font map that is never trimmed. Text that changes on every rendering update, such as a frame counter, adds one entry each time.

The patch clears the map when it reaches 4,096 entries.

Upstream issue: not filed yet. The same code is on Servo main at ced24a6 (2026-11-09).
