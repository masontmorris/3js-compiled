// Reads the measurements a perf page logged, in Edge or in the host.
export function parse(lines) {
  const draws = lines.map(line => /perf load run=0 ms=([\d.]+)/.exec(line)).filter(Boolean).map(m => Number(m[1]));
  const spans = lines.map(line => /perf loadspan ms=([\d.]+)/.exec(line)).filter(Boolean).map(m => Number(m[1]));
  const firstFrames = lines.map(line => /perf frame1 ms=([\d.]+)/.exec(line)).filter(Boolean).map(m => Number(m[1]));
  const dynamic = lines.map(line => /dynamic frames=(\d+) draw median ms=([\d.]+) p95 ms=([\d.]+) max ms=([\d.]+) span median ms=([\d.]+) p95 ms=([\d.]+) max ms=([\d.]+)/.exec(line)).filter(Boolean).map(m => ({ frames: Number(m[1]), median: Number(m[2]), p95: Number(m[3]), max: Number(m[4]), spanMedian: Number(m[5]), spanP95: Number(m[6]), spanMax: Number(m[7]) }));
  return { loads: spans, draws, firstFrames, dynamic };
}
