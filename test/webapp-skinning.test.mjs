// SkinnedMesh and morph targets: the engine receives the deformed shape,
// vertex for vertex the same as THREE.Mesh.getVertexPosition().
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, threeBuildDir } from './helpers/webapp-node-host.mjs';

const fixture = fileURLToPath(new URL('./fixtures/webapp-skinning', import.meta.url));
const skip = threeBuildDir() ? false : 'three is not installed (npm install)';

test('skinned and morphed meshes are drawn in their animated shape', { skip }, async () => {
  const { rec, status, context } = await runWebapp(fixture, { frames: 4 });
  assert.equal(status.bootError, null);
  assert.ok(!status.unsupported.some((u) => /Skinned|Morph/.test(u)), status.unsupported.join(', '));
  const { scene, renderer } = context.__ntLastRender;
  const THREE = { Vector3: scene.position.constructor };
  for (const name of ['arm', 'blob']) {
    const mesh = scene.getObjectByName(name);
    const record = renderer._geometries.get(renderer._deformed.get(mesh).geometry);
    const uploaded = rec.geometries.get(record.id).positions;
    const v = new THREE.Vector3();
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
