import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass } from './helpers/webapp-node-host.mjs';

const rock = fileURLToPath(new URL('./fixtures/k73-rock0-dx12', import.meta.url));

test('K73 real rock0 binary mesh and original LIT shader produce indexed native DX12 draw', async () => {
  const { status, context, rec } = await runWebapp(rock, { frames: 30 });
  assert.deepEqual(status.errors, []);
  assert.equal(status.bootError, null);
  assert.equal(context.k73ShaderTestReady, true);
  assert.equal(context.k73ShaderTestDraws, 30);
  assert.equal(rec.uploads, 1, 'rock geometry uploaded once, not every frame');
  const g = [...rec.geometries.values()][0];
  assert.equal(g.vertexCount, 48);
  assert.equal(g.indexCount, 90);
  assert.equal(g.hasNormals, true);
  assert.equal(g.colorChannels, 4);
  assert.equal(g.alphaMin, 1, 'K73 material ID byte must not become pixel alpha');
  assert.equal(rec.passes.length, 1);
  const pass = decodePass(rec.passes[0]);
  assert.equal(pass.draws.length, 1);
  assert.equal(pass.draws[0].count, 90);
  assert.equal(pass.draws[0].flags & 8, 8);
  assert.equal(pass.draws[0].flags & 16, 0);
  assert.equal(pass.lights.length, 1);
});
