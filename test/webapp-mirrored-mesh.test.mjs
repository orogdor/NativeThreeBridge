import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createNativeRendererClasses, DrawFlags } from '../js/native-renderer.mjs';

// GLTF models often mirror one half of a mesh with a negative scale. Three.js
// flips the front face for those (det(matrixWorld) < 0); the engine must too,
// or the visible side is culled and lighting is inverted (thatch, hair cards).
function queueFor(det) {
  class Unused {}
  const THREE = { Color: Unused, Matrix4: Unused, Vector3: Unused, Frustum: Unused, Quaternion: Unused, DoubleSide: 2, BackSide: 1 };
  const { NativeRenderer } = createNativeRendererClasses(THREE, {}, null, null);
  const renderer = Object.create(NativeRenderer.prototype);
  renderer.info = { render: { triangles: 0, lines: 0 } };
  const mesh = { matrixWorld: { determinant: () => det, elements: new Float32Array(16) }, renderOrder: 0 };
  const material = { isMeshStandardMaterial: true, roughness: 1, metalness: 0, opacity: 1, side: 0, visible: true, fog: false };
  const opaque = [];
  renderer._queue({ mesh, record: { id: 1, hasUvs: false }, instances: null, z: 0 }, material, 0, 3, opaque, []);
  return opaque[0].flags;
}

test('a mesh with a negative-determinant world matrix is drawn with reversed winding', () => {
  assert.ok(queueFor(-1) & DrawFlags.MIRRORED);
  assert.equal(queueFor(1) & DrawFlags.MIRRORED, 0);
});

test('native side honours the mirrored flag in culling and face orientation', () => {
  const cpp = readFileSync(new URL('../native-dx12/webapp_dx12.cpp', import.meta.url), 'utf8');
  const hlsl = readFileSync(new URL('../native-dx12/webapp_shader.h', import.meta.url), 'utf8');
  assert.match(cpp, new RegExp(`F_MIRRORED = ${DrawFlags.MIRRORED}\\b`));
  assert.match(cpp, /F_MIRRORED\) && cull != 1\) cull = cull == 2 \? 0 : 2/);
  assert.match(hlsl, new RegExp(`F_MIRRORED = ${DrawFlags.MIRRORED}\\b`));
  assert.match(hlsl, /F_MIRRORED\) front = !front/);
});
