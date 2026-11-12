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
