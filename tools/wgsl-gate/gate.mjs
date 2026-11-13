// Records every example scene, then validates each unique shader with naga and compiles its HLSL with DXC.
// Usage, from the repository root: node tools/wgsl-gate/gate.mjs [out-dir]
// NAGA and DXC name the executables; both default to the PATH.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodeCommands, Opcode } from '../../packages/three-native/src/commands.js';
import { names } from '../../examples/scenes/src/names.js';

const out = resolve(process.argv[2] ?? 'target/wgsl-gate');
const naga = process.env.NAGA ?? 'naga';
const dxc = process.env.DXC ?? 'dxc';
const expectedInvalid = /^fragment_invalid-wgsl-material$/;
const profiles = { vertex: 'vs_6_0', fragment: 'ps_6_0', compute: 'cs_6_0' };
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const shaders = new Map();
for (const scene of names) {
  const frames = join(out, 'frames', scene);
  execFileSync(process.execPath, ['tools/scenes/record.mjs', scene, frames, '3'], { stdio: 'inherit' });
  for (const file of readdirSync(frames).sort()) {
    for (const { opcode, payload } of decodeCommands(new Uint8Array(readFileSync(join(frames, file))))) {
      if (opcode !== Opcode.CREATE_SHADER) continue;
      const view = new DataView(payload.buffer);
      const labelEnd = 16 + view.getUint32(4, true);
      const label = new TextDecoder().decode(payload.subarray(16, labelEnd));
      const code = new TextDecoder().decode(payload.subarray(labelEnd, labelEnd + view.getUint32(8, true)));
      const hash = createHash('sha1').update(code).digest('hex').slice(0, 12);
      const shader = shaders.get(hash) ?? { hash, code, labels: new Set(), scenes: new Set() };
      shader.labels.add(label);
      shader.scenes.add(scene);
      shaders.set(hash, shader);
    }
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result.status === 0 ? null : `${result.stdout}${result.stderr}`.trim().split('\n').slice(0, 8).join('\n');
}

const failures = [];
const report = [];
for (const shader of shaders.values()) {
  const labels = [...shader.labels];
  const wgsl = join(out, `${shader.hash}.wgsl`);
  writeFileSync(wgsl, shader.code);
  const invalid = labels.some(label => expectedInvalid.test(label));
  const entry = { hash: shader.hash, labels, scenes: [...shader.scenes], naga: run(naga, [wgsl]), dxc: [] };
  if (invalid) {
    if (entry.naga === null) failures.push(`${shader.hash} (${labels}) should fail naga validation`);
  } else if (entry.naga !== null) {
    failures.push(`${shader.hash} (${labels}) naga: ${entry.naga}`);
  } else {
    const hlsl = join(out, `${shader.hash}.hlsl`);
    const generated = run(naga, ['--shader-model', '60', wgsl, hlsl]);
    if (generated !== null) failures.push(`${shader.hash} (${labels}) HLSL: ${generated}`);
    else {
      for (const [, stage, name] of shader.code.matchAll(/@(vertex|fragment|compute)[^{]*?fn\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const error = run(dxc, ['-nologo', '-T', profiles[stage], '-E', name, '-Fo', join(out, `${shader.hash}.${name}.dxil`), hlsl]);
        entry.dxc.push({ entryPoint: name, error });
        if (error !== null) failures.push(`${shader.hash} (${labels}) DXC ${name}: ${error}`);
      }
      if (entry.dxc.length === 0) failures.push(`${shader.hash} (${labels}) has no entry points`);
    }
  }
  report.push(entry);
}
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
const entryPoints = report.reduce((total, entry) => total + entry.dxc.length, 0);
console.log(`${shaders.size} shaders from ${names.length} scenes; ${entryPoints} entry points compiled with DXC; report ${join(out, 'report.json')}`);
for (const failure of failures) console.error(failure);
if (failures.length) process.exitCode = 1;
