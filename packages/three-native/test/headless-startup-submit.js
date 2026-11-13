// Submits a command stream at the top level, as a page that draws once while it loads, then again on its first frame.
globalThis.submitGpuCommands(new Uint8Array(16));
let sent = 1;
await new Promise(done => requestAnimationFrame(() => {
  globalThis.submitGpuCommands(new Uint8Array(16));
  sent++;
  done();
}));
console.log(`H submitted ${sent}`);
