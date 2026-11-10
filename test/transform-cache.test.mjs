import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createNativeRendererClasses } from '../js/native-renderer.mjs';

const { NativeRenderer } = createNativeRendererClasses(THREE, {});
const renderer = () => new NativeRenderer({ canvas: { width: 640, height: 360, style: {} } });
const pos = (object) => new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
const close = (actual, expected) => assert.ok(actual.distanceTo(expected) < 1e-6,
  'expected ' + expected.toArray() + ', received ' + actual.toArray());

test('unchanged hierarchy avoids world matrix multiplies on subsequent frames', () => {
  const r = renderer(), scene = new THREE.Scene(), parent = new THREE.Group();
  scene.add(parent);
  parent.position.set(2, 3, 4);
  const children = Array.from({ length: 200 }, (_, i) => {
    const object = new THREE.Object3D();
    object.position.set(i, -2, 1);
    parent.add(object);
    return object;
  });
  let multiplies = 0;
  const original = children[0].matrixWorld.multiplyMatrices;
  children[0].matrixWorld.multiplyMatrices = function (...args) {
    multiplies++;
    return original.apply(this, args);
  };
  r._syncWorldMatrices(scene);
  assert.equal(multiplies, 1);
  close(pos(children[0]), new THREE.Vector3(2, 1, 5));
  for (let i = 0; i < 8; i++) r._syncWorldMatrices(scene);
  assert.equal(multiplies, 1, 'a static child matrix must not be recalculated');
  parent.position.x = 8;
  r._syncWorldMatrices(scene);
  assert.equal(multiplies, 2, 'moving a parent updates its descendants');
  close(pos(children[0]), new THREE.Vector3(8, 1, 5));
});

test('direct position, quaternion and scale edits are detected without needsUpdate flags', () => {
  const r = renderer(), scene = new THREE.Scene(), object = new THREE.Object3D();
  scene.add(object);
  r._syncWorldMatrices(scene);
  object.position.x = 3;
  object.rotation.z = Math.PI / 2;
  object.scale.y = 4;
  r._syncWorldMatrices(scene);
  const expected = new THREE.Matrix4().compose(object.position, object.quaternion, object.scale);
  assert.ok(object.matrixWorld.equals(expected));
  object.position.x = 9;
  r._syncWorldMatrices(scene);
  close(pos(object), new THREE.Vector3(9, 0, 0));
});

test('manual local/world matrix changes and reparenting propagate to children', () => {
  const r = renderer(), scene = new THREE.Scene();
  const a = new THREE.Group(), b = new THREE.Group();
  a.position.set(10, 0, 0); b.position.set(-10, 0, 0);
  const manual = new THREE.Group(), leaf = new THREE.Object3D();
  manual.matrixAutoUpdate = false;
  manual.matrix.makeTranslation(2, 0, 0);
  leaf.position.set(0, 3, 0);
  scene.add(a, b);
  a.add(manual); manual.add(leaf);
  r._syncWorldMatrices(scene);
  close(pos(leaf), new THREE.Vector3(12, 3, 0));
  manual.matrix.makeTranslation(5, 0, 0); // no explicit needsUpdate
  r._syncWorldMatrices(scene);
  close(pos(leaf), new THREE.Vector3(15, 3, 0));
  b.add(manual);
  r._syncWorldMatrices(scene);
  close(pos(leaf), new THREE.Vector3(-5, 3, 0));
  manual.matrixWorldAutoUpdate = false;
  manual.matrixWorld.makeTranslation(40, 0, 0);
  r._syncWorldMatrices(scene);
  close(pos(leaf), new THREE.Vector3(40, 3, 0));
  manual.matrixWorld.makeTranslation(50, 0, 0);
  r._syncWorldMatrices(scene);
  close(pos(leaf), new THREE.Vector3(50, 3, 0));
});

test('camera inverses and custom updateMatrixWorld hooks retain native Three.js semantics', () => {
  const r = renderer(), scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
  camera.position.set(0, 2, 8);
  scene.add(camera);
  const custom = new THREE.Object3D(), nested = new THREE.Object3D();
  scene.add(custom); custom.add(nested);
  let hookCalls = 0;
  const base = custom.updateMatrixWorld;
  custom.updateMatrixWorld = function (force) { hookCalls++; return base.call(this, force); };
  r._syncWorldMatrices(scene);
  camera.position.z = 12;
  custom.position.x = 7;
  r._syncWorldMatrices(scene);
  const identity = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, camera.matrixWorld);
  assert.ok(identity.equals(new THREE.Matrix4()), 'camera inverse must follow its current world transform');
  close(pos(nested), new THREE.Vector3(7, 0, 0));
  assert.equal(hookCalls, 2);
});

test('manually flagged matrixWorldNeedsUpdate still forces a world update', () => {
  const r = renderer(), scene = new THREE.Scene(), node = new THREE.Object3D();
  scene.add(node);
  r._syncWorldMatrices(scene);
  node.matrixAutoUpdate = false;
  node.matrix.makeTranslation(4, 0, 0);
  node.matrixWorldNeedsUpdate = true;
  r._syncWorldMatrices(scene);
  close(pos(node), new THREE.Vector3(4, 0, 0));
  assert.equal(node.matrixWorldNeedsUpdate, false);
});
