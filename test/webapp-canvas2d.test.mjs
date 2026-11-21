// Canvas 2D shadows and createPattern reach the Direct2D executor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, threeBuildDir } from './helpers/webapp-node-host.mjs';

const fixture = fileURLToPath(new URL('./fixtures/webapp-canvas2d', import.meta.url));
const skip = threeBuildDir() ? false : 'three is not installed (npm install)';
const SHADOW = 43, FILL_STYLE = 3, FILL_RECT = 23, TEXT = 30;

test('canvas shadows are sent before the shapes they belong to', { skip }, async () => {
  const { rec, status } = await runWebapp(fixture, { frames: 2 });
  assert.equal(status.bootError, null);
  assert.ok(!status.unsupported.some((u) => /shadow|pattern/i.test(u)), status.unsupported.join(', '));
  const canvas = [...rec.canvases.values()].find((c) => c.width === 560);
  const ops = canvas.ops;
  const shadows = ops.filter((o) => o[0] === SHADOW).map((o) => o.slice(1));
  assert.ok(shadows[0].every((v) => v === 0), 'no shadow for the background');
  assert.deepEqual(shadows[1].slice(0, 3), [12, 8, 8], 'blur 12, offset 8,8');
  assert.ok(Math.abs(shadows[1][6] - 0.6) < 1e-6, 'shadow colour alpha');
  assert.ok(shadows.some((s) => s[0] === 0 && s[1] === 8 && s[6] === 1), 'hard blue shadow');
  assert.ok(shadows.some((s) => s[0] === 6 && s[1] === 3), 'text shadow');
  assert.ok(shadows.at(-1).every((v) => v === 0), 'restore() turns shadows off again');
  const textIndex = ops.findIndex((o) => o[0] === TEXT);
  const lastShadowBeforeText = ops.slice(0, textIndex).filter((o) => o[0] === SHADOW).at(-1);
  assert.equal(lastShadowBeforeText[1], 6);
});

test('createPattern fills use the canvas or image as a repeating brush', { skip }, async () => {
  const { rec } = await runWebapp(fixture, { frames: 2 });
  const canvas = [...rec.canvases.values()].find((c) => c.width === 560);
  const patterns = canvas.ops.filter((o) => o[0] === FILL_STYLE && o[1] === 3);
  assert.equal(patterns.length, 2);
  const [fromCanvas, fromImage] = patterns;
  assert.equal(fromCanvas[2], 1, 'canvas source');
  assert.ok(rec.canvases.has(fromCanvas[3]), 'names the checker canvas');
  assert.deepEqual(fromCanvas.slice(4, 6), [1, 1], 'repeat in x and y');
  assert.equal(fromImage[2], 0, 'image source');
  assert.deepEqual(fromImage.slice(6, 12), [1, 0, 0, 1, 0, 0], 'identity pattern matrix');
  assert.ok(canvas.ops.some((o) => o[0] === FILL_RECT));
});
