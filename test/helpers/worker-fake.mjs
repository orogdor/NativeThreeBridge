// Node stand-in for the engine's Web Worker and background-read natives
// (webapp_host_v8.cpp): each worker runs js/webapp-worker-shim.js in its own
// vm context. Everything stays on one thread, but messages, errors and
// finished reads are delivered between frames exactly like the engine does
// (WebappHost::frame -> pumpNative), so the page and worker shims are
// exercised end to end.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { resolveModule } from './webapp-node-host.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workerShim = readFileSync(path.join(repo, 'js/webapp-worker-shim.js'), 'utf8');

export function createWorkerNatives({ asyncReadBytes = 256 * 1024, hardwareConcurrency = 8 } = {}) {
  const outbox = [];       // [workerId, kind, data, message, filename, line]
  const reads = [];        // [id, buffer | null, error | null]
  const workers = new Map();
  const logs = [];
  let nextWorker = 1, nextRead = 1;
  const clone = (value, transfer) => structuredClone(value, { transfer: (transfer || []).filter((t) => t instanceof ArrayBuffer || Object.prototype.toString.call(t) === '[object ArrayBuffer]') });

  function install({ nt, context, readGameFile }) {
    context.__ntTestHarness = true;
    const toContextBuffer = (bytes) => {
      const ab = new (vm.runInContext('ArrayBuffer', context))(bytes.length);
      new Uint8Array(ab).set(bytes);
      return ab;
    };
    nt.hardwareConcurrency = () => hardwareConcurrency;
    nt.now = () => performance.now();
    nt.structuredClone = (value, transfer) => clone(value, transfer);
    nt.readBinaryAsync = (p) => {
      const bytes = readGameFile(String(p));
      if (bytes.length < asyncReadBytes) return toContextBuffer(bytes);
      const id = nextRead++;
      reads.push([id, toContextBuffer(bytes), null]);
      return id;
    };
    nt.workerCreate = (scriptPath, source, isModule, name, url) => {
      const id = nextWorker++;
      const ctx = vm.createContext({});
      const w = { id, ctx, inbox: [], closed: false, name, host: null };
      const send = (...event) => { if (!w.closed || event[1] !== 0) outbox.push([id, ...event]); };
      ctx.__ntw = {
        log: (level, text) => logs.push([String(level), `[worker ${name || scriptPath || id}] ${text}`]),
        postMessage: (value, transfer) => send(0, clone(value, transfer)),
        reportError: (message, file, line) => send(1, undefined, String(message), String(file), line | 0),
        close: () => { w.closed = true; },
        now: () => performance.now(),
        readText: (p) => readGameFile(String(p)).toString('utf8'),
        readBinary: (p) => {
          const bytes = readGameFile(String(p));
          const ab = new (vm.runInContext('ArrayBuffer', ctx))(bytes.length);
          new Uint8Array(ab).set(bytes);
          return ab;
        },
        evalScript: (code, file) => vm.runInContext(String(code), ctx, { filename: String(file) }),
        structuredClone: (value, transfer) => clone(value, transfer),
        hardwareConcurrency: () => hardwareConcurrency,
      };
      vm.runInContext(workerShim, ctx, { filename: 'nt:webapp-worker-shim.js' });
      w.host = ctx.__ntWorkerHost;
      w.host.boot(url, name, isModule);
      workers.set(id, w);
      const entry = scriptPath || `nt:worker-${id}`;
      const code = scriptPath ? readGameFile(scriptPath).toString('utf8') : String(source);
      const bootError = (e) => send(1, undefined, String(e && e.message || e), url, 0);
      if (!isModule) {
        try { vm.runInContext(code, ctx, { filename: entry }); } catch (e) { bootError(e); }
      } else {
        const cache = new Map();
        const load = (name2, text) => {
          if (cache.has(name2)) return cache.get(name2);
          const m = new vm.SourceTextModule(text, { context: ctx, identifier: name2 });
          cache.set(name2, m);
          return m;
        };
        const linker = (specifier, referencing) => {
          const resolved = resolveModule(referencing.identifier, specifier, [], []);
          return load(resolved, readGameFile(resolved).toString('utf8'));
        };
        w.ready = (async () => {
          const m = load(entry, code);
          await m.link(linker);
          await m.evaluate();
        })().catch(bootError);
      }
      return id;
    };
    nt.workerPost = (id, value, transfer) => {
      const data = clone(value, transfer);
      const w = workers.get(id);
      if (w && !w.closed) w.inbox.push(data);
    };
    nt.workerTerminate = (id) => {
      const w = workers.get(id);
      if (w) { w.closed = true; workers.delete(id); }
    };
  }

  // Worker threads "run", then the page receives what they sent.
  async function beforeFrame({ host }) {
    for (const w of [...workers.values()]) {
      if (w.ready) await w.ready;
      while (w.inbox.length && !w.closed) w.host.message(w.inbox.shift(), false);
      if (!w.closed) w.host.timers(performance.now());
    }
    await new Promise((r) => setTimeout(r, 2));
    for (const w of workers.values()) if (!w.closed) w.host.timers(performance.now());
    for (const [id, buffer, error] of reads.splice(0)) host.ioComplete(id, buffer, error);
    for (const event of outbox.splice(0)) host.workerEvent(...event);
  }

  return { install, beforeFrame, logs, workers };
}
