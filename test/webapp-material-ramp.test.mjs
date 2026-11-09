import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeRendererClasses } from '../js/native-renderer.mjs';

test('a masked surface keeps distinct deep and shallow palette colors', () => {
  class Color {}
  class Unused {}
  const THREE = { Color, Matrix4: Unused, Vector3: Unused, Frustum: Unused, Quaternion: Unused };
  let uploaded;
  const nt = { uploadGeometry(_id, _p, _n, colors) { uploaded = colors; } };
  const lib = { uniforms: {}, vertexShader: '#include <common>', fragmentShader: '#include <common>' };
  const { NativeRenderer } = createNativeRendererClasses(THREE, nt, null, {
    ShaderLib: { standard: lib }, UniformsUtils: { clone: () => ({}) },
  });
  const renderer = Object.create(NativeRenderer.prototype);
  renderer._patches = new WeakMap();
  renderer._maskedGeometries = new WeakMap();
  renderer.info = { memory: { geometries: 0 } };
  const material = {
    type: 'MeshStandardMaterial',
    onBeforeCompile(shader) {
      shader.uniforms.deep = { value: { isColor: true, r: 0.1, g: 0.2, b: 0.4 } };
      shader.uniforms.shallow = { value: { isColor: true, r: 0.3, g: 0.5, b: 0.2 } };
      shader.vertexShader += '\nattribute float aDepth; vDepth = aDepth; vShore = 1.0-smoothstep(0.0,3.6,aDepth);';
      shader.fragmentShader += '\nvec3 palette = mix(deep, shallow, pow(vShore,2.2)*.85); diffuseColor.rgb=palette * .97; float wet=smoothstep(-.12,.20,vDepth); diffuseColor.a*=wet;';
    },
  };
  const patch = renderer._patchInfo(material);
  assert.ok(patch.colorRamp);
  const vector = { count: 3, itemSize: 3, array: new Float32Array(9) };
  const geometry = {
    attributes: { aDepth: { count: 3, itemSize: 1, getX: (i) => [-1, 0.4, 5][i] }, position: vector, normal: vector },
    addEventListener() {},
  };
  const base = { key: 'original', vertexCount: 3, indexCount: 0 };
  const first = renderer._maskedGeometryRecord(geometry, base, material, patch.alphaRamp, false, patch.colorRamp);
  assert.equal(uploaded[3], 0, 'dry vertex');
  assert.equal(uploaded[7], 1, 'wet vertex');
  assert.ok(uploaded[4] > uploaded[8] && uploaded[5] > uploaded[9] && uploaded[6] < uploaded[10], 'shallow differs from deep');
  assert.deepEqual(Array.from(uploaded.slice(8)), Array.from(new Float32Array([0.1, 0.2, 0.4, 1])));
  assert.equal(renderer._maskedGeometryRecord(geometry, base, material, patch.alphaRamp, false, patch.colorRamp), first);
});
