import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createNativeRendererClasses, DrawFlags, PASS_HEADER_FLOATS } from '../js/native-renderer.mjs';

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

test('procedural ShaderMaterial keeps a live uniform and additive instanced drawing', () => {
  const stages = new Map();
  let pass;
  const { NativeRenderer } = createNativeRendererClasses(THREE, {
    uploadGeometry() {},
    uploadInstances() {},
    registerColorPatch(id, source) { stages.set(id, source); return true; },
    submitPass(packet, count) { pass = packet.slice(0, count); },
  });
  const renderer = new NativeRenderer();
  const time = { value: 0.5 };
  const material = new THREE.ShaderMaterial({
    uniforms: { time },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: 'varying vec2 coord; void main() { coord = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform float time; varying vec2 coord; void main() { float fade = coord.y * time; gl_FragColor = vec4(fade, 0.0, 0.0, fade); }',
  });
  const scene = new THREE.Scene();
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(), material, 2);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const camera = new THREE.PerspectiveCamera();
  renderer.render(scene, camera);
  const draw = PASS_HEADER_FLOATS;
  assert.equal(pass[draw + 2], 2);
  assert.ok(pass[draw + 3] & DrawFlags.ADDITIVE);
  assert.ok(pass[draw + 3] & DrawFlags.UNLIT);
  assert.match(stages.get(pass[draw + 48]), /diffuseColor = float4\(fade, 0\.0, 0\.0, fade\)/);
  assert.equal(pass[draw + 49], 0.5);
  time.value = 0.75;
  renderer.render(scene, camera);
  assert.equal(pass[draw + 49], 0.75);
  assert.equal(stages.size, 1);
});
