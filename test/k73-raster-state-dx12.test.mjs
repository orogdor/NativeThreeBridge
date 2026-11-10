import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWebapp, decodePass } from './helpers/webapp-node-host.mjs';

test('K73 WebGL2 depth/blend/cull/polygon state alters native DX12 draw flags, not merely JS bookkeeping', async () => {
 const dir=mkdtempSync(join(tmpdir(),'k73-raster-'));
 try {
  const vs='#version 300 es\nlayout(location=0) in vec3 aPos; void main(){gl_Position=vec4(aPos,1.0);}';
  const fs='#version 300 es\nprecision mediump float; out vec4 oC;void main(){oC=vec4(0.25,0.35,0.45,1.0);}';
  const code=[
   "const gl=document.getElementById('gl').getContext('webgl2');",
   "function sh(type,src){const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;}",
   "const p=gl.createProgram();gl.attachShader(p,sh(gl.VERTEX_SHADER,"+JSON.stringify(vs)+"));gl.attachShader(p,sh(gl.FRAGMENT_SHADER,"+JSON.stringify(fs)+"));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));gl.useProgram(p);",
   "const vao=gl.createVertexArray();gl.bindVertexArray(vao);const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-0.5,-0.5,0,0.5,-0.5,0,0,0.5,0]),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);",
   "window.invalidRasterRejected=false;try{gl.enable(0xDEAD);}catch(e){window.invalidRasterRejected=true;}",
   "function frame(){",
   "gl.drawArrays(gl.TRIANGLES,0,3);",
   "gl.enable(gl.DEPTH_TEST);gl.enable(gl.CULL_FACE);gl.depthMask(false);gl.drawArrays(gl.TRIANGLES,0,3);",
   "gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.drawArrays(gl.TRIANGLES,0,3);",
   "gl.blendFunc(gl.ONE,gl.ONE);gl.drawArrays(gl.TRIANGLES,0,3);",
   "gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(1.6,3.0);gl.drawArrays(gl.TRIANGLES,0,3);",
   "gl.frontFace(gl.CW);gl.cullFace(gl.FRONT);gl.drawArrays(gl.TRIANGLES,0,3);",
   "gl.disable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.disable(gl.BLEND);gl.disable(gl.POLYGON_OFFSET_FILL);gl.depthMask(true);gl.frontFace(gl.CCW);gl.cullFace(gl.BACK);gl.drawArrays(gl.TRIANGLES,0,3);",
   "window.defaultDepthDisabled=!gl.isEnabled(gl.DEPTH_TEST);requestAnimationFrame(frame);",
   "}requestAnimationFrame(frame);"
  ].join('\n');
  writeFileSync(join(dir,'index.html'),'<!doctype html><title>DX12 raster state</title><canvas id="gl" data-native-webgl2-prototype width="640" height="480"></canvas><script>'+code+'</script>');
  const {status,context,rec}=await runWebapp(dir,{frames:5});
  assert.equal(status.bootError,null);
  assert.deepEqual(status.errors,[]);
  assert.equal(context.invalidRasterRejected,true);
  assert.equal(context.defaultDepthDisabled,true);
  assert.equal(rec.uploads,1);
  assert.equal(rec.passes.length,7);
  const flags=rec.passes.map(p=>decodePass(p).draws[0].flags);
  const has=(i,bit)=>(flags[i]&bit)!==0;
  assert.equal(has(0,2),true,'WebGL culling initially off');
  assert.equal(has(0,64),true,'WebGL depth test initially off');
  assert.equal(has(0,32),false,'WebGL default depth write on');
  assert.equal(has(1,2),false,'enabled cull removes double-sided flag');
  assert.equal(has(1,64),false,'enabled depth removes no-depth-test flag');
  assert.equal(has(1,32),true,'depthMask(false) removes depth writes');
  assert.equal(has(2,1),true,'alpha blending enabled');
  assert.equal(has(2,4194304),false,'normal alpha blending is not additive');
  assert.equal(has(3,4194304),true,'ONE,ONE additive blend flag');
  assert.equal(has(4,8388608),true,'shadow polygon offset flag');
  assert.equal(has(5,4),true,'front-face culling');
  assert.equal(has(5,16777216),true,'CW winding');
  assert.equal(has(6,1),false,'blend disabled');
  assert.equal(has(6,32),false,'depth write restored');
  assert.equal(has(6,64),true,'depth test disabled again');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
