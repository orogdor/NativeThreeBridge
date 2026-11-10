import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { performance } from 'node:perf_hooks';

function bootShim() {
  const source = readFileSync(new URL('../js/webapp-shim.js', import.meta.url), 'utf8');
  const context = {
    __nt: { log() {}, setTitle() {}, readText() { return ''; }, readBinary() { return new ArrayBuffer(0); } },
    performance, URL, TextEncoder, TextDecoder,
  };
  runInNewContext(source, context, { filename: 'webapp-shim.js' });
  return context;
}

test('3D RAF and game timers run on every frame even when the UI is capped', () => {
  const window = bootShim(), host = window.__ntHost;
  let uiFrames = 0, gameFrames = 0, timerHits = 0;
  host.ui = { frame() { uiFrames++; }, invalidate() {} };
  const render = () => { gameFrames++; window.requestAnimationFrame(render); };
  window.requestAnimationFrame(render);
  window.setInterval(() => { timerHits++; }, 10);
  host.frame(0, true);
  host.frame(16, false);
  host.frame(32, false);
  host.frame(34, true);
  host.frame(50, false);
  assert.equal(gameFrames, 5, '3D callbacks must not be rate-limited');
  assert.equal(uiFrames, 2, 'UI advances only when explicitly scheduled');
  assert.ok(timerHits >= 3, 'UI throttling must not stop game timers');
});

test('legacy one-argument frame() still refreshes the UI each frame', () => {
  const window = bootShim(), host = window.__ntHost;
  let uiFrames = 0;
  host.ui = { frame() { uiFrames++; }, invalidate() {} };
  host.frame(0);
  host.frame(16);
  host.frame(32);
  assert.equal(uiFrames, 3);
});
