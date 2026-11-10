import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runWebapp} from './helpers/webapp-node-host.mjs';

test('K73 SKIN morph texture offsets are read as RGBA32F before weighted bone transforms', async()=>{
 const source=readFileSync(fileURLToPath(new URL('./fixtures/k73-real-skin-dx12/index.html',import.meta.url)),'utf8').replace(/\r\n/g,'\n');
 const dir=mkdtempSync(join(tmpdir(),'k73-morph-'));
 try {
   const a="gl.uniform1i(gl.getUniformLocation(lit,'uMorphN'),0);\ngl.uniform4fv(gl.getUniformLocation(lit,'uMW'),new Float32Array(8));";
   const b=[
     "gl.uniform1i(gl.getUniformLocation(lit,'uMorphN'),8);",
     "gl.uniform4fv(gl.getUniformLocation(lit,'uMW'),new Float32Array([1,0,0,0,0,0,0,0]));",
     "const morph=gl.createTexture();gl.activeTexture(gl.TEXTURE5);gl.bindTexture(gl.TEXTURE_2D,morph);",
     "const morphData=new Float32Array(1024*8*4);morphData[0]=0.5;",
     "gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,1024,8,0,gl.RGBA,gl.FLOAT,morphData);",
     "gl.uniform1i(gl.getUniformLocation(lit,'uMorphTex'),5);gl.activeTexture(gl.TEXTURE0);",
   ].join('\n');
   assert.ok(source.includes(a));
   writeFileSync(join(dir,'index.html'),source.replace(a,b));
   const {status,rec}=await runWebapp(dir,{frames:4});
   assert.equal(status.bootError,null);assert.deepEqual(status.errors,[]);
   assert.ok(rec.uploads>=2,'morphed and un-morphed depth variants both submit geometry');
   const first=[...rec.geometries.values()][0].firstPositions;
   assert.deepEqual(first,[2.5,0,0,3,0,0,2,1,0]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
