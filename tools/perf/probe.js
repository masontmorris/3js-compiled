// Counts animation frames, times each frame's callbacks, and reports the measured window through console.log.
// The frame-cost tool sets globalThis.__perfProbe = { warmup, frames, go } before this script runs.
// Frames count from the first frame after `go` becomes true. Callbacks that share a timestamp belong to
// one frame, because three's renderer runs its own animation loop beside the application's.
{
  const { warmup, frames } = globalThis.__perfProbe;
  const request = globalThis.requestAnimationFrame.bind(globalThis);
  const callbackTimes = [];
  let count = 0;
  let start = 0;
  let frameTime = null;
  let frameCallbacks = 0;
  const size = () => {
    const canvas = globalThis.__scene?.renderer.domElement;
    return `${canvas?.width}x${canvas?.height}`;
  };
  const finishFrame = now => {
    count++;
    globalThis.__perfCount = count;
    if (count > warmup && count <= warmup + frames) callbackTimes.push(frameCallbacks);
    if (count === warmup) {
      start = now;
      console.log(`perf start ${JSON.stringify({ drawingBuffer: size() })}`);
    } else if (count === warmup + frames) {
      const sorted = callbackTimes.toSorted((a, b) => a - b);
      const at = share => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
      console.log(`perf end ${JSON.stringify({ elapsedMs: now - start, callbackP50: at(0.5), callbackP95: at(0.95) })}`);
    }
  };
  globalThis.requestAnimationFrame = callback => request(time => {
    const before = performance.now();
    if (globalThis.__perfProbe.go && time !== frameTime) {
      if (frameTime !== null) finishFrame(before);
      frameTime = time;
      frameCallbacks = 0;
    }
    callback(time);
    frameCallbacks += performance.now() - before;
  });
}
