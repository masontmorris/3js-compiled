// Reads the measurements a perf page logged, in Edge or in the host, and names the records a counted run of `scene`
// needs and lacks, and whether the scene logged an error. The summary drops each dynamic run's first summary, so a dynamic
// run needs two.
export function parse(lines, scene) {
  const draws = lines.map(line => /perf load run=0 ms=([\d.]+)/.exec(line)).filter(Boolean).map(m => Number(m[1]));
  const spans = lines.map(line => /perf loadspan ms=([\d.]+)/.exec(line)).filter(Boolean).map(m => Number(m[1]));
  const firstFrames = lines.map(line => /perf frame1 ms=([\d.]+)/.exec(line)).filter(Boolean).map(m => Number(m[1]));
  const dynamic = lines.map(line => /dynamic frames=(\d+) draw median ms=([\d.]+) p95 ms=([\d.]+) max ms=([\d.]+) span median ms=([\d.]+) p95 ms=([\d.]+) max ms=([\d.]+)/.exec(line)).filter(Boolean).map(m => ({ frames: Number(m[1]), median: Number(m[2]), p95: Number(m[3]), max: Number(m[4]), spanMedian: Number(m[5]), spanP95: Number(m[6]), spanMax: Number(m[7]) }));
  const missing = scene === 'perf'
    ? [['perf load run=0', draws], ['perf loadspan', spans], ['perf frame1', firstFrames]].filter(([, values]) => !values.length).map(([name]) => name)
    : dynamic.length > 1 ? [] : ['a dynamic summary after the first'];
  const failed = lines.some(line => line.includes('scene error'));
  return { loads: spans, draws, firstFrames, dynamic, missing, failed };
}

// The host's script for a native perf page: wait for the scene, then `waitFrames` frames, then close.
export function nativeSteps(waitFrames) {
  return [{ type: 'wait_for', expression: "(() => { if (globalThis.__sceneError) throw new Error(String(globalThis.__sceneError)); return !!globalThis.__sceneReady; })()", timeout_frames: 6000 }, { type: 'wait', frames: waitFrames }, { type: 'close' }];
}
