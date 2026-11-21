// NativeThreeBridge worker shim (classic script, embedded in the EXE).
//
// The global scope of a Web Worker: self, postMessage/onmessage, close,
// importScripts, timers, fetch for files inside the game folder, console,
// performance, URL, TextEncoder/TextDecoder, atob/btoa, structuredClone.
// Every worker runs in its own V8 isolate on its own OS thread, so this file
// shares nothing with the page shim (js/webapp-shim.js).
//
// Native side (`globalThis.__ntw`, see webapp_host_v8.cpp runWorker):
//   log(level, text)  postMessage(value, transferList)  reportError(message, file, line)
//   close()  now() -> ms  readText(path)  readBinary(path) -> ArrayBuffer
//   evalScript(source, name)  structuredClone(value, transferList)  hardwareConcurrency()
// Engine -> JS entry points live on `globalThis.__ntWorkerHost`.
(function installWorkerShim(global) {
  'use strict';
  const nt = global.__ntw;
  if (!nt) throw new Error('NativeThreeBridge: __ntw native bridge missing');
  const GAME_ORIGIN = 'nt://game';
  let scriptURL = `${GAME_ORIGIN}/worker.js`;
  let closing = false;

  // ---------------------------------------------------------------- console
  function format(args) {
    return args.map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ? `${a.message}\n${a.stack}` : String(a);
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
  }
  const console = {};
  for (const [name, level] of [['log', 'log'], ['info', 'info'], ['debug', 'debug'], ['warn', 'warn'], ['error', 'error'], ['trace', 'debug'], ['table', 'log'], ['dir', 'log'], ['group', 'log'], ['groupCollapsed', 'log']])
    console[name] = (...a) => nt.log(level, format(a));
  console.groupEnd = () => {};
  console.assert = (ok, ...a) => { if (!ok) nt.log('error', 'Assertion failed: ' + format(a)); };
  const labels = new Map();
  console.time = (l = 'default') => labels.set(l, nt.now());
  console.timeEnd = (l = 'default') => { if (labels.has(l)) nt.log('log', `${l}: ${(nt.now() - labels.get(l)).toFixed(3)} ms`); labels.delete(l); };
  console.timeLog = (l = 'default') => { if (labels.has(l)) nt.log('log', `${l}: ${(nt.now() - labels.get(l)).toFixed(3)} ms`); };
  console.count = (() => { const c = new Map(); return (l = 'default') => { const n = (c.get(l) || 0) + 1; c.set(l, n); nt.log('log', `${l}: ${n}`); }; })();

  // ---------------------------------------------------------------- paths
  function normalizePath(path) {
    const out = [];
    for (const part of path.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') { if (out.length === 0) throw new TypeError(`Path leaves the game folder: ${path}`); out.pop(); } else out.push(part);
    }
    return out.join('/');
  }
  // Minimal WHATWG URL: absolute URLs keep their scheme; relative ones
  // resolve against the worker script inside nt://game.
  class URL {
    constructor(input, base) {
      let href = String(input instanceof URL ? input.href : input);
      if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        const b = base === undefined ? null : String(base instanceof URL ? base.href : base);
        if (!b) throw new TypeError(`Invalid URL: ${href}`);
        const m = /^nt:\/\/game(\/[^?#]*)?/.exec(b);
        if (!m) throw new TypeError(`Cannot resolve ${href} against ${b}`);
        const [, rest = '', hash = ''] = /^([^#]*)(#.*)?$/.exec(href);
        const [, pathPart = '', query = ''] = /^([^?]*)(\?.*)?$/.exec(rest);
        const baseDir = (m[1] || '/').replace(/[^/]*$/, '');
        const joined = pathPart.startsWith('/') ? pathPart : pathPart === '' ? (m[1] || '/') : baseDir + pathPart;
        href = `${GAME_ORIGIN}/${normalizePath(joined)}${query}${hash}`;
      }
      const m = /^([a-z][a-z0-9+.-]*:)(?:\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(href);
      this.protocol = m ? m[1].toLowerCase() : '';
      this.host = this.hostname = m && m[2] || '';
      this.port = '';
      this.pathname = m && m[3] || '';
      this.search = m && m[4] || '';
      this.hash = m && m[5] || '';
      this.href = href;
      this.origin = this.protocol === 'nt:' ? GAME_ORIGIN : this.host ? `${this.protocol}//${this.host}` : 'null';
      this.username = this.password = '';
    }
    get searchParams() {
      const params = new Map();
      for (const pair of this.search.replace(/^\?/, '').split('&')) {
        if (!pair) continue;
        const [k, v = ''] = pair.split('=');
        params.set(decodeURIComponent(k.replace(/\+/g, ' ')), decodeURIComponent(v.replace(/\+/g, ' ')));
      }
      return { get: (k) => (params.has(k) ? params.get(k) : null), has: (k) => params.has(k), entries: () => params.entries(), [Symbol.iterator]: () => params.entries() };
    }
    toString() { return this.href; }
    toJSON() { return this.href; }
    static createObjectURL(blob) { const url = `blob:${GAME_ORIGIN}/${++blobSeq}`; blobStore.set(url, blob); return url; }
    static revokeObjectURL(url) { blobStore.delete(String(url)); }
  }
  let blobSeq = 0;
  const blobStore = new Map();
  function toGamePath(input) {
    const url = new URL(String(input), scriptURL);
    if (url.protocol !== 'nt:' || url.host !== 'game') return null;
    return normalizePath(decodeURIComponent(url.pathname));
  }

  // ---------------------------------------------------------- text, base64
  class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(text = '') {
      const s = String(text), out = [];
      for (let i = 0; i < s.length; i++) {
        let c = s.codePointAt(i);
        if (c > 0xffff) i++;
        else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }
    encodeInto(text, dest) { const b = this.encode(text); const n = Math.min(b.length, dest.length); dest.set(b.subarray(0, n)); return { read: String(text).length, written: n }; }
  }
  class TextDecoder {
    constructor(label = 'utf-8', options = {}) { this.encoding = 'utf-8'; this.fatal = !!options.fatal; this.ignoreBOM = !!options.ignoreBOM; }
    decode(input) {
      if (input === undefined) return '';
      const b = input instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && input instanceof SharedArrayBuffer)
        ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      let out = '', i = 0;
      if (!this.ignoreBOM && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
      const chunk = [];
      const flush = () => { out += String.fromCharCode.apply(null, chunk); chunk.length = 0; };
      while (i < b.length) {
        const c = b[i++];
        let cp;
        if (c < 0x80) cp = c;
        else if (c >= 0xc2 && c < 0xe0 && i < b.length) cp = ((c & 31) << 6) | (b[i++] & 63);
        else if (c >= 0xe0 && c < 0xf0 && i + 1 < b.length) { cp = ((c & 15) << 12) | ((b[i] & 63) << 6) | (b[i + 1] & 63); i += 2; }
        else if (c >= 0xf0 && c < 0xf5 && i + 2 < b.length) { cp = ((c & 7) << 18) | ((b[i] & 63) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63); i += 3; }
        else { if (this.fatal) throw new TypeError('The encoded data was not valid utf-8'); cp = 0xfffd; }
        if (cp > 0xffff) { cp -= 0x10000; chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); } else chunk.push(cp);
        if (chunk.length >= 8192) flush();
      }
      flush();
      return out;
    }
  }
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function btoa(s) {
    s = String(s); let out = '';
    for (let i = 0; i < s.length; i += 3) {
      const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255) throw new Error('btoa: character out of range');
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < s.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < s.length ? B64[n & 63] : '=');
    }
    return out;
  }
  function atob(s) {
    s = String(s).replace(/[\s=]/g, ''); let out = '';
    for (let i = 0; i < s.length; i += 4) {
      const n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) | ((B64.indexOf(s[i + 2]) & 63) << 6) | (B64.indexOf(s[i + 3]) & 63);
      out += String.fromCharCode(n >> 16);
      if (i + 2 < s.length) out += String.fromCharCode((n >> 8) & 255);
      if (i + 3 < s.length) out += String.fromCharCode(n & 255);
    }
    return out;
  }

  // ---------------------------------------------------------------- events
  class Event {
    constructor(type, init = {}) {
      this.type = String(type); this.bubbles = !!init.bubbles; this.cancelable = !!init.cancelable;
      this.target = null; this.currentTarget = null; this.defaultPrevented = false; this.isTrusted = false;
      this.timeStamp = nt.now(); this._stopNow = false;
    }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    stopPropagation() {}
    stopImmediatePropagation() { this._stopNow = true; }
  }
  class MessageEvent extends Event {
    constructor(type, init = {}) { super(type, init); this.data = init.data; this.origin = init.origin || ''; this.lastEventId = ''; this.source = null; this.ports = init.ports || []; }
  }
  class ErrorEvent extends Event {
    constructor(type, init = {}) { super(type, init); this.message = init.message || ''; this.filename = init.filename || ''; this.lineno = init.lineno || 0; this.colno = init.colno || 0; this.error = init.error ?? null; }
  }
  class PromiseRejectionEvent extends Event {
    constructor(type, init = {}) { super(type, init); this.promise = init.promise; this.reason = init.reason; }
  }
  class EventTarget {
    addEventListener(type, listener, options) {
      if (!listener) return;
      const listeners = this._ntListeners || (Object.defineProperty(this, '_ntListeners', { value: new Map() }), this._ntListeners);
      const once = !!(options && typeof options === 'object' && options.once);
      const list = listeners.get(type) || [];
      if (!list.some((l) => l.listener === listener)) list.push({ listener, once });
      listeners.set(type, list);
    }
    removeEventListener(type, listener) {
      const list = this._ntListeners && this._ntListeners.get(type);
      if (list) this._ntListeners.set(type, list.filter((l) => l.listener !== listener));
    }
    dispatchEvent(event) {
      event.target = event.currentTarget = this;
      const list = this._ntListeners && this._ntListeners.get(event.type);
      // Like a browser: a throwing listener is reported and the rest still run.
      const call = (fn) => {
        try { return fn(); } catch (e) {
          if (event.type === 'error') nt.log('error', `worker error handler: ${e && e.stack || e}`); else reportError(e);
        }
        return undefined;
      };
      if (list) {
        for (const entry of list.slice()) {
          if (event._stopNow) break;
          if (entry.once) this.removeEventListener(event.type, entry.listener);
          call(() => (typeof entry.listener === 'function' ? entry.listener.call(this, event) : entry.listener.handleEvent(event)));
        }
      }
      const handler = this['on' + event.type];
      if (typeof handler === 'function' && !event._stopNow) {
        // self.onerror is an OnErrorEventHandler: (message, filename, lineno, colno, error), true = handled.
        if (this === global && event instanceof ErrorEvent) {
          if (call(() => handler.call(this, event.message, event.filename, event.lineno, event.colno, event.error)) === true) event.preventDefault();
        } else if (call(() => handler.call(this, event)) === false) event.preventDefault();
      }
      return !event.defaultPrevented;
    }
  }
  // Listener errors behave like uncaught errors in a browser worker:
  // self.onerror / 'error' listeners first, then the page's Worker.onerror.
  function reportError(error) {
    const message = error && error.stack ? `${error}\n${error.stack}` : String(error);
    const event = new ErrorEvent('error', { message: String(error && error.message || error), error, cancelable: true, filename: scriptURL });
    let handled = false;
    try { handled = !global.dispatchEvent(event); } catch (e) { nt.log('error', `worker onerror: ${e}`); }
    if (!handled) nt.reportError(message, scriptURL, 0);
  }

  // ---------------------------------------------------------------- timers
  let timerSeq = 0;
  const timers = new Map();
  function addTimer(fn, delay, args, repeat) {
    const id = ++timerSeq, ms = Math.max(repeat ? 1 : 0, Number(delay) || 0);
    timers.set(id, { fn, args, due: nt.now() + ms, interval: repeat ? ms : null, seq: id });
    return id;
  }
  const setTimeout = (fn, delay = 0, ...args) => addTimer(fn, delay, args, false);
  const setInterval = (fn, delay = 0, ...args) => addTimer(fn, delay, args, true);
  const clearTimeout = (id) => { timers.delete(id); };
  function runTimers(now) {
    const due = [...timers.entries()].filter(([, t]) => t.due <= now).sort((a, b) => a[1].due - b[1].due || a[1].seq - b[1].seq);
    for (const [id, t] of due) {
      if (!timers.has(id) || closing) continue;
      if (t.interval === null) timers.delete(id); else t.due = Math.max(t.due + t.interval, now);
      try { typeof t.fn === 'function' ? t.fn(...t.args) : (0, eval)(String(t.fn)); } catch (e) { reportError(e); }
    }
    let next = Infinity;
    for (const t of timers.values()) next = Math.min(next, t.due);
    return next === Infinity ? -1 : Math.max(0, next - nt.now());
  }

  // ---------------------------------------------------------------- fetch
  class Headers {
    constructor(init) { this._m = new Map(); if (init) for (const [k, v] of (init instanceof Headers ? init._m : Symbol.iterator in Object(init) ? init : Object.entries(init))) this._m.set(String(k).toLowerCase(), String(v)); }
    get(k) { return this._m.get(String(k).toLowerCase()) ?? null; }
    set(k, v) { this._m.set(String(k).toLowerCase(), String(v)); }
    append(k, v) { this.set(k, v); }
    has(k) { return this._m.has(String(k).toLowerCase()); }
    delete(k) { this._m.delete(String(k).toLowerCase()); }
    forEach(fn) { for (const [k, v] of this._m) fn(v, k, this); }
    entries() { return this._m.entries(); }
    [Symbol.iterator]() { return this._m.entries(); }
  }
  const bytesOf = (b) => {
    if (b === null || b === undefined) return new Uint8Array(0);
    if (typeof b === 'string') return new TextEncoder().encode(b);
    if (b instanceof ArrayBuffer) return new Uint8Array(b);
    if (b instanceof Blob) return b._bytes;
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  };
  class Blob {
    constructor(parts = [], options = {}) {
      const chunks = parts.map((p) => (p instanceof Blob ? p._bytes : bytesOf(p)));
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
      this._bytes = out; this.size = out.length; this.type = String(options.type || '').toLowerCase();
    }
    arrayBuffer() { return Promise.resolve(this._bytes.slice().buffer); }
    text() { return Promise.resolve(new TextDecoder().decode(this._bytes)); }
    bytes() { return Promise.resolve(this._bytes.slice()); }
    slice(start = 0, end = this.size, type = '') { const b = new Blob([], { type }); b._bytes = this._bytes.slice(start, end); b.size = b._bytes.length; return b; }
  }
  class Response {
    constructor(body = null, init = {}) {
      this._body = body; this.status = init.status ?? 200; this.statusText = init.statusText ?? 'OK';
      this.ok = this.status >= 200 && this.status < 300; this.headers = new Headers(init.headers); this.url = init.url || '';
      this.redirected = false; this.type = 'basic'; this.bodyUsed = false;
    }
    _bytes() { this.bodyUsed = true; return bytesOf(this._body); }
    arrayBuffer() { const u = this._bytes(); return Promise.resolve(u.byteOffset === 0 && u.byteLength === u.buffer.byteLength ? u.buffer : u.slice().buffer); }
    bytes() { return Promise.resolve(this._bytes().slice()); }
    text() { return Promise.resolve(typeof this._body === 'string' ? (this.bodyUsed = true, this._body) : new TextDecoder().decode(this._bytes())); }
    json() { return this.text().then(JSON.parse); }
    blob() { return Promise.resolve(new Blob([this._bytes()], { type: this.headers.get('content-type') || '' })); }
    clone() { return new Response(this._body, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url }); }
  }
  class Request {
    constructor(input, init = {}) { this.url = input instanceof Request ? input.url : String(input); this.method = (init.method || 'GET').toUpperCase(); this.headers = new Headers(init.headers); }
  }
  const MIME = { json: 'application/json', js: 'text/javascript', mjs: 'text/javascript', wasm: 'application/wasm', html: 'text/html', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', glb: 'model/gltf-binary', gltf: 'model/gltf+json', bin: 'application/octet-stream' };
  function dataUrlBytes(url) {
    const m = /^data:([^,;]*)((?:;[^,]*)*),(.*)$/s.exec(url);
    if (!m) throw new TypeError('Bad data URL');
    if (/;base64/i.test(m[2])) { const raw = atob(m[3]); const out = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i) & 255; return { type: m[1], bytes: out }; }
    return { type: m[1], bytes: new TextEncoder().encode(decodeURIComponent(m[3])) };
  }
  function fetch(input, init = {}) {
    return new Promise((resolve, reject) => {
      const url = input instanceof Request ? input.url : String(input instanceof URL ? input.href : input);
      const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') { reject(new TypeError(`fetch: ${method} is not supported offline`)); return; }
      try {
        if (url.startsWith('blob:')) {
          const blob = blobStore.get(url);
          if (blob) resolve(new Response(blob, { url })); else reject(new TypeError(`fetch: unknown blob ${url}`));
          return;
        }
        if (url.startsWith('data:')) { const d = dataUrlBytes(url); resolve(new Response(d.bytes, { url, headers: { 'content-type': d.type || 'text/plain' } })); return; }
        const path = toGamePath(url);
        if (path === null) { reject(new TypeError(`fetch: network access is disabled in NativeThreeBridge (${url})`)); return; }
        let data;
        try { data = nt.readBinary(path); } catch (e) { resolve(new Response(String(e && e.message || e), { status: 404, statusText: 'Not Found', url })); return; }
        const ext = path.split('.').pop().toLowerCase();
        resolve(new Response(method === 'HEAD' ? null : data, { url: `${GAME_ORIGIN}/${path}`, headers: { 'content-type': MIME[ext] || 'application/octet-stream', 'content-length': String(data.byteLength) } }));
      } catch (e) { reject(e); }
    });
  }

  // ------------------------------------------------------ the global scope
  class WorkerGlobalScope extends EventTarget {}
  class DedicatedWorkerGlobalScope extends WorkerGlobalScope {}
  // `self instanceof WorkerGlobalScope` is how some libraries detect a worker.
  try { Object.setPrototypeOf(global, DedicatedWorkerGlobalScope.prototype); } catch { /* immutable global prototype */ }
  const performance = { now: () => nt.now(), timeOrigin: Date.now() - nt.now(), mark() {}, measure() {}, clearMarks() {}, clearMeasures() {}, getEntriesByName: () => [], getEntriesByType: () => [] };
  const navigator = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NativeThreeBridge', platform: 'Win32', language: 'et-EE', languages: ['et-EE', 'et', 'en'],
    onLine: false, hardwareConcurrency: nt.hardwareConcurrency(), deviceMemory: 8, gpu: undefined,
  };
  const location = {
    get href() { return scriptURL; }, protocol: 'nt:', host: 'game', hostname: 'game', port: '', origin: GAME_ORIGIN,
    get pathname() { return new URL(scriptURL).pathname; }, get search() { return new URL(scriptURL).search; }, get hash() { return new URL(scriptURL).hash; },
    toString() { return scriptURL; },
  };
  function importScripts(...urls) {
    for (const u of urls) {
      const href = new URL(String(u), scriptURL).href;
      let source;
      if (href.startsWith('blob:')) { const blob = blobStore.get(href); if (!blob) throw new TypeError(`importScripts: unknown blob ${href}`); source = new TextDecoder().decode(blob._bytes); }
      else if (href.startsWith('data:')) source = new TextDecoder().decode(dataUrlBytes(href).bytes);
      else {
        const path = toGamePath(href);
        if (path === null) throw new TypeError(`importScripts: network access is disabled in NativeThreeBridge (${href})`);
        source = nt.readText(path);
      }
      nt.evalScript(source, href);
    }
  }
  function postMessage(message, transfer) {
    const list = Array.isArray(transfer) ? transfer : transfer && Array.isArray(transfer.transfer) ? transfer.transfer : [];
    nt.postMessage(message, list);
  }
  const assign = {
    self: global, console, performance, navigator, location,
    setTimeout, setInterval, clearTimeout, clearInterval: clearTimeout,
    queueMicrotask: (fn) => { Promise.resolve().then(fn).catch(reportError); },
    structuredClone: (value, options) => nt.structuredClone(value, options && Array.isArray(options.transfer) ? options.transfer : []),
    postMessage, importScripts, close() { closing = true; timers.clear(); nt.close(); },
    reportError, fetch, Headers, Request, Response, Blob, URL, TextEncoder, TextDecoder, atob, btoa,
    Event, EventTarget, MessageEvent, ErrorEvent, PromiseRejectionEvent, WorkerGlobalScope, DedicatedWorkerGlobalScope,
    isSecureContext: true, crossOriginIsolated: true, origin: GAME_ORIGIN,
    // Bound to the global: module code calls addEventListener(...) bare.
    addEventListener: (...a) => EventTarget.prototype.addEventListener.apply(global, a),
    removeEventListener: (...a) => EventTarget.prototype.removeEventListener.apply(global, a),
    dispatchEvent: (e) => EventTarget.prototype.dispatchEvent.call(global, e),
    crypto: {
      // Not cryptographically secure: ids and seeds for game code (uuid, nanoid).
      getRandomValues(array) {
        const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
        return array;
      },
      randomUUID() {
        const b = this.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
        const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      },
    },
  };
  for (const [k, v] of Object.entries(assign))
    Object.defineProperty(global, k, { value: v, writable: true, configurable: true, enumerable: false });
  for (const name of ['onmessage', 'onmessageerror', 'onerror', 'onunhandledrejection', 'onrejectionhandled'])
    if (!(name in global)) global[name] = null;
  let workerName = '';
  Object.defineProperty(global, 'name', { get: () => workerName, configurable: true });

  const host = {
    boot(url, name, isModule) {
      scriptURL = String(url) || scriptURL;
      workerName = String(name || '');
      host.module = !!isModule;
      if (isModule) Object.defineProperty(global, 'importScripts', { value() { throw new TypeError('importScripts() is not available in module workers'); }, writable: true, configurable: true });
    },
    message(data, failed) {
      if (closing) return;
      global.dispatchEvent(new MessageEvent(failed ? 'messageerror' : 'message', { data: failed ? null : data }));
    },
    // Runs due timers; returns ms until the next one, or -1.
    timers(now) { return closing ? -1 : runTimers(now); },
  };
  Object.defineProperty(global, '__ntWorkerHost', { value: host, writable: false, configurable: false });
})(globalThis);
