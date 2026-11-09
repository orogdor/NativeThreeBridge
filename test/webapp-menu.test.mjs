import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, threeBuildDir } from './helpers/webapp-node-host.mjs';
import { decodeUi } from '../tools/ui-preview.mjs';

const fixture = fileURLToPath(new URL('./fixtures/webapp-menu', import.meta.url));
const skip = threeBuildDir() ? false : 'three.js build not installed';
const center = (el) => {
  const r = el.getBoundingClientRect();
  return [r.x + r.width / 2, r.y + r.height / 2];
};
const click = (host, x, y) => {
  host.pointer('down', x, y, 0);
  host.pointer('up', x, y, 0);
};
const popupLabel = (host, label) => {
  host.ui.hitTest(0, 0); // Flush invalidation before inspecting the display list.
  const { floats, joined } = host.ui._debug.encode();
  const strings = joined.split('\x1f');
  let match;
  decodeUi(floats, (op, data) => {
    if (op === 5 && strings[data[4]].trim() === label) match = [data[0] + 12, data[1] + 6];
  });
  assert.ok(match, `visible option ${label}`);
  return match;
};

test('menu keeps its grid scroll offset through measurement and reaches its last control', { skip }, async () => {
  const { context, host } = await runWebapp(fixture, { frames: 1, width: 1280, height: 720 });
  const doc = context.document;
  const controls = doc.getElementById('controls'), last = doc.getElementById('last');
  const [x] = center(controls), y = controls.getBoundingClientRect().top + 12;
  host.wheel(x, y, 0, 120);
  host.ui.hitTest(x, y);
  assert.equal(controls.scrollTop, 120);
  host.wheel(x, y, 0, 2400);
  host.ui.hitTest(x, y);
  assert.ok(controls.scrollTop > 300);
  assert.equal(host.ui.hitTest(...center(last)), last, 'bottom setting is visible and clickable');
  host.resize(700, 650);
  const card = doc.getElementById('card');
  host.wheel(...center(card), 0, 2400);
  host.ui.hitTest(...center(card));
  assert.equal(host.ui.hitTest(...center(last)), last, 'the single-column menu also reaches its bottom');
});

test('nested wheel input continues to the parent at the inner boundary', { skip }, async () => {
  const { context, host } = await runWebapp(fixture, { frames: 1, width: 1280, height: 720 });
  const doc = context.document;
  const controls = doc.getElementById('controls'), nested = doc.getElementById('nested');
  const [x, y] = center(nested);
  host.wheel(x, y, 0, 300);
  host.ui.hitTest(x, y);
  assert.equal(nested.scrollTop, 125);
  assert.equal(controls.scrollTop, 0);
  host.wheel(x, y, 0, 70);
  host.ui.hitTest(x, y);
  assert.equal(controls.scrollTop, 70);
});

test('select opens a list, commits only an enabled choice and fires change once', { skip }, async () => {
  const { context, host } = await runWebapp(fixture, { frames: 1, width: 1280, height: 720 });
  const select = context.document.getElementById('quality');
  const events = [];
  select.addEventListener('input', () => events.push('input'));
  select.addEventListener('change', () => events.push('change'));
  click(host, ...center(select));
  assert.equal(select.value, 'low');
  assert.deepEqual(events, []);
  click(host, ...popupLabel(host, 'Unavailable'));
  assert.equal(select.value, 'low');
  click(host, ...popupLabel(host, 'High detail'));
  assert.equal(select.value, 'high');
  assert.deepEqual(events, ['input', 'change']);
  click(host, ...center(select));
  click(host, ...center(select));
  assert.equal(select.value, 'high');
  click(host, ...center(select));
  host.key(true, 'Escape', 'Escape', false, false, false, false, false);
  assert.equal(select.value, 'high');
  click(host, ...center(select));
  const pos = popupLabel(host, 'High detail');
  host.wheel(...pos, 0, 300);
  click(host, ...popupLabel(host, 'Final choice'));
  assert.equal(select.value, 'last');
  assert.deepEqual(events, ['input', 'change', 'input', 'change']);
});
