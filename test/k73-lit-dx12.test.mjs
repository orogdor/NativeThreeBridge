import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass } from './helpers/webapp-node-host.mjs';

const k73 = fileURLToPath(new URL('./fixtures/k73-real-lit-dx12', import.meta.url));

test('exact K73 v86 LIT shaders use existing DX12 pass for indexed RGBA8 mesh', async () => {
  const { status, context, rec } = await runWebapp(k73, { frames: 40 });
  assert.equal(status.booted, true);
  assert.deepEqual(status.errors, []);
  assert.equal(status.bootError, null);
  assert.equal(context.k73ShaderTestReady, true);
  assert.ok(context.k73ShaderTestDraws >= 35, 'drawElements must submit repeatedly');
  assert.equal(rec.uploads, 1, 'static K73 geometry should be uploaded only once');
  assert.equal(rec.geometries.size, 1);
  const g = [...rec.geometries.values()][0];
  assert.equal(g.vertexCount, 3);
  assert.equal(g.indexCount, 3);
  assert.equal(g.hasNormals, true);
  assert.equal(g.colorChannels, 4);
  assert.equal(g.alphaMin, 1, 'K73 vertex alpha encodes material, not opacity');
  assert.equal(g.alphaMax, 1);
  assert.equal(rec.passes.length, 1);
  const p = decodePass(rec.passes[0]);
  assert.equal(p.size[0], 800);
  assert.equal(p.size[1], 600);
  assert.equal(p.draws.length, 1);
  assert.equal(p.draws[0].count, 3);
  assert.equal(p.draws[0].flags & 8, 8, 'native DX12 material uses vertex colours');
  assert.equal(p.draws[0].flags & 16, 0, 'K73 lit material is not unlit');
  assert.equal(p.lights.length, 1, 'sunlight is submitted as a native directional light');
  assert.ok(Math.abs(p.draws[0].color[0] - 0.9) < 0.001);
  assert.ok(Math.abs(p.draws[0].color[1] - 0.8) < 0.001);
  assert.equal(p.draws[0].opacity, 1);
});

test('full K73 still fails honestly on unsupported 3D texture setup, not a false success', async () => {
  const { context } = await runWebapp(k73, { frames: 3 });
  const gl = context.document.querySelector('#gl').getContext('webgl2');
  const shader = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(shader, '#version 300 es\nlayout(location=0) in vec3 aPos; uniform mat4 uVP;\nvoid main(){gl_Position=uVP*vec4(aPos,1.0);}');
  gl.compileShader(shader);
  assert.equal(gl.getShaderParameter(shader, gl.COMPILE_STATUS), false,
    'unsupported arbitrary shader programs must be rejected');
});
