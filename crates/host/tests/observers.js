// F1's gaps G10 to G13 inside the host: every scenario of the platform's DOM fixture, field by field against Edge
// 157's results. Each field logs one `R` line, and the last line counts the fields that differ.
import { mutations, delivery, exceptions, observerOptions, intersections, namespaces } from '../../../packages/three-native/test/fixtures/dom-scenarios.js';
import { EDGE } from '../../../packages/three-native/test/fixtures/dom-edge.js';

const lines = [];
let differ = 0;
const compare = (scenario, native) => {
  const edge = EDGE[scenario];
  const fields = edge !== null && typeof edge === 'object' && !Array.isArray(edge) ? Object.keys(edge) : [null];
  for (const field of fields) {
    const want = JSON.stringify(field === null ? edge : edge[field]);
    const got = JSON.stringify(field === null ? native : native?.[field]);
    const label = field === null ? scenario : `${scenario}.${field}`;
    if (want === got) lines.push(`R ${label}: match`);
    else { differ++; lines.push(`R ${label}: differs native=${got} edge=${want}`); }
  }
};
const run = async (scenario, call) => {
  try { compare(scenario, await call(globalThis)); } catch (error) { differ++; lines.push(`R ${scenario}: threw ${error?.stack ?? error}`); }
};

let done = false;
(async () => {
  await run('mutations', mutations);
  await run('delivery', delivery);
  await run('exceptions', exceptions);
  await run('observerOptions', observerOptions);
  await run('intersections', intersections);
  await run('namespaces', namespaces);
  lines.push(`R fields that differ: ${differ}`);
  done = true;
})();

function frame() {
  if (done) {
    for (const line of lines) console.log(line);
    setClearColor(0, 1, 0, 1);
    return;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
