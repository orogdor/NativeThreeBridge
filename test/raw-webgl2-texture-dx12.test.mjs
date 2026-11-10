import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass } from './helpers/webapp-node-host.mjs';

const fixture = fileURLToPath(new URL('./fixtures/raw-webgl2-texture-dx12', import.meta.url));

test('RG8B8 Texture2D pixel data is GPU-uploaded and sampled by existing DX12 sampler', async () => {
  const { status, context, rec } = await runWebapp(fixture, { frames: 35 });
  assert.equal(status.booted, true);
  assert.deepEqual(status.errors, []);
  assert.equal(context.textureStatus.drawCount, 35);
  assert.equal(context.textureStatus.nativeUploadCount, 1, 'only 2D texture uploaded; 2-layer array CPU staging');
  assert.equal(context.textureStatus.stackDepth, 2);
  assert.deepEqual([...context.textureStatus.stackSecondPixel], [128, 80, 60, 255]);
  assert.equal(rec.textureUploads, 1);
  assert.equal(rec.textures.size, 1);
  const tex = [...rec.textures.values()][0];
  assert.deepEqual([tex.w, tex.h, tex.bytes], [2, 2, 16]);
  assert.equal(rec.uploads, 1);
  const geo = [...rec.geometries.values()][0];
  assert.equal(geo.vertexCount, 4);
  assert.equal(geo.indexCount, 6);
  assert.equal(geo.hasUvs, true);
  assert.equal(rec.passes.length, 1);
  const p = decodePass(rec.passes[0]);
  assert.equal(p.draws.length, 1);
  assert.equal(p.draws[0].count, 6);
  assert.equal(p.draws[0].flags & 4096, 4096, 'must set real native Texture2D F_MAP flag');
  assert.ok(rec.textures.has(p.draws[0].textureId), 'draw packet must point at uploaded DX12 resource');
});

test('non-opt-in canvas does not expose fake WebGL2 textures', async () => {
  const { context } = await runWebapp(fixture, { frames: 2 });
  assert.equal(context.document.createElement('canvas').getContext('webgl2'), null);
});
