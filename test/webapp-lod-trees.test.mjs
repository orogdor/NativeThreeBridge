import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeRendererClasses } from '../js/native-renderer.mjs';

const layers = { test: () => true };
const mesh = (name, visible = true) => ({ name, visible, layers, children: [], isMesh: true });

function collect(scene, camera = { layers }) {
  class Unused {}
  const THREE = { Color: Unused, Matrix4: Unused, Vector3: Unused, Frustum: Unused, Quaternion: Unused };
  const { NativeRenderer } = createNativeRendererClasses(THREE, {}, null, null);
  const renderer = Object.create(NativeRenderer.prototype);
  const calls = [];
  renderer._addMesh = (object) => calls.push(object.name);
  renderer._collect(scene, camera, [], [], [], [0, 0, 0]);
  return calls;
}

test('LOD.update(camera) switches a loaded tree from fallback to its mesh before rendering', () => {
  const fallback = mesh('fallback');
  const tree = mesh('sapling far', false);
  const scene = { visible: true, layers, children: [] };
  const camera = { layers };
  let updates = 0;
  const lod = { visible: true, layers, isLOD: true, autoUpdate: true, children: [fallback, tree],
    update(received) { assert.equal(received, camera); updates++; fallback.visible = false; tree.visible = true; } };
  scene.children.push(lod);
  assert.deepEqual(collect(scene, camera), ['sapling far']);
  assert.equal(updates, 1);
});

test('LOD respects autoUpdate=false and hidden objects', () => {
  const fallback = mesh('fallback');
  let updates = 0;
  const lod = { visible: true, layers, isLOD: true, autoUpdate: false, children: [fallback],
    update() { updates++; fallback.visible = false; } };
  const scene = { visible: true, layers, children: [lod] };
  assert.deepEqual(collect(scene), ['fallback']);
  lod.visible = false;
  assert.deepEqual(collect(scene), []);
  assert.equal(updates, 0);
});

test('a live Sapling LOD can append an instance batch to the scene during traversal', () => {
  const scene = { visible: true, layers, children: [] };
  const fallback = mesh('fallback');
  const batch = mesh('sapling resource batch');
  const lod = { visible: true, layers, isLOD: true, autoUpdate: true, children: [fallback],
    update() { fallback.visible = false; if (!scene.children.includes(batch)) scene.children.push(batch); } };
  scene.children.push(lod);
  assert.deepEqual(collect(scene), ['sapling resource batch']);
});
