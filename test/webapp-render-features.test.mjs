import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createNativeRendererClasses, DrawFlags, DRAW_FLOATS } from '../js/native-renderer.mjs';

// Minimal stand-ins: _queue only needs a few THREE constants and a texture lookup.
function makeRenderer() {
  class Unused {}
  const THREE = { Color: Unused, Matrix4: Unused, Vector3: Unused, Frustum: Unused, Quaternion: Unused,
    DoubleSide: 2, BackSide: 1, RepeatWrapping: 1000, MirroredRepeatWrapping: 1002, ObjectSpaceNormalMap: 1, TangentSpaceNormalMap: 0 };
  const { NativeRenderer } = createNativeRendererClasses(THREE, {}, null, null);
  const renderer = Object.create(NativeRenderer.prototype);
  renderer.info = { render: { triangles: 0, lines: 0 } };
  renderer._textureRecord = (t) => ({ id: t.id });
  return renderer;
}
const identity = { elements: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
function texture(id, flipY) { return { id, flipY, wrapS: 1001, wrapT: 1001, matrixAutoUpdate: false, matrix: identity }; }
function queue(renderer, material) {
  const mesh = { matrixWorld: { determinant: () => 1, elements: new Float32Array(16) }, renderOrder: 0 };
  const opaque = [];
  renderer._queue({ mesh, record: { id: 1, hasUvs: true }, instances: null, z: 0 }, material, 0, 3, opaque, []);
  return opaque[0];
}
const standard = (extra) => ({ isMeshStandardMaterial: true, roughness: 1, metalness: 0, opacity: 1, side: 0, visible: true, fog: false, ...extra });

test('a normal map is sent with its texture id and scale', () => {
  const draw = queue(makeRenderer(), standard({ map: texture(5, false), normalMap: texture(7, false), normalScale: { x: 0.5, y: 2 } }));
  assert.ok(draw.flags & DrawFlags.NORMAL_MAP);
  assert.equal(draw.normalMapId, 7);
  assert.deepEqual([draw.normalScaleX, draw.normalScaleY], [0.5, 2]);
});

test('a flipY uv transform mirrors the normal map bitangent', () => {
  const draw = queue(makeRenderer(), standard({ normalMap: texture(7, true), normalScale: { x: 1, y: 1 } }));
  assert.equal(draw.normalScaleY, -1);
  assert.equal(draw.ud, -1, 'the normal map supplies the uv transform when there is no colour map');
});

test('unlit materials ignore normal maps', () => {
  const draw = queue(makeRenderer(), { isMeshBasicMaterial: true, opacity: 1, side: 0, visible: true, fog: false, normalMap: texture(7, false) });
  assert.equal(draw.flags & DrawFlags.NORMAL_MAP, 0);
});

test('the draw record carries the normal map id and scale at [53..55]', () => {
  assert.equal(DRAW_FLOATS, 60);
  const src = readFileSync(new URL('../js/native-renderer.mjs', import.meta.url), 'utf8');
  assert.match(src, /p\[o \+ 53\] = d\.normalMapId/);
  const cpp = readFileSync(new URL('../native-dx12/webapp_dx12.cpp', import.meta.url), 'utf8');
  assert.match(cpp, new RegExp(`F_NORMAL_MAP = ${DrawFlags.NORMAL_MAP}\\b`));
  assert.match(cpp, /textureHandle\(std::uint32_t\(d\[53\]\)\)/);
  const hlsl = readFileSync(new URL('../native-dx12/webapp_shader.h', import.meta.url), 'utf8');
  assert.match(hlsl, new RegExp(`F_NORMAL_MAP = ${DrawFlags.NORMAL_MAP}\\b`));
  assert.ok(hlsl.length < 16000, 'shader stays below the MSVC string literal limit');
});

// Column-major 4x4 with the three Matrix4 methods skinVertices uses.
class Mat4 {
  constructor(e) { this.elements = e ? Float64Array.from(e) : Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }
  fromArray(a, o = 0) { for (let i = 0; i < 16; i++) this.elements[i] = a[o + i]; return this; }
  static mul(a, b) {
    const r = new Float64Array(16);
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += a[k * 4 + row] * b[c * 4 + k];
      r[c * 4 + row] = v;
    }
    return r;
  }
  multiply(m) { this.elements = Mat4.mul(this.elements, m.elements); return this; }
  premultiply(m) { this.elements = Mat4.mul(m.elements, this.elements); return this; }
}
const translate = (x, y, z) => new Mat4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
const rotZ90 = new Mat4([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

test('CPU skinning matches Three.js linear blend skinning', async () => {
  const { skinVertices } = await import('../js/native-renderer.mjs');
  const rec = {
    srcPos: new Float32Array([1, 0, 0, 0, 2, 0]), srcNrm: new Float32Array([1, 0, 0, 1, 0, 0]),
    idx: new Uint16Array([0, 1, 0, 0, 1, 0, 0, 0]), wgt: new Float32Array([0.5, 0.5, 0, 0, 1, 0, 0, 0]),
    pos: new Float32Array(6), nrm: new Float32Array(6),
  };
  const bones = new Float32Array(32);
  bones.set(new Mat4().elements, 0);
  bones.set(rotZ90.elements, 16);
  skinVertices(rec, bones, new Mat4(), new Mat4(), { Matrix4: Mat4 });
  // vertex 0: half identity, half rotated -> ((1,0,0) + (0,1,0)) / 2
  assert.deepEqual(Array.from(rec.pos.slice(0, 3)).map((v) => +v.toFixed(5)), [0.5, 0.5, 0]);
  // vertex 1: fully rotated (0,2,0) -> (-2,0,0); its normal (1,0,0) -> (0,1,0)
  assert.deepEqual(Array.from(rec.pos.slice(3)).map((v) => +v.toFixed(5)), [-2, 0, 0]);
  assert.deepEqual(Array.from(rec.nrm.slice(3)).map((v) => +v.toFixed(5)), [0, 1, 0]);

  // A bind matrix moves the vertex into bone space and back: bindInverse * bone * bind.
  const rec2 = { ...rec, pos: new Float32Array(6), nrm: new Float32Array(6), combined: null };
  const bones2 = new Float32Array(32);
  bones2.set(translate(0, 0, 3).elements, 0);
  bones2.set(translate(0, 0, 3).elements, 16);
  skinVertices(rec2, bones2, translate(5, 0, 0), translate(-5, 0, 0), { Matrix4: Mat4 });
  assert.deepEqual(Array.from(rec2.pos.slice(0, 3)).map((v) => +v.toFixed(5)), [1, 0, 3]);
});

test('a skinned mesh is re-uploaded only when its bones move', () => {
  const uploads = [];
  class Unused {}
  const { NativeRenderer } = createNativeRendererClasses({ Color: Unused, Matrix4: Mat4, Vector3: Unused, Frustum: Unused, Quaternion: Unused },
    { uploadGeometry: (id, p) => uploads.push([id, Array.from(p)]), releaseGeometry() {} }, null, null);
  const renderer = Object.create(NativeRenderer.prototype);
  renderer.info = { render: { frame: 1 }, memory: { geometries: 0 } };
  renderer._geometryRecord = () => ({ key: 'k', indexCount: 0 });
  const attr = (values, itemSize) => ({ count: values.length / itemSize, itemSize, array: Float32Array.from(values),
    getX: (i) => values[i * itemSize], getY: (i) => values[i * itemSize + 1], getZ: (i) => values[i * itemSize + 2], getW: (i) => values[i * itemSize + 3] });
  const geometry = { attributes: { position: attr([1, 0, 0], 3), normal: attr([0, 1, 0], 3), skinIndex: attr([0, 0, 0, 0], 4), skinWeight: attr([1, 0, 0, 0], 4) },
    index: null, addEventListener() {}, removeEventListener() {} };
  const boneMatrices = Float32Array.from(translate(0, 2, 0).elements);
  let updates = 0;
  const skeleton = { boneMatrices, update() { updates++; } };
  const mesh = { geometry, skeleton, bindMatrix: new Mat4(), bindMatrixInverse: new Mat4() };
  const rec = renderer._skinnedRecord(mesh);
  assert.deepEqual(uploads.at(-1)[1], [1, 2, 0]);
  assert.equal(rec.vertexCount, 1);
  renderer.info.render.frame = 2;
  renderer._skinnedRecord(mesh);
  assert.equal(uploads.length, 1, 'unchanged pose: no upload');
  assert.equal(updates, 2, 'skeleton updated once per frame');
  boneMatrices.set(translate(0, 5, 0).elements);
  renderer.info.render.frame = 3;
  renderer._skinnedRecord(mesh);
  assert.deepEqual(uploads.at(-1)[1], [1, 5, 0]);
});

test('the first shadow-casting directional or spot light gets the shadow map', () => {
  const renderer = makeRenderer();
  const shadow = () => ({ updates: 0, updateMatrices() { this.updates++; } });
  const lights = [
    { light: { isPointLight: true, castShadow: false } },
    { light: { isPointLight: true, castShadow: true, shadow: shadow() } },
    { light: { isDirectionalLight: true, castShadow: true, shadow: shadow() } },
    { light: { isSpotLight: true, castShadow: true, shadow: shadow() } },
  ];
  const found = renderer._shadowLight(lights);
  assert.equal(found.index, 2);
  assert.equal(lights[2].light.shadow.updates, 1, 'shadow camera follows the light');
  assert.equal(lights[3].light.shadow.updates, 0);
  assert.equal(renderer._shadowLight([{ light: { isDirectionalLight: true, castShadow: false } }]), null);
});

test('casters and receivers are flagged; off-screen casters go to the shadow map only', () => {
  const renderer = makeRenderer();
  const mesh = { matrixWorld: { determinant: () => 1, elements: new Float32Array(16) }, renderOrder: 0, castShadow: true, receiveShadow: true };
  const opaque = [];
  renderer._queue({ mesh, record: { id: 1, hasUvs: false }, instances: null, z: 0, shadowOnly: true }, standard({}), 0, 3, opaque, []);
  const draw = opaque[0];
  assert.ok(draw.flags & DrawFlags.RECEIVE_SHADOW);
  assert.ok(draw.flags & DrawFlags.CAST_SHADOW);
  assert.equal(draw.shadow, 3, 'cast + shadow-only');
});

test('native and shader code agree on the shadow layout', () => {
  const cpp = readFileSync(new URL('../native-dx12/webapp_dx12.cpp', import.meta.url), 'utf8');
  const hlsl = readFileSync(new URL('../native-dx12/webapp_shader.h', import.meta.url), 'utf8');
  const h = readFileSync(new URL('../native-dx12/webapp_host.h', import.meta.url), 'utf8');
  assert.match(h, new RegExp(`kWebappDrawFloats = ${DRAW_FLOATS};`));
  assert.match(hlsl, new RegExp(`F_RECEIVE_SHADOW = ${DrawFlags.RECEIVE_SHADOW}\\b`));
  // Frame cbuffer: ... gFog (304) then gShadowVP at float 308 and two float4s: 332 floats.
  assert.match(hlsl, /float4 gFog;[^\n]*\n\s*float4x4 gShadowVP;[^\n]*\n\s*float4 gShadow;[^\n]*\n\s*float4 gShadow2;/);
  assert.match(cpp, /std::memcpy\(fcb \+ 308, shadowVP/);
  assert.match(cpp, /kFrameCBBytes = 1536;/);
  assert.ok(332 * 4 <= 1536);
  assert.match(hlsl, /void ShadowPS\(VSOut i\)/);
  assert.match(cpp, /"ShadowPS"/);
});

test('repeated opaque meshes are merged into one instanced draw', async () => {
  const uploads = [];
  class Unused {}
  const { NativeRenderer } = createNativeRendererClasses({ Color: Unused, Matrix4: Unused, Vector3: Unused, Frustum: Unused, Quaternion: Unused },
    { uploadInstances: (id, m, c, n) => uploads.push({ id, m: Array.from(m), n }), releaseInstances() {} }, null, null);
  const renderer = Object.create(NativeRenderer.prototype);
  const { AUTO_INSTANCE_MIN } = await import('../js/native-renderer.mjs');
  const grass = { id: 1 }, rock = { id: 2 };
  const draw = (material, x, extra = {}) => ({ geometryId: 3, start: 0, count: 6, flags: 0, shadow: 0, renderOrder: 0, material, batchable: true,
    instanceId: 0, instanceCount: 1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1], ...extra });
  const draws = [];
  for (let i = 0; i < AUTO_INSTANCE_MIN; i++) draws.push(draw(grass, i));
  draws.push(draw(rock, 99), draw(grass, 50, { flags: DrawFlags.MIRRORED }), draw(grass, 60, { batchable: false }));
  const out = renderer._autoInstance(draws);
  assert.equal(out.length, 4, 'one merged grass draw + rock + mirrored grass + unbatchable');
  assert.equal(out[0].instanceCount, AUTO_INSTANCE_MIN);
  assert.equal(out[0].instanceId, uploads[0].id);
  assert.deepEqual(uploads[0].m.filter((_, k) => k % 16 === 12), [...Array(AUTO_INSTANCE_MIN).keys()], 'world matrices become instance matrices');
  assert.deepEqual(Array.from(out[0].matrix), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  // A second render() in the same frame gets its own instance buffer.
  const again = renderer._autoInstance(draws);
  assert.notEqual(again[0].instanceId, out[0].instanceId);
  await Promise.resolve();
  const nextFrame = renderer._autoInstance(draws);
  assert.equal(nextFrame[0].instanceId, out[0].instanceId, 'reused next frame');
  assert.equal(renderer._autoInstance(draws.slice(0, 3)).length, 3, 'small lists are left alone');
});

test('THREE.LOD picks its level for the camera', () => {
  const renderer = makeRenderer();
  let updated = 0;
  const camera = { layers: { mask: 1 } };
  const lod = { isLOD: true, autoUpdate: true, visible: true, layers: { test: () => true }, children: [], update(c) { assert.equal(c, camera); updated++; } };
  renderer._collect(lod, camera, [], [], [], [0, 0, 0]);
  assert.equal(updated, 1);
});
