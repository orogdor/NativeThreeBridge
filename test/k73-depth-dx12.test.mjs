import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWebapp, decodePass } from './helpers/webapp-node-host.mjs';

// Exact public K73 v86 DEPTH_VS GLSL structure (SKIN branches deliberately
// remain in the source, but must not be enabled for this native profile).
const vs = [
  'precision highp float;',
  'layout(location=0) in vec3 aPos;',
  '#ifdef INST',
  'layout(location=3) in vec4 aM0;',
  'layout(location=4) in vec4 aM1;',
  'layout(location=5) in vec4 aM2;',
  'layout(location=6) in vec4 aM3;',
  '#endif',
  '#ifdef SKIN',
  'layout(location=3) in vec4 aJ;',
  'layout(location=4) in vec4 aW;',
  'uniform vec4 uB[96];',
  'mat4 boneM(float j){ int i=int(j+0.5)*3; vec4 a=uB[i],b=uB[i+1],c=uB[i+2]; return mat4(a.x,b.x,c.x,0.0,a.y,b.y,c.y,0.0,a.z,b.z,c.z,0.0,a.w,b.w,c.w,1.0); }',
  '#endif',
  'uniform mat4 uVP; uniform mat4 uModel;',
  'void main(){',
  '#ifdef SKIN',
  'mat4 M = uModel*(boneM(aJ.x)*aW.x + boneM(aJ.y)*aW.y + boneM(aJ.z)*aW.z + boneM(aJ.w)*aW.w);',
  '#elif defined(INST)',
  'mat4 M = mat4(aM0,aM1,aM2,aM3);',
  '#else',
  'mat4 M = uModel;',
  '#endif',
  'gl_Position = uVP*(M*vec4(aPos,1.0));',
  '}',
].join('\n');
const fs = 'precision mediump float; void main(){}';
const I = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];

async function render(instanced, definition = '') {
  const dir = mkdtempSync(join(tmpdir(), 'k73-depth-'));
  const vsource = '#version 300 es\n' + definition + vs;
  const fsource = '#version 300 es\n' + fs;
  const body = [
    "const canvas=document.getElementById('gl'),gl=canvas.getContext('webgl2');",
    "function compile(type,src){const sh=gl.createShader(type);gl.shaderSource(sh,src);gl.compileShader(sh);if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(sh));return sh;}",
    'const v=compile(gl.VERTEX_SHADER,' + JSON.stringify(vsource) + ');',
    'const f=compile(gl.FRAGMENT_SHADER,' + JSON.stringify(fsource) + ');',
    'const p=gl.createProgram();gl.attachShader(p,v);gl.attachShader(p,f);gl.linkProgram(p);',
    'window.k73DepthProgramLinked=gl.getProgramParameter(p,gl.LINK_STATUS);',
    'if(!window.k73DepthProgramLinked)throw Error(gl.getProgramInfoLog(p));gl.useProgram(p);',
    'const vao=gl.createVertexArray();gl.bindVertexArray(vao);',
    'const pos=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,pos);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-0.7,-0.7,0,0.7,-0.7,0,0,0.7,0]),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);',
    'const idx=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,idx);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array([0,1,2]),gl.STATIC_DRAW);',
    'const I=new Float32Array(' + JSON.stringify(I) + ');',
    "gl.uniformMatrix4fv(gl.getUniformLocation(p,'uVP'),false,I);",
    "gl.uniformMatrix4fv(gl.getUniformLocation(p,'uModel'),false,I);",
  ];
  if (instanced) body.push(
    'const inst=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,inst);gl.bufferData(gl.ARRAY_BUFFER,160,gl.DYNAMIC_DRAW);',
    'const data=new Float32Array(40);for(let n=0;n<2;n++){data.set(I,n*20);data[n*20+12]=n*0.4;data.set([1,1,1,0],n*20+16);}',
    'gl.bufferSubData(gl.ARRAY_BUFFER,0,data);',
    'for(let j=0;j<5;j++){gl.enableVertexAttribArray(j+3);gl.vertexAttribPointer(j+3,4,gl.FLOAT,false,80,j*16);gl.vertexAttribDivisor(j+3,1);}',
  );
  body.push('function frame(){gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);' +
    (instanced ? 'gl.drawElementsInstanced(gl.TRIANGLES,3,gl.UNSIGNED_SHORT,0,2);' :
      'gl.drawElements(gl.TRIANGLES,3,gl.UNSIGNED_SHORT,0);') +
    'requestAnimationFrame(frame);}requestAnimationFrame(frame);');
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>K73 depth GLSL test</title><canvas id="gl" data-native-webgl2-prototype width="800" height="600"></canvas><script>' + body.join('\n') + '</script>');
    return await runWebapp(dir, { frames: 12 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('K73 DEPTH_VS/DEPTH_FS compile as a matched profile with the original uVP/uModel matrices', async () => {
  const {context, status, rec} = await render(false);
  assert.equal(status.booted, true);
  assert.equal(status.bootError, null);
  assert.deepEqual(status.errors, []);
  assert.equal(context.k73DepthProgramLinked, true);
  assert.ok(rec.passes.length, 'matched depth shader submits a native geometry packet');
  const p = decodePass(rec.passes[0]);
  assert.equal(p.draws.length, 1);
  assert.equal(p.draws[0].count, 3);
  assert.equal(p.draws[0].instanceCount, 1);
  assert.equal(rec.uploads, 1);
  assert.ok(status.unsupported.includes('K73 shadow depth framebuffer'), 'depth shader recognition must report absent shadow FBO support');
});

test('K73 INST depth vertex shader uses a single native draw with two GPU instances', async () => {
  const {context, status, rec} = await render(true, '#define INST 1\n');
  assert.deepEqual(status.errors, []);
  assert.equal(context.k73DepthProgramLinked, true);
  assert.equal(rec.instanceUploads, 1);
  assert.equal(rec.instances.size, 1);
  assert.equal(rec.uploads, 1);
  const p = decodePass(rec.passes[0]);
  assert.equal(p.draws.length, 1);
  assert.equal(p.draws[0].instanceCount, 2);
  assert.ok(p.draws[0].instanceId > 0);
});
