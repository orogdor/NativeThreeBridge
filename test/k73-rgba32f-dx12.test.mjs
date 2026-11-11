import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runWebapp} from './helpers/webapp-node-host.mjs';

test('RGBA32F images and immutable bone textures retain actual float precision across partial updates',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'k73-rgba32f-'));
 try{
  const code=[
   "const gl=document.getElementById('gl').getContext('webgl2');",
   "const morph=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,morph);",
   "gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,2,2,0,gl.RGBA,gl.FLOAT,new Float32Array([-1.25,0.123456,3.5,1,4,5,6,7,8,9,10,11,12,13,14,15]));",
   "window.morphId=morph.id;",
   "const bones=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,bones);",
   "gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA32F,216,96);",
   "window.boneId=bones.id;",
   "const data=new Float32Array(216*4*3);data[216*4*2]=-31.625;data[216*4*2+5]=0.8765432;",
   "gl.texSubImage2D(gl.TEXTURE_2D,0,0,55,216,1,gl.RGBA,gl.FLOAT,data,216*4*2);",
   "window.floatTestReady=true;"
  ].join('\n');
  writeFileSync(join(dir,'index.html'),'<!doctype html><title>Float texture</title><canvas id="gl" data-native-webgl2-prototype width="480" height="320"></canvas><script>'+code+'</script>');
  const {context,status,rec}=await runWebapp(dir,{frames:2});
  assert.equal(status.bootError,null);assert.deepEqual(status.errors,[]);
  assert.equal(context.floatTestReady,true);
  const m=rec.textures.get(context.morphId), b=rec.textures.get(context.boneId);
  assert.equal(m.type,'rgba32f');assert.equal(b.type,'rgba32f');
  assert.equal(m.first[0],-1.25);
  assert.ok(Math.abs(m.first[1]-0.123456)<1e-7);
  assert.equal(b.w,216);assert.equal(b.h,96);
  assert.equal(b.pixels[55*216*4],-31.625);
  assert.ok(Math.abs(b.pixels[55*216*4+5]-0.8765432)<1e-7);
  assert.equal(b.pixels[54*216*4],0);
  assert.equal(rec.floatSubUploads,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
