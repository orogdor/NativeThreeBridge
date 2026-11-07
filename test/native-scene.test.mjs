import test from 'node:test';
import assert from 'node:assert/strict';
import { scene, houses, trunks, canopies, frame, diagnostics } from '../threejs-native/scene.mjs';

test('scene uses real official Three.js class instances, not a JSON stand-in', () => {
  const d = diagnostics();
  assert.equal(d.actualThreeScene, true);
  assert.equal(d.actualThreeGroup, true);
  assert.equal(d.actualThreeMesh, true);
  assert.equal(d.actualThreeInstances, true);
  assert.equal(houses.isInstancedMesh, true);
  assert.equal(trunks.isInstancedMesh, true);
  assert.equal(scene.name, 'NativeThreeBridge - Kuningriigid Stone Age');
  assert.equal(d.houseCount, 10);
  assert.equal(d.treeCount, 10);
  assert.deepEqual(d.treePartCounts, [10, 10]);
});
test('native adapter reads actual Three.js Matrix4 transforms each frame', () => {
  const m = frame(0.016);
  assert.ok(m instanceof Float32Array);
  assert.equal(m.length, 20 * 16);
  const translate = (n) => [m[n * 16 + 12], m[n * 16 + 13], m[n * 16 + 14]];
  assert.deepEqual(translate(0).map(x => +x.toFixed(3)), [-13.6, 0, -14]);
  assert.deepEqual(translate(9).map(x => +x.toFixed(3)), [13.6, 0, -7.5]);
  assert.deepEqual(translate(10).map(x => +x.toFixed(3)), [-18, 0, 13]);
  assert.deepEqual(translate(19).map(x => +x.toFixed(3)), [18, 0, 22]);
});
