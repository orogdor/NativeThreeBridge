import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runWebapp,decodePass} from './helpers/webapp-node-host.mjs';

// Uses a real K73-style WebGL2 depth shader and six live DSV resources.
// A mock-only test would miss Float32 packet conversion failures.

test('consecutive K73 depth IDs survive actual Float32 packet packing and native resource lookup',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'k73-id-precision-'));
 try {
  const vs = [
   'precision highp float;',
   'layout(location=0) in vec3 aPos;',
   'uniform mat4 uVP;uniform mat4 uModel;',
   'void main(){mat4 M = uModel;gl_Position = uVP*(M*vec4(aPos,1.0));}'
  ].join('\n');
  const fs='precision mediump float; void main(){}';
  const js=[
   "const gl=document.getElementById('gl').getContext('webgl2');",
   "function sh(t,s){let x=gl.createShader(t);gl.shaderSource(x,s);gl.compileShader(x);if(!gl.getShaderParameter(x,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(x));return x;}",
   "const p=gl.createProgram();gl.attachShader(p,sh(gl.VERTEX_SHADER,"+JSON.stringify('#version 300 es\n'+vs)+"));gl.attachShader(p,sh(gl.FRAGMENT_SHADER,"+JSON.stringify('#version 300 es\n'+fs)+"));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));gl.useProgram(p);",
   "const textures=[];const fbs=[];for(let i=0;i<6;i++){let t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texStorage2D(gl.TEXTURE_2D,1,gl.DEPTH_COMPONENT24,64,64);textures.push(t);let f=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,f);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.TEXTURE_2D,t,0);gl.drawBuffers([gl.NONE]);gl.readBuffer(gl.NONE);fbs.push(f);}",
   "window.targetIds=textures.map(t=>t.id);window.complete=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;",
   "const vao=gl.createVertexArray();gl.bindVertexArray(vao);let b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-0.7,-0.7,0,0.7,-0.7,0,0,0.7,0]),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);",
   "let e=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,e);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array([0,1,2]),gl.STATIC_DRAW);",
   "const I=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);gl.uniformMatrix4fv(gl.getUniformLocation(p,'uVP'),false,I);gl.uniformMatrix4fv(gl.getUniformLocation(p,'uModel'),false,I);",
   "let f=0;function frame(){gl.bindFramebuffer(gl.FRAMEBUFFER,fbs[f%6]);gl.viewport(0,0,64,64);gl.clear(gl.DEPTH_BUFFER_BIT);gl.drawElements(gl.TRIANGLES,3,gl.UNSIGNED_SHORT,0);f++;requestAnimationFrame(frame);}requestAnimationFrame(frame);"
  ].join('\n');
  writeFileSync(join(dir,'index.html'),'<!doctype html><title>K73 float32 resource ID regression</title><canvas id="gl" data-native-webgl2-prototype width="800" height="600"></canvas><script>'+js+'</script>');
  const observed=[];
  const {status,context,rec}=await runWebapp(dir,{frames:18,
    onFrame:({rec})=>{if(rec.framePasses.length)observed.push(...rec.framePasses);}
  });
  assert.equal(status.bootError,null);
  assert.deepEqual(status.errors,[]);
  assert.equal(context.complete,true);
  assert.equal(rec.depthTargets.size,6);
  assert.ok(observed.length>=12, 'multiple real frames recorded');
  const ids=Array.from(context.targetIds);
  assert.equal(new Set(ids).size,6);
  assert.deepEqual(ids,[7000000,7000001,7000002,7000003,7000004,7000005]);
  assert.deepEqual(Array.from(Float32Array.from(ids)),ids,'no float32 identifier aliasing');
  const packed=observed.map(p=>p[55]);
  const cycle=packed.slice(0,6);
  assert.deepEqual(cycle,ids,'six native passes refer to the correct DSV resources');
  assert.ok(packed.every((id,i)=>id===ids[i%6]));
  for(const id of packed) assert.ok(rec.depthTargets.has(id),'native target exists');
  for(const p of observed) {
    const draw=decodePass(p).draws[0];
    assert.equal(draw.count,3);
    assert.ok(Number.isSafeInteger(draw.geometryId),'geometry ID retained as integer');
    assert.ok(draw.geometryId>=9000000 && draw.geometryId<=10999999);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
