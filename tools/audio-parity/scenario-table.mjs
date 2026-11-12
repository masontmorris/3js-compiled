// Writes docs/native-audio-scenarios.md: one row per logged step of every scenario, with Edge's value from
// scenarios.edge.json, the host's from a host run, the row's rule and its verdict.
// `node tools/audio-parity/scenario-table.mjs <scenarios.host.json>`
import { readFileSync, writeFileSync } from 'node:fs';

const [hostPath] = process.argv.slice(2);
const edge = JSON.parse(readFileSync('tools/audio-parity/scenarios.edge.json', 'utf8'));
const host = JSON.parse(readFileSync(hostPath, 'utf8'));

// Rows whose rule is not equality with Edge, and why.
const RULES = {
  'unsupported-methods': 'Throws a NotSupportedError that names the method; Edge supports it.',
  'context-start/baseLatency': 'The device period, which Edge reports for its own device.',
};
// Rows that are information only: read at startup, on different devices. Lane 5 judges latency in steady state, on
// one device, against Edge's reading there.
const INFO = { 'context-start/latency under 50 ms': 'Information only. Read at startup on different devices; lane 5 judges latency.' };
const cell = value => `\`${JSON.stringify(value).replace(/\|/g, '\\|')}\``;

const lines = [
  '# Web Audio scenario table',
  '',
  `Each row is one step that \`tools/audio-parity/scenarios.mjs\` logs. Edge's value comes from ${edge.userAgent.match(/Edg\/[\d.]+/)[0]} headless, muted, in \`scenarios.edge.json\`. The host's value comes from \`node tools/audio-parity/host.mjs scenarios\` with the host playing to Steam Streaming Speakers. A row passes when the values are equal, unless its rule says otherwise. \`node tools/audio-parity/scenario-table.mjs <scenarios.host.json>\` rewrites this file.`,
  '',
  '| Scenario | Step | Edge | Host | Rule | Verdict |',
  '| --- | --- | --- | --- | --- | --- |',
];
let pass = 0;
let total = 0;
for (const [name, edgeLog] of Object.entries(edge.scenarios)) {
  const hostLog = host[name] ?? [];
  const steps = Math.max(edgeLog.length, hostLog.length);
  for (let i = 0; i < steps; i++) {
    const e = edgeLog[i];
    const h = hostLog[i];
    const step = (e ?? h)[0];
    const info = INFO[`${name}/${step}`];
    if (info) {
      lines.push(`| ${name} | ${step} | ${e ? cell(e.slice(1)) : '—'} | ${h ? cell(h.slice(1)) : '—'} | ${info} | info |`);
      continue;
    }
    const rule = RULES[name] ?? RULES[`${name}/${step}`];
    let verdict;
    if (name === 'unsupported-methods') verdict = step === 'still playing' ? JSON.stringify(e) === JSON.stringify(h) : h?.[2] === 'NotSupportedError' && String(h?.[3]).includes(step.split('.').at(-1));
    else if (rule) verdict = typeof h?.[1] === 'number' && h[1] > 0 && h[1] <= 0.02;
    else verdict = JSON.stringify(e) === JSON.stringify(h);
    total++;
    if (verdict) pass++;
    lines.push(`| ${name} | ${step} | ${e ? cell(e.slice(1)) : '—'} | ${h ? cell(h.slice(1)) : '—'} | ${rule ?? 'equal'} | ${verdict ? 'pass' : 'FAIL'} |`);
  }
}
lines.splice(4, 0, `${pass} of ${total} judged rows pass; rows marked info are not judged.`, '');
writeFileSync('docs/native-audio-scenarios.md', `${lines.join('\n')}\n`);
console.log(`${pass} of ${total} rows pass`);
