import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass } from './helpers/webapp-node-host.mjs';
const fixture = fileURLToPath(new URL('./fixtures/raw-webgl2-dx12', import.meta.url));

test('opt-in raw WebGL2 triangle uses existing NativeRenderer DX12 packet and caches geometry', async () => {
  const { context, rec, status } = await runWebapp(fixture, { frames: 15 });
  assert.equal(status.bootError, null);
  assert.deepEqual(status.errors, []);
  assert.equal(context.rawPrototypeReady, true);
  assert.ok(context.rawPrototypeDraws >= 12);
  assert.equal(rec.uploads, 1, 'unchanged geometry uploaded once, reused on subsequent frames');
  assert.equal(rec.geometries.size, 1);
  assert.equal(rec.passes.length, 1);
  const pass = decodePass(rec.passes[0]);
  assert.equal(pass.draws.length, 1);
  assert.equal(pass.draws[0].count, 3);
  assert.equal(pass.draws[0].geometryId, [...rec.geometries.keys()][0]);
  assert.equal(pass.draws[0].flags & 16, 16, 'uses existing native UNLIT flag');
  assert.equal(pass.draws[0].color[0], 1);
  assert.ok(Math.abs(pass.draws[0].color[1] - 0.15) < 0.001);
  assert.deepEqual(pass.size, [640, 480]);
});

test('non-opt-in raw WebGL2 remains unavailable instead of pretending to support K73 GLSL', async () => {
  const { context } = await runWebapp(fixture, { frames: 2 });
  assert.equal(context.document.createElement('canvas').getContext('webgl2'), null);
  const gl = context.document.querySelector('#raw').getContext('webgl2');
  const shader = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(shader, '#version 300 es\nlayout(location=0) in vec3 pos; uniform mat4 m;\nvoid main(){gl_Position=m*vec4(pos,1.0);}');
  gl.compileShader(shader);
  assert.equal(gl.getShaderParameter(shader, gl.COMPILE_STATUS), false);
  assert.match(gl.getShaderInfoLog(shader), /Unsupported GLSL/i);
});
