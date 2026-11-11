# Platform shims

The host runs browser game code on shims that behave as headless Edge does for what a three.js game reaches. The shims are ES modules in `packages/three-native/src/platform`. The host builds them into its binary and evaluates `threejsc:/platform/index.js` before the entry module. The Rust side, in `crates/host/src/platform`, turns SDL input into input facts, reads files and decodes images on the blocking thread pool, and persists `localStorage`.

## DOM

`dom.js` is an inert element tree. Nothing lays out or paints.

- `document` has `documentElement`, `head`, `body`, `activeElement`, `hasFocus()`, `createElement`, `createElementNS`, `createTextNode`, `getElementById`, `querySelector` and `querySelectorAll`. `readyState` is `complete` and `visibilityState` is `visible`.
- Elements keep attributes, `id`, `className`, `classList`, inline `style`, `dataset`, children, `textContent`, `focus()`, `blur()`, `tabIndex`, and pointer capture.
- Selectors cover type, universal, id, class and attribute selectors, `:not()`, `:is()`, `:where()`, a few structural pseudo-classes, and the descendant, child and sibling combinators, in comma-separated lists.
- A canvas, the body and the root element fill the window in `getBoundingClientRect()`, `clientWidth` and `clientHeight`. Every other element has an empty box.
- A canvas has `width` and `height` with Edge's defaults of 300 and 150. `getContext()` returns `null` and logs that it is not implemented.
- Setting `innerHTML` stores the string and leaves the element with no children, and logs once that markup is not parsed.
- A method Edge's DOM defines on an element or the document that the stand-in lacks logs `DOM method not implemented: <Interface>.<method>` once and returns `undefined`. `tools/platform/dom-methods.mjs` lists those methods from Edge into `dom-methods.js`. Any other missing property reads as `undefined`, as in Edge.

## Events

`events.js` has `Event`, `CustomEvent`, `ErrorEvent`, `UIEvent`, `FocusEvent`, `KeyboardEvent`, `MouseEvent`, `PointerEvent` and `WheelEvent`, and `EventTarget` with capture, target and bubble phases, `once`, `passive`, `signal`, `stopImmediatePropagation()` and event handler attributes such as `onclick`. The window is an `EventTarget`.

The input router turns each host input fact into the events Edge fires for it:

- A key goes to the focused element as `keydown` or `keyup`, with Edge's `key`, `code`, `keyCode`, `location`, `repeat` and modifiers. A `keydown` that a listener does not cancel and that types a character, or Enter, without Ctrl or Meta, adds `keypress`.
- A pointer move fires the boundary events when the pointer reaches a new element, then `pointermove` and `mousemove`.
- A button press fires `pointerdown`, or `pointermove` when another button is already down, then `mousedown`, which moves focus to the nearest focusable ancestor or the body. A release fires `pointerup` or `pointermove`, then `mouseup`, then `click` for the primary button or `auxclick` for others, and `contextmenu` for the secondary button. Canceling `pointerdown` suppresses the mouse events until the last button is released.
- `setPointerCapture()` retargets pointer events to the element, with `gotpointercapture` and `lostpointercapture`. The last button's release ends capture.
- A wheel fires `wheel` with pixel deltas and Edge's legacy `wheelDelta` values.
- Window focus fires `blur` or `focus` at the focused element and the window.

## Gamepads

`navigator.getGamepads()` returns eight slots, as Edge 157 does. Each pad is a `Gamepad` snapshot in the standard mapping, with 17 buttons and 4 axes, which the host sends only when a pad changes. The analog triggers are buttons 6 and 7, pressed above 30 of 255 as in Edge. As in Edge, a page sees no pad until a button is pressed or a stick moves past half way, and `gamepadconnected` and `gamepaddisconnected` fire at the window. XInput pads read as `Xbox 360 Controller (XInput STANDARD GAMEPAD)`, and other pads as `<name> (STANDARD GAMEPAD Vendor: <vid> Product: <pid>)`. `vibrationActuator.playEffect()` logs that rumble is not implemented and resolves.

## Storage

`localStorage` keeps its entries in JavaScript for reads and sends each change to a writer thread, which rewrites one JSON file per game at most every 100 ms, with a rename so a crash keeps the old file or the new one. The host writes the last changes when it exits. The quota is Edge's, 5,242,880 UTF-16 code units over keys and values, past which `setItem` throws `QuotaExceededError`. `sessionStorage` lives in memory.

## Images and loading

- `fetch` reads `file:` URLs from disk, answers a missing file with status 404 as a development server does, and serves `blob:` and `data:` URLs. Network URLs reject with a `TypeError`, as a failed request does in Edge.
- `location` is the entry module's `file:` URL with the `--hash` fragment. Setting `location.hash` fires `hashchange`. Navigation is not implemented.
- `URL` parses and resolves URLs as WHATWG URL does for the file, blob, data and HTTP schemes, and `URL.createObjectURL()` makes blob URLs.
- `Blob`, `File`, `Headers`, `Request` and `Response` cover what three's `FileLoader` and `ImageBitmapLoader` use. Bodies are not streams.
- The image element and `new Image()` load their `src` and fire `load` or `error`. `createImageBitmap()` takes a `Blob`, a loaded image, an `ImageBitmap` or `ImageData`, with a crop rectangle, `imageOrientation: 'flipY'` and `premultiplyAlpha: 'premultiply'`.
- The host decodes PNG, JPEG and WebP to straight-alpha RGBA8 off the main thread. Like Edge with `colorSpaceConversion: 'none'`, it applies no embedded color profile or gamma.
- `GPUQueue.copyExternalImageToTexture()` writes a decoded image or bitmap into an RGBA8 or BGRA8 texture, with `flipY`, `premultipliedAlpha` and a source origin.

## Window

`devicePixelRatio` is the window's display scale. `innerWidth` and `innerHeight` are the window's size in CSS pixels. A resize fires one `resize` at the window and then `change` at each `MediaQueryList` whose result changed. `matchMedia` evaluates width, height, aspect ratio, orientation and resolution queries, and answers Edge's defaults for a desktop with a mouse and a light color scheme. `navigator.userAgent` is Edge's on Windows.

## Not implemented

- Canvas 2D, which E6 adds, and audio, `Audio` and `XMLHttpRequest`, which E7 adds.
- HTML parsing, CSS, layout, hit testing below the canvas, and `getComputedStyle`, which returns the inline style.
- Touch events, `visibilitychange`, pointer lock, fullscreen, text input and IME composition.
- Workers, `WebSocket`, network `fetch`, response streams, `crypto`, and navigation.
- EXIF orientation, color profiles, `createImageBitmap` resizing, and canvas or video sources for images.
