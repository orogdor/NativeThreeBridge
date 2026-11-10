import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass } from './helpers/webapp-node-host.mjs';

const fixture = fileURLToPath(new URL('./fixtures/k73-real-particle-dx12', import.meta.url));

test('original K73 PART shaders map three billboard particles to one native DX12 instanced draw', async () => {
  const {status, context, rec} = await runWebapp(fixture,{frames:24});
  assert.equal(status.booted,true);
  assert.equal(status.bootError,null);
  assert.deepEqual(status.errors,[]);
  assert.equal(context.particleShaderLinked,true);
  assert.ok(context.particleDrawCount>=20);
  assert.ok(status.unsupported.includes('K73 particle GLSL approximation'));
  assert.equal(rec.geometries.size,1);
  assert.equal(rec.uploads,1,'static billboard geometry uploads once');
  const geo=[...rec.geometries.values()][0];
  assert.equal(geo.vertexCount,6);
  assert.equal(rec.instanceUploads,2,'updated particle positions cause exactly one additional upload');
  assert.equal(rec.instances.size,1);
  const instance=[...rec.instances.values()][0];
  assert.equal(instance.count,3);
  assert.equal(instance.hasColors,true);
  assert.equal(rec.passes.length,1);
  const pass=decodePass(rec.passes[0]);
  assert.equal(pass.draws.length,1);
  const draw=pass.draws[0];
  assert.equal(draw.count,6);
  assert.equal(draw.instanceCount,3);
  assert.ok(draw.instanceId>0);
  assert.equal(draw.flags & 1,1,'transparent');
  assert.equal(draw.flags & 2,2,'double-sided');
  assert.equal(draw.flags & 16,16,'unlit');
  assert.equal(draw.flags & 32,32,'no depth writes');
  assert.equal(draw.flags & 1024,1024,'GPU instance colours');
  assert.ok(Math.abs(draw.opacity-0.6)<0.0001,'per-pool alpha approximates the shared opacity');
});

test('unmatched non-K73 particle GLSL must not link', async () => {
  const {context} = await runWebapp(fixture,{frames:1});
  const gl=context.document.getElementById('gl').getContext('webgl2');
  const v=gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(v,'#version 300 es\nlayout(location=0) in vec2 aC; layout(location=1) in vec4 aPS; uniform mat4 uVP;void main(){gl_Position=uVP*vec4(aC,0.0,1.0);}');
  gl.compileShader(v);
  assert.equal(gl.getShaderParameter(v,gl.COMPILE_STATUS),false);
});
