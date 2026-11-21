// Web Workers, background fetch and structuredClone in the webapp shims.
// The engine runs each worker on its own thread (webapp_host_v8.cpp); the
// Windows CI runs the same fixture there (WebappSmokeV8).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runWebapp, threeBuildDir } from './helpers/webapp-node-host.mjs';
import { createWorkerNatives } from './helpers/worker-fake.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(repo, 'test/fixtures/webapp-workers');
const skip = threeBuildDir() ? false : 'three is not installed (npm install)';

test('workers fixture: classic, module, blob, errors, shared memory, background fetch', { skip }, async () => {
  const natives = createWorkerNatives();
  const { rec, status, context } = await runWebapp(fixture, { frames: 40, natives: natives.install, beforeFrame: natives.beforeFrame });
  assert.equal(status.bootError, null);
  assert.deepEqual(status.errors, []);
  assert.equal(rec.titles.at(-1), 'Workers OK', `title: ${rec.titles.at(-1)}; logs: ${JSON.stringify(natives.logs)}`);
  assert.equal(rec.passes.at(-1)[43], 4, 'the page drew the extra meshes after every check passed');
  assert.equal(context.navigator.hardwareConcurrency, 8);
  assert.equal(context.crossOriginIsolated, true);
  assert.equal(natives.workers.size, 0, 'the page terminated its workers');
});

test('without native workers (QuickJS build) Worker stays undefined', { skip }, async () => {
  const { context } = await runWebapp(path.join(repo, 'samples/hello-webapp'), { frames: 2 });
  assert.equal(typeof context.Worker, 'undefined');
  assert.equal(context.crossOriginIsolated, false);
  assert.equal(typeof context.MessageEvent, 'function');
});

// The worker shim alone, with a minimal native side.
function bootWorker(source, { url = 'nt://game/js/w.js', name = 'w', files = {} } = {}) {
  const sent = [], errors = [], logs = [];
  let now = 0;
  const ctx = vm.createContext({});
  ctx.__ntw = {
    log: (l, t) => logs.push([l, t]), postMessage: (v) => sent.push(structuredClone(v)),
    reportError: (m, f, l) => errors.push({ m, f, l }), close() {}, now: () => now,
    readText: (p) => { if (!(p in files)) throw new ReferenceError(`File not found in game folder: ${p}`); return files[p]; },
    readBinary: () => new ArrayBuffer(0),
    evalScript: (code, file) => vm.runInContext(code, ctx, { filename: file }),
    structuredClone: (v) => structuredClone(v), hardwareConcurrency: () => 6,
  };
  vm.runInContext(readFileSync(path.join(repo, 'js/webapp-worker-shim.js'), 'utf8'), ctx);
  ctx.__ntWorkerHost.boot(url, name, false);
  vm.runInContext(source, ctx);
  return { ctx, sent, errors, logs, host: ctx.__ntWorkerHost, advance(ms) { now += ms; return ctx.__ntWorkerHost.timers(now); } };
}

test('worker shim: messages, listeners, timers and the next-timer delay', () => {
  const w = bootWorker(`
    let ticks = 0;
    addEventListener('message', (e) => postMessage({ via: 'listener', data: e.data }));
    onmessage = (e) => postMessage({ via: 'onmessage', data: e.data });
    setTimeout(() => postMessage('timeout'), 10);
    const id = setInterval(() => { if (++ticks === 2) { clearInterval(id); postMessage('interval'); } }, 4);
    postMessage([self.name, navigator.hardwareConcurrency, location.href, typeof importScripts, self === globalThis]);
  `);
  assert.deepEqual(w.sent.shift(), ['w', 6, 'nt://game/js/w.js', 'function', true]);
  w.host.message({ n: 1 }, false);
  assert.deepEqual(w.sent.splice(0), [{ via: 'listener', data: { n: 1 } }, { via: 'onmessage', data: { n: 1 } }]);
  assert.equal(w.advance(0), 4, 'next timer in 4 ms');
  w.advance(4);
  w.advance(4);
  assert.deepEqual(w.sent.splice(0), ['interval']);
  assert.equal(w.advance(0), 2, 'timeout in 2 ms');
  w.advance(2);
  assert.deepEqual(w.sent.splice(0), ['timeout']);
  assert.equal(w.advance(100), -1, 'no timers left');
});

test('worker shim: errors go to self.onerror first, then to the page', () => {
  const w = bootWorker(`
    let handled = 0;
    onmessage = (e) => { if (e.data === 'throw') throw new Error('boom ' + handled); };
    onerror = (message) => { handled++; return handled === 1; };
  `);
  w.host.message('throw', false);
  assert.equal(w.errors.length, 0, 'onerror returned true: handled');
  w.host.message('throw', false);
  assert.equal(w.errors.length, 1);
  assert.match(w.errors[0].m, /boom 1/);
});

test('worker shim: importScripts, URL resolution, fetch inside the game folder', async () => {
  const w = bootWorker(`
    importScripts('../lib/a.js', 'b.js');
    postMessage([a, b, new URL('../x/y.png?v=2#h', location.href).href, new URL('/root.js', location.href).pathname]);
    fetch('https://example.com/x').catch((e) => postMessage('blocked: ' + (e instanceof TypeError)));
  `, { files: { 'lib/a.js': 'var a = 1;', 'js/b.js': 'var b = 2;' } });
  assert.deepEqual(w.sent.shift(), [1, 2, 'nt://game/x/y.png?v=2#h', '/root.js']);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.sent.splice(0), ['blocked: true']);
  assert.throws(() => vm.runInContext("importScripts('missing.js')", w.ctx), /File not found/);
});

test('worker shim: TextEncoder/TextDecoder round trip and base64', () => {
  const w = bootWorker(`
    const text = 'Tõnu 🚜 ääre';
    const bytes = new TextEncoder().encode(text);
    postMessage([new TextDecoder().decode(bytes), bytes.length, atob(btoa('ok')), crypto.randomUUID().length]);
  `);
  assert.deepEqual(w.sent.shift(), ['Tõnu 🚜 ääre', Buffer.byteLength('Tõnu 🚜 ääre'), 'ok', 36]);
});
