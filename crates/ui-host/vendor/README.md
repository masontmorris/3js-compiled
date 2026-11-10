# Patched Servo crates

ui-host builds three Servo 0.7.0 crates from this directory instead of crates.io. `[patch.crates-io]` in `crates/ui-host/Cargo.toml` selects them. Each copy is the published crate with the changes below. `servo-fonts` leaves out its `tests/` directory, which holds 14 MB of test fonts.

Check the copies against crates.io:

```sh
python tools/check-servo-vendor.py
```

The script reads each `.crate` from the Cargo cache or from static.crates.io, checks its SHA-256 against the crates.io checksum, and requires the difference to equal `servo-script.patch`, `servo-fonts.patch` and `servo-layout.patch`. After you change a vendored file, run it with `--write` and review the patch files.

## servo-script: release script records

`maybe_associate_with_script` (classic scripts, including every `WebView::evaluate_javascript` call) and `ModuleTree::create_a_javascript_module_script` pass `Rc::into_raw` to `SetScriptPrivate` and `SetModulePrivate`. SpiderMonkey's `setPrivate` also calls Servo's add-ref hook, which takes a second reference, and the release hook drops only that one when the script's source object is finalized. Each compiled script therefore leaks one `ModuleScript`. A module script's record also holds a `Trusted<GlobalScope>`, so a leaked one keeps a reference to its global.

The patch passes `Rc::as_ptr` so that the hook holds the only reference. With it, eval records are freed at each GC and module records are freed after navigation.

Upstream issue: not filed yet. Servo main at ced24a6 (2026-11-09) still passes `Rc::into_raw` at both sites. There the record type is `BaseScript`, which has no owner, so a leaked record keeps no global alive.

## servo-script: fire a click where browsers fire it

`maybe_trigger_click_for_mouse_button_down_event` fires `click` on the element under the up, and only when the up is within 10 px of the last mouse button down, measured as points in the viewport. Chrome and Firefox fire a mouse `click` on the nearest common ancestor of the elements under the down and the up, with no distance rule. In Servo a press that starts and ends on one element gets no click when a resize between the down and the up moves the element more than 10 px, and a press that ends on another element clicks that element.

The patch records the element under the last mouse button down in place of its point. On a primary up it fires `click`, and `dblclick` where Servo fires one, on the nearest element that is an inclusive ancestor of both elements in the flat tree. It fires none when the two have no common ancestor, for example after the down's element was removed from the document.

Upstream issue: not filed. Servo's policy forbids AI-written issues.

## servo-fonts: bound the shaped text cache

`Font::shape_text` caches every shaped string in a per-font map that is never trimmed. Text that changes on every rendering update, such as a frame counter, adds one entry each time.

The patch clears the map when it reaches 4,096 entries.

Upstream issue: not filed yet. On Servo main at ced24a6 (2026-11-09) the map is still never trimmed. Its key also has `language_override`.

## servo-layout: keep one layout entry per pseudo-element

`create_pseudo_layout_data` appends an entry to an element's `pseudo_boxes` each time the box tree builds a box for one of the element's pseudo-elements. The list is cleared only when the element's own boxes are unset. When the inline content around the element is rebuilt, for example because a sibling's text changed, each `::before` or `::after` gains another entry, and every old entry keeps its boxes alive. Servo's user-agent sheet gives every `<br>` a `::before`, so a HUD line with a `<br>` and a changing counter grew by about 2 MB a minute.

The patch replaces the existing entry for the same pseudo-element. Lookups through `pseudo_layout_data`, which return the first match, then also see the current box instead of the oldest.

Upstream issue: not filed yet. The same code is on Servo main at ced24a6 (2026-11-09).
