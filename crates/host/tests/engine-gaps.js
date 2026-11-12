// F1's engine gaps G3 and G7 inside the host. Each result is one `R` line; Edge 157's values are in the E5 owner
// folder's probe/f1-probe.json.
const results = [];
const check = (name, value) => results.push(`R ${name}: ${value}`);
const describe = error => `${error.constructor.name} ${error.name}: ${error.message}`;

const rejections = [];
addEventListener('unhandledrejection', event => {
  rejections.push(`${event.constructor.name} ${event.type} ${String(event.reason)} ${event.promise instanceof Promise} ${event.cancelable} ${event.isTrusted}`);
  if (event.reason?.message === 'prevented') event.preventDefault();
});
Promise.reject(new Error('not handled'));
Promise.reject(new Error('prevented'));

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const url = type => URL.createObjectURL(new Blob([wasm], { type }));
try {
  const result = await WebAssembly.instantiateStreaming(fetch(url('application/wasm')));
  check('instantiateStreaming', `${Object.keys(result).join(',')} ${result.module instanceof WebAssembly.Module}`);
  check('compileStreaming', (await WebAssembly.compileStreaming(fetch(url('application/wasm')))) instanceof WebAssembly.Module);
  await WebAssembly.instantiateStreaming(fetch(url('text/plain'))).catch(error => check('wrong type', describe(error)));
  await WebAssembly.instantiateStreaming(Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/wasm' } })))
    .catch(error => check('bad bytes', error.constructor.name));
} catch (error) {
  check('error', describe(error));
}

let frames = 0;
function frame() {
  if (++frames === 10) {
    check('rejections', rejections.join(' | '));
    check('frames after the rejections', frames);
    for (const line of results) console.log(line);
    setClearColor(0, 1, 0, 1);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
