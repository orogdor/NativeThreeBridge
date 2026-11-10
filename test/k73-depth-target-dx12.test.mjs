import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runWebapp,decodePass} from './helpers/webapp-node-host.mjs';

function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'k73-depth-dsv-'));
 const vs=[
  'precision highp float;',
  'layout(location=0) in vec3 aPos;',
  'uniform mat4 uVP;uniform mat4 uModel;',
  'void main(){',
  '#ifdef SKIN',
  'mat4 M=uModel;',
  '#elif defined(INST)',
  'mat4 M=mat4(aM0,aM1,aM2,aM3);',
  '#else',
  'mat4 M = uModel;',
  '#endif',
  'gl_Position = uVP*(M*vec4(aPos,1.0));',
  '}'
 ].join('\n');
 const fs='precision mediump float; void main(){}';
 const code=[
  "const canvas=document.getElementById('gl'),gl=canvas.getContext('webgl2');",
  "function shader(t,s){const x=gl.createShader(t);gl.shaderSource(x,s);gl.compileShader(x);if(!gl.getShaderParameter(x,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(x));return x;}",
  'const v=shader(gl.VERTEX_SHADER,'+JSON.stringify('#version 300 es\n'+vs)+');',
  'const f=shader(gl.FRAGMENT_SHADER,'+JSON.stringify('#version 300 es\n'+fs)+');',
  "const p=gl.createProgram();gl.attachShader(p,v);gl.attachShader(p,f);gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));gl.useProgram(p);",
  'const depth=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,depth);',
  'gl.texStorage2D(gl.TEXTURE_2D,1,gl.DEPTH_COMPONENT24,128,128);',
  'gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);',
  'gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_COMPARE_MODE,gl.COMPARE_REF_TO_TEXTURE);',
  'gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_COMPARE_FUNC,gl.LEQUAL);',
  "window.depthId=depth.id; window.depthAllocations=gl.__nativeDepthAllocations;",
  'const fb=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fb);',
  'gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.TEXTURE_2D,depth,0);',
  'gl.drawBuffers([gl.NONE]);gl.readBuffer(gl.NONE);',
  "window.depthFboComplete=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;",
  'const vao=gl.createVertexArray();gl.bindVertexArray(vao);',
  'const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);',
  'gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-0.7,-0.7,0,0.7,-0.7,0,0,0.7,0]),gl.STATIC_DRAW);',
  'gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);',
  'const e=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,e);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array([0,1,2]),gl.STATIC_DRAW);',
  "const I=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);gl.uniformMatrix4fv(gl.getUniformLocation(p,'uVP'),false,I);gl.uniformMatrix4fv(gl.getUniformLocation(p,'uModel'),false,I);",
  "function frame(){gl.viewport(0,0,128,128);gl.clear(gl.DEPTH_BUFFER_BIT);gl.drawElements(gl.TRIANGLES,3,gl.UNSIGNED_SHORT,0);window.depthDrawCount=gl.__nativeDraws;requestAnimationFrame(frame);}requestAnimationFrame(frame);"
 ].join('\n');
 writeFileSync(join(dir,'index.html'),'<!doctype html><title>K73 DX12 depth target test</title><canvas id="gl" data-native-webgl2-prototype width="800" height="600"></canvas><script>'+code+'</script>');
 return dir;
}
test('WebGL2 depth storage creates native D32 target and routes depth-only draws offscreen',async()=>{
 const dir=fixture();
 try {
  const {status,context,rec}=await runWebapp(dir,{frames:15});
  assert.equal(status.bootError,null);
  assert.deepEqual(status.errors,[]);
  assert.equal(context.depthFboComplete,true);
  assert.equal(context.depthAllocations,1);
  assert.equal(rec.depthTargets.size,1);
  assert.deepEqual(rec.depthTargets.get(context.depthId),{width:128,height:128,format:'D32_FLOAT'});
  assert.ok(context.depthDrawCount>=12);
  assert.equal(rec.uploads,1);
  const p=rec.passes[0];
  assert.equal(p[55],context.depthId,'target id stored in reserved native packet header');
  const draw=decodePass(p).draws[0];
  assert.equal(draw.count,3);
  assert.equal(draw.instanceCount,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('WebGL2 depth storage validation rejects unsupported formats before allocating',async()=>{
 const dir=fixture();
 try{
  const {context,rec}=await runWebapp(dir,{frames:1});
  const gl=context.document.getElementById('gl').getContext('webgl2');
  const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);
  assert.throws(()=>gl.texStorage2D(gl.TEXTURE_2D,1,0x881A,64,64),/only level-1 DEPTH_COMPONENT24/);
  assert.equal(rec.depthTargets.size,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
