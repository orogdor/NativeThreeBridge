// HTML/CSS UI layer (js/webapp-ui.js): cascade, layout, display list,
// hit-testing and DOM geometry, through the same Node mirror of the engine
// host that the other webapp tests use.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWebapp, threeBuildDir } from './helpers/webapp-node-host.mjs';
import { decodeUi } from '../tools/ui-preview.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures/webapp-ui');
const skip = threeBuildDir() ? false : 'three.js build not installed';
const OP = { CLIP: 1, RECT: 2, BORDER: 3, IMAGE: 4, TEXT: 5, LGRAD: 6, RGRAD: 7, SHADOW: 8 };

function decoded(rec) {
  const items = [];
  decodeUi(rec.ui.floats, (op, a) => items.push({ op, a: Array.from(a) }));
  const s = rec.ui.strings;
  return {
    items,
    texts: items.filter((i) => i.op === OP.TEXT).map((i) => ({ text: s[i.a[4]], font: s[i.a[5]], x: i.a[0], y: i.a[1], w: i.a[2], h: i.a[3], size: i.a[6], weight: i.a[7], color: i.a.slice(9, 13) })),
    images: items.filter((i) => i.op === OP.IMAGE).map((i) => ({ src: s[i.a[4]], x: i.a[0], y: i.a[1], w: i.a[2], h: i.a[3], crop: i.a.slice(5, 9) })),
  };
}
const rectOf = (doc, id) => doc.getElementById(id).getBoundingClientRect();
const center = (r) => [r.x + r.width / 2, r.y + r.height / 2];
const settle = () => new Promise((r) => setImmediate(r));
async function step(host, n = 1) { for (let i = 0; i < n; i++) { host.frame(i * 16); await settle(); } }

test('stylesheets cascade into a real layout (flex, grid, fixed, translate, media)', { skip }, async () => {
  const { context, status, rec } = await runWebapp(fixture, { frames: 3, width: 1280, height: 720 });
  assert.equal(status.bootError, null);
  assert.deepEqual(rec.logs.filter((l) => l[0] === 'error'), []);
  const doc = context.document;
  const hud = rectOf(doc, 'hud');
  assert.deepEqual([hud.x, hud.y, hud.width, hud.height], [0, 0, 1280, 44], 'fixed header spans the window');
  const pause = rectOf(doc, 'pause');
  assert.ok(Math.abs(pause.right - 1268) < 0.5, `margin-left:auto pushes the last flex item right (${pause.right})`);
  const card = doc.querySelector('.card').getBoundingClientRect();
  assert.equal(card.width, 420, 'width: min(420px, 90vw)');
  assert.ok(Math.abs(card.x + card.width / 2 - 640) < 0.5 && Math.abs(card.y + card.height / 2 - 360) < 0.5, 'flex centring');
  const start = rectOf(doc, 'start');
  assert.equal(start.width, card.width - 2 - 48, 'block button fills the card content box');
  const tools = rectOf(doc, 'tools');
  assert.ok(Math.abs(tools.x + tools.width / 2 - 640) < 0.5, 'left:50% + translateX(-50%)');
  assert.ok(Math.abs(tools.bottom - 708) < 0.5, 'bottom: 12px');
  // grid: 3 equal columns, second cell spans two
  const cells = doc.querySelectorAll('.cell').map((c) => c.getBoundingClientRect());
  assert.ok(Math.abs(cells[0].width - (370 - 8) / 3) < 0.5);
  assert.ok(Math.abs(cells[1].width - (2 * (370 - 8) / 3 + 4)) < 0.5, 'span 2 includes the gap');
  assert.equal(cells[2].y, cells[3].y);
  assert.ok(cells[2].y > cells[0].y);
  // hidden / closed details have no box
  assert.equal(rectOf(doc, 'panel').width, 0);
  assert.equal(rectOf(doc, 'more-text').height, 0);
  // computed style
  assert.equal(context.getComputedStyle(doc.getElementById('menu')).display, 'flex');
  assert.equal(context.getComputedStyle(doc.getElementById('title')).color, '#e3b341', 'var() from @import-ed theme');
  assert.equal(context.getComputedStyle(doc.getElementById('start')).width, `${start.width - 24 - 2}px`);
  // @media (max-width: 700px) turns the toolbar into a right-hand column
  context.__ntHost.resize(640, 720);
  const narrow = rectOf(doc, 'tools');
  assert.ok(narrow.height > narrow.width, 'flex-direction: column under 700px');
  assert.ok(Math.abs(narrow.right - 632) < 0.5);
});

test('display list: text, images, gradients, shadows; nothing behind the 3D canvas', { skip }, async () => {
  const { rec } = await runWebapp(fixture, { frames: 3, width: 1280, height: 720 });
  assert.ok(rec.uiSubmits >= 1, 'UI submitted to the engine');
  const d = decoded(rec);
  const words = d.texts.map((t) => t.text);
  for (const w of ['KUNINGRIIGID', 'Alusta mängu', 'Kuld: ', '120', ' ⛀', 'Salvestatud', '⚒ Ehita', 'Rida 1']) assert.ok(words.includes(w), w);
  const title = d.texts.find((t) => t.text === 'KUNINGRIIGID');
  assert.equal(title.size, 28);
  assert.equal(title.weight, 700, 'h1 is bold by default');
  assert.ok(Math.abs(title.color[0] - 0xe3 / 255) < 0.01);
  assert.ok(d.texts.find((t) => t.text === 'Alusta mängu').font.startsWith('Segoe UI'));
  const srcs = d.images.map((i) => i.src);
  assert.ok(srcs.includes('img/icon.png'), '<img>');
  assert.ok(srcs.includes('img/frame.svg'), 'background-image url() relative to the stylesheet');
  const photo = d.images.find((i) => i.src === 'img/photo.jpg');
  assert.ok(photo.crop[3] > 0 && photo.crop[3] < 48 && Math.abs(photo.crop[2] - 64) < 0.01, 'object-fit: cover crops the source rows');
  assert.ok(d.items.some((i) => i.op === OP.LGRAD), 'linear-gradient');
  assert.ok(d.items.some((i) => i.op === OP.SHADOW), 'box-shadow');
  assert.ok(d.items.some((i) => i.op === OP.BORDER), 'borders');
  // body { background: #102030 } is behind the full-window canvas: not drawn
  const bodyBg = d.items.find((i) => i.op === OP.RECT && Math.abs(i.a[8] - 0x10 / 255) < 0.01 && Math.abs(i.a[10] - 0x30 / 255) < 0.01 && i.a[2] >= 1280);
  assert.equal(bodyBg, undefined);
  // the scroller clips its rows
  assert.ok(d.items.some((i) => i.op === OP.CLIP && i.a[2] === 370 && i.a[3] === 60));
});

test('pointer input is hit-tested: buttons get clicks, the canvas gets the rest', { skip }, async () => {
  const { context, host } = await runWebapp(fixture, { frames: 3, width: 1280, height: 720 });
  const doc = context.document;
  const click = (x, y) => { host.pointer('move', x, y, 0); host.pointer('down', x, y, 0); host.pointer('up', x, y, 0); };
  click(...center(rectOf(doc, 'start')));
  click(...center(rectOf(doc, 'pause')));
  click(...center(rectOf(doc, 'off')));
  assert.deepEqual(Array.from(context.clicks), ['start', 'pause'], 'disabled button gets no click');
  const downsBefore = context.canvasDowns;
  click(100, 300); // empty area: #menu has pointer-events:none, so the canvas is hit
  assert.equal(context.canvasDowns, downsBefore + 1);
  assert.equal(doc.elementFromPoint(...center(rectOf(doc, 'start'))).id, 'start');
  // <details> toggles on summary click; the paragraph then gets a box
  click(...center(rectOf(doc, 'more-summary')));
  assert.equal(doc.getElementById('more').hasAttribute('open'), true);
  assert.ok(rectOf(doc, 'more-text').height > 0);
  // checkbox default action
  click(...center(rectOf(doc, 'sound')));
  assert.equal(context.sound, true);
  // :hover restyles the button under the pointer
  host.pointer('move', ...center(rectOf(doc, 'build')), 0);
  assert.equal(context.getComputedStyle(doc.getElementById('build')).backgroundColor, '#5a4c34');
});

test('wheel scrolls overflow:auto boxes; DOM changes re-layout', { skip }, async () => {
  const { context, host, rec } = await runWebapp(fixture, { frames: 3, width: 1280, height: 720 });
  const doc = context.document;
  const scroller = doc.getElementById('scroller');
  assert.ok(scroller.scrollHeight > scroller.clientHeight);
  const firstRow = scroller.firstChild.getBoundingClientRect().y;
  host.wheel(...center(rectOf(doc, 'scroller')), 0, 40);
  assert.equal(scroller.scrollTop, 40);
  assert.equal(scroller.firstChild.getBoundingClientRect().y, firstRow - 40);
  const submits = rec.uiSubmits;
  context.addGold(5);
  await new Promise((r) => setTimeout(r, 150)); // past the adaptive refresh interval
  await step(host);
  assert.ok(rec.uiSubmits > submits, 'text change re-submits the UI');
  assert.ok(decoded(rec).texts.some((t) => t.text === '125'));
  const idle = rec.uiSubmits;
  await step(host, 3);
  assert.equal(rec.uiSubmits, idle, 'unchanged UI is not re-sent');
  doc.getElementById('panel').hidden = false;
  assert.ok(rectOf(doc, 'panel').height > 0, 'hidden attribute removal');
  doc.getElementById('toast').style.display = 'none';
  assert.equal(rectOf(doc, 'toast').width, 0, 'inline style change');
});
