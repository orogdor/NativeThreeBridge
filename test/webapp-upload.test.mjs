import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { decodePass, runWebapp, threeBuildDir } from './helpers/webapp-node-host.mjs';
import { DrawFlags } from '../js/native-renderer.mjs';

const fixture = fileURLToPath(new URL('./fixtures/webapp-upload', import.meta.url));
const skip = threeBuildDir() ? false : 'three.js build not installed';

test('opaque meshes batch in place and only visible static instance ranges are submitted', { skip }, async () => {
  const { rec, host, context, status } = await runWebapp(fixture, { frames: 3 });
  assert.deepEqual(status.errors, []);
  const draws = () => decodePass(rec.passes.at(-1)).draws;
  const first = draws();
  assert.equal(first.length, 6);
  const batch = first.find((d) => d.instanceCount === 24);
  assert.ok(batch?.instanceId > 0);
  assert.deepEqual(batch.matrix.slice(12, 15), [0, 0, 0]);
  assert.equal(first.filter((d) => d.flags & DrawFlags.TRANSPARENT).length, 2);
  assert.equal(first.find((d) => d.instanceCount === 64).firstInstance, 64);
  assert.equal(first.filter((d) => d.instanceCount === 256).length, 1, 'dynamic instances keep their full draw');

  context.moveVisibleChunk();
  host.frame(100);
  assert.equal(draws().filter((d) => d.instanceCount === 256).length, 2, 'changed transforms invalidate the old bounds');
  host.frame(116);
  assert.equal(draws().find((d) => d.instanceCount === 64).firstInstance, 128);
});
