import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createNativeRendererClasses } from '../js/native-renderer.mjs';

test('reuses unchanged geometry and uploads interleaved changes and attribute replacements', () => {
  const uploads = [];
  const { NativeRenderer } = createNativeRendererClasses(THREE, {
    uploadGeometry(id, positions) { uploads.push({ id, positions: [...positions] }); },
    releaseGeometry() {},
  });
  const renderer = new NativeRenderer({ canvas: { width: 128, height: 128, style: {} } });
  const geometry = new THREE.BufferGeometry();
  const data = new THREE.InterleavedBuffer(new Float32Array([0,0,0,0, 1,0,0,0, 0,1,0,0]), 4);
  geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(data, 3, 0));
  const first = renderer._geometryRecord(geometry);
  assert.equal(renderer._geometryRecord(geometry), first);
  assert.equal(uploads.length, 1);
  data.array[0] = 2;
  data.needsUpdate = true;
  assert.equal(renderer._geometryRecord(geometry), first);
  assert.equal(uploads.length, 2);
  assert.equal(uploads[1].positions[0], 2);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0], 3));
  renderer._geometryRecord(geometry);
  assert.equal(uploads.length, 3);
  assert.equal(uploads[2].positions[0], 0);
});
