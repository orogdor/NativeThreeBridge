import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass } from './helpers/webapp-node-host.mjs';
const fixture=fileURLToPath(new URL('./fixtures/k73-lit-dx12',import.meta.url));

test('recognized K73 vertex/fragment GLSL uniform contract routes indexed coloured mesh into existing DX12 pipeline',async()=>{
 const {rec,context,status}=await runWebapp(fixture,{frames:8});
 assert.equal(status.bootError,null);
 assert.deepEqual(status.errors,[]);
 assert.equal(context.__k73LitTest.drawn,8);
 assert.equal(rec.uploads,1,'unchanged indexed geometry reuses one native upload');
 assert.equal(rec.geometries.size,1);
 assert.equal(rec.passes.length,1);
 const pass=decodePass(rec.passes[0]);
 assert.equal(pass.draws.length,1);
 assert.equal(pass.draws[0].count,3);
 assert.ok(Math.abs(pass.draws[0].color[0]-0.8)<1e-5);
 assert.ok(Math.abs(pass.draws[0].color[1]-0.6)<1e-5);
 assert.equal(pass.draws[0].flags & 8,8,'native vertex colour flag enabled');
 assert.equal(pass.draws[0].flags & 16,0,'native HLSL lit path, not flat unlit');
 assert.equal(rec.geometries.values().next().value.indexCount,3);
 assert.equal(rec.geometries.values().next().value.colorChannels,4);
 assert.equal(rec.geometries.values().next().value.alphaMin,1,
   'K73 material IDs in vertex alpha are not treated as opacity');
});
