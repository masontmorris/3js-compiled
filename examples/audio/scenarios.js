// Runs tools/audio-parity/scenarios.mjs in the host and logs `AUDIO-SCENARIO <json>` per scenario, then
// `AUDIO-SCENARIO-DONE`. `#filter=<text>` picks scenarios. tools/audio-parity/host-scenarios.mjs runs it and compares
// each log with Edge's in scenarios.edge.json.
import { scenarioEnv } from '../../tools/audio-parity/scenario-env.mjs';
import { scenarios } from '../../tools/audio-parity/scenarios.mjs';

const filter = new URLSearchParams(location.hash.slice(1)).get('filter') ?? '';
const base = new URL('.', import.meta.url).href;
for (const name of Object.keys(scenarios).filter(n => n.includes(filter))) {
  const log = [];
  try {
    await scenarios[name]((...entry) => log.push(entry), scenarioEnv(base));
  } catch (error) {
    log.push(['threw', error.name, error.message]);
  }
  console.log(`AUDIO-SCENARIO ${JSON.stringify({ name, log })}`);
}
console.log('AUDIO-SCENARIO-DONE');
