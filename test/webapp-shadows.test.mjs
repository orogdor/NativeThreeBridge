// Shadow maps: the pass carries light.shadow, draws carry cast/receive
// bits, and off-screen casters are sent for the shadow pass only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass, threeBuildDir } from './helpers/webapp-node-host.mjs';
import { ShadowFlags, LightType } from '../js/native-renderer.mjs';

const fixture = fileURLToPath(new URL('./fixtures/webapp-shadows', import.meta.url));
const skip = threeBuildDir() ? false : 'three is not installed (npm install)';

test('a directional light with castShadow sends its shadow camera and caster bits', { skip }, async () => {
  const { rec, status, context } = await runWebapp(fixture, { frames: 3 });
  assert.equal(status.bootError, null);
  assert.ok(!status.unsupported.some((u) => /Shadow maps/.test(u)), status.unsupported.join(', '));
  const pass = decodePass(rec.passes.at(-1));
  assert.ok(pass.shadow, 'the pass has a shadow light');
  assert.equal(pass.lights[pass.shadow.light].type, LightType.DIRECTIONAL);
  assert.equal(pass.shadow.mapSize, 2048);
  assert.ok(Math.abs(pass.shadow.bias + 0.0005) < 1e-7);
  assert.ok(Math.abs(pass.shadow.normalBias - 0.02) < 1e-6);
  // Same matrix Three.js uses (shadow camera projection * view).
  const { scene } = context.__ntLastRender;
  const sun = scene.children.find((o) => o.isDirectionalLight);
  const expected = sun.shadow.camera.projectionMatrix.clone().multiply(sun.shadow.camera.matrixWorldInverse).elements;
  pass.shadow.viewProjection.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-4, `viewProjection[${i}]`));

  const casters = pass.draws.filter((d) => d.shadow & ShadowFlags.CAST);
  const receivers = pass.draws.filter((d) => d.shadow & ShadowFlags.RECEIVE);
  const only = pass.draws.filter((d) => d.shadow & ShadowFlags.ONLY);
  assert.equal(casters.length, 4, 'box, posts, leaf card and the off-screen tower cast');
  assert.equal(receivers.length, 2, 'ground and box receive');
  assert.equal(only.length, 1, 'the tower is outside the view and only casts');
  assert.ok(only[0].shadow & ShadowFlags.CAST);
  assert.ok(casters.some((d) => d.instanceCount === 5), 'instanced posts cast');
});

test('without renderer.shadowMap.enabled nothing is sent for shadows', { skip }, async () => {
  const { rec } = await runWebapp(fixture, { frames: 2, beforeFrame: ({ context }) => { const r = context.__ntLastRender?.renderer; if (r) r.shadowMap.enabled = false; } });
  const pass = decodePass(rec.passes.at(-1));
  assert.equal(pass.shadow, null);
  assert.equal(pass.draws.filter((d) => d.shadow & ShadowFlags.ONLY).length, 0);
});
