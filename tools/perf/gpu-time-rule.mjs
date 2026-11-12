// The perf rule of tools/perf/gpu-time.mjs, apart from the runs that measure it.

const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];

// A frame's GPU time from three's timestamp entries, [uid, ms] pairs whose uid is `r:<render call>:<context>:f<frame>`
// for a render pass. `whole` sums the frame's render passes, and `chain` those from render call `firstChainCall` on, which
// leaves out the scene pass when the scene's first render call draws it, as RenderPipeline's pass() does.
export function frameTimes(entries, firstChainCall) {
  let whole = 0;
  let chain = 0;
  let passes = 0;
  for (const [uid, ms] of entries) {
    const call = /^r:(\d+):/.exec(uid)?.[1];
    if (call === undefined) continue;
    passes++;
    whole += ms;
    if (Number(call) >= firstChainCall) chain += ms;
  }
  return { whole, chain, passes };
}

// Why a pair's clocks void it, or null when they are within 5 percent of each other.
function clockGap(edge, native) {
  const change = (native / edge - 1) * 100;
  if (Math.abs(change) <= 5) return null;
  return `native graphics clock ${Math.abs(change).toFixed(1)}% ${change > 0 ? 'above' : 'below'} Edge's`;
}

// Judges interleaved runs pair by pair. A pair is void when the two sides' median graphics clocks differ by more than
// 5 percent either way, because a clock gap moves the chain's time, or when either side has under 10 clock samples. The
// rule compares the chain medians of the counted pairs' runs and needs at least 3 counted pairs, and the whole frame is
// reported beside the chain.
export function judge(results, margin) {
  const pairs = [...new Set(results.map(result => result.run))].map(run => {
    const edge = results.find(result => result.side === 'edge' && result.run === run);
    const native = results.find(result => result.side === 'native' && result.run === run);
    const reason = !edge || !native ? 'a side has no run'
      : edge.gpu.samples < 10 ? `Edge had ${edge.gpu.samples} clock samples, under 10`
        : native.gpu.samples < 10 ? `native had ${native.gpu.samples} clock samples, under 10`
          : clockGap(edge.gpu.graphicsMedian, native.gpu.graphicsMedian);
    return { run, counted: reason === null, reason, edge, native };
  });
  const counted = pairs.filter(pair => pair.counted);
  const side = key => counted.length
    ? { chainP50: median(counted.map(pair => pair[key].chainP50)), wholeP50: median(counted.map(pair => pair[key].wholeP50)) }
    : { chainP50: null, wholeP50: null };
  const verdict = { pairs: pairs.map(({ run, counted: isCounted, reason }) => ({ run, counted: isCounted, reason })), counted: counted.length, edge: side('edge'), native: side('native') };
  verdict.limit = verdict.edge.chainP50 === null ? null : verdict.edge.chainP50 * (1 + margin);
  verdict.reason = counted.length < 3 ? `${counted.length} counted pairs, under 3` : null;
  verdict.pass = verdict.reason === null && verdict.native.chainP50 <= verdict.limit;
  verdict.outcome = verdict.reason !== null ? 'INCONCLUSIVE' : verdict.pass ? 'PASS' : 'FAIL';
  return verdict;
}
