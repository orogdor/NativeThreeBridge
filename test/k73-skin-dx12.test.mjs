import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {runWebapp,decodePass} from './helpers/webapp-node-host.mjs';

const fixture=fileURLToPath(new URL('./fixtures/k73-real-skin-dx12',import.meta.url));

test('K73 original SKIN LIT/DEPTH shader pairs deform packed joints/weights with uniform bone matrices',async()=>{
 const {context,status,rec}=await runWebapp(fixture,{frames:8});
 assert.equal(status.bootError,null);
 assert.deepEqual(status.errors,[]);
 assert.equal(context.skinLinked,true);
 assert.equal(context.depthSkinLinked,true);
 assert.ok(context.skinDraws>=12);
 assert.ok(status.unsupported.includes('K73 CPU skinning fallback'));
 assert.equal(rec.uploads,1,'unchanged pose should upload a single geometry even across lit/depth draws');
 assert.equal(rec.geometries.size,1);
 const g=[...rec.geometries.values()][0];
 assert.equal(g.vertexCount,3);
 assert.equal(g.indexCount,3);
 assert.equal(g.hasUvs,true);
 assert.equal(g.hasNormals,true);
 assert.deepEqual(g.firstPositions,[2,0,0,3,0,0,2,1,0]);
 assert.ok(Math.abs(g.firstNormals[2]-1)<1e-7);
 assert.equal(rec.passes.length,2);
 const draws=rec.passes.map(p=>decodePass(p).draws[0]);
 assert.equal(draws[0].count,3);
 assert.equal(draws[1].count,3);
 assert.equal(draws[1].flags & 4096,4096,'skinned albedo texture bound as mapped native draw');
});
