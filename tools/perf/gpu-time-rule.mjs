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

// Judges interleaved runs pair by pair. A pair counts unless native's median graphics clock is more than 5 percent
// above Edge's, because a faster clock could hide a slower native chain, or either side has under 10 clock samples.
// The rule compares the chain medians of the counted pairs' runs, and the whole frame is reported beside them.
export function judge(results, margin) {
  const pairs = [...new Set(results.map(result => result.run))].map(run => {
    const edge = results.find(result => result.side === 'edge' && result.run === run);
    const native = results.find(result => result.side === 'native' && result.run === run);
    const reason = !edge || !native ? 'a side has no run'
      : edge.gpu.samples < 10 ? `Edge had ${edge.gpu.samples} clock samples, under 10`
        : native.gpu.samples < 10 ? `native had ${native.gpu.samples} clock samples, under 10`
          : native.gpu.graphicsMedian > edge.gpu.graphicsMedian * 1.05
            ? `native graphics clock ${((native.gpu.graphicsMedian / edge.gpu.graphicsMedian - 1) * 100).toFixed(1)}% above Edge`
            : null;
    return { run, counted: reason === null, reason, edge, native };
  });
  const counted = pairs.filter(pair => pair.counted);
  const side = key => counted.length
    ? { chainP50: median(counted.map(pair => pair[key].chainP50)), wholeP50: median(counted.map(pair => pair[key].wholeP50)) }
    : { chainP50: null, wholeP50: null };
  const verdict = { pairs: pairs.map(({ run, counted: isCounted, reason }) => ({ run, counted: isCounted, reason })), counted: counted.length, edge: side('edge'), native: side('native') };
  verdict.limit = verdict.edge.chainP50 === null ? null : verdict.edge.chainP50 * (1 + margin);
  verdict.pass = counted.length > 0 && verdict.native.chainP50 <= verdict.limit;
  verdict.outcome = counted.length === 0 ? 'INCONCLUSIVE' : verdict.pass ? 'PASS' : 'FAIL';
  return verdict;
}
