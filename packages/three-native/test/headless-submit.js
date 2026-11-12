// Submits a command stream on three frames, as a page that renders every frame does, then logs how many it sent.
let sent = 0;
await new Promise(done => {
  const frame = () => {
    globalThis.submitGpuCommands(new Uint8Array(16));
    if (++sent === 3) done();
    else requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
});
console.log(`H submitted ${sent}`);
