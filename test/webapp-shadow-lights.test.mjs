// Several shadow lights per render(): directional and spot lights get one
// shadow map slice, a point light six (cube faces); an InstancedMesh with
// mirrored instances is flagged for per-instance face culling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass, threeBuildDir } from './helpers/webapp-node-host.mjs';
import { DrawFlags, LightType } from '../js/native-renderer.mjs';

const fixture = fileURLToPath(new URL('./fixtures/webapp-shadow-lights', import.meta.url));
const skip = threeBuildDir() ? false : 'three is not installed (npm install)';

test('directional, point and spot lights all cast shadows in one pass', { skip }, async () => {
  const { rec, status, context } = await runWebapp(fixture, { frames: 3 });
  assert.equal(status.bootError, null);
  assert.ok(!status.unsupported.some((u) => /shadow/i.test(u)), status.unsupported.join(', '));
  const pass = decodePass(rec.passes.at(-1));
  assert.equal(pass.shadowLights.length, 3);
  assert.equal(pass.shadowViews.length, 8, '1 + 6 + 1 map slices');
  assert.equal(pass.shadowMapSize, 1024, 'the largest mapSize');
  const types = pass.shadowLights.map((s) => pass.lights[s.light].type);
  assert.deepEqual(types.sort(), [LightType.DIRECTIONAL, LightType.POINT, LightType.SPOT].sort());
  pass.shadowLights.forEach((s, k) => assert.equal(pass.lights[s.light].shadow, k + 1, 'the light names its shadow'));
  const point = pass.shadowLights.find((s) => s.point);
  assert.equal(point.near, 0.5); assert.equal(point.far, 500);
  // Every cube face sees the point straight along its axis from the lamp.
  const { scene } = context.__ntLastRender;
  const lamp = scene.getObjectByName('lamp').position;
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  dirs.forEach((d, face) => {
    const m = pass.shadowViews[point.firstView + face];
    const x = lamp.x + d[0] * 3, y = lamp.y + d[1] * 3, z = lamp.z + d[2] * 3;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    assert.ok(cw > 0 && Math.abs(cx / cw) < 1e-4 && Math.abs(cy / cw) < 1e-4, `face ${face} looks along its axis`);
  });
});

test('an InstancedMesh with mirrored instances is drawn with per-instance culling', { skip }, async () => {
  const { rec, context } = await runWebapp(fixture, { frames: 2 });
  const { scene, renderer } = context.__ntLastRender;
  const pass = decodePass(rec.passes.at(-1));
  const ramps = scene.getObjectByName('ramps');
  const draw = pass.draws.find((d) => d.instanceId === renderer._instances.get(ramps).id);
  assert.ok(draw.flags & DrawFlags.INSTANCE_MIRRORED);
  const plain = pass.draws.filter((d) => !d.instanceId);
  assert.ok(plain.every((d) => !(d.flags & DrawFlags.INSTANCE_MIRRORED)));
});
