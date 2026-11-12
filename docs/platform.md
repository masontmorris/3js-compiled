# Platform shims

The host runs browser game code on shims that behave as headless Edge does for what a three.js game reaches. The shims are ES modules in `packages/three-native/src/platform`. The host builds them into its binary and evaluates `threejsc:/platform/index.js` before the entry module. The Rust side, in `crates/host/src/platform`, turns SDL input into input facts, reads files and decodes images on the blocking thread pool, and persists `localStorage`.

## DOM

`dom.js` is an inert element tree. Nothing lays out or paints.

- `document` has `documentElement`, `head`, `body`, `activeElement`, `hasFocus()`, `createElement`, `createElementNS`, `createTextNode`, `getElementById`, `querySelector` and `querySelectorAll`. `readyState` is `complete` and `visibilityState` is `visible`.
- Elements keep attributes, `id`, `className`, `classList`, inline `style`, `dataset`, children, `textContent`, `focus()`, `blur()`, `tabIndex`, and pointer capture.
- Selectors cover type, universal, id, class and attribute selectors, `:not()`, `:is()`, `:where()`, a few structural pseudo-classes, and the descendant, child and sibling combinators, in comma-separated lists.
- Nothing has layout, with one exception. An element whose inline style has `position: fixed` or `absolute` and fixes each axis with `left`, `right`, `top`, `bottom`, `inset`, `width` or `height` in px, %, vw or vh measures that box against the window in `getBoundingClientRect()`, `offsetWidth`, `offsetHeight`, `clientWidth` and `clientHeight`, as Edge does. Borders, padding and positioned ancestors are ignored. Otherwise a canvas, the body and the root element fill the window, and every other element has an empty box, where Edge would lay it out.
- A canvas has `width` and `height` with Edge's defaults of 300 and 150. `getContext()` returns `null` and logs that it is not implemented.
- Setting `innerHTML` stores the string and leaves the element with no children, and logs once that markup is not parsed.
- A method Edge's DOM defines on an element or the document that the stand-in lacks logs `DOM method not implemented: <Interface>.<method>` once and returns `undefined`. `tools/platform/dom-methods.mjs` lists those methods from Edge into `dom-methods.js`. Any other missing property reads as `undefined`, as in Edge.

## Events

`events.js` has `Event`, `CustomEvent`, `ErrorEvent`, `UIEvent`, `FocusEvent`, `KeyboardEvent`, `MouseEvent`, `PointerEvent` and `WheelEvent`, and `EventTarget` with capture, target and bubble phases, `once`, `passive`, `signal`, `stopImmediatePropagation()` and event handler attributes such as `onclick`. The window is an `EventTarget`.

The input router turns each host input fact into the events Edge fires for it:

- A key goes to the focused element as `keydown` or `keyup`, with Edge's `key`, `code`, `keyCode`, `location`, `repeat` and modifiers. A `keydown` that a listener does not cancel and that types a character, or Enter, without Ctrl or Meta, adds `keypress`, which goes to the element focused after the `keydown` listeners ran.
- A pointer move fires `pointerover` and `mouseover` when the pointer reaches a new element, and `pointerenter` and `mouseenter` at each element it enters that listens for them, as Edge does, then `pointermove` and `mousemove`. Pointer events carry fractional client and offset coordinates. Mouse events carry whole-pixel client coordinates and an offset rounded from the exact position. `movementX` and `movementY` are whole pixels between moves and 0 on every other event. `click`, `auxclick` and `contextmenu` are not primary.
- A button press fires `pointerdown`, or `pointermove` when another button is already down, then `mousedown`, which moves focus to the nearest focusable ancestor or the body. A release fires `pointerup` or `pointermove`, then `mouseup`, then `click` for the primary button or `auxclick` for others, and `contextmenu` for the secondary button. A press of another button between a button's press and release cancels that button's click and gives its `mouseup` a `detail` of 0. Canceling `pointerdown` suppresses the mouse events until the last button is released.
- `setPointerCapture()` retargets pointer events to the element, with `gotpointercapture` and `lostpointercapture`, as the Pointer Events spec says. The last button's release ends capture. Headless Edge does not apply capture to DevTools mouse input, so this row has no Edge reference.
- A wheel fires `wheel` with pixel deltas and a legacy `wheelDelta` of 120 against each axis it scrolls. As in Edge, wheel and touch listeners on the window, the document, the root element and the body are passive unless they say otherwise, so `wheel` is cancelable only when another listener on its path is not passive.
- Window focus fires `blur` or `focus` at the focused element and the window.
- After each listener of an event the host dispatches, promise jobs run, as HTML's microtask checkpoint does. A job a `keydown` listener queues runs before the next listener, and `pointerdown`'s jobs run before `mousedown`. Listeners of an event a script dispatches run back to back.

## Gamepads

`navigator.getGamepads()` returns eight slots, as Edge 157 does. Each pad is a `Gamepad` snapshot in the standard mapping, with 17 buttons and 4 axes, which the host sends only when a pad changes. The analog triggers are buttons 6 and 7, pressed above 30 of 255 as in Edge. As in Edge, a page sees no pad until a button is pressed or a stick moves past half way, and `gamepadconnected` and `gamepaddisconnected` fire at the window. XInput pads read as `Xbox 360 Controller (XInput STANDARD GAMEPAD)`, and other pads as `<name> (STANDARD GAMEPAD Vendor: <vid> Product: <pid>)`. `vibrationActuator.playEffect()` logs that rumble is not implemented and resolves. Pads keep reporting while the window is in the background, as Edge reads them while the page is visible.

## Storage

`localStorage` keeps its entries in JavaScript for reads and sends each change to a writer thread, which rewrites one JSON file per game at most every 100 ms, with a rename so a crash keeps the old file or the new one. The host writes the last changes when it exits. The quota is Edge's, 5,242,880 UTF-16 code units over keys and values, past which `setItem` throws `QuotaExceededError`. `sessionStorage` lives in memory. The file is `%LOCALAPPDATA%\threejsc\<folder>-<hash>\localStorage.json`, where `<folder>` is the name of the entry module's folder and `<hash>` is 16 hex digits of FNV-1a over the entry's absolute path, so two games built to folders of the same name keep separate files and a rebuild in place keeps its file. `--storage <file>` names another file. Keys come back in insertion order. Edge returns them in an order of its own, before and after a reload, which the stand-in does not copy.

`document.cookie` keeps Edge's order: longest path first, then the order the cookies were last set. It honors `path`, `expires` and `max-age`, serializes a cookie without a name as its value, and ignores `domain`, `secure`, `samesite` and `httponly`. Each game's cookies persist in `cookies.json` beside its `localStorage` file. Session cookies persist too, as Edge keeps them when it restores a session.

## Images and loading

- `fetch` reads `file:` URLs from disk, answers a missing file with status 404 as a development server does, and serves `blob:` and `data:` URLs. Network URLs reject with a `TypeError`, as a failed request does in Edge.
- `location` is the entry module's `file:` URL with the `--hash` fragment. Setting `location.hash` fires `hashchange`. Navigation is not implemented.
- `URL` parses and resolves URLs as WHATWG URL does for the file, blob, data and HTTP schemes, with its percent-encode sets for paths, queries and fragments, and `URL.createObjectURL()` makes blob URLs.
- `Blob`, `File`, `Headers`, `Request`, `Response`, `AbortController` and `AbortSignal` cover what three's `FileLoader` and `ImageBitmapLoader` use, including `AbortSignal.any()`, `abort()` and `timeout()`. `fetch` rejects with the signal's reason when the signal aborts first. An abort removes each listener added for the signal's callback, including one added again without the signal, as Edge 157 does. Bodies are not streams.
- The image element and `new Image()` load their `src` and fire `load` or `error`. `createImageBitmap()` takes a `Blob`, a loaded image, an `ImageBitmap` or `ImageData`, with a crop rectangle, `imageOrientation: 'flipY'` and `premultiplyAlpha: 'premultiply'`.
- The host decodes PNG, JPEG and WebP to straight-alpha RGBA8 off the main thread. For an image element, and for `createImageBitmap()` unless `colorSpaceConversion` is `'none'`, it converts the image's declared color space to sRGB, as Edge does: a PNG's from cICP, else iCCP, else sRGB, else gAMA with cHRM, and a JPEG's or WebP's from its ICC profile. `createImageBitmap()` with `'none'`, as three's `ImageBitmapLoader` passes it, keeps the stored values. The conversion uses moxcms.
- `GPUQueue.copyExternalImageToTexture()` writes a decoded image or bitmap into an RGBA8 or BGRA8 texture, with `flipY`, `premultipliedAlpha` and a source origin.

## Window

`devicePixelRatio` is the window's display scale. `innerWidth` and `innerHeight` are the window's size in CSS pixels. A resize fires one `resize` at the window and then `change` at each `MediaQueryList` whose result changed. `matchMedia` evaluates width, height, aspect ratio, orientation and resolution in their plain, `min-`, `max-` and range forms, and answers Edge's defaults for a desktop with a mouse, a light color scheme and no reduced motion, including the boolean forms. `navigator.userAgent` is Edge's on Windows.

`window.open()` opens an `http:` or `https:` URL in the system's default browser, refuses any other URL and logs it, and returns `null`, as Edge does for a `noopener` open.

`crypto.getRandomValues()` and `crypto.randomUUID()` read the operating system's random source, with Edge's errors for a non-integer array and for more than 65,536 bytes. `crypto.subtle` is not implemented.

## Not implemented

- Canvas 2D, which E6 adds, and audio, `Audio` and `XMLHttpRequest`, which E7 adds ("Play sound through Web Audio (E7)" in plan PR #4).
- HTML parsing, stylesheets, layout beyond the inline-style rule above, hit testing below the canvas, and `getComputedStyle`, which returns the inline style.
- Touch events, `visibilitychange`, pointer lock, fullscreen, text input and IME composition.
- Workers, `WebSocket`, network `fetch`, response streams, `crypto.subtle`, and navigation.
- EXIF orientation, `createImageBitmap` resizing and color conversion of an image element's pixels with `'none'`, and canvas or video sources for images.
- WebP decodes about 2.3 times slower than in Edge: 41.5 ms against 18.1 ms for folio's 20 largest WebP files (swarm lane P at 9652f72).
