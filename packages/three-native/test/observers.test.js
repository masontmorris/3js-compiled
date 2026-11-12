import test from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '../src/platform/dom.js';
import { addEventListener, dispatchEvent } from '../src/platform/events.js';
import { MutationObserver, IntersectionObserver } from '../src/platform/observers.js';
import { mutations, delivery, observerOptions, namespaces } from './fixtures/dom-scenarios.js';
import { EDGE } from './fixtures/dom-edge.js';

// Every expectation is Edge 157's result for the same scenario (tools/platform/dom-reference.mjs). The scenarios
// that need frames, and the DOMException ones, which need the host's DOMException, run in the host's test.
const env = () => {
  const window = { addEventListener, dispatchEvent, innerWidth: 1280, innerHeight: 720 };
  return { document: new Document(window), MutationObserver, IntersectionObserver };
};

test('a fragment moves its children as in Edge, with the same return values and mutation records (G10)', () => {
  const result = mutations(env());
  for (const key of Object.keys(EDGE.mutations)) assert.deepEqual(result[key], EDGE.mutations[key], key);
});

test('mutation records reach observers in a microtask, in the order the observers were made', async () => {
  assert.deepEqual(await delivery(env()), EDGE.delivery);
});

test('IntersectionObserver takes Edge 157 options and throws its errors (G12)', () => {
  const result = observerOptions(env());
  for (const key of Object.keys(EDGE.observerOptions)) assert.deepEqual(result[key], EDGE.observerOptions[key], key);
});

test('the namespaced attribute methods read and write SVG and HTML attributes as in Edge (G13)', () => {
  const result = namespaces(env());
  // Edge's values were recorded through JSON, where a method's undefined return reads as null.
  assert.deepEqual(JSON.parse(JSON.stringify(result)), EDGE.namespaces);
});
