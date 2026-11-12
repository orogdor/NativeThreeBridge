// Painted HUD art: CSS border-image nine-slices and clip-path on images.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWebapp, threeBuildDir } from './helpers/webapp-node-host.mjs';
import { decodeUi } from '../tools/ui-preview.mjs';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/webapp-ui-art');
const skip = threeBuildDir() ? false : 'three.js build not installed';
const IMAGE = 4, BORDER = 3, CLIP = 1;
function images(rec, file) {
  const out = [];
  decodeUi(rec.ui.floats, (op, a) => { if (op === IMAGE && rec.ui.strings[a[4]].endsWith(file)) out.push({ x: a[0], y: a[1], w: a[2], h: a[3], crop: Array.from(a.slice(5, 9)) }); });
  return out;
}
const near = (a, b, e = 0.01) => Math.abs(a - b) <= e;

test('border-image draws a nine-slice (shorthand with fill, and longhands without)', { skip }, async () => {
  const { rec, status } = await runWebapp(fixture, { frames: 3, width: 1280, height: 720 });
  assert.equal(status.bootError, null);
  const parts = images(rec, 'panel.png');
  // #rail::before: box 300..980 x 420..680; 32x32 image, 25% slice = 8px; width 12px.
  const rail = parts.filter((p) => p.y >= 419 && p.x >= 299);
  assert.equal(rail.length, 9, 'shorthand with fill: 8 edges/corners + middle');
  const tl = rail.find((p) => near(p.x, 300) && near(p.y, 420));
  assert.ok(tl && near(tl.w, 12) && near(tl.h, 12), 'corner keeps the border-image-width');
  assert.deepEqual(tl.crop, [0, 0, 8, 8], 'corner samples the 8px slice');
  const middle = rail.find((p) => near(p.x, 312) && near(p.y, 432));
  assert.ok(middle && near(middle.w, 680 - 24) && near(middle.h, 260 - 24), 'fill stretches the middle');
  assert.deepEqual(middle.crop, [8, 8, 16, 16]);
  // #framed: border-box 20..236 x 20..136, border 8, width multiplier 2 -> 16px corners, no middle.
  const framed = parts.filter((p) => p.y < 200);
  assert.equal(framed.length, 8, 'no middle without fill');
  assert.ok(framed.some((p) => near(p.x, 20) && near(p.y, 20) && near(p.w, 16) && near(p.h, 16)));
  let redBorder = false;
  decodeUi(rec.ui.floats, (op, a) => { if (op === BORDER && near(a[0], 20) && near(a[1], 20)) redBorder = true; });
  assert.equal(redBorder, false, 'the image replaces the solid border');
});

test('clip-path inset() cuts an image', { skip }, async () => {
  const { rec } = await runWebapp(fixture, { frames: 3, width: 1280, height: 720 });
  const [img] = images(rec, 'portrait.png');
  // img box 620..780 x 60..220; inset(0 0 25% 0) leaves 620..780 x 60..180.
  assert.ok(img, 'portrait drawn');
  let clipped = null;
  decodeUi(rec.ui.floats, (op, a) => { if (op === CLIP && near(a[0], 620) && near(a[1], 60)) clipped = Array.from(a.slice(0, 4)); });
  assert.deepEqual(clipped, [620, 60, 160, 120]);
});

test('a positioned z-index:auto box does not trap its z-indexed children below a sibling', { skip }, async () => {
  const { rec } = await runWebapp(fixture, { frames: 3, width: 1280, height: 720 });
  const order = [];
  decodeUi(rec.ui.floats, (op, a) => { if (op === IMAGE) order.push(rec.ui.strings[a[4]].split('/').pop() + '@' + Math.round(a[0])); });
  const frame = order.indexOf('panel.png@1080'), portrait = order.indexOf('portrait.png@1130');
  assert.ok(frame >= 0 && portrait >= 0, order.join(' '));
  assert.ok(portrait > frame, 'z-index:2 portrait paints after the z-index:1 frame');
});

test('element.dataset is reflected to data-* attributes (and CSS follows it)', { skip }, async () => {
  const { context } = await runWebapp(fixture, { frames: 3, width: 1280, height: 720 });
  const flag = context.document.getElementById('flag');
  assert.equal(flag.getAttribute('data-state'), 'on');
  assert.equal(flag.getAttribute('data-panel-kind'), 'build');
  assert.equal(context.document.querySelector('[data-panel-kind=build]'), flag);
  assert.equal(flag.getBoundingClientRect().width, 50);
  assert.deepEqual(Object.keys(flag.dataset).sort(), ['panelKind', 'state']);
  delete flag.dataset.state;
  assert.equal(flag.hasAttribute('data-state'), false);
  assert.equal('state' in flag.dataset, false);
  flag.setAttribute('data-x-y', '1');
  assert.equal(flag.dataset.xY, '1');
});

test('MutationObserver delivers childList and filtered attribute records', { skip }, async () => {
  const { context } = await runWebapp(fixture, { frames: 3, width: 1280, height: 720 });
  const records = [...context.__mo];
  // [type, attributeName, oldValue, added, removed]
  assert.deepEqual(records.slice(0, 3), ['childList:::1:0', 'attributes:hidden::0:0', 'attributes:hidden::0:0']);
  const card = context.document.querySelector('#flag > button');
  assert.ok(card.classList.contains('decorated'));
  assert.equal(card.children.length, 1, 'the callback ran once per new button, not in a loop');
  assert.ok(records.filter((r) => r === 'childList:::1:0').length >= 2, 'the decorator\'s own append is observed too');
  assert.ok(!records.some((r) => r.includes('title')), 'attributeFilter excludes other attributes');
});

test('DOM queries use the full selector matcher (:scope, :is, :not, sibling combinators)', { skip }, async () => {
  const { context } = await runWebapp(fixture, { frames: 2, width: 1280, height: 720 });
  const doc = context.document;
  const box = doc.createElement('div');
  box.innerHTML = '<span data-r="a"></span><p class="x"><span data-r="b"></span></p><i class="y"></i><b></b>';
  doc.body.append(box);
  assert.equal(box.querySelectorAll(':scope > span[data-r]').length, 1, ':scope > only matches children');
  assert.equal(box.querySelectorAll('span[data-r]').length, 2);
  assert.equal(box.querySelectorAll(':is(p, i).x, i.y').length, 2);
  assert.equal(box.querySelectorAll('*:not(.x, .y)').length, 3);
  assert.equal(box.querySelector('p + i').className, 'y');
  assert.equal(box.querySelectorAll('span ~ b').length, 1);
  assert.equal(box.querySelector('i').matches(':scope.y'), true);
  assert.equal(box.querySelector('[data-r=b]').closest(':not(span)'), box.querySelector('p'));
  box.remove();
});

test('clip-path circle wider than a non-square box still clips round', { skip }, async () => {
  const { rec } = await runWebapp(fixture, { frames: 3, width: 1280, height: 720 });
  let clip = null;
  decodeUi(rec.ui.floats, (op, a) => { if (op === CLIP && a[0] > 100 && a[0] < 110 && near(a[1], 300)) clip = Array.from(a.slice(0, 5)); });
  // circle(50%) of a 140x120 box: R = 50% of sqrt((140^2 + 120^2) / 2) = 65.2,
  // clamped to the box height -> 130.4 x 120 with radius 60 (was square before).
  assert.ok(clip, 'minimap host clip emitted');
  assert.deepEqual(clip.slice(0, 4).map((v) => Math.round(v * 10) / 10), [104.8, 300, 130.4, 120]);
  assert.equal(Math.round(clip[4]), 60);
});
