// THREE.Points become one instanced draw of camera-facing quads per object.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass, threeBuildDir } from './helpers/webapp-node-host.mjs';
import { DrawFlags } from '../js/native-renderer.mjs';

const fixture = fileURLToPath(new URL('./fixtures/webapp-points', import.meta.url));
const skip = threeBuildDir() ? false : 'three is not installed (npm install)';

test('points: instanced billboards with colours, size and texture', { skip }, async () => {
  const { rec, status, context } = await runWebapp(fixture, { frames: 3 });
  assert.equal(status.bootError, null);
  assert.ok(!status.unsupported.some((u) => /Points/.test(u)), status.unsupported.join(', '));
  const pass = decodePass(rec.passes.at(-1));
  const galaxy = pass.draws.find((d) => d.instanceCount === 4000);
  const sparks = pass.draws.find((d) => d.instanceCount === 60);
  const stars = pass.draws.find((d) => d.instanceCount === 300);
  assert.ok(galaxy && sparks && stars, `instance counts: ${pass.draws.map((d) => d.instanceCount)}`);
  for (const d of [galaxy, sparks, stars]) {
    assert.ok(d.flags & DrawFlags.UNLIT && d.flags & DrawFlags.DOUBLE_SIDED);
    assert.equal(d.count, 6, 'one quad');
  }
  assert.ok(galaxy.flags & DrawFlags.INSTANCE_COLORS, 'vertex colours become instance colours');
  assert.ok(sparks.flags & DrawFlags.MAP && sparks.flags & DrawFlags.TRANSPARENT && sparks.alphaTest > 0.29);
  const camera = context.__ntLastRender.camera;
  const instances = rec.instances.get(galaxy.instanceId);
  assert.equal(instances.count, 4000);
  // sizeAttenuation: world size = size * tan(fov / 2) on every point.
  const expected = 0.12 * Math.tan((camera.fov * Math.PI) / 360);
  const m = instances.first;
  assert.ok(Math.abs(Math.hypot(m[0], m[1], m[2]) - expected) < 1e-5, `quad size ${Math.hypot(m[0], m[1], m[2])} vs ${expected}`);
  assert.equal(context.__ntLastRender.renderer.info.render.points, 4360);
});
