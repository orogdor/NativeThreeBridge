import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass } from './helpers/webapp-node-host.mjs';

const fixture = fileURLToPath(new URL('./fixtures/k73-real-sky-dx12', import.meta.url));

test('K73 original procedural sky GLSL is explicitly mapped to native DX12 sky gradient', async () => {
  const { status, context, rec } = await runWebapp(fixture, {frames: 24});
  assert.equal(status.booted, true);
  assert.equal(status.bootError, null);
  assert.deepEqual(status.errors, []);
  assert.equal(context.skyShaderLinked, true);
  assert.ok(context.skyDrawCount >= 20);
  assert.ok(status.unsupported.includes('K73 sky shader approximation'));
  assert.equal(rec.geometries.size, 1, 'sky geometry reused');
  assert.equal(rec.uploads, 2, 'dynamic zenith colour uploads exactly once after uniform changes');
  const g = [...rec.geometries.values()][0];
  assert.equal(g.vertexCount, 425);
  assert.equal(g.indexCount, 2304);
  assert.equal(g.hasColors, true);
  assert.equal(g.colorChannels, 4);
  assert.equal(g.alphaMin, 1);
  assert.equal(g.alphaMax, 1);
  assert.equal(rec.passes.length, 1);
  const p = decodePass(rec.passes[0]);
  assert.equal(p.draws.length, 1);
  const draw = p.draws[0];
  assert.equal(draw.count, 2304);
  assert.equal(draw.instanceCount, 1);
  assert.equal(draw.flags & 8, 8, 'vertex gradient');
  assert.equal(draw.flags & 16, 16, 'unlit');
  assert.equal(draw.flags & 32, 32, 'no depth writes');
  assert.equal(draw.flags & 64, 64, 'no depth test');
  assert.equal(draw.flags & 65536, 65536, 'no double tone mapping');
});

test('unmatched non-K73 GLSL fragment cannot be linked as a sky shader', async () => {
  const { context } = await runWebapp(fixture, {frames: 1});
  const gl = context.document.getElementById('gl').getContext('webgl2');
  const vertex = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vertex, '#version 300 es\nlayout(location=0) in vec2 aP; out vec2 vP; void main(){vP=aP;gl_Position=vec4(aP,0.0,1.0);}');
  gl.compileShader(vertex);
  const fragment = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fragment, '#version 300 es\nprecision mediump float; out vec4 oC;void main(){oC=vec4(1.0,0.2,0.3,1.0);}');
  gl.compileShader(fragment);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  assert.equal(gl.getProgramParameter(program, gl.LINK_STATUS), false);
});
