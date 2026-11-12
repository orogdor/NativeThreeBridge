import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass, threeBuildDir } from './helpers/webapp-node-host.mjs';

test('actual native renderer draws Sapling-style LOD instance batches', { skip: !threeBuildDir() }, async () => {
  const fixture = fileURLToPath(new URL('./fixtures/webapp-lod', import.meta.url));
  const { status, context, rec } = await runWebapp(fixture, { frames: 5 });
  assert.deepEqual(status.errors, []);
  assert.ok(context.treeLodUpdates >= 1, 'LOD.update must be called');
  const pass = decodePass(rec.framePasses.at(-1) || rec.passes.at(-1));
  assert.ok(pass.draws.some((draw) => draw.instanceCount === 4), 'four visible tree instances must reach DX12 draw packet');
  assert.ok(!pass.draws.some((draw) => draw.instanceCount === 1 && draw.count === 36), 'fallback tree must be hidden');
});
