// normalMap, roughnessMap, metalnessMap, emissiveMap, aoMap and alphaMap
// reach the engine as textures in slots t1..t6 with their parameters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass, threeBuildDir } from './helpers/webapp-node-host.mjs';
import { StandardMaps } from '../js/native-renderer.mjs';

const fixture = fileURLToPath(new URL('./fixtures/webapp-material-maps', import.meta.url));
const skip = threeBuildDir() ? false : 'three is not installed (npm install)';

test('standard material maps are uploaded and bound per slot', { skip }, async () => {
  const { rec, status } = await runWebapp(fixture, { frames: 3 });
  assert.equal(status.bootError, null);
  assert.ok(!status.unsupported.some((u) => /Textures other than map|envMap/.test(u)), status.unsupported.join(', '));
  const pass = decodePass(rec.passes.at(-1));
  const all = StandardMaps.NORMAL | StandardMaps.ROUGHNESS | StandardMaps.METALNESS | StandardMaps.EMISSIVE | StandardMaps.AO;
  const ball = pass.draws.find((d) => d.standardMaps === all);
  assert.ok(ball, `maps bits: ${pass.draws.map((d) => d.standardMaps)}`);
  assert.equal(ball.materialTextures.slice(0, 5).filter((id) => id > 0).length, 5);
  assert.equal(new Set(ball.materialTextures.slice(0, 5)).size, 5, 'five different textures');
  assert.deepEqual(ball.normalScale, [1.5, 1.5], 'normalScale (DataTexture: flipY false, no sign change)');
  assert.ok(Math.abs(ball.aoMapIntensity - 0.8) < 1e-6);
  assert.ok(Math.abs(ball.uvTransform[0] - 3) < 1e-6, 'uv repeat of the first map is used');
  const card = pass.draws.find((d) => d.standardMaps === StandardMaps.ALPHA);
  assert.ok(card && card.materialTextures[5] > 0 && card.alphaTest === 0.5);
});
