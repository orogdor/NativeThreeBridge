// v0.32 webapp textures, Canvas 2D, sprites and shader-patch colours.
// The engine decodes images natively (WIC) and runs Canvas 2D commands with
// Direct2D; here the Node host records what crosses the bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass, threeBuildDir } from './helpers/webapp-node-host.mjs';
import { decodeUi } from '../tools/ui-preview.mjs';
import { DrawFlags, ToneMapping } from '../js/native-renderer.mjs';

const fixture = fileURLToPath(new URL('./fixtures/webapp-textures', import.meta.url));
const skip = threeBuildDir() ? false : 'three is not installed (npm install)';
const settle = () => new Promise((r) => setImmediate(r));
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;
// THREE.Color('#rrggbb') linear value of one sRGB channel
const lin = (v) => { const c = v / 255; return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4); };

async function run(frames = 8) {
  const out = await runWebapp(fixture, { frames, width: 1280, height: 720 });
  for (let i = 0; i < 30 && !out.context.loaderDone; i++) { out.host.frame(1000 + i * 16); await settle(); }
  out.host.frame(2000); await settle();
  out.pass = decodePass(out.rec.framePasses.at(-1) || out.rec.passes.at(-1));
  return out;
}

test('image textures: Blob -> createImageBitmap, TextureLoader and DataTexture upload once', { skip }, async () => {
  const { rec, context, status, pass } = await run();
  assert.deepEqual(status.errors, []);
  assert.deepEqual(Array.from(context.bitmapSize), [32, 32], 'ImageBitmap knows the PNG size');
  const textures = [...rec.textures.values()];
  assert.ok(textures.some((t) => t.type === 'png' && t.w === 32), 'encoded PNG bytes reach the engine');
  assert.ok(textures.some((t) => t.type === 'rgba' && t.w === 4), 'DataTexture pixels arrive as RGBA8');
  assert.ok(textures.some((t) => t.canvas > 0), 'CanvasTexture refers to its native canvas');
  const uploads = rec.textureUploads;
  const leaf = pass.draws.find((d) => d.alphaTest > 0.39);
  assert.ok(leaf && (leaf.flags & DrawFlags.MAP) && leaf.textureId > 0, 'map + alphaTest draw');
  assert.deepEqual(Array.from(leaf.uvTransform, (v) => Math.round(v * 100) / 100 + 0), [1, 0, 0, 1, 0, 0], 'flipY=false keeps uv');
  const loaded = pass.draws.find((d) => (d.flags & DrawFlags.MAP_REPEAT));
  assert.ok(loaded, 'RepeatWrapping selects the repeat sampler');
  assert.deepEqual(Array.from(loaded.uvTransform, (v) => Math.round(v * 100) / 100 + 0), [2, 0, 0, -2, 0, 1], 'repeat(2,2) and flipY fold into the uv transform');
  const floor = pass.draws.find((d) => d.textureId && !(d.flags & DrawFlags.UNLIT) && d.alphaTest === 0 && d !== leaf);
  assert.ok(floor, 'DataTexture draw');
  assert.equal(rec.textureUploads, uploads, 'no re-upload while nothing changed');
  assert.ok(!status.unsupported.includes('Textures other than map (normalMap, envMap …)'));
});

test('Canvas 2D drawing is recorded for native Direct2D and shown in the HTML UI', { skip }, async () => {
  const { rec, context, host } = await run();
  const canvases = [...rec.canvases.values()];
  const icon = canvases.find((c) => c.width === 64);
  assert.ok(icon, 'the icon canvas was flushed');
  const ops = icon.ops.map((o) => o[0]);
  assert.ok(ops.includes(13), 'arc() becomes Bézier segments');
  assert.ok(ops.includes(20) && ops.includes(21), 'fill + stroke');
  assert.ok(icon.strings.includes('K'), 'fillText string');
  const fillStyle = icon.ops.find((o) => o[0] === 3 && o[1] === 2);
  assert.ok(fillStyle, 'radial gradient fill style');
  assert.ok(context.measured > 30, 'measureText gives a width');
  const mini = canvases.find((c) => c.width === 50);
  assert.ok(mini.ops.filter((o) => o[0] === 23).length >= 626, 'fillRect batches');
  const strings = rec.ui.strings;
  const images = [];
  decodeUi(rec.ui.floats, (op, a) => { if (op === 4) images.push({ src: strings[a[4]], x: a[0], y: a[1], w: a[2], h: a[3] }); });
  const shown = images.find((i) => i.src.startsWith('nt-canvas:'));
  assert.ok(shown, 'the minimap canvas is an image in the UI display list');
  assert.deepEqual([shown.x, shown.y, shown.w, shown.h], [10, 10, 100, 100], 'scaled to its CSS box');
  // redrawing the canvas changes the UI image version -> a partial UI update
  const before = rec.uiSubmits;
  context.drawMini(1);
  await new Promise((r) => setTimeout(r, 150));
  host.frame(3000); await settle();
  assert.ok(rec.uiSubmits > before, 'a redrawn canvas re-submits the UI');
  const [, , , , dx, dy, dw, dh] = rec.ui.floats;
  assert.ok(dw > 0 && dw <= 110 && dh <= 110 && dx <= 10 && dy <= 10, `only the canvas area is re-rasterised (${dx},${dy} ${dw}x${dh})`);
});

test('sprites, shader-patched water, sky ShaderMaterial and tone mapping', { skip }, async () => {
  const { pass } = await run();
  assert.equal(pass.toneMapping, ToneMapping.ACES);
  assert.ok(near(pass.exposure, 1.02));
  const sprite = pass.draws.find((d) => (d.flags & DrawFlags.UNLIT) && (d.flags & DrawFlags.MAP) && (d.flags & DrawFlags.NO_DEPTH_TEST));
  assert.ok(sprite, 'Sprite with CanvasTexture is drawn unlit without depth test');
  assert.ok(near(sprite.matrix[12], 2) && near(sprite.matrix[13], 1), 'at the sprite position');
  assert.ok(near(Math.hypot(sprite.matrix[0], sprite.matrix[1], sprite.matrix[2]), 2), 'scaled');
  const sea = pass.draws.find((d) => near(d.opacity, 0.94));
  assert.ok(sea, 'diffuseColor.a from the patch');
  assert.ok(!(sea.flags & DrawFlags.VERTEX_COLORS));
  const deep = [lin(0x1f), lin(0x4b), lin(0x55)], shallow = [lin(0x5e), lin(0x84), lin(0x66)];
  for (let i = 0; i < 3; i++) assert.ok(near(sea.color[i], deep[i] * 0.65 + shallow[i] * 0.35, 0.005), `sea channel ${i}`);
  const sky = pass.draws.find((d) => d.flags & DrawFlags.FAR_DEPTH);
  assert.ok(sky && (sky.flags & DrawFlags.UNLIT) && (sky.flags & DrawFlags.NO_TONE_MAP), 'sky: unlit, at the far plane, not tone mapped');
  // mix(horizon, top, h) and mix(horizon, ground, -h): mostly the horizon colour
  const horizon = [lin(0xd9), lin(0xe3), lin(0xdc)], top = [lin(0x7f), lin(0xa9), lin(0xc8)], ground = [lin(0xa8), lin(0xb7), lin(0x9a)];
  for (let i = 0; i < 3; i++) assert.ok(near(sky.color[i], horizon[i] * 0.65 + top[i] * 0.175 + ground[i] * 0.175, 0.01), `sky channel ${i}`);
});

test('showing and hiding a fixed panel lays out only that panel', { skip }, async () => {
  const { context, host } = await run();
  const doc = context.document;
  const ui = context.__ntHost.ui;
  const hint = doc.getElementById('hint');
  await new Promise((r) => setTimeout(r, 150));
  host.frame(4000); await settle();
  const t0 = { ...ui.stats().timing };
  // toggled back and forth in one frame (Kuningriigid's build hint): nothing to lay out
  for (let i = 0; i < 5; i++) { hint.hidden = true; hint.hidden = false; hint.hidden = true; }
  await new Promise((r) => setTimeout(r, 150));
  host.frame(4100); await settle();
  hint.hidden = false;
  assert.ok(hint.getBoundingClientRect().width > 20, 'shown panel has a box');
  hint.hidden = true;
  assert.equal(hint.getBoundingClientRect().width, 0, 'hidden again');
  await new Promise((r) => setTimeout(r, 150));
  host.frame(4200); await settle();
  const t1 = ui.stats().timing;
  assert.equal(t1.fullLayouts - t0.fullLayouts, 0, 'no whole-page layout');
  assert.ok(t1.partialLayouts > t0.partialLayouts, 'panel-only layouts');
});
