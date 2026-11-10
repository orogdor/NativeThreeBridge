import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass } from './helpers/webapp-node-host.mjs';

const fixture=fileURLToPath(new URL('./fixtures/k73-texture-array-dx12', import.meta.url));

test('K73 RGBA8 material array uploads both layers and binds same DX12 2D texture backend', async () => {
  const { status, context, rec }=await runWebapp(fixture, { frames: 40 });
  assert.equal(status.bootError, null);
  assert.deepEqual(status.errors, []);
  assert.equal(context.k73AtlasUploaded, 1);
  assert.equal(rec.textures.size, 1);
  const t=rec.textures.get(context.k73AtlasTextureId);
  assert.deepEqual({w:t.w,h:t.h,type:t.type,bytes:t.bytes},
    {w:2,h:4,type:'rgba',bytes:32});
  assert.equal(rec.uploads, 1, 'static geometry cached despite texture binding');
  assert.equal(rec.passes.length, 1);
  const p=decodePass(rec.passes[0]);
  assert.equal(p.draws[0].textureId, context.k73AtlasTextureId);
  assert.equal(p.draws[0].flags & 1048576, 1048576, 'K73 atlas material shader bit');
  assert.equal(p.draws[0].flags & 4096, 4096, 'native texture sample bit');
  assert.equal(p.draws[0].reflection[0], 2, 'two packed material layers');
  assert.equal(p.draws[0].count, 90);
  const mesh=[...rec.geometries.values()][0];
  assert.equal(mesh.vertexCount, 48);
  assert.equal(mesh.alphaMin, 0, 'material-class alpha preserved for atlas selection');
});
