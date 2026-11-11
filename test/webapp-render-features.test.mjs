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

test('the draw record carries normal map id and scale in its last three floats', () => {
  assert.equal(DRAW_FLOATS, 56);
  const src = readFileSync(new URL('../js/native-renderer.mjs', import.meta.url), 'utf8');
  assert.match(src, /p\[o \+ 53\] = d\.normalMapId/);
  const cpp = readFileSync(new URL('../native-dx12/webapp_dx12.cpp', import.meta.url), 'utf8');
  assert.match(cpp, new RegExp(`F_NORMAL_MAP = ${DrawFlags.NORMAL_MAP}\\b`));
  assert.match(cpp, /textureHandle\(std::uint32_t\(d\[53\]\)\)/);
  const hlsl = readFileSync(new URL('../native-dx12/webapp_shader.h', import.meta.url), 'utf8');
  assert.match(hlsl, new RegExp(`F_NORMAL_MAP = ${DrawFlags.NORMAL_MAP}\\b`));
  assert.ok(hlsl.length < 16000, 'shader stays below the MSVC string literal limit');
});
