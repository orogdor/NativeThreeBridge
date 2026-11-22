// three.js CSM: the cascade lights are shadow lights 1..N, CSM materials are
// flagged, and the pass carries the cascade depth ranges.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass, threeBuildDir } from './helpers/webapp-node-host.mjs';
import { ShadowFlags, LightType, PASS_HEADER_FLOATS } from '../js/native-renderer.mjs';

const fixture = fileURLToPath(new URL('./fixtures/webapp-csm', import.meta.url));
const skip = threeBuildDir() ? false : 'three is not installed (npm install)';

test('CSM cascades: one shadow light each, depth ranges in the pass', { skip }, async () => {
  const { rec, status, context } = await runWebapp(fixture, { frames: 3 });
  assert.equal(status.bootError, null);
  assert.ok(!status.unsupported.some((u) => /onBeforeCompile|ShaderMaterial/.test(u)), status.unsupported.join(', '));
  const packet = rec.passes.at(-1);
  const pass = decodePass(packet);
  assert.equal(pass.shadowLights.length, 3);
  assert.equal(packet[60], 3, 'three cascades');
  const csm = context.window.csm;
  assert.ok(Math.abs(packet[62] - Math.min(csm.camera.far, csm.maxFar)) < 1e-3, 'shadow far');
  // cascade ranges are increasing and cover 0..1
  const ranges = [0, 1, 2].map((i) => [packet[64 + i * 2], packet[65 + i * 2]]);
  assert.equal(ranges[0][0], 0);
  assert.ok(ranges[0][1] < ranges[1][1] && ranges[1][1] <= ranges[2][1] + 1e-6, JSON.stringify(ranges));
  const cascades = pass.lights.filter((l) => l.type === LightType.DIRECTIONAL).map((l) => l.extra[2]).sort();
  assert.deepEqual(cascades, [1, 2, 3], 'each cascade light names its cascade');
  const flagged = pass.draws.filter((d) => d.shadow & ShadowFlags.CSM);
  assert.ok(flagged.length >= 2, 'ground and posts use CSM');
  assert.ok(PASS_HEADER_FLOATS >= 80);
});
