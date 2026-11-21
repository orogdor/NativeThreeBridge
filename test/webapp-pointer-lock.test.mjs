// Pointer Lock and Fullscreen: the page asks, the engine pins the cursor
// and sends raw movement; Escape / focus loss end it.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWebapp, threeBuildDir } from './helpers/webapp-node-host.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = threeBuildDir() ? false : 'three is not installed (npm install)';
const tick = () => new Promise((r) => setTimeout(r, 5));

test('requestPointerLock, movement events, engine-side release and fullscreen', { skip }, async () => {
  const calls = [];
  let allow = true;
  const { context, status } = await runWebapp(path.join(repo, 'samples/hello-webapp'), {
    frames: 2,
    natives: ({ nt }) => {
      nt.setPointerLock = (on) => { calls.push(['lock', on]); return allow; };
      nt.setFullscreen = (on) => { calls.push(['fullscreen', on]); return true; };
    },
  });
  assert.equal(status.bootError, null);
  const { document } = context;
  const host = context.__ntHost;
  const canvas = document.querySelector('canvas');
  const seen = [];
  document.addEventListener('pointerlockchange', () => seen.push(['change', document.pointerLockElement === canvas]));
  document.addEventListener('mousemove', (e) => seen.push(['move', e.movementX, e.movementY, e.target === canvas]));
  assert.equal(document.pointerLockEnabled, true);
  await canvas.requestPointerLock();
  assert.equal(document.pointerLockElement, canvas);
  await tick();
  host.pointerMovement(7, -3);
  host.lockChanged(false, false); // Escape in the engine
  await tick();
  assert.equal(document.pointerLockElement, null);
  assert.deepEqual(seen, [['change', true], ['move', 7, -3, true], ['change', false]]);

  allow = false;
  let error = null;
  document.addEventListener('pointerlockerror', () => { error = 'event'; });
  await canvas.requestPointerLock().catch((e) => { error = error || e.name; });
  await tick();
  assert.equal(error, 'event');
  assert.equal(document.pointerLockElement, null);

  let fullscreenChanges = 0;
  document.addEventListener('fullscreenchange', () => fullscreenChanges++);
  await document.documentElement.requestFullscreen();
  assert.equal(document.fullscreenElement, document.documentElement);
  await document.exitFullscreen();
  await tick();
  assert.equal(document.fullscreenElement, null);
  assert.equal(fullscreenChanges, 2);
  assert.deepEqual(calls, [['lock', true], ['lock', true], ['fullscreen', true], ['fullscreen', false]]);
});
