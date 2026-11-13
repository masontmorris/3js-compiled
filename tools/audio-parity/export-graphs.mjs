// Writes crates/audio/tests/graphs.json, the reference graphs and decode cases offline.rs replays.
import { writeFileSync } from 'node:fs';
import { decodeCases, referenceGraphs } from './graphs.mjs';

writeFileSync('crates/audio/tests/graphs.json', `${JSON.stringify({ graphs: referenceGraphs(), decodes: decodeCases() }, null, 1)}\n`);
