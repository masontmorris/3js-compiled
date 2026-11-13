// Runs tools/audio-parity/scenarios.mjs in headless Edge, muted, and writes each scenario's log to
// tools/audio-parity/scenarios.edge.json, the Edge column of the scenario table.
// `node tools/audio-parity/edge-scenarios.mjs [name filter]`
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { scenarioEnv } from './scenario-env.mjs';
import { scenarios } from './scenarios.mjs';

const filter = process.argv[2] ?? '';
const outFile = 'tools/audio-parity/scenarios.edge.json';
const origin = 'https://reference.test';
const types = { mjs: 'text/javascript', json: 'application/json', txt: 'text/plain' };
let step = 'launch';
const profile = await mkdtemp(join(tmpdir(), 'threejsc-edge-audio-'));
const timeout = setTimeout(() => { console.error(`edge-scenarios.mjs: no finish within 5 minutes, at ${step}`); process.exit(1); }, 300_000);
let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, timeout: 60_000, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.route(`${origin}/**`, route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
    const file = path === '/scenarios.mjs' ? 'tools/audio-parity/scenarios.mjs' : join('examples/audio', path.slice(1));
    try {
      return route.fulfill({ contentType: types[file.split('.').pop()] ?? 'application/octet-stream', body: readFileSync(file) });
    } catch {
      return route.fulfill({ status: 404, statusText: 'Not Found', body: '' });
    }
  });
  await page.goto(`${origin}/`);
  const results = { userAgent: await page.evaluate(() => navigator.userAgent), scenarios: {} };
  for (const name of Object.keys(scenarios).filter(n => n.includes(filter))) {
    step = name;
    const run = page.evaluate(async ({ name, env }) => {
      const { scenarios } = await import('/scenarios.mjs');
      const log = [];
      try {
        await scenarios[name]((...entry) => log.push(entry), env);
      } catch (error) {
        log.push(['threw', error.name, error.message]);
      }
      return JSON.parse(JSON.stringify(log));
    }, { name, env: scenarioEnv('') });
    results.scenarios[name] = await Promise.race([run, new Promise((_, reject) => setTimeout(() => reject(new Error(`edge-scenarios.mjs: ${name} took over 60 s`)), 60_000).unref())]);
  }
  const previous = filter ? JSON.parse(readFileSync(outFile, 'utf8')) : { scenarios: {} };
  writeFileSync(outFile, `${JSON.stringify({ userAgent: results.userAgent, scenarios: { ...previous.scenarios, ...results.scenarios } }, null, 1)}\n`);
  console.log(`${results.userAgent}: ${Object.keys(results.scenarios).length} scenarios`);
} finally {
  clearTimeout(timeout);
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
