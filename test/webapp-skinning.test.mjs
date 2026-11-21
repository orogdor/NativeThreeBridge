// SkinnedMesh and morph targets: the engine draws the animated shape, vertex
// for vertex the same as THREE.Mesh.getVertexPosition(). Bones are applied
// on the GPU (skin weights + per-pass bone matrices); morph targets, and
// skinning in engines without GPU skinning, on the CPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass, threeBuildDir } from './helpers/webapp-node-host.mjs';

const fixture = fileURLToPath(new URL('./fixtures/webapp-skinning', import.meta.url));
const skip = threeBuildDir() ? false : 'three is not installed (npm install)';

// What the vertex shader computes: sum of weight * bone matrix * rest position.
function gpuSkinned(pass, draw, skin, rest, i) {
  const out = [0, 0, 0];
  const x = rest.getX(i), y = rest.getY(i), z = rest.getZ(i);
  for (let j = 0; j < 4; j++) {
    const w = skin.weights[i * 4 + j];
    if (!w) continue;
    const m = pass.boneMatrices.slice((draw.bones - 1 + skin.indices[i * 4 + j]) * 16);
    out[0] += w * (m[0] * x + m[4] * y + m[8] * z + m[12]);
    out[1] += w * (m[1] * x + m[5] * y + m[9] * z + m[13]);
    out[2] += w * (m[2] * x + m[6] * y + m[10] * z + m[14]);
  }
  return out;
}

test('a SkinnedMesh is skinned on the GPU with the bone matrices of the pass', { skip }, async () => {
  const { rec, status, context } = await runWebapp(fixture, { frames: 4 });
  assert.equal(status.bootError, null);
  assert.ok(!status.unsupported.some((u) => /Skinned|Morph|skinning/i.test(u)), status.unsupported.join(', '));
  const { scene, renderer } = context.__ntLastRender;
  const pass = decodePass(rec.passes.at(-1));
  const arm = scene.getObjectByName('arm');
  const record = renderer._geometries.get(arm.geometry);
  const draw = pass.draws.find((d) => d.geometryId === record.id);
  assert.ok(draw && draw.bones > 0, 'the arm draw names its first bone');
  assert.equal(pass.bones, 3, 'three bone matrices in the pass');
  const skin = rec.skins.get(record.id);
  assert.ok(skin, 'skin weights uploaded for the arm geometry');
  const rest = arm.geometry.attributes.position, v = new (scene.position.constructor)();
  let maxError = 0, moved = 0;
  for (let i = 0; i < rest.count; i++) {
    arm.getVertexPosition(i, v);
    const p = gpuSkinned(pass, draw, skin, rest, i);
    maxError = Math.max(maxError, Math.abs(v.x - p[0]), Math.abs(v.y - p[1]), Math.abs(v.z - p[2]));
    moved = Math.max(moved, Math.hypot(v.x - rest.getX(i), v.y - rest.getY(i), v.z - rest.getZ(i)));
  }
  assert.ok(maxError < 1e-4, `GPU skinning differs from Three.js by ${maxError}`);
  assert.ok(moved > 0.2, `the arm is animated, not the rest pose (${moved})`);
  assert.equal(rec.geometries.get(record.id).positions[0], rest.getX(0), 'rest pose geometry, uploaded once');
});

for (const gpu of [true, false]) {
  test(`morph targets${gpu ? '' : ' and CPU skinning (engine without GPU skinning)'} upload the deformed shape`, { skip }, async () => {
    const natives = gpu ? undefined : ({ nt }) => { delete nt.uploadSkin; };
    const { rec, status, context } = await runWebapp(fixture, { frames: 4, natives });
    assert.equal(status.bootError, null);
    const { scene, renderer } = context.__ntLastRender;
    for (const name of gpu ? ['blob'] : ['arm', 'blob']) {
      const mesh = scene.getObjectByName(name);
      const record = renderer._geometries.get(renderer._deformed.get(mesh).geometry);
      const uploaded = rec.geometries.get(record.id).positions;
      const v = new (scene.position.constructor)();
      let maxError = 0, moved = 0;
      for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
        mesh.getVertexPosition(i, v);
        maxError = Math.max(maxError, Math.abs(v.x - uploaded[i * 3]), Math.abs(v.y - uploaded[i * 3 + 1]), Math.abs(v.z - uploaded[i * 3 + 2]));
        const p = mesh.geometry.attributes.position;
        moved = Math.max(moved, Math.hypot(v.x - p.getX(i), v.y - p.getY(i), v.z - p.getZ(i)));
      }
      assert.ok(maxError < 1e-4, `${name}: uploaded shape differs from Three.js by ${maxError}`);
      assert.ok(moved > 0.2, `${name}: the shape is animated, not the rest pose (${moved})`);
    }
  });
}
