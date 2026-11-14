// Painted game HUDs (Kuningriigid v304+ style): dataset-driven [data-*]
// selectors, closed <details> with author display rules, border-image frames,
// calc() inside the `font` shorthand, z-index:auto positioned boxes and
// clip-path.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWebapp, threeBuildDir } from './helpers/webapp-node-host.mjs';
import { decodeUi } from '../tools/ui-preview.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures/webapp-ui-painted');
const skip = threeBuildDir() ? false : 'three.js build not installed';
const OP = { CLIP: 1, RECT: 2, BORDER: 3, IMAGE: 4, TEXT: 5 };

function ops(rec) {
  const out = [];
  let clip = null;
  decodeUi(rec.ui.floats, (op, a) => {
    if (op === OP.CLIP) { clip = a[2] < 0 ? null : Array.from(a.slice(0, 4)); return; }
    out.push({ op, a: Array.from(a), clip, s: op === OP.IMAGE || op === OP.TEXT ? rec.ui.strings[a[4]] : null });
  });
  return out;
}

test('painted HUD features match Chromium', { skip }, async () => {
  const { context, status, rec } = await runWebapp(fixture, { frames: 3, width: 1280, height: 720 });
  assert.equal(status.bootError, null);
  const doc = context.document;
  const rect = (id) => doc.getElementById(id).getBoundingClientRect();

  // dataset <-> data-* attributes, both ways
  const r2 = doc.getElementById('r2');
  assert.equal(r2.getAttribute('data-kind'), 'wood');
  assert.equal(r2.getAttribute('data-extra-value'), 'x');
  r2.setAttribute('data-other', '1');
  assert.equal(r2.dataset.other, '1');
  assert.deepEqual(Object.keys(r2.dataset).sort(), ['extraValue', 'kind', 'other']);
  delete r2.dataset.other;
  assert.equal(r2.hasAttribute('data-other'), false);
  assert.equal(rect('r1').x, 300, '[data-kind=gold] set through dataset');
  assert.equal(rect('r2').x, 400, '[data-kind=wood] set through dataset');

  // closed details keeps author `display:grid` content hidden
  assert.equal(rect('fields').height, 0);
  assert.ok(rect('sum').height > 0);
  assert.ok(rect('fields2').height > 0, 'open details shows its content');
  const list = ops(rec);
  assert.ok(!list.some((o) => o.op === OP.TEXT && /Loose text|^A$|^B$/.test(o.s)), 'nothing of a closed details is drawn');

  // calc() with a nested '/' inside the font shorthand
  const title = list.find((o) => o.op === OP.TEXT && o.s === 'World map');
  assert.ok(Math.abs(title.a[6] - 28) < 0.01, `font-size from calc() in font shorthand (${title.a[6]})`);
  assert.equal(title.a[7], 700);

  // border-image: nine slices, stretch, centre kept by `fill`
  const slices = list.filter((o) => o.op === OP.IMAGE && o.s === 'frame.png' && o.a[0] < 300);
  assert.equal(slices.length, 9);
  const corner = slices[0].a;
  assert.deepEqual(corner.slice(0, 4), [10, 10, 16, 16], 'top-left corner uses border-image-width');
  assert.deepEqual(corner.slice(5, 9), [0, 0, 8, 8], '25% of a 32px image');
  assert.ok(!list.some((o) => o.op === OP.BORDER && o.a[0] === 10 && o.a[1] === 10), 'border-image replaces the border');

  // z-index:auto positioned button: its z-index:2 child paints above the z-index:1 frame
  const imgs = list.filter((o) => o.op === OP.IMAGE && o.a[0] >= 600);
  const frameAt = imgs.findIndex((o) => o.a[2] === 100);
  const picAt = imgs.findIndex((o) => o.a[2] === 80);
  assert.ok(frameAt >= 0 && picAt > frameAt, `picture after frame (${frameAt}, ${picAt})`);
  // clip-path: inset(0 0 25% 0)
  assert.deepEqual(imgs[picAt].clip.map(Math.round), [612, 22, 80, 60], 'inside the button border');
});
