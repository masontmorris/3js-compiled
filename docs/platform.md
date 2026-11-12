# Platform shims

The host runs browser game code on shims that behave as headless Edge does for what a three.js game reaches. The shims are ES modules in `packages/three-native/src/platform`. The host builds them into its binary and evaluates `threejsc:/platform/index.js` before the entry module. The Rust side, in `crates/host/src/platform`, turns SDL input into input facts, reads files and decodes images on the blocking thread pool, and persists `localStorage`.

## DOM

`dom.js` is an inert element tree. Nothing lays out or paints.

- `document` has `documentElement`, `head`, `body`, `activeElement`, `hasFocus()`, `createElement`, `createElementNS`, `createTextNode`, `getElementById`, `querySelector` and `querySelectorAll`. `readyState` is `complete` and `visibilityState` is `visible`.
- Inline `style` and the `style` attribute reflect each other as in Edge: `setAttribute('style', ...)` parses into `element.style`, and changing `element.style` writes its text back to the attribute. Every CSS property Edge 157 knows, in camel case or hyphenated (from `tools/platform/dom-methods.mjs`), reads `''` while unset; other names read `undefined`. Values are kept as given, not checked as CSS.
- Inserting a `DocumentFragment` with `appendChild`, `insertBefore`, `append`, `prepend`, `before`, `after`, `replaceChild`, `replaceWith` or `replaceChildren` moves its children in order and leaves it empty, with Edge's return values. Every insertion and removal follows DOM's insert, remove and replace-all steps.
- `MutationObserver` has `childList`, `attributes`, `characterData`, `subtree`, the old values and `attributeFilter`, with Edge's option errors. Records queue in the order the DOM's steps make them, and callbacks run in one microtask, in the order the observers were made. A node removed from an observed subtree is not followed afterwards.
- `createElementNS` keeps the namespace, prefix and case of the name: an SVG element has the SVG namespace, its lowercase-or-camel-case `tagName` and Edge's `SVG...Element` class. `setAttributeNS`, `getAttributeNS`, `removeAttributeNS` and `hasAttributeNS` keep each attribute's namespace and prefix, with Edge's `NamespaceError`. `getAttribute` and `setAttribute` lowercase names only on HTML elements, as Edge does.
- Elements keep attributes, `id`, `className`, `classList`, inline `style`, `dataset`, children, `textContent`, `focus()`, `blur()`, `tabIndex`, and pointer capture.
- Selectors cover type, universal, id, class and attribute selectors, `:not()`, `:is()`, `:where()`, a few structural pseudo-classes, and the descendant, child and sibling combinators, in comma-separated lists.
- Nothing has layout, with one exception. An element whose inline style has `position: fixed` or `absolute` and fixes each axis with `left`, `right`, `top`, `bottom`, `inset`, `width` or `height` in px, %, vw or vh measures that box against the window in `getBoundingClientRect()`, which returns a `DOMRect`, `offsetWidth`, `offsetHeight`, `clientWidth` and `clientHeight`, as Edge does. Borders, padding and positioned ancestors are ignored. Otherwise a canvas, the body and the root element fill the window, and every other element has an empty box, where Edge would lay it out.
- `IntersectionObserver` checks its targets after each frame's callbacks and calls back in a task before the next frame, as Edge does. A target's rect is its `getBoundingClientRect()` under the rule above. Its intersection with the viewport, or with an element root it is in the containing block chain of, counts edges as meeting; the ratio is the intersection's share of the target's area as a 32-bit float, or 1 for a zero-area target that meets the root. As in Edge 157, an entry comes on the first check and whenever the number of thresholds the ratio has reached changes, and `isIntersecting` says whether it has reached the first. `rootMargin` takes px and %, px truncated to whole pixels. Scrolling, clipping by ancestors' `overflow`, transforms and `trackVisibility` are out of reach: `isVisible` is always false.
- A canvas has `width` and `height` with Edge's defaults of 300 and 150. `getContext('2d')` returns the canvas 2D context below. Other context types return `null` and log that they are not implemented.
- Setting `innerHTML` stores the string and leaves the element with no children, and logs once that markup is not parsed.
- A method Edge's DOM defines on an element or the document that the stand-in lacks logs `DOM method not implemented: <Interface>.<method>` once and returns `undefined`. `tools/platform/dom-methods.mjs` lists those methods from Edge into `dom-methods.js`. Any other missing property reads as `undefined`, as in Edge.
- A `DOMException` the platform throws carries its own `stack`, starting `<name>: <message>`, as Edge's do. One a script constructs has no `stack`, also as in Edge 157.

## Events

`events.js` has `Event`, `CustomEvent`, `ErrorEvent`, `PromiseRejectionEvent`, `UIEvent`, `FocusEvent`, `KeyboardEvent`, `MouseEvent`, `PointerEvent` and `WheelEvent`, and `EventTarget` with capture, target and bubble phases, every event handler attribute Edge 157 defines on elements, the document and the window (from `tools/platform/dom-methods.mjs`), `once`, `passive`, `signal`, `stopImmediatePropagation()` and event handler attributes such as `onclick`. The window is an `EventTarget`.

The input router turns each host input fact into the events Edge fires for it:

- A key goes to the focused element as `keydown` or `keyup`, with Edge's `key`, `code`, `keyCode`, `location`, `repeat` and modifiers. A `keydown` that a listener does not cancel and that types a character, or Enter, without Ctrl or Meta, adds `keypress`, which goes to the element focused after the `keydown` listeners ran.
- A pointer move fires `pointerover` and `mouseover` when the pointer reaches a new element, and `pointerenter` and `mouseenter` at each element it enters that listens for them, as Edge does, then `pointermove` and `mousemove`. Pointer events carry fractional client and offset coordinates. Mouse events, `click`, `auxclick` and `contextmenu` carry whole-pixel client coordinates and an offset rounded from the exact position. `movementX` and `movementY` are whole pixels between moves and 0 on every other event. `click`, `auxclick` and `contextmenu` are not primary.
- A button press fires `pointerdown`, or `pointermove` when another button is already down, then `mousedown`, which moves focus to the nearest focusable ancestor or the body. A release fires `pointerup` or `pointermove`, then `mouseup`, then `click` for the primary button or `auxclick` for others, and `contextmenu` for the secondary button. A press of another button between a button's press and release cancels that button's click and gives its `mouseup` a `detail` of 0. Canceling `pointerdown` suppresses the mouse events until the last button is released.
- `setPointerCapture()` retargets pointer events to the element, with `gotpointercapture` before the next pointer event and `lostpointercapture` right after the `pointerup` of the last button's release, carrying that event's fields, as the Pointer Events spec says. Headless Edge does not apply capture to DevTools mouse input, so these two events have no Edge reference.
- A wheel fires `wheel` with pixel deltas and a legacy `wheelDelta` of 120 against each axis it scrolls. As in Edge, wheel and touch listeners on the window, the document, the root element and the body are passive unless they say otherwise, so `wheel` is cancelable only when another listener on its path is not passive.
- Window focus fires `blur` or `focus` at the focused element and the window.
- After each listener of an event the host dispatches, promise jobs run, as HTML's microtask checkpoint does. A job a `keydown` listener queues runs before the next listener, and `pointerdown`'s jobs run before `mousedown`. Listeners of an event a script dispatches run back to back.

## Gamepads

`navigator.getGamepads()` returns eight slots, as Edge 157 does. Each pad is a `Gamepad` snapshot in the standard mapping, with 17 buttons and 4 axes, which the host sends only when a pad changes. The analog triggers are buttons 6 and 7, pressed above 30 of 255 as in Edge. A trigger held as the pad's first input exposes the pad with that button already pressed in its first snapshot. As in Edge, a page sees no pad until a button is pressed or a stick moves past half way, and `gamepadconnected` and `gamepaddisconnected` fire at the window. XInput pads read as `Xbox 360 Controller (XInput STANDARD GAMEPAD)`, and other pads as `<name> (STANDARD GAMEPAD Vendor: <vid> Product: <pid>)`. `vibrationActuator.playEffect()` logs that rumble is not implemented and resolves. Pads keep reporting while the window is in the background, as Edge reads them while the page is visible.

## Storage

`localStorage` keeps its entries in JavaScript for reads and sends each change to a writer thread, which rewrites one JSON file per game at most every 100 ms, with a rename so a crash keeps the old file or the new one. The host writes the last changes when it exits. The quota is Edge's, 5,242,880 UTF-16 code units over keys and values, past which `setItem` throws `QuotaExceededError`. `sessionStorage` lives in memory. The file is `%LOCALAPPDATA%\threejsc\<folder>-<hash>\localStorage.json`, where `<folder>` is the name of the entry module's folder and `<hash>` is 16 hex digits of FNV-1a over the entry's absolute path, so two games built to folders of the same name keep separate files and a rebuild in place keeps its file. `--storage <file>` names another file. Keys come back in the order they were first set, before and after a restart, as Edge returns them.

`document.cookie` keeps Edge's order: longest path first, then the order the cookies were last set. It honors `path`, `expires` and `max-age`, serializes a cookie without a name as its value, and ignores `domain`, `secure`, `samesite` and `httponly`. Each game's cookies persist in `cookies.json` beside its `localStorage` file. Session cookies persist too, as Edge keeps them when it restores a session.

## Images and loading

- `fetch` reads `file:` URLs from disk, answers a missing file with status 404 as a development server does, and serves `blob:` and `data:` URLs. Network URLs reject with a `TypeError`, as a failed request does in Edge.
- `location` is the entry module's `file:` URL with the `--hash` fragment, and its origin is `file://`, as Edge gives a file page. A blob URL made there starts `blob:null/`, as in Edge. Setting `location.hash` fires `hashchange`. Navigation is not implemented.
- `URL` parses and resolves URLs as WHATWG URL does for the file, blob, data and HTTP schemes, with its percent-encode sets for paths, queries and fragments, and `URL.createObjectURL()` makes blob URLs.
- `Blob`, `File`, `Headers`, `Request`, `Response`, `AbortController` and `AbortSignal` cover what three's `FileLoader` and `ImageBitmapLoader` use, including `AbortSignal.any()`, `abort()` and `timeout()`. `fetch` rejects with the signal's reason when the signal aborts first. An abort removes each listener added for the signal's callback, including one added again without the signal, as Edge 157 does. Bodies are not streams.
- The image element and `new Image()` load their `src` and fire `load` or `error`. `createImageBitmap()` takes a `Blob`, a loaded image, an `ImageBitmap` or `ImageData`, with a crop rectangle, `imageOrientation: 'flipY'` and `premultiplyAlpha: 'premultiply'`.
- The host decodes PNG, JPEG and WebP to straight-alpha RGBA8 off the main thread. For an image element, and for `createImageBitmap()` unless `colorSpaceConversion` is `'none'`, it converts the image's declared color space to sRGB, as Edge does: a PNG's from cICP, else iCCP, else sRGB, else gAMA with cHRM, and a JPEG's or WebP's from its ICC profile. `createImageBitmap()` with `'none'`, as three's `ImageBitmapLoader` passes it, keeps the stored values. The conversion uses moxcms.
- `GPUQueue.copyExternalImageToTexture()` writes a decoded image or bitmap into an RGBA8 or BGRA8 texture, with `flipY`, `premultipliedAlpha` and a source origin.

## Window

`devicePixelRatio` is the window's display scale. `innerWidth` and `innerHeight` are the window's size in CSS pixels. A resize fires one `resize` at the window and then `change` at each `MediaQueryList` with a change listener whose result changed. A list's `matches` reads the window as it is, so a `resize` listener already sees the new answer, and its `media` is serialized as Edge does, for example `(min-aspect-ratio: 3 / 2)`. `matchMedia` evaluates width, height, aspect ratio, orientation and resolution in their plain, `min-`, `max-` and range forms, and answers Edge's defaults for a desktop with a mouse, a light color scheme and no reduced motion, including the boolean forms. `navigator.userAgent` is Edge's on Windows.

`window.open()` opens an `http:` or `https:` URL in the system's default browser, refuses any other URL and logs it, and returns `null`, as Edge does for a `noopener` open.

`DOMRect`, `DOMRectReadOnly`, `DOMPoint`, `DOMPointReadOnly`, `DOMMatrix` and `DOMMatrixReadOnly` construct, combine, invert, transform points and serialize as in Edge 157. A matrix whose values include a NaN or an Infinity throws `InvalidStateError` from `toString()`, as Edge does. A `DOMMatrix` built from a CSS transform string throws that parsing a transform list is not implemented natively.

`btoa()` and `atob()` encode Latin-1 strings to and from base64, with Edge's errors for a character outside Latin-1, text that is not base64 and a missing argument.

A promise rejected with no handler fires a trusted, cancelable `unhandledrejection` at the window, and logs `Uncaught (in promise)` with the reason unless a listener cancels it. The game keeps running either way, as in Edge. `rejectionhandled` is not implemented.

`WebAssembly.compileStreaming()` and `instantiateStreaming()` take a `Response` or a promise of one, as from `fetch()`, with Edge's error for a MIME type other than `application/wasm` and a `CompileError` for bytes that are not a module. The whole body goes to the compiler at once.

`crypto.getRandomValues()` and `crypto.randomUUID()` read the operating system's random source, with Edge's errors for a non-integer array and for more than 65,536 bytes. `crypto.subtle` is not implemented.

## Known differences from Edge 157

None is reached by three.js or folio.

- `window.onerror` reads `undefined` where Edge reads `null`.
- `SVGElement` and its interfaces are not global constructors, so `instanceof SVGElement` is unavailable.
- `new Response(blob)` does not take the blob's type as the response's `Content-Type`.
- The `error` event from a throwing listener has `isTrusted` false where Edge reports true.
- `AbortSignal.any()` with a non-signal throws a `TypeError` whose message differs from Edge's.
- A `fetch` aborted after its response resolves still returns the body, where Edge rejects it.
- `IntersectionObserver` accepts `trackVisibility` without a delay of 100, which Edge rejects with `NotSupportedError`, and `isVisible` is always false.
- An element's `querySelector` and `querySelectorAll` with an invalid selector name `Document` in the `SyntaxError` where Edge names `Element`.
## Canvas 2D

`canvas2d.js` draws what a three.js game draws on a 2D canvas: rectangles, linear and radial gradients, images, and filled and stroked text, with `globalAlpha`, transforms, `save()` and `restore()`, `measureText()`, `getImageData()` and `putImageData()`. A canvas keeps its pixels as premultiplied RGBA8. Setting its `width` or `height`, even to the same value, clears the pixels and resets the drawing state, as in Edge. `THREE.Texture(canvas)` and `CanvasTexture` upload the canvas through `copyExternalImageToTexture()`, and `drawImage()` and `createImageBitmap()` read it.

- The host shapes text with harfrust, the Rust port of HarfBuzz that Chromium shapes with, at 16.16 fixed point as Blink does, so `measureText().width` matches Edge's to 0.01 px. Each character takes the first font in the list that has it, then the standard font, Times New Roman, then Segoe UI Emoji, Segoe UI Symbol, Segoe UI and Arial. The generic families are Edge's on Windows: Arial, Times New Roman, Consolas, Comic Sans MS, Impact and Segoe UI. The host reads these from the Windows font folder when a page first needs them.
- The font metrics are Blink's: the ascent and descent rounded to whole pixels, the hanging baseline at 0.8 of the ascent, and the em box normalized to the font size at 1/64 pixel for the `top`, `middle` and `bottom` baselines.
- vello_cpu with glifo rasterizes glyphs at quarter-pixel positions on a whole-pixel baseline, hinted, as Skia places horizontal text. Glyph coverage goes through Skia's glyph mask gamma before it blends, fitted to Edge at gamma 2.3 and contrast 1. Color fonts, such as Segoe UI Emoji, draw their own colors.
- `FontFace` loads TrueType, OpenType, WOFF and WOFF2 from a buffer or from `url()` sources through `fetch`, and `document.fonts` is a `FontFaceSet` with `add()`, `delete()`, `load()`, `check()` and `ready`. Text draws with a face once it is loaded and added to `document.fonts`, chosen by CSS font matching on weight and style. A variable face draws at the requested weight on its `wght` axis.
- Paths, clipping, patterns, shadows, filters, line dashes, `letterSpacing`, right-to-left text and compositing modes other than `source-over` log once and draw nothing, or draw with `source-over`. A `drawImage()` source rectangle rounds out to whole pixels, and fonts get no synthetic bold or italic.

## Not implemented

- Audio, `Audio` and `XMLHttpRequest`, which E7 adds ("Play sound through Web Audio (E7)" in plan PR #4).
- HTML parsing, stylesheets, layout beyond the inline-style rule above, hit testing below the canvas, and `getComputedStyle`, which returns the inline style.
- Touch events, `visibilitychange`, pointer lock, fullscreen, text input and IME composition.
- Workers, `WebSocket`, network `fetch`, response streams, `crypto.subtle`, and navigation.
- EXIF orientation, `createImageBitmap` resizing and color conversion of an image element's pixels with `'none'`, and video sources for images.
- WebP decodes about 2.3 times slower than in Edge: 41.5 ms against 18.1 ms for folio's 20 largest WebP files (swarm lane P at 9652f72).
