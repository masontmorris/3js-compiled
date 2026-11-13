import test from 'node:test';
import assert from 'node:assert/strict';

test('browser dispatch reports a listener error and reaches later listeners', async () => {
  let dispatch;
  globalThis.window = { addEventListener: (_, callback) => { dispatch = callback; } };
  const errors = [];
  globalThis.reportError = error => errors.push(error);
  try {
    const { bridge } = await import('../src/bridge.js');
    const error = new Error('listener failed');
    const received = [];
    const removeFirst = bridge.onEvent(() => { throw error; });
    const removeSecond = bridge.onEvent(value => received.push(value));
    dispatch({ data: 'hello' });
    assert.deepEqual(errors, [error]);
    assert.deepEqual(received, ['hello']);
    removeFirst();
    removeSecond();
  } finally {
    delete globalThis.window;
    delete globalThis.reportError;
  }
});
