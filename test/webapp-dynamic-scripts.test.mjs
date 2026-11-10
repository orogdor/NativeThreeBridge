import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp } from './helpers/webapp-node-host.mjs';

const folder = fileURLToPath(new URL('./fixtures/webapp-dynamic-scripts', import.meta.url));

test('connected dynamically appended scripts execute in order and signal load/error', async () => {
  const { context: w, status } = await runWebapp(folder, { frames: 25 });
  assert.equal(status.booted, true);
  assert.equal(status.bootError, null);
  assert.equal(w.document.title, 'Dynamic scripts ready');
  assert.equal(w.document.getElementById('status').textContent, 'Ready');
  assert.deepEqual([...w.scriptOrder], [
    'boot', 'first', 'loaded:first.js', 'second', 'loaded:second.js',
    'inline', 'error:not-a-file.js',
  ]);
  assert.equal(w.dynamicErrorReceived, true);
  assert.equal(w.firstDynamicValue, 42);
});

test('WebGL2 must not appear available without a real GPU-backed implementation', async () => {
  const { context: w } = await runWebapp(folder, { frames: 2 });
  const canvas = w.document.createElement('canvas');
  assert.equal(canvas.getContext('webgl2'), null);
});
