// NativeThreeBridge webapp shim (classic script, embedded in the EXE).
//
// Gives an ordinary Three.js webapp the small slice of the browser it needs:
// window, document + a DOM tree parsed from index.html, timers,
// requestAnimationFrame, keyboard/pointer/wheel/resize events, fetch for files
// inside the game folder, console, URL, TextEncoder/TextDecoder, storage.
// No HTML/CSS layout engine and no WebGL: rendering goes through the
// NativeRenderer that the engine installs as THREE.WebGLRenderer.
//
// Native side (`globalThis.__nt`, provided by C++ or by a test harness):
//   log(level, text)              setTitle(text)
//   readText(path) -> string      readBinary(path) -> ArrayBuffer
//   setImportMap([k, v, k, v...])
//   evalScript(source, name)      evalModule(source, name) -> Promise
// Engine -> JS entry points live on `globalThis.__ntHost`.
(function installWebappShim(global) {
  'use strict';
  const nt = global.__nt;
  if (!nt) throw new Error('NativeThreeBridge: __nt native bridge missing');

  const GAME_ORIGIN = 'nt://game';
  // HTML/CSS UI layer (js/webapp-ui.js) installs itself as __ntHost.ui.
  let uiLayer = null;
  const uiNotify = (kind, node, name) => { if (uiLayer) uiLayer.invalidate(kind, node, name); };
  const state = {
    width: 1280, height: 720, pixelRatio: 1,
    now: 0, frame: 0,
    errors: [], warnings: new Set(),
    unsupported: new Set(),
    booted: false, bootError: null,
  };

  // ---------------------------------------------------------------- console
  function format(args) {
    return args.map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ? `${a.message}\n${a.stack}` : String(a);
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
  }
  const counters = new Map(), timersByLabel = new Map();
  const console = {
    log: (...a) => nt.log('log', format(a)),
    info: (...a) => nt.log('info', format(a)),
    debug: (...a) => nt.log('debug', format(a)),
    warn: (...a) => nt.log('warn', format(a)),
    error: (...a) => { state.errors.push(format(a)); nt.log('error', format(a)); },
    trace: (...a) => nt.log('debug', format(a) + '\n' + new Error().stack),
    assert: (ok, ...a) => { if (!ok) console.error('Assertion failed:', ...a); },
    group: (...a) => nt.log('log', format(a)), groupCollapsed: (...a) => nt.log('log', format(a)),
    groupEnd() {}, table: (d) => nt.log('log', format([d])), dir: (d) => nt.log('log', format([d])),
    count(label = 'default') { const n = (counters.get(label) || 0) + 1; counters.set(label, n); nt.log('log', `${label}: ${n}`); },
    countReset(label = 'default') { counters.delete(label); },
    time(label = 'default') { timersByLabel.set(label, performance.now()); },
    timeEnd(label = 'default') { const t = timersByLabel.get(label); if (t !== undefined) nt.log('log', `${label}: ${(performance.now() - t).toFixed(3)} ms`); timersByLabel.delete(label); },
    timeLog(label = 'default') { const t = timersByLabel.get(label); if (t !== undefined) nt.log('log', `${label}: ${(performance.now() - t).toFixed(3)} ms`); },
  };
  function warnOnce(key, text) {
    if (state.warnings.has(key)) return;
    state.warnings.add(key);
    nt.log('warn', `[NativeThreeBridge] ${text}`);
  }
  function unsupported(feature, detail) {
    if (!state.unsupported.has(feature)) {
      state.unsupported.add(feature);
      nt.log('warn', `[NativeThreeBridge] Not supported yet: ${feature}${detail ? ' – ' + detail : ''}`);
    }
  }
  function reportError(where, error) {
    const text = `${where}: ${error && error.stack ? `${error}\n${error.stack}` : String(error)}`;
    state.errors.push(text);
    nt.log('error', text);
  }

  // ----------------------------------------------------- paths and URLs
  function normalizePath(path) {
    const out = [];
    for (const part of path.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') { if (out.length === 0) throw new TypeError(`Path leaves the game folder: ${path}`); out.pop(); } else out.push(part);
    }
    return out.join('/');
  }
  function dirname(path) { const i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i + 1); }

  class URLSearchParams {
    constructor(init = '') {
      this._list = [];
      if (typeof init === 'string') {
        for (const pair of init.replace(/^\?/, '').split('&')) {
          if (!pair) continue;
          const [k, v = ''] = pair.split('=');
          this._list.push([decodeURIComponent(k.replace(/\+/g, ' ')), decodeURIComponent(v.replace(/\+/g, ' '))]);
        }
      } else if (init && typeof init === 'object') {
        for (const [k, v] of (Symbol.iterator in init ? init : Object.entries(init))) this._list.push([String(k), String(v)]);
      }
    }
    get(k) { const e = this._list.find((p) => p[0] === k); return e ? e[1] : null; }
    getAll(k) { return this._list.filter((p) => p[0] === k).map((p) => p[1]); }
    has(k) { return this._list.some((p) => p[0] === k); }
    set(k, v) { this.delete(k); this._list.push([k, String(v)]); }
    append(k, v) { this._list.push([k, String(v)]); }
    delete(k) { this._list = this._list.filter((p) => p[0] !== k); }
    forEach(fn, self) { for (const [k, v] of this._list) fn.call(self, v, k, this); }
    keys() { return this._list.map((p) => p[0])[Symbol.iterator](); }
    values() { return this._list.map((p) => p[1])[Symbol.iterator](); }
    entries() { return this._list.map((p) => [p[0], p[1]])[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    toString() { return this._list.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'); }
  }

  const URL_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(?:\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/;
  class URL {
    constructor(input, base) {
      input = String(input);
      let m = URL_RE.exec(input);
      if (!m) {
        if (base === undefined) throw new TypeError(`Invalid URL: ${input}`);
        const b = base instanceof URL ? base : new URL(base);
        const rel = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(input);
        let path;
        if (input.startsWith('//')) return new URL(b.protocol + input);
        if (rel[1].startsWith('/')) path = rel[1];
        else if (rel[1] === '') path = b.pathname;
        else path = b.pathname.replace(/[^/]*$/, '') + rel[1];
        const query = rel[2] !== undefined ? rel[2] : (rel[1] === '' ? b.search : '');
        m = [null, b.protocol, b.host, path, query, rel[3]];
      }
      this.protocol = m[1].toLowerCase();
      this.host = m[2] || '';
      const segments = [];
      for (const part of (m[3] || '/').split('/')) {
        if (part === '.' ) continue;
        if (part === '..') { if (segments.length > 1) segments.pop(); continue; }
        segments.push(part);
      }
      let path = segments.join('/');
      if (!path.startsWith('/')) path = '/' + path;
      if ((m[3] || '').endsWith('/..') || (m[3] || '').endsWith('/.')) path = path.replace(/\/?$/, '/');
      this.pathname = path;
      this.search = m[4] && m[4] !== '?' ? m[4] : '';
      this.hash = m[5] && m[5] !== '#' ? m[5] : '';
      this.searchParams = new URLSearchParams(this.search);
    }
    get hostname() { return this.host.replace(/:\d+$/, ''); }
    get port() { const p = /:(\d+)$/.exec(this.host); return p ? p[1] : ''; }
    get origin() { return `${this.protocol}//${this.host}`; }
    get href() {
      const special = ['http:', 'https:', 'file:', 'nt:', 'ws:', 'wss:'].includes(this.protocol);
      return `${this.protocol}${special || this.host ? '//' + this.host : ''}${this.pathname}${this.search}${this.hash}`;
    }
    toString() { return this.href; }
    toJSON() { return this.href; }
    static createObjectURL(blob) { const id = `blob:${GAME_ORIGIN}/${++blobCounter}`; blobStore.set(id, blob); return id; }
    static revokeObjectURL(id) { blobStore.delete(id); }
    static canParse(u, b) { try { new URL(u, b); return true; } catch { return false; } }
  }
  let blobCounter = 0;
  const blobStore = new Map();
  let documentURL = `${GAME_ORIGIN}/index.html`;
  let pageURL = new URL(documentURL);

  // Game-folder path for a URL/relative string, or null for external URLs.
  function toGamePath(input, base = documentURL) {
    const url = new URL(String(input), base);
    if (url.protocol !== 'nt:' || url.host !== 'game') return null;
    return normalizePath(decodeURIComponent(url.pathname));
  }

  // ---------------------------------------------------- text encoding
  class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(text = '') {
      const s = String(text), out = [];
      for (let i = 0; i < s.length; i++) {
        let c = s.codePointAt(i);
        if (c > 0xffff) i++;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }
  }
  class TextDecoder {
    constructor(label = 'utf-8') {
      const l = String(label).toLowerCase();
      if (l !== 'utf-8' && l !== 'utf8') unsupported(`TextDecoder(${label})`, 'decoding as UTF-8');
    }
    get encoding() { return 'utf-8'; }
    decode(input) {
      if (input === undefined) return '';
      const b = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      let out = '', i = 0;
      if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
      const chunk = [];
      for (; i < b.length; i++) {
        let c = b[i];
        if (c >= 0xf0 && i + 3 < b.length) { c = ((c & 7) << 18) | ((b[++i] & 63) << 12) | ((b[++i] & 63) << 6) | (b[++i] & 63); }
        else if (c >= 0xe0 && i + 2 < b.length) { c = ((c & 15) << 12) | ((b[++i] & 63) << 6) | (b[++i] & 63); }
        else if (c >= 0xc0 && i + 1 < b.length) { c = ((c & 31) << 6) | (b[++i] & 63); }
        chunk.push(c);
        if (chunk.length >= 8192) { out += String.fromCodePoint(...chunk); chunk.length = 0; }
      }
      return out + String.fromCodePoint(...chunk);
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

  // ------------------------------------------------------------- events
  class Event {
    constructor(type, init = {}) {
      this.type = String(type);
      this.bubbles = !!init.bubbles; this.cancelable = !!init.cancelable; this.composed = !!init.composed;
      this.target = null; this.currentTarget = null; this.eventPhase = 0;
      this.defaultPrevented = false; this.isTrusted = false;
      this.timeStamp = performance.now();
      this._stop = false; this._stopNow = false;
    }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    stopPropagation() { this._stop = true; }
    stopImmediatePropagation() { this._stop = true; this._stopNow = true; }
    get returnValue() { return !this.defaultPrevented; }
    composedPath() { const p = []; for (let n = this.target; n; n = n.parentNode) p.push(n); if (p.length && p[p.length - 1] === document) p.push(window); return p; }
  }
  class ProgressEvent extends Event {
    constructor(t, i = {}) { super(t, i); this.lengthComputable = !!i.lengthComputable; this.loaded = i.loaded || 0; this.total = i.total || 0; }
  }
  class ErrorEvent extends Event {
    constructor(t, i = {}) { super(t, i); this.message = i.message || ''; this.error = i.error ?? null; this.filename = i.filename || ''; this.lineno = i.lineno || 0; this.colno = i.colno || 0; }
  }
  class CustomEvent extends Event { constructor(t, i = {}) { super(t, i); this.detail = i.detail ?? null; } }
  class UIEvent extends Event { constructor(t, i = {}) { super(t, i); this.view = window; this.detail = i.detail || 0; } }
  class FocusEvent extends UIEvent {}
  const MODS = (i) => ({ altKey: !!i.altKey, ctrlKey: !!i.ctrlKey, shiftKey: !!i.shiftKey, metaKey: !!i.metaKey });
  class KeyboardEvent extends UIEvent {
    constructor(t, i = {}) {
      super(t, i);
      Object.assign(this, MODS(i));
      this.key = i.key || ''; this.code = i.code || ''; this.repeat = !!i.repeat; this.location = i.location || 0;
      this.keyCode = i.keyCode || 0; this.which = this.keyCode; this.charCode = i.charCode || 0;
    }
    getModifierState(k) { return { Alt: this.altKey, Control: this.ctrlKey, Shift: this.shiftKey, Meta: this.metaKey }[k] || false; }
  }
  class MouseEvent extends UIEvent {
    constructor(t, i = {}) {
      super(t, i);
      Object.assign(this, MODS(i));
      this.clientX = i.clientX || 0; this.clientY = i.clientY || 0;
      this.screenX = i.screenX ?? this.clientX; this.screenY = i.screenY ?? this.clientY;
      this.pageX = this.clientX; this.pageY = this.clientY; this.x = this.clientX; this.y = this.clientY;
      this.offsetX = i.offsetX ?? this.clientX; this.offsetY = i.offsetY ?? this.clientY;
      this.movementX = i.movementX || 0; this.movementY = i.movementY || 0;
      this.button = i.button || 0; this.buttons = i.buttons || 0; this.relatedTarget = i.relatedTarget || null;
    }
    getModifierState(k) { return KeyboardEvent.prototype.getModifierState.call(this, k); }
  }
  class PointerEvent extends MouseEvent {
    constructor(t, i = {}) {
      super(t, i);
      this.pointerId = i.pointerId ?? 1; this.pointerType = i.pointerType || 'mouse'; this.isPrimary = i.isPrimary ?? true;
      this.width = 1; this.height = 1; this.pressure = i.pressure ?? (this.buttons ? 0.5 : 0); this.tiltX = 0; this.tiltY = 0;
    }
    getCoalescedEvents() { return [this]; }
    getPredictedEvents() { return []; }
  }
  class WheelEvent extends MouseEvent {
    constructor(t, i = {}) { super(t, i); this.deltaX = i.deltaX || 0; this.deltaY = i.deltaY || 0; this.deltaZ = i.deltaZ || 0; this.deltaMode = i.deltaMode || 0; this.wheelDelta = -this.deltaY; }
  }
  WheelEvent.DOM_DELTA_PIXEL = 0; WheelEvent.DOM_DELTA_LINE = 1; WheelEvent.DOM_DELTA_PAGE = 2;

  class EventTarget {
    constructor() { Object.defineProperty(this, '_listeners', { value: new Map(), writable: true }); }
    addEventListener(type, listener, options) {
      if (!listener) return;
      if (!this._listeners) Object.defineProperty(this, '_listeners', { value: new Map(), writable: true });
      const capture = typeof options === 'boolean' ? options : !!(options && options.capture);
      const once = !!(options && typeof options === 'object' && options.once);
      const list = this._listeners.get(type) || [];
      if (list.some((l) => l.listener === listener && l.capture === capture)) return;
      list.push({ listener, capture, once });
      this._listeners.set(type, list);
      if (options && typeof options === 'object' && options.signal) options.signal.addEventListener('abort', () => this.removeEventListener(type, listener, options));
    }
    removeEventListener(type, listener, options) {
      if (!this._listeners) return;
      const capture = typeof options === 'boolean' ? options : !!(options && options.capture);
      const list = this._listeners.get(type);
      if (list) this._listeners.set(type, list.filter((l) => !(l.listener === listener && l.capture === capture)));
    }
    _invoke(event, capturePhase) {
      const list = this._listeners && this._listeners.get(event.type);
      event.currentTarget = this;
      if (list) {
        for (const entry of list.slice()) {
          if (event._stopNow) break;
          if (event.eventPhase !== 2 && entry.capture !== capturePhase) continue;
          if (entry.once) this.removeEventListener(event.type, entry.listener, entry.capture);
          try {
            if (typeof entry.listener === 'function') entry.listener.call(this, event);
            else entry.listener.handleEvent(event);
          } catch (e) { reportError(`${event.type} listener`, e); }
        }
      }
      const handler = !capturePhase && this['on' + event.type];
      if (typeof handler === 'function' && !event._stopNow) {
        try { if (handler.call(this, event) === false) event.preventDefault(); } catch (e) { reportError(`on${event.type}`, e); }
      }
    }
    dispatchEvent(event) {
      event.target = this;
      const path = [];
      for (let n = this.parentNode; n; n = n.parentNode) path.push(n);
      if (path.length && path[path.length - 1] === document && this !== window) path.push(window);
      event.eventPhase = 1;
      for (let i = path.length - 1; i >= 0 && !event._stop; i--) path[i]._invoke(event, true);
      event.eventPhase = 2;
      if (!event._stop) this._invoke(event, false);
      if (event.bubbles) {
        event.eventPhase = 3;
        for (let i = 0; i < path.length && !event._stop; i++) path[i]._invoke(event, false);
      }
      event.eventPhase = 0; event.currentTarget = null;
      return !event.defaultPrevented;
    }
  }
  class AbortSignal extends EventTarget {
    constructor() { super(); this.aborted = false; this.reason = undefined; this.onabort = null; }
    throwIfAborted() { if (this.aborted) throw this.reason; }
    static timeout(ms) { const c = new AbortController(); setTimeout(() => c.abort(new Error('TimeoutError')), ms); return c.signal; }
  }
  class AbortController {
    constructor() { this.signal = new AbortSignal(); }
    abort(reason = new Error('AbortError')) { if (this.signal.aborted) return; this.signal.aborted = true; this.signal.reason = reason; this.signal.dispatchEvent(new Event('abort')); }
  }

  // Dynamic <script src=...> loading, shared by V8 and QuickJS.
  // A classic script appended by a loader must execute and fire 'load', or
  // Promise.all(loadScript(...)) applications (including K73) never boot.
  // Defer until the current JavaScript job finishes and retain insertion order
  // even when each script has .async=false assigned as a DOM property.
  const dynamicScriptQueue = [];
  let parsingInitialDocument = false;
  let dynamicScriptsRunning = false;
  let dynamicScriptCount = 0;
  function queueConnectedScripts(node) {
    if (parsingInitialDocument || !node.isConnected) return;
    const visit = (n) => {
      if (n.nodeType === 1 && n.localName === 'script' && !n._ntScriptStarted) {
        n._ntScriptStarted = true;
        dynamicScriptQueue.push(n);
      } else {
        for (const c of n.childNodes || []) visit(c);
      }
    };
    visit(node);
    if (dynamicScriptQueue.length && !dynamicScriptsRunning) {
      Promise.resolve().then(drainDynamicScripts);
    }
  }
  async function drainDynamicScripts() {
    if (dynamicScriptsRunning) return;
    dynamicScriptsRunning = true;
    try {
      while (dynamicScriptQueue.length) {
        const element = dynamicScriptQueue.shift();
        const type = (element.getAttribute('type') || '').trim().toLowerCase();
        // JSON/import maps and data scripts are not JavaScript.
        if (type && !['text/javascript', 'application/javascript', 'javascript', 'module'].includes(type)) continue;
        const src = element.getAttribute('src');
        try {
          let source, name;
          if (src) {
            const path = toGamePath(src);
            if (!path) throw new TypeError(`Dynamic script source is not a local game file: ${src}`);
            source = nt.readText(path);
            name = path;
          } else {
            source = element.textContent;
            name = `dynamic-script-${++dynamicScriptCount}`;
          }
          if (type === 'module') await nt.evalModule(source, name);
          else nt.evalScript(source, name);
          element.dispatchEvent(new Event('load'));
        } catch (e) {
          reportError(`dynamic script ${src || '(inline)'}`, e);
          element.dispatchEvent(new ErrorEvent('error', { message: String(e), error: e }));
        }
      }
    } finally {
      dynamicScriptsRunning = false;
      if (dynamicScriptQueue.length) Promise.resolve().then(drainDynamicScripts);
    }
  }

  // ---------------------------------------------------------------- DOM
  const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const RAW_TAGS = new Set(['script', 'style', 'textarea', 'title']);

  class Node extends EventTarget {
    constructor(nodeType, nodeName) {
      super();
      this.nodeType = nodeType; this.nodeName = nodeName;
      this.parentNode = null; this.childNodes = [];
      this.ownerDocument = null;
    }
    get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    get nextSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] || null; }
    get previousSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) - 1] || null; }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === document; }
    hasChildNodes() { return this.childNodes.length > 0; }
    appendChild(child) { return this.insertBefore(child, null); }
    insertBefore(child, ref) {
      if (child.nodeType === 11) { for (const c of child.childNodes.slice()) this.insertBefore(c, ref); return child; }
      if (child.parentNode) child.parentNode.removeChild(child);
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i < 0) this.childNodes.push(child); else this.childNodes.splice(i, 0, child);
      child.parentNode = this;
      child.ownerDocument = this.ownerDocument || (this.nodeType === 9 ? this : null);
      uiNotify('tree', this, child);
      // Connected DOM-inserted classic/module scripts run asynchronously, in
      // insertion order. Initial HTML parser scripts are handled by host.boot().
      queueConnectedScripts(child);
      return child;
    }
    removeChild(child) {
      const i = this.childNodes.indexOf(child);
      if (i >= 0) { this.childNodes.splice(i, 1); child.parentNode = null; uiNotify('tree', this, child); }
      return child;
    }
    replaceChild(newChild, oldChild) { this.insertBefore(newChild, oldChild); return this.removeChild(oldChild); }
    contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
    get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
    set textContent(v) { const hadElements = this.childNodes.some((c) => c.nodeType === 1); for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; uiNotify('tree', this, hadElements ? null : undefined); if (v !== '' && v != null) this.appendChild(new Text(String(v))); }
    cloneNode(deep) {
      const copy = this._shallowClone();
      if (deep) for (const c of this.childNodes) copy.appendChild(c.cloneNode(true));
      return copy;
    }
    getRootNode() { let n = this; while (n.parentNode) n = n.parentNode; return n; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    before(...n) { const p = this.parentNode; if (p) for (const c of n) p.insertBefore(typeof c === 'string' ? new Text(c) : c, this); }
    after(...n) { const p = this.parentNode; if (!p) return; const next = this.nextSibling; for (const c of n) p.insertBefore(typeof c === 'string' ? new Text(c) : c, next); }
    replaceWith(...n) { const p = this.parentNode; if (!p) return; const next = this.nextSibling; p.removeChild(this); for (const c of n) p.insertBefore(typeof c === 'string' ? new Text(c) : c, next); }
    isSameNode(o) { return o === this; }
    isEqualNode(o) { return !!o && serialize(o) === serialize(this); }
    compareDocumentPosition(o) {
      if (o === this) return 0;
      if (this.contains(o)) return 20; // CONTAINED_BY | FOLLOWING
      if (o.contains(this)) return 10; // CONTAINS | PRECEDING
      const all = []; (function walk(n) { all.push(n); for (const c of n.childNodes) walk(c); })(this.getRootNode());
      const a = all.indexOf(this), b = all.indexOf(o);
      if (a < 0 || b < 0) return 1;
      return b > a ? 4 : 2;
    }
    normalize() {}
  }
  const NODE_TYPES = { ELEMENT_NODE: 1, ATTRIBUTE_NODE: 2, TEXT_NODE: 3, CDATA_SECTION_NODE: 4, PROCESSING_INSTRUCTION_NODE: 7, COMMENT_NODE: 8, DOCUMENT_NODE: 9, DOCUMENT_TYPE_NODE: 10, DOCUMENT_FRAGMENT_NODE: 11 };
  Object.assign(Node, NODE_TYPES);
  Object.assign(Node.prototype, NODE_TYPES);
  Object.assign(Node, { DOCUMENT_POSITION_DISCONNECTED: 1, DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_CONTAINS: 8, DOCUMENT_POSITION_CONTAINED_BY: 16 });

  const NodeFilter = {
    FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3,
    SHOW_ALL: 0xffffffff, SHOW_ELEMENT: 0x1, SHOW_ATTRIBUTE: 0x2, SHOW_TEXT: 0x4, SHOW_CDATA_SECTION: 0x8,
    SHOW_PROCESSING_INSTRUCTION: 0x40, SHOW_COMMENT: 0x80, SHOW_DOCUMENT: 0x100, SHOW_DOCUMENT_TYPE: 0x200, SHOW_DOCUMENT_FRAGMENT: 0x400,
  };
  function filterNode(walker, node) {
    if (!((1 << (node.nodeType - 1)) & walker.whatToShow)) return NodeFilter.FILTER_SKIP;
    const f = walker.filter;
    if (!f) return NodeFilter.FILTER_ACCEPT;
    return (typeof f === 'function' ? f(node) : f.acceptNode(node)) ?? NodeFilter.FILTER_ACCEPT;
  }
  class TreeWalker {
    constructor(root, whatToShow = NodeFilter.SHOW_ALL, filter = null) {
      this.root = root; this.whatToShow = whatToShow >>> 0; this.filter = filter; this.currentNode = root;
    }
    parentNode() {
      for (let n = this.currentNode; n && n !== this.root;) {
        n = n.parentNode;
        if (n && filterNode(this, n) === NodeFilter.FILTER_ACCEPT) return (this.currentNode = n);
      }
      return null;
    }
    _child(first) {
      const kids = this.currentNode.childNodes;
      for (let i = 0; i < kids.length; i++) {
        const n = kids[first ? i : kids.length - 1 - i];
        if (filterNode(this, n) === NodeFilter.FILTER_ACCEPT) return (this.currentNode = n);
      }
      return null;
    }
    firstChild() { return this._child(true); }
    lastChild() { return this._child(false); }
    _sibling(next) {
      if (this.currentNode === this.root) return null;
      for (let n = next ? this.currentNode.nextSibling : this.currentNode.previousSibling; n; n = next ? n.nextSibling : n.previousSibling) {
        if (filterNode(this, n) === NodeFilter.FILTER_ACCEPT) return (this.currentNode = n);
      }
      return null;
    }
    nextSibling() { return this._sibling(true); }
    previousSibling() { return this._sibling(false); }
    // DOM spec "next node" walk in document order.
    nextNode() {
      let node = this.currentNode, result = NodeFilter.FILTER_ACCEPT;
      for (;;) {
        while (result !== NodeFilter.FILTER_REJECT && node.childNodes.length) {
          node = node.childNodes[0];
          result = filterNode(this, node);
          if (result === NodeFilter.FILTER_ACCEPT) return (this.currentNode = node);
        }
        let sibling = null;
        for (let temp = node; temp; temp = temp.parentNode) {
          if (temp === this.root) return null;
          sibling = temp.nextSibling;
          if (sibling) break;
        }
        if (!sibling) return null;
        node = sibling;
        result = filterNode(this, node);
        if (result === NodeFilter.FILTER_ACCEPT) return (this.currentNode = node);
      }
    }
    previousNode() {
      let node = this.currentNode;
      while (node !== this.root) {
        let sibling = node.previousSibling;
        while (sibling) {
          node = sibling;
          let result = filterNode(this, node);
          while (result !== NodeFilter.FILTER_REJECT && node.childNodes.length) {
            node = node.childNodes[node.childNodes.length - 1];
            result = filterNode(this, node);
          }
          if (result === NodeFilter.FILTER_ACCEPT) return (this.currentNode = node);
          sibling = node.previousSibling;
        }
        if (node === this.root || !node.parentNode) return null;
        node = node.parentNode;
        if (filterNode(this, node) === NodeFilter.FILTER_ACCEPT) return (this.currentNode = node);
      }
      return null;
    }
  }
  class NodeIterator {
    constructor(root, whatToShow = NodeFilter.SHOW_ALL, filter = null) {
      this.root = root; this.whatToShow = whatToShow >>> 0; this.filter = filter;
      this.referenceNode = root; this.pointerBeforeReferenceNode = true;
    }
    _ordered() {
      const out = [];
      (function walk(n) { out.push(n); for (const c of n.childNodes) walk(c); })(this.root);
      return out;
    }
    nextNode() {
      const nodes = this._ordered();
      let i = nodes.indexOf(this.referenceNode);
      if (!this.pointerBeforeReferenceNode) i++;
      for (; i >= 0 && i < nodes.length; i++) {
        if (filterNode(this, nodes[i]) === NodeFilter.FILTER_ACCEPT) { this.referenceNode = nodes[i]; this.pointerBeforeReferenceNode = false; return nodes[i]; }
      }
      return null;
    }
    previousNode() {
      const nodes = this._ordered();
      let i = nodes.indexOf(this.referenceNode);
      if (this.pointerBeforeReferenceNode) i--;
      for (; i >= 0; i--) {
        if (filterNode(this, nodes[i]) === NodeFilter.FILTER_ACCEPT) { this.referenceNode = nodes[i]; this.pointerBeforeReferenceNode = true; return nodes[i]; }
      }
      return null;
    }
    detach() {}
  }

  class Text extends Node {
    constructor(data = '') { super(3, '#text'); this._data = String(data); }
    get data() { return this._data; }
    set data(v) { v = String(v); if (v === this._data) return; this._data = v; uiNotify('text', this); }
    get textContent() { return this.data; }
    set textContent(v) { this.data = String(v); }
    get nodeValue() { return this.data; }
    set nodeValue(v) { this.data = String(v ?? ''); }
    get wholeText() { return this.data; }
    get length() { return this.data.length; }
    splitText(offset) { const rest = new Text(this.data.slice(offset)); this.data = this.data.slice(0, offset); if (this.parentNode) this.parentNode.insertBefore(rest, this.nextSibling); return rest; }
    _shallowClone() { return new Text(this.data); }
  }
  class Comment extends Node {
    constructor(data = '') { super(8, '#comment'); this.data = String(data); }
    get textContent() { return ''; }
    get nodeValue() { return this.data; }
    set nodeValue(v) { this.data = String(v ?? ''); }
    _shallowClone() { return new Comment(this.data); }
  }
  class DocumentFragment extends Node {
    constructor() { super(11, '#document-fragment'); }
    _shallowClone() { return new DocumentFragment(); }
    querySelector(s) { return querySelectorAll(this, s)[0] || null; }
    querySelectorAll(s) { return querySelectorAll(this, s); }
    get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
    append(...n) { for (const c of n) this.appendChild(typeof c === 'string' ? new Text(c) : c); }
  }

  class DOMTokenList {
    constructor(el) { this._el = el; }
    _get() { return (this._el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
    _set(list) { this._el.setAttribute('class', list.join(' ')); }
    get length() { return this._get().length; }
    item(i) { return this._get()[i] ?? null; }
    contains(c) { return this._get().includes(c); }
    add(...c) { const l = this._get(); for (const x of c) if (!l.includes(x)) l.push(x); this._set(l); }
    remove(...c) { this._set(this._get().filter((x) => !c.includes(x))); }
    toggle(c, force) { const has = this.contains(c); const want = force === undefined ? !has : !!force; if (want && !has) this.add(c); if (!want && has) this.remove(c); return want; }
    replace(a, b) { if (!this.contains(a)) return false; this._set(this._get().map((x) => (x === a ? b : x))); return true; }
    toString() { return this._get().join(' '); }
    forEach(fn, self) { this._get().forEach(fn, self); }
    [Symbol.iterator]() { return this._get()[Symbol.iterator](); }
  }
  function camelToKebab(s) { return s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()); }
  // Inline style; changes notify the UI layer. Values keep !important.
  function makeStyle(owner) {
    const props = new Map();
    const changed = () => { if (owner) uiNotify('style', owner); };
    const parse = (text) => {
      props.clear();
      for (const decl of splitDeclarations(String(text))) {
        const i = decl.indexOf(':');
        if (i > 0) props.set(decl.slice(0, i).trim().replace(/^[A-Z-]+$/, (m) => m.toLowerCase()), decl.slice(i + 1).trim());
      }
    };
    const setOne = (k, v, priority) => {
      const key = k.startsWith('--') ? k : camelToKebab(k).toLowerCase().replace(/^(webkit|moz|ms)-/, '-$1-');
      if (v === null || v === undefined || v === '') props.delete(key);
      else props.set(key, String(v) + (priority === 'important' ? ' !important' : ''));
      changed();
    };
    const target = {
      setProperty(k, v, priority) { setOne(String(k), v, priority); },
      getPropertyValue(k) { return (props.get(k) || '').replace(/\s*!important$/, ''); },
      getPropertyPriority(k) { return /!important$/.test(props.get(k) || '') ? 'important' : ''; },
      removeProperty(k) { const v = props.get(k) || ''; props.delete(k); changed(); return v; },
      item(i) { return [...props.keys()][i] || ''; },
      get length() { return props.size; },
      get cssText() { return [...props].map(([k, v]) => `${k}: ${v}`).join('; '); },
      set cssText(text) { parse(text); changed(); },
      _setSilently(text) { parse(text); },
    };
    return new Proxy(target, {
      get(t, k) {
        if (k in t) return t[k];
        if (typeof k !== 'string') return undefined;
        if (/^\d+$/.test(k)) return t.item(Number(k));
        return (props.get(k.startsWith('--') ? k : camelToKebab(k)) || '').replace(/\s*!important$/, '');
      },
      set(t, k, v) {
        if (k === 'cssText') { t.cssText = v; return true; }
        if (typeof k === 'string') setOne(k, v);
        return true;
      },
    });
  }
  function splitDeclarations(text) {
    const out = [];
    let depth = 0, quote = null, start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ';' && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
    }
    out.push(text.slice(start));
    return out;
  }

  class Element extends Node {
    constructor(tagName, namespaceURI = 'http://www.w3.org/1999/xhtml') {
      const lower = String(tagName).toLowerCase();
      super(1, lower.toUpperCase());
      this.localName = lower; this.tagName = lower.toUpperCase(); this.namespaceURI = namespaceURI;
      this._attrs = new Map();
      this.style = makeStyle(this);
      this.classList = new DOMTokenList(this);
      this.dataset = {};
    }
    get id() { return this.getAttribute('id') || ''; }
    set id(v) { this.setAttribute('id', v); }
    get className() { return this.getAttribute('class') || ''; }
    set className(v) { this.setAttribute('class', v); }
    get attributes() { return [...this._attrs].map(([name, value]) => ({ name, value })); }
    getAttribute(n) { n = String(n).toLowerCase(); return this._attrs.has(n) ? this._attrs.get(n) : null; }
    setAttribute(n, v) {
      n = String(n).toLowerCase(); v = String(v); this._attrs.set(n, v);
      if (n.startsWith('data-')) this.dataset[n.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
      if (n === 'style') this.style._setSilently(v);
      this._attributeChanged(n, v);
      uiNotify('attr', this, n);
    }
    _attributeChanged() {}
    hasAttribute(n) { return this._attrs.has(String(n).toLowerCase()); }
    removeAttribute(n) {
      n = String(n).toLowerCase();
      if (!this._attrs.has(n)) return;
      this._attrs.delete(n);
      if (n === 'style') this.style._setSilently('');
      uiNotify('attr', this, n);
    }
    toggleAttribute(n, force) { const has = this.hasAttribute(n); const want = force === undefined ? !has : !!force; if (want) this.setAttribute(n, ''); else this.removeAttribute(n); return want; }
    get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
    get childElementCount() { return this.children.length; }
    get firstElementChild() { return this.children[0] || null; }
    get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
    get nextElementSibling() { const p = this.parentNode; if (!p) return null; const s = p.childNodes; for (let i = s.indexOf(this) + 1; i < s.length; i++) if (s[i].nodeType === 1) return s[i]; return null; }
    get previousElementSibling() { const p = this.parentNode; if (!p) return null; const s = p.childNodes; for (let i = s.indexOf(this) - 1; i >= 0; i--) if (s[i].nodeType === 1) return s[i]; return null; }
    append(...n) { for (const c of n) this.appendChild(typeof c === 'string' ? new Text(c) : c); }
    prepend(...n) { for (const c of n.reverse()) this.insertBefore(typeof c === 'string' ? new Text(c) : c, this.firstChild); }
    replaceChildren(...n) { this.textContent = ''; this.append(...n); }
    get innerText() { return this.textContent; }
    set innerText(v) { this.textContent = v; }
    get innerHTML() { return this.childNodes.map(serialize).join(''); }
    set innerHTML(html) { this.textContent = ''; const frag = parseHTMLFragment(String(html)); this.appendChild(frag); }
    get outerHTML() { return serialize(this); }
    insertAdjacentHTML(pos, html) {
      const frag = parseHTMLFragment(String(html));
      switch (String(pos).toLowerCase()) {
        case 'beforebegin': this.parentNode && this.parentNode.insertBefore(frag, this); break;
        case 'afterbegin': this.insertBefore(frag, this.firstChild); break;
        case 'beforeend': this.appendChild(frag); break;
        case 'afterend': this.parentNode && this.parentNode.insertBefore(frag, this.nextSibling); break;
      }
    }
    insertAdjacentElement(pos, el) {
      switch (String(pos).toLowerCase()) {
        case 'beforebegin': this.parentNode && this.parentNode.insertBefore(el, this); break;
        case 'afterbegin': this.insertBefore(el, this.firstChild); break;
        case 'beforeend': this.appendChild(el); break;
        case 'afterend': this.parentNode && this.parentNode.insertBefore(el, this.nextSibling); break;
      }
      return el;
    }
    querySelector(s) { return querySelectorAll(this, s)[0] || null; }
    querySelectorAll(s) { return querySelectorAll(this, s); }
    getElementsByTagName(t) { return querySelectorAll(this, t); }
    getElementsByClassName(c) { return querySelectorAll(this, c.split(/\s+/).filter(Boolean).map((x) => '.' + x).join('')); }
    matches(s) { return parseSelectorGroups(s).some((g) => matchComplex(this, g)); }
    closest(s) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(s)) return n; return null; }
    _fullView() { return this.localName === 'canvas' || this.localName === 'body' || this.localName === 'html'; }
    // Real layout boxes from the UI layer; full-window fallback without it.
    _layoutRect() {
      if (uiLayer && this.isConnected) {
        const r = uiLayer.rect(this);
        if (r) return r;
        if (this.localName !== 'html' && this.localName !== 'body') return { x: 0, y: 0, w: 0, h: 0, bl: 0, br: 0, bt: 0, bb: 0 };
      }
      const full = this._fullView();
      return { x: 0, y: 0, w: full ? state.width : 0, h: full ? state.height : 0, bl: 0, br: 0, bt: 0, bb: 0 };
    }
    getBoundingClientRect() {
      const r = this._layoutRect();
      return { x: r.x, y: r.y, left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h, width: r.w, height: r.h, toJSON() { return this; } };
    }
    getClientRects() { const r = this.getBoundingClientRect(); return r.width || r.height ? [r] : []; }
    get clientWidth() { if (this.localName === 'html') return state.width; const r = this._layoutRect(); return Math.round(Math.max(0, r.w - r.bl - r.br)); }
    get clientHeight() { if (this.localName === 'html') return state.height; const r = this._layoutRect(); return Math.round(Math.max(0, r.h - r.bt - r.bb)); }
    get clientLeft() { return Math.round(this._layoutRect().bl || 0); }
    get clientTop() { return Math.round(this._layoutRect().bt || 0); }
    get offsetWidth() { return Math.round(this._layoutRect().w); }
    get offsetHeight() { return Math.round(this._layoutRect().h); }
    get offsetLeft() { const p = this.offsetParent; return Math.round(this._layoutRect().x - (p ? p._layoutRect().x + (p._layoutRect().bl || 0) : 0)); }
    get offsetTop() { const p = this.offsetParent; return Math.round(this._layoutRect().y - (p ? p._layoutRect().y + (p._layoutRect().bt || 0) : 0)); }
    get offsetParent() {
      for (let n = this.parentElement; n; n = n.parentElement) {
        if (n.localName === 'body') return n;
        const cs = uiLayer && uiLayer.computed(n);
        if (cs && cs.position && cs.position !== 'static') return n;
      }
      return this.parentElement;
    }
    get scrollWidth() { const r = this._layoutRect(); return Math.round(r.scrollW || Math.max(0, r.w - r.bl - r.br)); }
    get scrollHeight() { const r = this._layoutRect(); return Math.round(r.scrollH || Math.max(0, r.h - r.bt - r.bb)); }
    get scrollTop() { return this._ntScrollTop || 0; }
    set scrollTop(v) { const n = Math.max(0, Number(v) || 0); if (n === (this._ntScrollTop || 0)) return; this._ntScrollTop = n; uiNotify('layout', this); }
    get scrollLeft() { return this._ntScrollLeft || 0; }
    set scrollLeft(v) { const n = Math.max(0, Number(v) || 0); if (n === (this._ntScrollLeft || 0)) return; this._ntScrollLeft = n; uiNotify('layout', this); }
    focus() { const old = document.activeElement; document.activeElement = this; if (uiLayer && old !== this) uiLayer.focusChanged(old, this); }
    blur() { if (document.activeElement === this) { document.activeElement = document.body; if (uiLayer) uiLayer.focusChanged(this, document.body); } }
    click() { this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
    scrollIntoView(options) { uiLayer?.scrollIntoView(this, options); }
    scrollTo(x, y) { if (typeof x === 'object' && x) { if (x.top !== undefined) this.scrollTop = x.top; if (x.left !== undefined) this.scrollLeft = x.left; } else { if (x !== undefined) this.scrollLeft = x; if (y !== undefined) this.scrollTop = y; } }
    scrollBy(x, y) { if (typeof x === 'object' && x) { this.scrollTop += x.top || 0; this.scrollLeft += x.left || 0; } else { this.scrollLeft += x || 0; this.scrollTop += y || 0; } }
    animate() { unsupported('Element.animate'); return { finished: Promise.resolve(), cancel() {}, play() {}, pause() {} }; }
    requestPointerLock() { unsupported('Pointer Lock', 'cursor stays free'); return Promise.resolve(); }
    requestFullscreen() { unsupported('Fullscreen API'); return Promise.resolve(); }
    setPointerCapture() {}
    releasePointerCapture() {}
    hasPointerCapture() { return false; }
    attachShadow() { unsupported('Shadow DOM'); const f = new DocumentFragment(); f.host = this; return f; }
    _shallowClone() { const e = document.createElement(this.localName); for (const [k, v] of this._attrs) e.setAttribute(k, v); return e; }
  }
  // href/src read back as absolute URLs, like in a browser.
  function reflectURL(el, attr) {
    const v = el.getAttribute(attr);
    if (v === null || v === '') return v === '' ? documentURL : '';
    if (/^(data|blob|javascript|mailto):/i.test(v)) return v;
    try { return new URL(v, documentURL).href; } catch { return v; }
  }
  class HTMLElement extends Element {
    get href() { return reflectURL(this, 'href'); }
    set href(v) { this.setAttribute('href', v); }
    get rel() { return this.getAttribute('rel') || ''; }
    set rel(v) { this.setAttribute('rel', v); }
    get name() { return this.getAttribute('name') || ''; }
    set name(v) { this.setAttribute('name', v); }
    get lang() { return this.getAttribute('lang') || ''; }
    set lang(v) { this.setAttribute('lang', v); }
    get dir() { return this.getAttribute('dir') || ''; }
    set dir(v) { this.setAttribute('dir', v); }
    get disabled() { return this._disabled ?? this.hasAttribute('disabled'); }
    set disabled(v) { this._disabled = !!v; uiNotify('attr', this, 'disabled'); }
    get sheet() { return null; }
    // <details>/<dialog>
    get open() { return this.hasAttribute('open'); }
    set open(v) { this.toggleAttribute('open', !!v); }
    show() { this.open = true; }
    showModal() { this.open = true; }
    close(value) { if (!this.open) return; this.open = false; if (value !== undefined) this.returnValue = String(value); this.dispatchEvent(new Event('close')); }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(v) { this.toggleAttribute('hidden', !!v); }
    get title() { return this.getAttribute('title') || ''; }
    set title(v) { this.setAttribute('title', v); }
    get tabIndex() { return Number(this.getAttribute('tabindex') ?? -1); }
    set tabIndex(v) { this.setAttribute('tabindex', v); }
  }
  class HTMLInputElement extends HTMLElement {
    get value() {
      if (this.localName === 'select' && this._value === undefined) {
        const opts = this.querySelectorAll('option');
        const sel = opts.find((o) => o.hasAttribute('selected')) || opts[0];
        return sel ? (sel.getAttribute('value') ?? sel.textContent) : '';
      }
      return this._value ?? this.getAttribute('value') ?? '';
    }
    set value(v) { this._value = String(v); uiNotify('attr', this, 'value'); }
    get checked() { return this._checked ?? this.hasAttribute('checked'); }
    set checked(v) { this._checked = !!v; uiNotify('attr', this, 'checked'); }
    get selectedIndex() { const opts = this.querySelectorAll('option'); const i = opts.findIndex((o) => (o.getAttribute('value') ?? o.textContent) === this.value); return i; }
    set selectedIndex(i) { const o = this.querySelectorAll('option')[i]; if (o) this.value = o.getAttribute('value') ?? o.textContent; }
    get options() { return this.querySelectorAll('option'); }
    get type() { return this.getAttribute('type') || 'text'; }
    set type(v) { this.setAttribute('type', v); }
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(v) { this.toggleAttribute('disabled', !!v); }
  }
  class HTMLButtonElement extends HTMLElement {
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(v) { this.toggleAttribute('disabled', !!v); }
  }
  class HTMLScriptElement extends HTMLElement {
    get src() { return reflectURL(this, 'src'); }
    set src(v) { this.setAttribute('src', v); }
    get type() { return this.getAttribute('type') || ''; }
    set type(v) { this.setAttribute('type', v); }
    get text() { return this.textContent; }
    set text(v) { this.textContent = v; }
  }
  // Experimental raw WebGL2 commands -> the EXISTING native DX12 packet
  // format. Deliberately opt-in and narrowly scoped: it does NOT claim to
  // implement arbitrary WebGL2 or compile the complex GLSL used by K73.
  let nextRawGeometryId = 90000000;
  let nextRawInstanceId = 95000000;
  function makeRawDx12Prototype(canvas) {
    const ID = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const G = {
      NO_ERROR: 0, FLOAT: 0x1406, UNSIGNED_BYTE: 0x1401, UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405,
      ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8,
      VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
      COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
      TRIANGLES: 4, COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x100,
      TEXTURE_2D: 0x0de1, TEXTURE_2D_ARRAY: 0x8c1a, TEXTURE0: 0x84c0,
      TEXTURE1: 0x84c1, TEXTURE2: 0x84c2, TEXTURE3: 0x84c3, TEXTURE4: 0x84c4, TEXTURE5: 0x84c5, TEXTURE6: 0x84c6, TEXTURE7: 0x84c7, TEXTURE8: 0x84c8, TEXTURE9: 0x84c9, TEXTURE10: 0x84ca, TEXTURE11: 0x84cb, TEXTURE12: 0x84cc, TEXTURE13: 0x84cd, TEXTURE14: 0x84ce, TEXTURE15: 0x84cf,
      RGBA: 0x1908, RGBA8: 0x8058, RGBA32F: 0x8814,
      BYTE: 0x1400,
      TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
      TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
      TEXTURE_MAX_LEVEL: 0x813d,
      LINEAR: 0x2601, NEAREST: 0x2600,
      LINEAR_MIPMAP_LINEAR: 0x2703,
      REPEAT: 0x2901, CLAMP_TO_EDGE: 0x812f,
      UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243, NONE: 0, BROWSER_DEFAULT_WEBGL: 0x9244,
      DEPTH_COMPONENT24: 0x81a6, TEXTURE_COMPARE_MODE: 0x884c,
      COMPARE_REF_TO_TEXTURE: 0x884e, TEXTURE_COMPARE_FUNC: 0x884d, LEQUAL: 0x0203,
      FRAMEBUFFER: 0x8d40, DEPTH_ATTACHMENT: 0x8d00,
      FRAMEBUFFER_COMPLETE: 0x8cd5, FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8cd6,
      DEPTH_TEST: 0x0b71, CULL_FACE: 0x0b44, BLEND: 0x0be2,
      POLYGON_OFFSET_FILL: 0x8037,
      ZERO: 0, ONE: 1, SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303,
      FRONT: 0x0404, BACK: 0x0405, CCW: 0x0901, CW: 0x0900,
    };
    const state = { buffer: null, vao: { attributes: new Map(), elements: null },
      program: null, clear: [0, 0, 0, 1], clearFlags: 3, cache: new WeakMap(), draws: 0,
      activeTextureUnit: 0, textureUnits: Array.from({ length: 16 }, () => new Map()),
      liveTextures: new Set(), textureUploads: 0, depthAllocations: 0,
      framebuffers: new Set(), framebuffer: null,
      // WebGL2 initial raster state. These values feed the DX12 PSO flags
      // rather than silently treating all draw calls alike.
      capabilities: new Set(), depthWrite: true,
      blendSrc: G.ONE, blendDst: G.ZERO,
      cullMode: G.BACK, frontWinding: G.CCW,
      polygonFactor: 0, polygonUnits: 0,
      instanceCache: new WeakMap(), sky: null };
    const unsupportedRaw = (method) => {
      throw new Error('NativeThreeBridge DX12 raw-WebGL2 prototype does not support: ' + method);
    };
    // Reuse NativeThreeBridge's existing nt.uploadTexture / DX12 Texture2D.
    // A TEXTURE_2D_ARRAY with N layers is stored as a VERTICAL ATLAS:
    // width x (height*N) RGBA8 pixels, or exactly the original JPEG atlas.
    // This preserves layer data; the K73-specific HLSL profile remaps the
    // triplanar layer coordinate, without creating a second GPU backend.
    let nextRawTextureId = 70000000;
    function boundTexture(target) {
      if (target !== G.TEXTURE_2D && target !== G.TEXTURE_2D_ARRAY)
        return unsupportedRaw('texture target 0x' + target.toString(16));
      const texture = state.textureUnits[state.activeTextureUnit].get(target);
      if (!texture || texture.deleted) throw Error('WebGL2 texture target has no live bound texture');
      return texture;
    }
    function setTexturePixels(texture, width, height, layers, bytes, encoded = false) {
      if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(layers) ||
          width < 1 || height < 1 || layers < 1 || width > 8192 || height * layers > 16384)
        throw new RangeError('Texture dimensions out of native DX12 range');
      if (!encoded && (!(bytes instanceof Uint8Array) || bytes.byteLength !== width * height * layers * 4))
        throw new RangeError('Expected tightly packed RGBA8 texture pixels for all layers');
      const ok = nt.uploadTexture(texture.id, bytes, encoded ? 0 : width,
        encoded ? 0 : height * layers, 0); // atlas mipmaps not safe across layers
      if (!ok) throw Error('NativeThreeBridge DX12 texture upload failed');
      texture.width = width; texture.height = height; texture.layers = layers;
      texture.loaded = true; texture.encoded = encoded; texture.version++;
      state.textureUploads++;
    }
    function imageBytesAndSize(image, width, height, layers) {
      const src = image?._ntSource;
      const w = image?.naturalWidth || image?.width, h = image?.naturalHeight || image?.height;
      if (!src || w !== width || h !== height * layers)
        throw new RangeError('Image dimensions do not match width x (height * layers) K73 atlas');
      if (src.bytes) return new Uint8Array(src.bytes);
      if (src.path) return new Uint8Array(nt.readBinary(src.path));
      throw new TypeError('Texture image has no encoded JPEG/PNG byte source');
    }
    function setFloatTexture(texture, width, height, pixels, immutable = false) {
      if (!Number.isInteger(width) || !Number.isInteger(height) ||
          width < 1 || height < 1 || width > 4096 || height > 1024 ||
          width * height > 1048576)
        throw new RangeError('Native RGBA32F texture exceeds supported dimensions');
      if (pixels !== null && !(pixels instanceof Float32Array))
        return unsupportedRaw('RGBA32F pixels must be Float32Array or null');
      if (pixels && pixels.length !== width * height * 4)
        throw new RangeError('RGBA32F pixel array length');
      const copy = pixels ? Float32Array.from(pixels) : new Float32Array(width * height * 4);
      const bytes = new Uint8Array(copy.buffer, copy.byteOffset, copy.byteLength);
      if (!nt.uploadTexture(texture.id, bytes, width, height, 4))
        throw Error('Native RGBA32F GPU texture allocation failed');
      texture.width = width; texture.height = height; texture.layers = 1;
      texture.float32 = true; texture.floatPixels = copy; texture.loaded = true;
      texture.immutable = immutable; texture.version++;
      state.textureUploads++;
    }
    function setTexImage(target, level, format, width, height, layers, pixelFormat, pixelType, pixels) {
      if (target === G.TEXTURE_2D && level === 0 && layers === 1 &&
          format === G.RGBA32F && pixelFormat === G.RGBA && pixelType === G.FLOAT) {
        const tex = boundTexture(target);
        if (tex.immutable) return unsupportedRaw('texImage on immutable float texture');
        setFloatTexture(tex, width, height, pixels, false);
        return;
      }
      if (boundTexture(target).immutable) return unsupportedRaw('texImage on immutable texture storage');
      if (level !== 0 || (format !== G.RGBA8 && format !== G.RGBA) ||
          pixelFormat !== G.RGBA || pixelType !== G.UNSIGNED_BYTE)
        return unsupportedRaw('texImage: only level-0 RGBA8/UNSIGNED_BYTE is supported');
      const texture = boundTexture(target);
      if (pixels?._ntSource) {
        const bytes = imageBytesAndSize(pixels, width, height, layers);
        setTexturePixels(texture, width, height, layers, bytes, true);
      } else if (pixels instanceof Uint8Array) {
        setTexturePixels(texture, width, height, layers, pixels, false);
      } else if (pixels === null) {
        // WebGL allows allocating with null pixels. Keep all bytes defined as
        // transparent black, so uninitialised data never leak to the GPU.
        setTexturePixels(texture, width, height, layers,
          new Uint8Array(width * height * layers * 4), false);
      } else {
        return unsupportedRaw('texImage pixels: only Uint8Array, Image, or null');
      }
    }
    function compileVertex(source) {
      // K73's INST variant has exactly four per-instance matrix columns at
      // locations 3..6 and a per-instance colour at 7. Route those attributes
      // to NativeRenderer's real DX12 instancing buffer; never silently
      // accept arbitrary GLSL or SKIN vertex shaders.
      const instanced = /#define\s+INST\b/.test(source);
      const skinned = /#define\s+SKIN\b/.test(source);
      // K73 SKIN shader pair. Uniform-bone variant is supported through a
      // CPU pose-to-geometry fallback until a dedicated GPU skin vertex shader
      // is available. BONETEX / TINTTEX variants are rejected explicitly.
      if (skinned && !instanced &&
          !/#define\s+(?:BONETEX|TINTTEX)\b/.test(source) &&
          /layout\s*\(location\s*=\s*3\)\s*in\s+vec4\s+aJ\s*;/.test(source) &&
          /layout\s*\(location\s*=\s*4\)\s*in\s+vec4\s+aW\s*;/.test(source) &&
          /uniform\s+vec4\s+uB\s*\[\s*96\s*\]\s*;/.test(source) &&
          /mat4\s+boneM\s*\(\s*float\s+j\s*\)/.test(source) &&
          /uniform\s+mat4\s+uVP\s*;/.test(source) &&
          /uniform\s+mat4\s+uModel\s*;/.test(source) &&
          /gl_Position\s*=/.test(source) &&
          /layout\s*\(location\s*=\s*0\)\s*in\s+vec3\s+aPos\s*;/.test(source)) {
        const depth = /gl_Position\s*=\s*uVP\s*\*\s*\(\s*M\s*\*\s*vec4\s*\(\s*aPos\s*,\s*1\.0\s*\)\s*\)\s*;/.test(source);
        const lit = /gl_Position\s*=\s*uVP\s*\*\s*w\s*;/.test(source) &&
          /layout\s*\(location\s*=\s*1\)\s*in\s+vec3\s+aNor\s*;/.test(source) &&
          /layout\s*\(location\s*=\s*2\)\s*in\s+vec4\s+aCol\s*;/.test(source);
        if (depth || lit) return {kind: depth ? 'k73-depth-skin' : 'k73-lit-skin',size:3};
      }
      // K73 v86 PART_VS billboard particles: four attributes and uVP.
      // Exact GLSL is recognized; the native path uses GPU instanced quads.
      if (!instanced && !skinned &&
          /layout\s*\(\s*location\s*=\s*0\s*\)\s*in\s+vec2\s+aC\s*;/.test(source) &&
          /layout\s*\(\s*location\s*=\s*1\s*\)\s*in\s+vec4\s+aPS\s*;/.test(source) &&
          /layout\s*\(\s*location\s*=\s*2\s*\)\s*in\s+vec4\s+aCol\s*;/.test(source) &&
          /layout\s*\(\s*location\s*=\s*3\s*\)\s*in\s+vec4\s+aDir\s*;/.test(source) &&
          /uniform\s+mat4\s+uVP\s*;/.test(source) &&
          /uniform\s+vec3\s+uR\s*;/.test(source) &&
          /uniform\s+vec3\s+uU\s*;/.test(source) &&
          /gl_Position\s*=\s*uVP\s*\*\s*vec4\s*\(\s*wp\s*,\s*1\.0\s*\)\s*;/.test(source))
        return {kind: 'k73-part', size: 2};
      // K73 full-screen sky vertex shader (clip-space aP).
      // The native counterpart creates a low-resolution sky gradient mesh.
      if (!instanced && !skinned &&
          /layout\s*\(\s*location\s*=\s*0\s*\)\s*in\s+vec2\s+aP\s*;/.test(source) &&
          /out\s+vec2\s+vP\s*;/.test(source) &&
          /vP\s*=\s*aP\s*;/.test(source) &&
          /gl_Position\s*=\s*vec4\s*\(\s*aP\s*,\s*0\.0\s*,\s*1\.0\s*\)\s*;/.test(source))
        return { kind: 'k73-sky', size: 2 };
      // K73 v86 depth-only vertex shader, including the exact INST variant.
      // Compilation is profile recognition, not a claim of generic GLSL -> HLSL.
      // Shadow framebuffer support is a separate, necessary stage.
      if (!skinned &&
          /layout\s*\(location\s*=\s*0\)\s*in\s+vec3\s+aPos\s*;/.test(source) &&
          /uniform\s+mat4\s+uVP\s*;/.test(source) &&
          /uniform\s+mat4\s+uModel\s*;/.test(source) &&
          /gl_Position\s*=\s*uVP\s*\*\s*\(\s*M\s*\*\s*vec4\s*\(\s*aPos\s*,\s*1\.0\s*\)\s*\)\s*;/.test(source)) {
        const usesInstMatrix = /mat4\s+M\s*=\s*mat4\s*\(\s*aM0\s*,\s*aM1\s*,\s*aM2\s*,\s*aM3\s*\)\s*;/.test(source);
        const usesModel = /mat4\s+M\s*=\s*uModel\s*;/.test(source);
        const columns = [3, 4, 5, 6].every(i =>
          new RegExp('layout\\s*\\(location\\s*=\\s*' + i +
            '\\)\\s*in\\s+vec4\\s+aM' + (i - 3) + '\\s*;').test(source));
        if (instanced ? (usesInstMatrix && columns) : usesModel)
          return {kind: instanced ? 'k73-depth-inst' : 'k73-depth', size: 3};
      }
      if (/layout\s*\(location\s*=\s*0\)\s*in\s+vec3\s+aPos\s*;/.test(source) &&
          /layout\s*\(location\s*=\s*1\)\s*in\s+vec3\s+aNor\s*;/.test(source) &&
          /layout\s*\(location\s*=\s*2\)\s*in\s+vec4\s+aCol\s*;/.test(source) &&
          /uniform\s+mat4\s+uVP\s*;/.test(source) &&
          /gl_Position\s*=\s*uVP\s*\*\s*w\s*;/.test(source) && !skinned) {
        if (instanced && ![3, 4, 5, 6, 7].every(i =>
            new RegExp('layout\\s*\\(location\\s*=\\s*' + i + '\\)\\s*in\\s+vec4\\s+a' +
              (i === 7 ? 'IC' : 'M' + (i - 3)) + '\\s*;').test(source))) return null;
        return { kind: instanced ? 'k73-lit-inst' : 'k73-lit', size: 3 };
      }
      const attr = /layout\s*\(\s*location\s*=\s*0\s*\)\s*in\s+vec([23])\s+(\w+)\s*;/.exec(source);
      if (!attr) return null;
      // Avoid accepting arbitrary GLSL and silently rendering the wrong output.
      const assignment = new RegExp('gl_Position\\s*=\\s*vec4\\s*\\(\\s*' + attr[2] + '\\s*,\\s*1(?:\\.0+)?\\s*\\)\\s*;');
      if (!assignment.test(source)) return null;
      if (/uniform\s+|texture\s*\(|gl_VertexID|gl_InstanceID|mat[234]\s/.test(source)) return null;
      return { size: Number(attr[1]) };
    }
    function compileFragment(source) {
      // Original K73 PART_FS uses a screen-space radial falloff and
      // procedural smoke. Native unlit instancing currently approximates both.
      if (!/#define\s+(?:INST|SKIN)\b/.test(source) &&
          /in\s+vec4\s+vCol\s*;/.test(source) &&
          /in\s+vec2\s+vUV\s*;/.test(source) &&
          /in\s+float\s+vF\s*;/.test(source) &&
          /uniform\s+float\s+uAdd\s*;/.test(source) &&
          /uniform\s+vec3\s+uFogCol\s*;/.test(source) &&
          /if\s*\(\s*uAdd\s*>\s*0\.5\s*\)/.test(source) &&
          /oC\s*=\s*vec4\s*\(\s*mix\s*\(\s*vCol\.rgb\s*\*\s*sh\s*,\s*uFogCol\s*,\s*vF\s*\*\s*0\.8\s*\)\s*,\s*vCol\.a\s*\*\s*a\s*\*\s*a\s*\)\s*;/.test(source))
        return {kind:'k73-part'};
      // Original K73 procedural SKY_FS. Its atmospheric/planet/cloud code is
      // not executable GLSL here: a verified native sky approximation is used.
      if (!/#define\s+(?:INST|SKIN)\b/.test(source) &&
          /in\s+vec2\s+vP\s*;/.test(source) &&
          /uniform\s+mat4\s+uInvVP\s*;/.test(source) &&
          /uniform\s+vec3\s+uCam\b/.test(source) &&
          /uniform\s+vec3\s+uZen\b/.test(source) &&
          /uniform\s+vec3\s+uHor\b/.test(source) &&
          /uniform\s+vec3\s+uSunDir\b/.test(source) &&
          /uniform\s+vec3\s+uFogCol\b/.test(source) &&
          /vec4\s+a\s*=\s*uInvVP\s*\*\s*vec4\s*\(\s*vP\s*,\s*1\.0\s*,\s*1\.0\s*\)\s*;/.test(source) &&
          /oC\s*=\s*vec4\s*\(\s*tm\s*\(\s*col\s*\*\s*uExposure\s*\)\s*,\s*1\.0\s*\)\s*;/.test(source))
        return {kind: 'k73-sky'};
      // K73 depth fragment: no colour output (depth-only pipeline).
      // Reject other empty GLSL programs rather than claiming broad support.
      if (/^\s*#version\s+300\s+es\s*(?:#define\s+(?:INST|SKIN)\s+1\s*)?precision\s+mediump\s+float\s*;\s*void\s+main\s*\(\s*\)\s*\{\s*\}\s*$/.test(source))
        return {kind: 'k73-depth'};
      // K73 v86's LIT_FS uses triplanar detail, normal arrays, shadow PCF,
      // custom exposure and fog. The native fixed HLSL material backend can
      // currently only approximate its vertex colors, sun, tint and normals.
      if (/in\s+vec4\s+vC\s*;/.test(source) &&
          /uniform\s+vec4\s+uTint\s*;/.test(source) &&
          /vec3\s+base\s*=\s*vC\.rgb\s*\*\s*uTint\.rgb\s*;/.test(source) &&
          /uniform\s+vec3\s+uSunDir/.test(source) &&
          /out\s+vec4\s+oC\s*;/.test(source) &&
          (!/#define\s+SKIN\b/.test(source) ||
           !/#define\s+(?:BONETEX|TINTTEX)\b/.test(source))) {
        return { kind: /#define\s+SKIN\b/.test(source) ? 'k73-lit-skin' : 'k73-lit' };
      }
      const output = /\bout\s+vec4\s+(\w+)\s*;/.exec(source);
      if (!output) return null;
      const assignment = new RegExp('\\b' + output[1] + '\\s*=\\s*vec4\\s*\\(\\s*([^)]*)\\s*\\)\\s*;').exec(source);
      if (!assignment) return null;
      const nums = assignment[1].split(',').map(x => x.trim());
      if (nums.length !== 4 || nums.some(x => !/^(?:\d+\.?\d*|\.\d+)$/.test(x))) return null;
      if (/uniform\s+|texture\s*\(/.test(source)) return null;
      const rgba = nums.map(Number);
      return rgba.every(x => x >= 0 && x <= 1) ? rgba : null;
    }
    function k73MaterialAtlas() {
      if (!['k73-lit', 'k73-lit-inst'].includes(state.program?.profile)) return null;
      const unit = state.program.uniforms?.get('uMatA') ?? 6;
      if (state.program.uniforms?.get('uMatOn') < 0.5) return null;
      if (!Number.isInteger(unit) || unit < 0 || unit >= state.textureUnits.length) return null;
      const texture = state.textureUnits[unit].get(G.TEXTURE_2D_ARRAY);
      return texture?.loaded ? texture : null;
    }
    // K73 uses independent position, normal, and RGBA8 vertex-colour VBOs.
    // Convert those existing WebGL attributes into NativeRenderer's exact
    // interleaved geometry upload format, preserving optional index buffers.
    function upload(first, count, indexType = 0, indexOffset = 0) {
      const vao = state.vao, attrs = vao.attributes, pos = attrs.get(0);
      if (!pos?.enabled || !pos.buffer || pos.type !== G.FLOAT ||
          pos.size !== 3 && pos.size !== 2 || pos.normalized)
        return unsupportedRaw('position attribute 0 must be FLOAT vec2/vec3');
      const vertexIndices = [];
      let maxVertex = first + count - 1;
      if (indexType) {
        const buf = vao.elements?.data;
        const bytes = indexType === G.UNSIGNED_SHORT ? 2 : indexType === G.UNSIGNED_INT ? 4 : 0;
        if (!buf || !bytes || buf.BYTES_PER_ELEMENT !== bytes || indexOffset % bytes)
          return unsupportedRaw('drawElements requires aligned Uint16Array/Uint32Array index buffer');
        const indexStart = indexOffset / bytes;
        if (indexStart + count > buf.length) throw new RangeError('drawElements indexes outside index buffer');
        for (let i = 0; i < count; i++) vertexIndices.push(buf[indexStart + i]);
        maxVertex = vertexIndices.reduce((max, i) => Math.max(max, i), 0);
      }
      const numVertices = indexType ? maxVertex + 1 : count;
      if (numVertices > 400000) throw new RangeError('DX12 prototype geometry too large');
      function attributeData(i, vertex, expectedSize, defaultValues) {
        const attr = attrs.get(i);
        if (!attr?.enabled) return defaultValues;
        if (!attr.buffer?.data || attr.size !== expectedSize) return unsupportedRaw('vertex attribute size/buffer ' + i);
        if (attr.type !== G.FLOAT && attr.type !== G.UNSIGNED_BYTE)
          return unsupportedRaw('attribute component type ' + i);
        const data = attr.buffer.data;
        const bytes = attr.type === G.FLOAT ? 4 : 1;
        const stride = attr.stride || bytes * attr.size;
        const start = attr.offset + vertex * stride;
        if (start < 0 || start + bytes * attr.size > data.byteLength || start % bytes)
          throw new RangeError('vertex attribute outside byte buffer: ' + i);
        const view = new DataView(data.buffer, data.byteOffset + start, bytes * attr.size);
        const v = [];
        for (let c = 0; c < attr.size; c++) {
          let x = attr.type === G.FLOAT ? view.getFloat32(c * bytes, true) : view.getUint8(c);
          if (attr.normalized && attr.type === G.UNSIGNED_BYTE) x /= 255;
          v.push(x);
        }
        return v;
      }
      const cacheKey = [first, count, indexType, indexOffset,
        vao.elements?.version || 0, state.program?.profile || '',
        !!k73MaterialAtlas(),
        ...[0, 1, 2].flatMap(i => {
          const a = attrs.get(i);
          return a ? [a.buffer?.version, a.size, a.type, a.normalized, a.stride, a.offset] : [0];
        }),
      ].join(':');
      const old = state.cache.get(vao);
      if (old?.key === cacheKey) return old.id;
      const positions = new Float32Array(numVertices * 3);
      const normals = new Float32Array(numVertices * 3);
      const colors = new Float32Array(numVertices * 4);
      let hasNormals = false, hasColors = false;
      for (let i = 0; i < numVertices; i++) {
        const vertex = indexType ? i : first + i;
        const p = attributeData(0, vertex, pos.size, [0, 0, 0]);
        positions.set([p[0], p[1], p[2] || 0], i * 3);
        const n = attributeData(1, vertex, 3, [0, 1, 0]);
        normals.set(n, i * 3);
        hasNormals ||= !!attrs.get(1)?.enabled;
        const col = attributeData(2, vertex, 4, [1, 1, 1, 1]);
        // K73 stores its material-class identifier in vertex-color alpha;
        // it is NOT transparency. Native HLSL's vertex alpha controls pixel
        // opacity, so pass opaque alpha until the material-class shader stage
        // is separately translated.
        if (state.program?.profile?.startsWith('k73-lit') && !k73MaterialAtlas()) col[3] = 1;
        colors.set(col, i * 4);
        hasColors ||= !!attrs.get(2)?.enabled;
      }
      if (old) nt.releaseGeometry(old.id);
      const id = nextRawGeometryId++;
      nt.uploadGeometry(id, positions, hasNormals ? normals : null,
        hasColors ? colors : null,
        indexType ? new Uint32Array(vertexIndices) : null, null);
      state.cache.set(vao, { id, key: cacheKey });
      return id;
    }
    // K73 uniform-bone fallback. Joint indices/weights are decoded from the
    // original packed WebGL2 vertex buffers. Pose and morph weights are
    // applied before uploading the *actual* animated geometry to DX12.
    // Unlike simply accepting a SKIN GLSL profile, this moves vertices.
    function uploadSkin(first, count, indexType = 0, indexOffset = 0) {
      const vao = state.vao, attrs = vao.attributes;
      if (!['k73-lit-skin','k73-depth-skin'].includes(state.program?.profile))
        return unsupportedRaw('uploadSkin profile');
      const u = state.program.uniforms || new Map();
      const bones = u.get('uB');
      if (!(bones instanceof Float32Array) || bones.length < 12 ||
          bones.length % 12 || bones.length > 384)
        return unsupportedRaw('K73 skin requires 1..32 joint matrices in uB');
      const boneCount = bones.length / 12;
      const get = (i, vertex, size) => {
        const a = attrs.get(i);
        if (!a?.enabled || !a.buffer?.data || a.size !== size || a.divisor)
          return unsupportedRaw('K73 skin attribute '+i);
        const bytes = a.type === G.FLOAT ? 4 : a.type === G.UNSIGNED_SHORT ? 2 : 1;
        if (![G.FLOAT,G.UNSIGNED_SHORT,G.UNSIGNED_BYTE,G.BYTE].includes(a.type))
          return unsupportedRaw('K73 skin attribute component '+i);
        const offset = a.offset + vertex*(a.stride || size*bytes);
        const buf = a.buffer.data;
        if (offset < 0 || offset + size*bytes > buf.byteLength)
          throw new RangeError('K73 skin attribute outside buffer '+i);
        const view = new DataView(buf.buffer, buf.byteOffset+offset,size*bytes);
        const out = [];
        for(let k=0;k<size;k++) {
          let x = a.type === G.FLOAT ? view.getFloat32(k*4,true)
            : a.type === G.UNSIGNED_SHORT ? view.getUint16(k*2,true)
            : a.type === G.BYTE ? view.getInt8(k) : view.getUint8(k);
          if (a.normalized) x = a.type === G.UNSIGNED_SHORT ? x/65535 :
            a.type === G.BYTE ? Math.max(-1,x/127) :
            a.type === G.UNSIGNED_BYTE ? x/255 : x;
          out.push(x);
        }
        return out;
      };
      // Strictly check exact K73 typed attribute layout.
      const expected = [[0,3,G.FLOAT],[1,3,G.BYTE],[2,2,G.UNSIGNED_SHORT],
                        [3,4,G.UNSIGNED_BYTE],[4,4,G.UNSIGNED_BYTE]];
      for (const [idx,size,type] of expected) {
        const a=attrs.get(idx);
        if (!a?.enabled || a.size!==size || a.type!==type)
          return unsupportedRaw('K73 packed skin attribute layout '+idx);
      }
      const elements = vao.elements?.data;
      const indexed = !!indexType;
      let indices = null;
      if (indexed) {
        const bytes = indexType===G.UNSIGNED_SHORT?2:indexType===G.UNSIGNED_INT?4:0;
        if (!bytes || !elements || elements.BYTES_PER_ELEMENT!==bytes || indexOffset%bytes)
          return unsupportedRaw('K73 skin index buffer type/alignment');
        if (indexOffset/bytes+count>elements.length)
          throw new RangeError('K73 skin indexes outside element buffer');
        indices = Uint32Array.from(elements.subarray(indexOffset/bytes,indexOffset/bytes+count));
      }
      let maxVertex = indexed ? indices.reduce((m,x)=>Math.max(m,x),0) : first+count-1;
      if (maxVertex>=120000) throw new RangeError('K73 skin geometry exceeds CPU fallback limit');
      const numVertices=indexed?maxVertex+1:count;
      const morphN=Math.max(0,Math.min(8,Number(u.get('uMorphN')||0)));
      const morphUnit=u.get('uMorphTex')??5;
      const morphTex=morphN && Number.isInteger(morphUnit)
        ? state.textureUnits[morphUnit]?.get(G.TEXTURE_2D):null;
      const morphWeights=u.get('uMW');
      if (morphN && (!morphTex?.float32 || !morphTex.floatPixels ||
          !morphWeights || morphWeights.length<8))
        return unsupportedRaw('K73 skin morph requires RGBA32F texture and 8 weights');
      const baseKey=[first,count,indexType,indexOffset,vao.elements?.version||0,
        ...[0,1,2,3,4].flatMap(idx=>{
          const a=attrs.get(idx);return [a.buffer?.version,a.size,a.type,a.stride,a.offset,a.normalized];
        }),morphN,morphTex?.id||0,morphTex?.version||0].join(':');
      const old=state.cache.get(vao);
      if(old?.skinKey===baseKey && old.bones?.length===bones.length &&
          old.bones.every((x,i)=>x===bones[i]) &&
          (!morphN || old.morphWeights?.every((x,i)=>x===morphWeights[i])))
        return old.id;
      const positions=new Float32Array(numVertices*3);
      const normals=new Float32Array(numVertices*3);
      const colors=new Float32Array(numVertices*4);
      const uvs=new Float32Array(numVertices*2);
      for(let i=0;i<numVertices;i++){
        const vertex=indexed?i:first+i;
        const p=get(0,vertex,3), n=get(1,vertex,3), uv=get(2,vertex,2);
        const joints=get(3,vertex,4),weights=get(4,vertex,4);
        if(morphN){
          const x=vertex%1024, row=Math.floor(vertex/1024)*8;
          const image=morphTex.floatPixels;
          for(let k=0;k<morphN;k++){
            const weight=morphWeights[k];if(!weight)continue;
            if(x>=morphTex.width || row+k>=morphTex.height)throw new RangeError('K73 morph texel outside RGBA32F texture');
            const o=((row+k)*morphTex.width+x)*4;
            p[0]+=image[o]*weight;p[1]+=image[o+1]*weight;p[2]+=image[o+2]*weight;
          }
        }
        const outP=[0,0,0],outN=[0,0,0];
        let weightSum=0;
        for(let j=0;j<4;j++){
          const w=weights[j];if(w<=0)continue;
          const bone=joints[j]|0;
          if(bone<0 || bone>=boneCount)throw new RangeError('K73 skin bone index outside uB');
          const o=bone*12;
          const a0=bones[o],a1=bones[o+1],a2=bones[o+2],ax=bones[o+3];
          const b0=bones[o+4],b1=bones[o+5],b2=bones[o+6],by=bones[o+7];
          const c0=bones[o+8],c1=bones[o+9],c2=bones[o+10],cz=bones[o+11];
          outP[0]+=w*(a0*p[0]+a1*p[1]+a2*p[2]+ax);
          outP[1]+=w*(b0*p[0]+b1*p[1]+b2*p[2]+by);
          outP[2]+=w*(c0*p[0]+c1*p[1]+c2*p[2]+cz);
          outN[0]+=w*(a0*n[0]+a1*n[1]+a2*n[2]);
          outN[1]+=w*(b0*n[0]+b1*n[1]+b2*n[2]);
          outN[2]+=w*(c0*n[0]+c1*n[1]+c2*n[2]);
          weightSum+=w;
        }
        // Vertices with no joint weights retain their bind-pose positions.
        if(weightSum===0){outP.splice(0,3,...p);outN.splice(0,3,...n);}
        const len=Math.hypot(...outN)||1;
        positions.set(outP,i*3);
        normals.set(outN.map(x=>x/len),i*3);
        colors.set([1,1,1,1],i*4);
        uvs.set(uv,i*2);
      }
      const id=old?.id??nextRawGeometryId++;
      nt.uploadGeometry(id,positions,normals,colors,indices,uvs);
      state.cache.set(vao,{id,skinKey:baseKey,bones:Float32Array.from(bones),
        morphWeights:morphN?Float32Array.from(morphWeights):null});
      return id;
    }
    // Clip-space K73 sky proxy. Sample the original inverse-view-projection
    // direction per grid vertex; use the existing unlit native DX12 shader,
    // no extra WebGL context and no fake "GLSL compiler" result.
    // Clouds, stars, giant planet and exact sun disk require a dedicated HLSL
    // pixel shader later. This intentionally reports that limitation.
    function skyGeometry() {
      const u = state.program.uniforms || new Map();
      const val = (name, fallback) => u.get(name) ?? fallback;
      const inv = val('uInvVP', ID);
      const cam = val('uCam', [0, 0, 0]);
      const zen = val('uZen', [0.25, 0.22, 0.3]);
      const hor = val('uHor', [0.75, 0.52, 0.38]);
      const fog = val('uFogCol', [0.62, 0.44, 0.32]);
      const sun = val('uSunDir', [0.4, 0.5, 0.3]);
      const sunCol = val('uSunCol', [1.3, 0.95, 0.7]);
      const exposure = Math.max(0.01, Number(val('uExposure', 1.5)));
      const night = Math.max(0, Math.min(1, Number(val('uNight', 0))));
      if (!inv || inv.length !== 16) return unsupportedRaw('K73 sky needs inverse view projection mat4');
      const key = [...inv, ...cam, ...zen, ...hor, ...fog, ...sun, ...sunCol, exposure, night].join(',');
      if (state.sky?.key === key) return state.sky.id;
      // 24x16 grid: 425 vertices and 2304 indexes, independent of game size.
      const cols = 24, rows = 16;
      const positions = new Float32Array((cols + 1) * (rows + 1) * 3);
      const colors = new Float32Array((cols + 1) * (rows + 1) * 4);
      const indices = new Uint32Array(cols * rows * 6);
      const clamp = x => Math.max(0, Math.min(1, x));
      const tm = x => {
        x = Math.max(0, x * exposure);
        return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14));
      };
      const normalize = (x, y, z) => {
        const len = Math.hypot(x, y, z) || 1;
        return [x / len, y / len, z / len];
      };
      const sn = normalize(sun[0], sun[1], sun[2]);
      for (let iy = 0; iy <= rows; iy++) for (let ix = 0; ix <= cols; ix++) {
        const x = -1 + ix * 2 / cols;
        const y = -1 + iy * 2 / rows;
        const p = (iy * (cols + 1) + ix) * 3;
        const c = (iy * (cols + 1) + ix) * 4;
        positions.set([x, y, 0], p);
        const wx = inv[0] * x + inv[4] * y + inv[8] + inv[12];
        const wy = inv[1] * x + inv[5] * y + inv[9] + inv[13];
        const wz = inv[2] * x + inv[6] * y + inv[10] + inv[14];
        const ww = inv[3] * x + inv[7] * y + inv[11] + inv[15];
        const w = Math.abs(ww) < 1e-7 ? (ww < 0 ? -1e-7 : 1e-7) : ww;
        const dir = normalize(wx / w - cam[0], wy / w - cam[1], wz / w - cam[2]);
        const h = dir[1];
        const skyT = Math.pow(clamp(h), 0.55);
        const fogT = Math.exp(-Math.max(h, 0) * 9) * 0.85;
        const sd = Math.max(0, dir[0] * sn[0] + dir[1] * sn[1] + dir[2] * sn[2]);
        const glow = Math.pow(sd, 24) * 0.28 + Math.pow(sd, 4) * 0.1;
        for (let ch = 0; ch < 3; ch++) {
          let v = hor[ch] * (1 - skyT) + zen[ch] * skyT;
          if (h < 0) v = fog[ch] * (1 - 0.2 * clamp(-h * 3));
          else v = v * (1 - fogT) + fog[ch] * fogT;
          v += sunCol[ch] * glow;
          // K73's original shader already uses nighttime colors via its
          // dynamic environment uniforms; keep those rather than hardcoding.
          colors[c + ch] = tm(v);
        }
        colors[c + 3] = 1;
      }
      let n = 0;
      for (let iy = 0; iy < rows; iy++) for (let ix = 0; ix < cols; ix++) {
        const a = iy * (cols + 1) + ix, b = a + 1, d = a + cols + 1, e = d + 1;
        indices[n++] = a; indices[n++] = b; indices[n++] = d;
        indices[n++] = b; indices[n++] = e; indices[n++] = d;
      }
      const id = state.sky?.id ?? nextRawGeometryId++;
      nt.uploadGeometry(id, positions, null, colors, indices, null);
      state.sky = {id, key, count: indices.length};
      return id;
    }
    // K73 particle attribute 0 is a six-vertex billboard with aC.xy.
    // Upload one local-space quad and let DX12 draw its N instances at once.
    function particleGeometry(first, count) {
      const vao = state.vao;
      const a = vao.attributes.get(0);
      if (!a?.enabled || a?.divisor || a.size !== 2 || a.type !== G.FLOAT ||
          !a.buffer?.data || a.normalized || first !== 0 || count !== 6)
        return unsupportedRaw('K73 particle quad needs 6 FLOAT vec2 vertices at attribute 0');
      const key = [a.buffer.version, a.offset, a.stride, first, count].join(':');
      let old = state.cache.get(vao);
      if (old?.key === key) return old.id;
      const stride = a.stride || 8;
      const pos = new Float32Array(18);
      for (let i=0;i<6;i++) {
        const offset = a.offset + i * stride;
        if (offset < 0 || offset + 8 > a.buffer.data.byteLength)
          throw new RangeError('K73 particle quad attribute 0 outside buffer');
        const v = new DataView(a.buffer.data.buffer,a.buffer.data.byteOffset+offset,8);
        pos[i*3] = v.getFloat32(0,true);
        pos[i*3+1] = v.getFloat32(4,true);
      }
      if (old) nt.releaseGeometry(old.id);
      const id = nextRawGeometryId++;
      nt.uploadGeometry(id,pos,null,null,null,null);
      state.cache.set(vao,{id,key});
      return id;
    }
    function particleRecord(count) {
      if (state.program?.profile !== 'k73-part') return null;
      if (!Number.isSafeInteger(count) || count < 0 || count > 100000)
        return unsupportedRaw('K73 particle instance count');
      const vao = state.vao;
      const attrs = [1,2,3].map(i=>vao.attributes.get(i));
      if (attrs.some(a=>!a?.enabled || a?.divisor !== 1 ||
          !a.buffer?.data || a.size !== 4 || a.type !== G.FLOAT || a.normalized))
        return unsupportedRaw('K73 particle instances require aPS/aCol/aDir FLOAT vec4 divisor 1');
      const uniforms = state.program.uniforms || new Map();
      const u = (key,defaultValue) => uniforms.get(key) ?? defaultValue;
      const cam = u('uCam',[0,0,10]), right = u('uR',[1,0,0]), up = u('uU',[0,1,0]);
      const additive = Number(u('uAdd',0)) > 0.5;
      const key = [count, ...cam, ...right, ...up, additive,
        ...attrs.flatMap(a=>[a.buffer.version,a.stride,a.offset])].join(':');
      let record = state.instanceCache.get(vao);
      if (record?.key === key) return record;
      const matrices = new Float32Array(count*16);
      const colors = new Float32Array(count*3);
      let alphaTotal = 0;
      const norm = (x,y,z) => {
        const len = Math.hypot(x,y,z);
        return len > 1e-7 ? [x/len,y/len,z/len] : [0,1,0];
      };
      const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],
        a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
      function attrib(a,index) {
        const offset = a.offset+index*(a.stride||16);
        if (offset<0 || offset+16>a.buffer.data.byteLength)
          throw new RangeError('K73 particle attribute outside buffer');
        const view=new DataView(a.buffer.data.buffer,a.buffer.data.byteOffset+offset,16);
        return [view.getFloat32(0,true),view.getFloat32(4,true),
          view.getFloat32(8,true),view.getFloat32(12,true)];
      }
      for (let i=0;i<count;i++) {
        const ps=attrib(attrs[0],i), color=attrib(attrs[1],i), dir=attrib(attrs[2],i);
        const stretch=dir[3]>0;
        const upward=stretch ? norm(dir[0],dir[1],dir[2]) : up;
        const towards=norm(cam[0]-ps[0],cam[1]-ps[1],cam[2]-ps[2]);
        const side=stretch ? norm(...cross(upward,towards)) : right;
        const sx=ps[3],sy=stretch?dir[3]:ps[3];
        const depth=norm(...cross(side,upward));
        const o=i*16;
        matrices.set([
          side[0]*sx,side[1]*sx,side[2]*sx,0,
          upward[0]*sy,upward[1]*sy,upward[2]*sy,0,
          depth[0],depth[1],depth[2],0,
          ps[0],ps[1],ps[2],1
        ],o);
        const opacity=Math.max(0,Math.min(1,color[3]));
        colors.set([color[0]*(additive?opacity:1),
          color[1]*(additive?opacity:1), color[2]*(additive?opacity:1)],i*3);
        alphaTotal+=opacity;
      }
      if(!record) record={id:nextRawInstanceId++};
      nt.uploadInstances(record.id,matrices,colors,count);
      record.count=count;record.key=key;
      // DX12 instance colours currently carry RGB, not individual alphas.
      // Pool-level mean opacity is explicit approximation, not per-pixel GLSL.
      record.opacity=count?alphaTotal/count:1;
      record.additive=additive;
      state.instanceCache.set(vao,record);
      return record;
    }
    function instanceRecord(count) {
      if (!['k73-lit-inst', 'k73-depth-inst'].includes(state.program?.profile)) return null;
      const vao = state.vao;
      if (!Number.isInteger(count) || count < 0 || count > 250000)
        return unsupportedRaw('invalid instance count');
      const attrs = [3, 4, 5, 6, 7].map(i => vao.attributes.get(i));
      if (attrs.some(a => !a?.enabled || !a.buffer?.data || a.divisor !== 1 ||
            a.type !== G.FLOAT || a.size !== 4 || a.normalized))
        return unsupportedRaw('K73 INST needs five FLOAT vec4 attributes with divisor=1');
      const key = [count, ...attrs.flatMap(a =>
        [a.buffer.version, a.stride, a.offset, a.buffer.data.byteLength])].join(':');
      let old = state.instanceCache.get(vao);
      if (old?.key === key) return old;
      const matrices = new Float32Array(count * 16);
      const colors = new Float32Array(count * 3);
      for (let row = 0; row < count; row++) {
        for (let col = 0; col < 5; col++) {
          const a = attrs[col], stride = a.stride || 16;
          const byteOffset = a.offset + row * stride;
          if (byteOffset < 0 || byteOffset + 16 > a.buffer.data.byteLength)
            throw new RangeError('K73 INST attribute data outside buffer');
          const view = new DataView(a.buffer.data.buffer,
            a.buffer.data.byteOffset + byteOffset, 16);
          for (let c = 0; c < (col === 4 ? 3 : 4); c++) {
            const value = view.getFloat32(c * 4, true);
            if (col === 4) colors[row * 3 + c] = value;
            else matrices[row * 16 + col * 4 + c] = value;
          }
        }
      }
      if (!old) old = { id: nextRawInstanceId++ };
      nt.uploadInstances(old.id, matrices, colors, count);
      old.key = key; old.count = count;
      state.instanceCache.set(vao, old);
      return old;
    }
    function submitRawPass(geometryId, count, profile, instances = null) {
      const uniforms = state.program.uniforms || new Map();
      const uniform = (name, fallback) => uniforms.get(name) ?? fallback;
      const lit = profile === 'k73-lit' || profile === 'k73-lit-inst' || profile === 'k73-lit-skin';
      const depth = profile === 'k73-depth' || profile === 'k73-depth-inst' || profile === 'k73-depth-skin';
      const sky = profile === 'k73-sky';
      const particle = profile === 'k73-part';
      const transform = (lit || depth) ? uniform('uVP', ID) : ID;
      const model = ['k73-lit','k73-depth','k73-lit-skin','k73-depth-skin'].includes(profile) ? uniform('uModel', ID) : ID;
      const tint = lit ? uniform('uTint', [1, 1, 1, 1]) : depth || sky || particle ? [1, 1, 1, 1] : state.program.color;
      const packet = new Float32Array(64 + (lit ? 16 : 0) + 56);
      packet.set(ID, 0); packet.set(transform, 16);
      packet.set(state.clear, 36);
      const useLight = lit;
      packet[35] = useLight ? 1 : 0;
      if (useLight) {
        const sky = uniform('uSkyCol', [0.3, 0.3, 0.35]);
        packet[40] = sky[0] * 0.65; packet[41] = sky[1] * 0.65; packet[42] = sky[2] * 0.65;
        const cam = uniform('uCam', [0, 0, 10]);
        packet.set(cam.subarray ? cam.subarray(0, 3) : cam, 32);
        const sun = uniform('uSunCol', [1, 1, 1]);
        const dir = uniform('uSunDir', [0.4, 0.7, 0.6]);
        packet[64] = 3; packet[65] = sun[0]; packet[66] = sun[1]; packet[67] = sun[2];
        packet[72] = -dir[0]; packet[73] = -dir[1]; packet[74] = -dir[2];
      }
      packet[43] = 1; packet[44] = state.clearFlags;
      if (state.framebuffer) {
        const depthTexture = state.framebuffer.depth;
        if (!depthTexture?.depth || !depthTexture.loaded ||
            !depth)
          return unsupportedRaw('depth framebuffer draws require K73 DEPTH shader and allocated depth texture');
        // Native WebappWindow directs this pass to the real DSV instead of
        // silently overwriting the game swap-chain framebuffer.
        packet[55] = depthTexture.id;
      }
      packet[45] = canvas.width; packet[46] = canvas.height;
      packet[47] = uniform('uExposure', 1);
      const o = useLight ? 80 : 64;
      packet[o] = geometryId;
      packet[o + 1] = instances?.id || 0;
      packet[o + 2] = instances?.count || 1;
      const hasColors = !!state.vao.attributes.get(2)?.enabled;
      const atlas = useLight ? k73MaterialAtlas() : null;
      const skinAlbedo = profile === 'k73-lit-skin'
        ? state.textureUnits[uniform('uAlb',1)]?.get(G.TEXTURE_2D) : null;
      const raster = sky ? (2 | 32 | 64) :
        (!state.capabilities.has(G.CULL_FACE) ? 2 : (state.cullMode === G.FRONT ? 4 : 0)) |
        (!state.capabilities.has(G.DEPTH_TEST) ? 64 : 0) |
        (!state.depthWrite ? 32 : 0) |
        (state.capabilities.has(G.BLEND) ? 1 : 0) |
        (state.capabilities.has(G.BLEND) && state.blendSrc === G.ONE &&
         state.blendDst === G.ONE ? 4194304 : 0) |
        (state.capabilities.has(G.POLYGON_OFFSET_FILL) ? 8388608 : 0) |
        (state.frontWinding === G.CW ? 16777216 : 0);
      packet[o + 3] = (useLight ? ((hasColors ? 8 : 0) | (instances ? 1024 : 0) |
        (atlas ? 4096 | 1048576 : skinAlbedo?.loaded ? 4096 : 0)) :
        sky ? (16 | 8 | 65536) :
        particle ? (16 | 1024 | 65536) : 16) | raster;
      if (skinAlbedo?.loaded) packet[o + 32] = skinAlbedo.id;
      if (atlas) {
        packet[o + 32] = atlas.id;         // Native DX12 texture slot
        packet[o + 40] = atlas.layers;     // gReflection.x = atlas layer count
      }
      packet[o + 5] = count; packet[o + 6] = 1;
      packet[o + 8] = tint[0]; packet[o + 9] = tint[1]; packet[o + 10] = tint[2];
      packet[o + 11] = useLight ? (uniform('uAlpha', 1) * (tint[3] ?? 1)) :
        particle ? (instances?.opacity ?? 1) : tint[3];
      packet[o + 15] = -1;
      if (useLight) {
        const e = uniform('uEmis', [0, 0, 0]);
        packet[o + 12] = e[0]; packet[o + 13] = e[1]; packet[o + 14] = e[2];
      }
      packet.set(model, o + 16);
      packet[o + 34] = 1; packet[o + 37] = 1;
      state.clearFlags = 0;
      nt.submitPass(packet, packet.length);
      state.draws++;
    }
    const gl = {
      ...G, canvas,
      get drawingBufferWidth() { return canvas.width; },
      get drawingBufferHeight() { return canvas.height; },
      getContextAttributes: () => ({ alpha: false, depth: true, stencil: false, antialias: false }),
      getSupportedExtensions: () => [], getExtension: () => null, getError: () => 0,
      createShader(type) {
        if (type !== G.VERTEX_SHADER && type !== G.FRAGMENT_SHADER) return unsupportedRaw('createShader type');
        return { type, source: '', compiled: false, payload: null };
      },
      shaderSource(shader, source) { shader.source = String(source); shader.compiled = false; },
      compileShader(shader) {
        shader.payload = shader.type === G.VERTEX_SHADER ? compileVertex(shader.source) : compileFragment(shader.source);
        shader.compiled = !!shader.payload;
      },
      getShaderParameter(shader, key) { if (key !== G.COMPILE_STATUS) return unsupportedRaw('getShaderParameter'); return shader.compiled; },
      getShaderInfoLog(shader) { return shader.compiled ? '' : 'Unsupported GLSL. DX12 prototype accepts only position vec2/vec3 and literal vec4 output.'; },
      createProgram() { return { shaders: [], linked: false }; },
      attachShader(program, shader) { program.shaders.push(shader); },
      linkProgram(program) {
        const vs = program.shaders.find(s => s.type === G.VERTEX_SHADER);
        const fs = program.shaders.find(s => s.type === G.FRAGMENT_SHADER);
        program.linked = !!(vs?.compiled && fs?.compiled);
        program.color = program.linked && Array.isArray(fs.payload) ? fs.payload : null;
        const litPair = ['k73-lit', 'k73-lit-inst'].includes(vs?.payload?.kind) && fs?.payload?.kind === 'k73-lit';
        const depthPair = ['k73-depth', 'k73-depth-inst'].includes(vs?.payload?.kind) && fs?.payload?.kind === 'k73-depth';
        const skinLitPair = vs?.payload?.kind === 'k73-lit-skin' && fs?.payload?.kind === 'k73-lit-skin';
        const skinDepthPair = vs?.payload?.kind === 'k73-depth-skin' && fs?.payload?.kind === 'k73-depth';
        const skyPair = vs?.payload?.kind === 'k73-sky' && fs?.payload?.kind === 'k73-sky';
        const particlePair = vs?.payload?.kind === 'k73-part' && fs?.payload?.kind === 'k73-part';
        // An empty depth fragment is only valid with the exact K73 depth vertex profile.
        program.linked &&= !!(litPair || depthPair || skinLitPair || skinDepthPair || skyPair || particlePair ||
          (Array.isArray(fs?.payload) && Number.isInteger(vs?.payload?.size)));
        program.profile = program.linked ? (litPair || depthPair || skinLitPair || skinDepthPair || skyPair || particlePair ? vs.payload.kind : 'constant') : 'invalid';
        program.uniforms = new Map();
        if (program.profile.startsWith('k73-lit')) unsupported('K73 advanced GLSL shading',
          'K73 LIT_VS / LIT_FS mapped to existing native lighting; triplanar detail, PCF shadows and tone mapping are approximate');
        if (program.profile.startsWith('k73-depth')) unsupported('K73 shadow depth framebuffer',
          'DEPTH_VS/DEPTH_FS variants recognised, but actual off-screen shadow texture rendering needs FBO/DX12 depth target support');
        if (program.profile === 'k73-sky') unsupported('K73 sky shader approximation',
          'Sky gradient and broad sun glow use native unlit DX12 geometry; procedural clouds, stars, planet and precise GLSL atmosphere are not yet translated');
        if (program.profile === 'k73-lit-skin' || program.profile === 'k73-depth-skin')
          unsupported('K73 CPU skinning fallback',
            'K73 uniform bones and morph offsets are processed on CPU and uploaded as animated geometry; dedicated HLSL GPU skinning is needed for performance and exact material appearance');
        if (program.profile === 'k73-part') unsupported('K73 particle GLSL approximation',
          'Particles use GPU-instanced billboard quads and per-pool opacity; exact smoke noise, radial soft alpha and additive blend need native HLSL and per-instance alpha');
      },
      getProgramParameter(program, key) { if (key !== G.LINK_STATUS) return unsupportedRaw('getProgramParameter'); return program.linked; },
      getProgramInfoLog(program) { return program.linked ? '' : 'Unsupported or uncompiled GLSL stages'; },
      useProgram(program) { if (!program?.linked) throw Error('Program must be linked'); state.program = program; },
      getUniformLocation(program, name) { return program?.linked ? { program, name: String(name) } : null; },
      uniformMatrix4fv(location, transpose, values) {
        if (!location) return;
        if (transpose || !ArrayBuffer.isView(values) || values.length !== 16)
          return unsupportedRaw('uniformMatrix4fv requires one column-major matrix');
        location.program.uniforms.set(location.name, Float32Array.from(values));
      },
      uniform4fv(location, values, srcOffset = 0, srcLength) {
        if (!location) return;
        if (!ArrayBuffer.isView(values) || !Number.isInteger(srcOffset) || srcOffset < 0 ||
            (srcLength !== undefined && (!Number.isInteger(srcLength) || srcLength < 1)))
          return unsupportedRaw('uniform4fv source range');
        const end = srcLength === undefined ? values.length : srcOffset + srcLength;
        if (end > values.length || end-srcOffset < 4 || (end-srcOffset)%4)
          return unsupportedRaw('uniform4fv vector array range');
        location.program.uniforms.set(location.name, Float32Array.from(values.subarray(srcOffset,end)));
      },
      uniform3fv(location, values) {
        if (!location) return;
        if (!(ArrayBuffer.isView(values) || Array.isArray(values)) || values.length < 3)
          return unsupportedRaw('uniform3fv');
        location.program.uniforms.set(location.name, Float32Array.from(Array.from(values).slice(0, 3)));
      },
      uniform3f(location, x, y, z) { if (location) location.program.uniforms.set(location.name, Float32Array.of(x, y, z)); },
      uniform1f(location, x) {
        if (!location) return;
        if (location.name === 'uShadowOn' && x > 0) {
          unsupported('K73 DX12 shadow sampling',
            'Native depth texture receives offscreen shadow draws, but PCF sampling is not yet bound to the lit HLSL pixel shader');
          x = 0;
        }
        location.program.uniforms.set(location.name, Number(x));
      },
      uniform1i(location, x) { if (location) location.program.uniforms.set(location.name, Number(x)); },
      createTexture() {
        const t = { id: nextRawTextureId++, target: null, width: 0, height: 0,
          layers: 0, version: 0, loaded: false, deleted: false, parameters: new Map() };
        state.liveTextures.add(t);
        return t;
      },
      deleteTexture(t) {
        if (!t || t.deleted) return;
        if (t.loaded) {
          if (t.depth) nt.releaseDepthTarget(t.id);
          else nt.releaseTexture(t.id);
        }
        for (const fb of state.framebuffers) if (fb.depth === t) fb.depth = null;
        t.deleted = true; t.loaded = false;
        state.liveTextures.delete(t);
        for (const unit of state.textureUnits) {
          for (const [key, value] of unit) if (value === t) unit.delete(key);
        }
      },
      activeTexture(unit) {
        const index = unit - G.TEXTURE0;
        if (!Number.isInteger(index) || index < 0 || index >= state.textureUnits.length)
          return unsupportedRaw('activeTexture unit ' + unit);
        state.activeTextureUnit = index;
      },
      bindTexture(target, t) {
        if (target !== G.TEXTURE_2D && target !== G.TEXTURE_2D_ARRAY) return unsupportedRaw('bindTexture target');
        const bindings = state.textureUnits[state.activeTextureUnit];
        if (t === null) { bindings.delete(target); return; }
        if (!state.liveTextures.has(t) || t.deleted) return unsupportedRaw('bindTexture invalid/deleted texture');
        if (t.target !== null && t.target !== target) return unsupportedRaw('bindTexture immutable texture target');
        t.target = target;
        bindings.set(target, t);
      },
      // Immutable WebGL2 depth storage. Unlike an RGBA upload, this allocates
      // a real D3D12 D32_FLOAT DSV resource (24-bit WebGL minimum retained)
      // through the native bridge. No false CPU-only texture object is exposed.
      texStorage2D(target, levels, format, width, height) {
        if (target === G.TEXTURE_2D && levels === 1 && format === G.RGBA32F) {
          const tex = boundTexture(target);
          if (tex.immutable || tex.loaded) return unsupportedRaw('texStorage2D already initialized');
          setFloatTexture(tex, width, height, null, true);
          return;
        }
        if (target !== G.TEXTURE_2D || levels !== 1 || format !== G.DEPTH_COMPONENT24 ||
            !Number.isInteger(width) || !Number.isInteger(height) ||
            width < 1 || height < 1 || width > 4096 || height > 4096)
          return unsupportedRaw('texStorage2D: only level-1 DEPTH_COMPONENT24 up to 4096 supported');
        const t = boundTexture(target);
        if (t.immutable || t.loaded) return unsupportedRaw('texStorage2D already initialized');
        if (typeof nt.allocateDepthTarget !== 'function' ||
            !nt.allocateDepthTarget(t.id, width, height))
          throw Error('NativeThreeBridge DX12 depth render target allocation failed');
        t.immutable = true; t.depth = true; t.loaded = true;
        t.width = width; t.height = height; t.layers = 1; t.version++;
        state.depthAllocations++;
      },
      texImage3D(target, level, internalFormat, width, height, depth, border, format, type, pixels) {
        if (target !== G.TEXTURE_2D_ARRAY || border !== 0) return unsupportedRaw('texImage3D target/border');
        setTexImage(target, level, internalFormat, width, height, depth, format, type, pixels);
      },
      texImage2D(...a) {
        if (a.length === 9) {
          const [target, level, internalFormat, width, height, border, format, type, pixels] = a;
          if (target !== G.TEXTURE_2D || border !== 0) return unsupportedRaw('texImage2D target/border');
          setTexImage(target, level, internalFormat, width, height, 1, format, type, pixels);
        } else if (a.length === 6) {
          const [target, level, internalFormat, format, type, pixels] = a;
          if (target !== G.TEXTURE_2D || !pixels?._ntSource) return unsupportedRaw('texImage2D image');
          setTexImage(target, level, internalFormat, pixels.naturalWidth || pixels.width,
            pixels.naturalHeight || pixels.height, 1, format, type, pixels);
        } else return unsupportedRaw('texImage2D overload');
      },
      texSubImage2D(target, level, x, y, w, h, format, type, pixels, srcOffset = 0) {
        if (target !== G.TEXTURE_2D || level !== 0 || format !== G.RGBA ||
            type !== G.FLOAT || !Number.isInteger(srcOffset) || srcOffset < 0)
          return unsupportedRaw('texSubImage2D: RGBA32F level 0 only');
        const tex = boundTexture(target);
        if (!tex.float32 || !tex.floatPixels || !tex.loaded)
          return unsupportedRaw('texSubImage2D: no allocated float texture');
        if (![x,y,w,h].every(Number.isInteger) || x < 0 || y < 0 ||
            w < 1 || h < 1 || x + w > tex.width || y + h > tex.height)
          throw new RangeError('texSubImage2D rectangle outside float texture');
        if (!(pixels instanceof Float32Array) || srcOffset + w * h * 4 > pixels.length)
          throw new RangeError('texSubImage2D source range');
        const region = new Float32Array(w * h * 4);
        region.set(pixels.subarray(srcOffset, srcOffset + region.length));
        for (let row = 0; row < h; row++) {
          tex.floatPixels.set(region.subarray(row*w*4,(row+1)*w*4),
            ((y+row)*tex.width+x)*4);
        }
        const bytes = new Uint8Array(region.buffer,region.byteOffset,region.byteLength);
        if (!nt.updateFloatTexture(tex.id,x,y,w,h,bytes))
          throw Error('Native DX12 RGBA32F subregion upload failed');
        tex.version++; state.textureUploads++;
      },
      texParameteri(target, name, value) {
        const t = boundTexture(target);
        if (![G.TEXTURE_MIN_FILTER, G.TEXTURE_MAG_FILTER, G.TEXTURE_WRAP_S,
              G.TEXTURE_WRAP_T, G.TEXTURE_MAX_LEVEL,
              G.TEXTURE_COMPARE_MODE, G.TEXTURE_COMPARE_FUNC].includes(name))
          return unsupportedRaw('texParameteri pname 0x' + name.toString(16));
        if (name === G.TEXTURE_COMPARE_MODE && value !== G.COMPARE_REF_TO_TEXTURE && value !== G.NONE)
          return unsupportedRaw('texParameteri invalid compare mode');
        if (name === G.TEXTURE_COMPARE_FUNC && value !== G.LEQUAL)
          return unsupportedRaw('texParameteri unsupported compare function');
        t.parameters.set(name, value);
      },
      texParameterf(target, name, value) {
        return unsupportedRaw('texParameterf extension 0x' + name.toString(16));
      },
      pixelStorei(name, value) {
        if (name !== G.UNPACK_COLORSPACE_CONVERSION_WEBGL || (value !== G.NONE && value !== G.BROWSER_DEFAULT_WEBGL))
          return unsupportedRaw('pixelStorei pname');
        // JPEG colorspace is decoded natively by Windows WIC; the material
        // atlas is already authored for this texture path.
      },
      generateMipmap(target) {
        const t = boundTexture(target);
        if (!t.loaded) throw Error('generateMipmap on incomplete texture');
        if (t.layers > 1) unsupported('K73 texture-array mipmaps',
          'Native DX12 vertical atlas retains full-resolution layers; mipmaps disabled to prevent cross-layer bleed');
      },
      get __nativeDepthAllocations() { return state.depthAllocations; },
      createFramebuffer() {
        const f = {depth: null, deleted: false, draw: null, read: null};
        state.framebuffers.add(f);
        return f;
      },
      deleteFramebuffer(f) {
        if (!f || f.deleted) return;
        if (state.framebuffer === f) state.framebuffer = null;
        f.deleted = true; f.depth = null; state.framebuffers.delete(f);
      },
      bindFramebuffer(target, f) {
        if (target !== G.FRAMEBUFFER) return unsupportedRaw('bindFramebuffer target');
        if (f !== null && (!state.framebuffers.has(f) || f.deleted))
          return unsupportedRaw('bindFramebuffer invalid framebuffer');
        state.framebuffer = f;
      },
      framebufferTexture2D(target, attachment, textureTarget, tex, level) {
        if (target !== G.FRAMEBUFFER || attachment !== G.DEPTH_ATTACHMENT ||
            textureTarget !== G.TEXTURE_2D || level !== 0 || !state.framebuffer)
          return unsupportedRaw('framebufferTexture2D only depth attachment 0');
        if (tex !== null && (!state.liveTextures.has(tex) || !tex.depth || !tex.loaded))
          return unsupportedRaw('framebufferTexture2D needs allocated depth texture');
        state.framebuffer.depth = tex;
      },
      checkFramebufferStatus(target) {
        if (target !== G.FRAMEBUFFER) return unsupportedRaw('checkFramebufferStatus target');
        return !state.framebuffer || state.framebuffer.depth?.loaded
          ? G.FRAMEBUFFER_COMPLETE : G.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
      },
      drawBuffers(buffers) {
        if (!state.framebuffer || !Array.isArray(buffers) ||
            buffers.length !== 1 || buffers[0] !== G.NONE)
          return unsupportedRaw('drawBuffers: only depth-only framebuffer');
        state.framebuffer.draw = G.NONE;
      },
      readBuffer(mode) {
        if (!state.framebuffer || mode !== G.NONE)
          return unsupportedRaw('readBuffer: only depth-only framebuffer');
        state.framebuffer.read = G.NONE;
      },
      get __nativeTextureUploads() { return state.textureUploads; },
      get __nativeTextureUnits() { return state.textureUnits; },
      createBuffer() { return { data: null, version: 0 }; },
      bindBuffer(target, buffer) {
        if (target === G.ARRAY_BUFFER) state.buffer = buffer;
        else if (target === G.ELEMENT_ARRAY_BUFFER) state.vao.elements = buffer;
        else return unsupportedRaw('bindBuffer target');
      },
      bufferData(target, data) {
        if (typeof data === 'number') {
          if (!Number.isSafeInteger(data) || data < 0 || data > 256 * 1024 * 1024)
            return unsupportedRaw('bufferData size');
          data = new Uint8Array(data);
        }
        if (!ArrayBuffer.isView(data)) return unsupportedRaw('bufferData typed arrays or size');
        const dst = target === G.ARRAY_BUFFER ? state.buffer :
          target === G.ELEMENT_ARRAY_BUFFER ? state.vao.elements : null;
        if (!dst) throw Error('No buffer bound for bufferData');
        dst.data = new data.constructor(data); dst.version++;
      },
      bufferSubData(target, offset, data, sourceOffset = 0, length) {
        if (!ArrayBuffer.isView(data) || !Number.isInteger(sourceOffset) || sourceOffset < 0)
          return unsupportedRaw('bufferSubData data/sourceOffset');
        const dst = target === G.ARRAY_BUFFER ? state.buffer :
          target === G.ELEMENT_ARRAY_BUFFER ? state.vao.elements : null;
        const elements = length === undefined ? data.length - sourceOffset : length;
        if (!Number.isInteger(elements) || elements < 0 || sourceOffset + elements > data.length)
          return unsupportedRaw('bufferSubData element range');
        const byteCount = elements * data.BYTES_PER_ELEMENT;
        if (!dst?.data || !Number.isInteger(offset) || offset < 0 ||
            offset + byteCount > dst.data.byteLength) return unsupportedRaw('bufferSubData byte range');
        new Uint8Array(dst.data.buffer, dst.data.byteOffset, dst.data.byteLength).set(
          new Uint8Array(data.buffer, data.byteOffset +
            sourceOffset * data.BYTES_PER_ELEMENT, byteCount), offset);
        dst.version++;
      },
      createVertexArray() { return { attributes: new Map(), elements: null }; },
      bindVertexArray(vao) { state.vao = vao || { attributes: new Map(), elements: null }; },
      enableVertexAttribArray(index) {
        const old = state.vao.attributes.get(index) || {};
        state.vao.attributes.set(index, { ...old, enabled: true });
      },
      vertexAttribIPointer(index, size, type, stride, offset) {
        if (type !== G.UNSIGNED_BYTE || size !== 4)
          return unsupportedRaw('vertexAttribIPointer: only unsigned byte uvec4');
        return this.vertexAttribPointer(index,size,type,false,stride,offset);
      },
      vertexAttribPointer(index, size, type, normalized, stride, offset) {
        if (index < 0 || index > 7 || !state.buffer) return unsupportedRaw('vertexAttribPointer attribute ' + index);
        const old = state.vao.attributes.get(index) || {};
        state.vao.attributes.set(index, { ...old, buffer: state.buffer, size, type, normalized: !!normalized, stride, offset });
      },
      vertexAttribDivisor(index, divisor) {
        if (index < 0 || index > 7 || (divisor !== 0 && divisor !== 1))
          return unsupportedRaw('vertexAttribDivisor attribute/divisor');
        const old = state.vao.attributes.get(index) || {};
        state.vao.attributes.set(index, { ...old, divisor });
      },
      deleteBuffer(buffer) { if (buffer) { buffer.data = null; buffer.version++; } },
      deleteVertexArray(vao) {
        const rec = state.instanceCache.get(vao);
        if (rec) { nt.releaseInstances(rec.id); state.instanceCache.delete(vao); }
        const g = state.cache.get(vao);
        if (g) { nt.releaseGeometry(g.id); state.cache.delete(vao); }
        if (state.vao === vao) state.vao = { attributes: new Map(), elements: null };
      },
      enable(cap) {
        if (![G.DEPTH_TEST, G.CULL_FACE, G.BLEND, G.POLYGON_OFFSET_FILL].includes(cap))
          return unsupportedRaw('enable capability ' + cap);
        state.capabilities.add(cap);
      },
      disable(cap) {
        if (![G.DEPTH_TEST, G.CULL_FACE, G.BLEND, G.POLYGON_OFFSET_FILL].includes(cap))
          return unsupportedRaw('disable capability ' + cap);
        state.capabilities.delete(cap);
      },
      isEnabled(cap) { return state.capabilities.has(cap); },
      depthMask(value) { state.depthWrite = !!value; },
      cullFace(mode) {
        if (mode !== G.BACK && mode !== G.FRONT) return unsupportedRaw('cullFace mode');
        state.cullMode = mode;
      },
      frontFace(mode) {
        if (mode !== G.CCW && mode !== G.CW) return unsupportedRaw('frontFace mode');
        state.frontWinding = mode;
      },
      blendFunc(src, dst) {
        if (!((src === G.SRC_ALPHA && dst === G.ONE_MINUS_SRC_ALPHA) ||
              (src === G.ONE && dst === G.ONE) ||
              (src === G.ONE && dst === G.ZERO)))
          return unsupportedRaw('blendFunc combination');
        state.blendSrc = src; state.blendDst = dst;
      },
      polygonOffset(factor, units) {
        if (!Number.isFinite(factor) || !Number.isFinite(units))
          return unsupportedRaw('polygonOffset non-finite');
        // K73 only enables polygon offset during its depth-only shadow pass.
        // Native DX12 uses its fixed DepthBias/SlopeScaledDepthBias profile.
        state.polygonFactor = factor; state.polygonUnits = units;
        if (factor !== 1.6 || units !== 3)
          unsupported('K73 polygon offset approximation',
            'Native D3D12 depth bias currently uses the K73 shadow profile factor=1.6, units=3');
      },
      viewport(x, y, w, h) {
        const target = state.framebuffer?.depth;
        const width = target?.width ?? canvas.width, height = target?.height ?? canvas.height;
        if (x || y || w !== width || h !== height) return unsupportedRaw('partial viewport');
      },
      clearColor(r, g, b, a) { state.clear = [r, g, b, a]; },
      clear(mask) {
        if (mask & G.COLOR_BUFFER_BIT) state.clearFlags |= 1;
        if (mask & G.DEPTH_BUFFER_BIT) state.clearFlags |= 2;
      },
      drawArrays(mode, first, count) {
        if (mode !== G.TRIANGLES || count < 3 || count % 3 || first < 0) return unsupportedRaw('drawArrays primitive');
        if (!state.program?.linked) throw Error('No linked shader program');
        if (state.program.profile === 'k73-sky') {
          if (first !== 0 || count !== 3) return unsupportedRaw('K73 sky requires fullscreen triangle');
          const id = skyGeometry();
          submitRawPass(id, state.sky.count, 'k73-sky');
        } else {
          const skin = state.program.profile==='k73-lit-skin' || state.program.profile==='k73-depth-skin';
          submitRawPass(skin?uploadSkin(first,count):upload(first,count), count, state.program.profile);
        }
      },
      drawElements(mode, count, type, offset) {
        if (mode !== G.TRIANGLES || count < 3 || count % 3) return unsupportedRaw('drawElements primitive');
        if (!state.program?.linked) throw Error('No linked shader program');
        const skin = state.program.profile==='k73-lit-skin' || state.program.profile==='k73-depth-skin';
        submitRawPass(skin?uploadSkin(0,count,type,offset):upload(0,count,type,offset),
          count, state.program.profile);
      },
      drawArraysInstanced(mode, first, count, instanceCount) {
        if (mode !== G.TRIANGLES || count < 3 || count % 3 || first < 0)
          return unsupportedRaw('drawArraysInstanced primitive');
        if (!state.program?.linked) throw Error('No linked shader program');
        if (!instanceCount) return;
        if (state.program.profile === 'k73-part') {
          const geometryId=particleGeometry(first,count), instances=particleRecord(instanceCount);
          submitRawPass(geometryId,count,'k73-part',instances);
          return;
        }
        const instances = instanceRecord(instanceCount);
        if (!instances) return unsupportedRaw('instanced shader profile mismatch');
        submitRawPass(upload(first, count), count, state.program.profile, instances);
      },
      drawElementsInstanced(mode, count, type, offset, instanceCount) {
        if (mode !== G.TRIANGLES || count < 3 || count % 3)
          return unsupportedRaw('drawElementsInstanced primitive');
        if (!state.program?.linked) throw Error('No linked shader program');
        if (!instanceCount) return;
        const instances = instanceRecord(instanceCount);
        if (!instances) return unsupportedRaw('instanced shader profile mismatch');
        submitRawPass(upload(0, count, type, offset), count, state.program.profile, instances);
      },
      get __nativeDraws() { return state.draws; },
    };
    return gl;
  }

  class HTMLCanvasElement extends HTMLElement {
    constructor(tag = 'canvas', ns) { super(tag, ns); this._width = 300; this._height = 150; }
    get width() { return this._width; }
    // Setting the size (even to the same value) clears a 2D canvas.
    set width(v) { const n = Math.max(0, v | 0); const changed = n !== this._width; this._width = n; if (this._ctx2d) this._ctx2d._reset(); if (changed) uiNotify('layout', this); }
    get height() { return this._height; }
    set height(v) { const n = Math.max(0, v | 0); const changed = n !== this._height; this._height = n; if (this._ctx2d) this._ctx2d._reset(); if (changed) uiNotify('layout', this); }
    _attributeChanged(n, v) {
      if (n === 'width') this._width = v === null ? 300 : v | 0;
      if (n === 'height') this._height = v === null ? 150 : v | 0;
      if ((n === 'width' || n === 'height') && this._ctx2d) this._ctx2d._reset();
    }
    getContext(kind, options) {
      if (kind === '2d') {
        if (!this._ctx2d) this._ctx2d = new CanvasRenderingContext2D(this, options || {});
        return this._ctx2d;
      }
      if (kind === 'webgl2' && this.hasAttribute('data-native-webgl2-prototype')) {
        if (!this._nativeGL2) this._nativeGL2 = makeRawDx12Prototype(this);
        this._ntRendererCanvas = true;
        return this._nativeGL2;
      }
      unsupported(`canvas.getContext('${kind}')`, 'use THREE.WebGLRenderer, which renders natively');
      return null;
    }
    _ntFlushCanvas() { if (this._ctx2d) { this._ctx2d._sizeCheck(); this._ctx2d._flush(); } }
    toDataURL() { unsupported('canvas.toDataURL'); return 'data:,'; }
    toBlob(cb) { unsupported('canvas.toBlob'); setTimeout(() => cb(null), 0); }
    captureStream() { unsupported('canvas.captureStream'); return null; }
    transferControlToOffscreen() { unsupported('OffscreenCanvas'); return null; }
  }
  // ---------------------------------------------------------------- Canvas 2D
  // Drawing calls are recorded as compact commands and executed natively by
  // Direct2D on a persistent bitmap per canvas (webapp_ui_d2d.cpp). Paths are
  // sent in device space (the current transform is applied here), arcs as
  // cubic Béziers. Canvases appear in the HTML UI and as CanvasTexture.
  const CV = { RESET: 1, TRANSFORM: 2, FILL_STYLE: 3, STROKE_STYLE: 4, LINE: 5, DASH: 6, ALPHA: 7,
    BEGIN: 10, MOVE: 11, LINE_TO: 12, BEZIER: 13, CLOSE: 14,
    FILL: 20, STROKE: 21, CLIP: 22, FILL_RECT: 23, FILL_QUAD: 24, STROKE_QUAD: 25, CLEAR_RECT: 26,
    TEXT: 30, FONT: 31, TEXT_ALIGN: 32, IMAGE: 40, SAVE: 41, RESTORE: 42 };
  let nextCanvasId = 1;
  const dirtyCanvases = new Set();
  const COMPOSITE = { 'source-over': 0, copy: 1, lighter: 2, 'destination-out': 3, 'source-atop': 4, 'destination-over': 5, multiply: 6, screen: 7, 'destination-in': 8, 'source-in': 9 };
  class CanvasGradient {
    constructor(kind, coords) { this._kind = kind; this._coords = coords; this._stops = []; }
    addColorStop(offset, color) {
      const c = parseCanvasColor(color);
      if (!c) throw new SyntaxError(`addColorStop: bad colour ${color}`);
      this._stops.push([Math.min(1, Math.max(0, +offset || 0)), c]);
      this._stops.sort((a, b) => a[0] - b[0]);
    }
  }
  class CanvasPattern { constructor(image, repetition) { this._image = image; this._repetition = repetition; } setTransform() {} }
  class ImageData {
    constructor(a, b, c) {
      if (a instanceof Uint8ClampedArray) { this.data = a; this.width = b; this.height = c ?? (a.length / 4 / b); }
      else { this.width = a | 0; this.height = b | 0; this.data = new Uint8ClampedArray(this.width * this.height * 4); }
      this.colorSpace = 'srgb';
    }
  }
  class Path2D {
    constructor(src) { this._ops = src instanceof Path2D ? src._ops.slice() : []; if (typeof src === 'string') unsupported('Path2D SVG path strings', 'the path stays empty'); }
    addPath(p) { if (p && p._ops) this._ops.push(...p._ops); }
  }
  for (const m of ['moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo', 'arc', 'arcTo', 'ellipse', 'rect', 'roundRect', 'closePath']) {
    Path2D.prototype[m] = function (...args) { this._ops.push([m, args]); };
  }
  const canvasColorCache = new Map();
  function parseCanvasColor(v) {
    const key = String(v);
    let c = canvasColorCache.get(key);
    if (c === undefined) {
      c = uiLayer && uiLayer.parseColor ? uiLayer.parseColor(key) : null;
      if (canvasColorCache.size > 4096) canvasColorCache.clear();
      canvasColorCache.set(key, c);
    }
    return c;
  }
  function parseCanvasFont(text) {
    const s = String(text).trim();
    const m = /^((?:(?:italic|oblique|normal|small-caps|bold|bolder|lighter|[1-9]00|ultra-condensed|condensed|semi-condensed|semi-expanded|expanded)\s+)*)([\d.]+)(px|pt|em|rem|%)?(?:\s*\/\s*\S+)?\s+(.+)$/i.exec(s);
    if (!m) return null;
    const pre = m[1].toLowerCase();
    let size = parseFloat(m[2]);
    const unit = (m[3] || 'px').toLowerCase();
    if (unit === 'pt') size *= 4 / 3; else if (unit === 'em' || unit === 'rem') size *= 16; else if (unit === '%') size *= 0.16;
    const wm = /\b(bold|bolder|[1-9]00)\b/.exec(pre);
    const weight = !wm ? 400 : wm[1] === 'bold' || wm[1] === 'bolder' ? 700 : parseInt(wm[1], 10);
    return { size, weight, italic: /\b(italic|oblique)\b/.test(pre), family: m[4].trim() };
  }
  const defaultCanvasState = () => ({
    fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10,
    lineDashOffset: 0, dash: [], globalAlpha: 1, globalCompositeOperation: 'source-over', font: '10px sans-serif',
    textAlign: 'start', textBaseline: 'alphabetic', direction: 'ltr', shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)',
    shadowOffsetX: 0, shadowOffsetY: 0, imageSmoothingEnabled: true, imageSmoothingQuality: 'low', filter: 'none',
    letterSpacing: '0px', wordSpacing: '0px', fontKerning: 'auto', textRendering: 'auto', fontStretch: 'normal', fontVariantCaps: 'normal',
    m: [1, 0, 0, 1, 0, 0],
  });
  class CanvasRenderingContext2D {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this._id = nextCanvasId++;
      canvas._ntCanvasId = this._id;
      canvas._ntCanvasVersion = 0;
      this._opts = options;
      this._f = new Float32Array(4096);
      this._n = 0;          // floats used
      this._strings = [];
      this._stringIndex = new Map();
      this._s = defaultCanvasState();
      this._stack = [];
      this._sent = {};      // last state sent to the native side
      this._cx = 0; this._cy = 0; this._hasPoint = false; this._sx = 0; this._sy = 0;
      this._w = canvas.width; this._h = canvas.height;
      this._op(CV.RESET, [this._w, this._h]);
    }
    // ---- recording
    _op(op, args) {
      const need = this._n + 2 + args.length;
      if (need > this._f.length) {
        if (this._n > 2000000) this._flush();
        if (this._n + 2 + args.length > this._f.length) {
          const g = new Float32Array(Math.max(this._f.length * 2, this._n + 2 + args.length + 1024));
          g.set(this._f.subarray(0, this._n));
          this._f = g;
        }
      }
      const f = this._f;
      let o = this._n;
      f[o++] = op; f[o++] = args.length;
      for (let i = 0; i < args.length; i++) f[o++] = args[i];
      this._n = o;
      if (!dirtyCanvases.has(this)) dirtyCanvases.add(this);
    }
    _str(text) {
      const t = String(text);
      let i = this._stringIndex.get(t);
      if (i === undefined) { i = this._strings.length; this._strings.push(t.replace(/\u001f/g, ' ')); this._stringIndex.set(t, i); }
      return i;
    }
    _sizeCheck() {
      const c = this.canvas;
      if (c.width !== this._w || c.height !== this._h) this._reset();
    }
    _flush() {
      if (!this._n) return;
      if (nt.canvasCommands) nt.canvasCommands(this._id, this._w, this._h, this._f, this._n, this._strings.join('\u001f'));
      this._n = 0;
      this._strings = []; this._stringIndex.clear();
      this.canvas._ntCanvasVersion++;
      dirtyCanvases.delete(this);
      uiNotify('paint', this.canvas);
    }
    _reset() {
      this._n = 0; this._strings = []; this._stringIndex.clear();
      this._s = defaultCanvasState(); this._stack = []; this._sent = {};
      this._hasPoint = false;
      this._w = this.canvas.width; this._h = this.canvas.height;
      this._op(CV.RESET, [this._w, this._h]);
    }
    // device space
    _x(x, y) { const m = this._s.m; return m[0] * x + m[2] * y + m[4]; }
    _y(x, y) { const m = this._s.m; return m[1] * x + m[3] * y + m[5]; }
    _scale() { const m = this._s.m; return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 0; }
    _sendTransform() {
      const m = this._s.m, s = this._sent.m;
      if (s && s[0] === m[0] && s[1] === m[1] && s[2] === m[2] && s[3] === m[3] && s[4] === m[4] && s[5] === m[5]) return;
      this._sent.m = m.slice();
      this._op(CV.TRANSFORM, m);
    }
    _styleArgs(style) {
      if (style instanceof CanvasGradient) {
        const out = [style._kind, ...style._coords, style._stops.length];
        for (const [o, c] of style._stops) out.push(o, c[0], c[1], c[2], c[3]);
        return out;
      }
      if (style instanceof CanvasPattern) {
        warnOnce('canvas-pattern', 'Canvas 2D createPattern is drawn as a flat grey fill');
        return [0, 0.5, 0.5, 0.5, 1];
      }
      const c = parseCanvasColor(style) || [0, 0, 0, 1];
      return [0, c[0], c[1], c[2], c[3]];
    }
    _sendStyle(which) {
      const style = which === 'fill' ? this._s.fillStyle : this._s.strokeStyle;
      const key = which === 'fill' ? 'fs' : 'ss';
      if (style instanceof CanvasGradient) this._sendTransform(); // gradient coordinates are user space
      if (this._sent[key] === style && !(style instanceof CanvasGradient && this._sent[key + 'n'] !== style._stops.length)) return;
      this._sent[key] = style;
      if (style instanceof CanvasGradient) { this._sent[key + 'n'] = style._stops.length; this._sendTransform(); }
      this._op(which === 'fill' ? CV.FILL_STYLE : CV.STROKE_STYLE, this._styleArgs(style));
    }
    _sendAlpha() {
      const s = this._s;
      const comp = COMPOSITE[s.globalCompositeOperation] ?? 0;
      if (this._sent.alpha === s.globalAlpha && this._sent.comp === comp) return;
      this._sent.alpha = s.globalAlpha; this._sent.comp = comp;
      this._op(CV.ALPHA, [s.globalAlpha, comp]);
    }
    _sendLine() {
      const s = this._s, k = this._scale();
      const w = s.lineWidth * k;
      const cap = s.lineCap === 'round' ? 1 : s.lineCap === 'square' ? 2 : 0;
      const join = s.lineJoin === 'round' ? 1 : s.lineJoin === 'bevel' ? 2 : 0;
      const key = `${w}|${cap}|${join}|${s.miterLimit}|${s.dash.join(',')}|${s.lineDashOffset}|${k}`;
      if (this._sent.line === key) return;
      this._sent.line = key;
      this._op(CV.LINE, [w, cap, join, s.miterLimit]);
      this._op(CV.DASH, [s.lineDashOffset * k, s.dash.length, ...s.dash.map((d) => d * k)]);
    }
    _shadowWarn() { if (this._s.shadowBlur > 0 || this._s.shadowOffsetX || this._s.shadowOffsetY) { const c = parseCanvasColor(this._s.shadowColor); if (c && c[3] > 0) warnOnce('canvas-shadow', 'Canvas 2D shadows are not drawn yet'); } }
    // ---- state
    save() { const s = this._s; this._stack.push({ ...s, m: s.m.slice(), dash: s.dash.slice() }); this._op(CV.SAVE, []); }
    restore() { if (!this._stack.length) return; this._s = this._stack.pop(); this._op(CV.RESTORE, []); }
    reset() { this._reset(); }
    isContextLost() { return false; }
    getContextAttributes() { return { alpha: this._opts.alpha !== false, colorSpace: 'srgb', desynchronized: false, willReadFrequently: !!this._opts.willReadFrequently }; }
    // ---- transforms
    setTransform(a, b, c, d, e, f) {
      if (a && typeof a === 'object') { const m = a; this._s.m = [m.a ?? m.m11 ?? 1, m.b ?? m.m12 ?? 0, m.c ?? m.m21 ?? 0, m.d ?? m.m22 ?? 1, m.e ?? m.m41 ?? 0, m.f ?? m.m42 ?? 0]; return; }
      if (a === undefined) { this._s.m = [1, 0, 0, 1, 0, 0]; return; }
      this._s.m = [+a, +b, +c, +d, +e, +f];
    }
    resetTransform() { this._s.m = [1, 0, 0, 1, 0, 0]; }
    getTransform() { const [a, b, c, d, e, f] = this._s.m; return { a, b, c, d, e, f, m11: a, m12: b, m21: c, m22: d, m41: e, m42: f, is2D: true, isIdentity: a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0 }; }
    transform(a, b, c, d, e, f) {
      const m = this._s.m;
      this._s.m = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]];
    }
    translate(x, y) { this.transform(1, 0, 0, 1, +x, +y); }
    scale(x, y) { this.transform(+x, 0, 0, +y, 0, 0); }
    rotate(a) { const c = Math.cos(a), s = Math.sin(a); this.transform(c, s, -s, c, 0, 0); }
    // ---- paths (device space)
    beginPath() { this._op(CV.BEGIN, []); this._hasPoint = false; }
    _moveDev(x, y) { this._op(CV.MOVE, [x, y]); this._cx = x; this._cy = y; this._sx = x; this._sy = y; this._hasPoint = true; }
    _lineDev(x, y) { if (!this._hasPoint) { this._moveDev(x, y); return; } this._op(CV.LINE_TO, [x, y]); this._cx = x; this._cy = y; }
    moveTo(x, y) { if (!Number.isFinite(x) || !Number.isFinite(y)) return; this._moveDev(this._x(x, y), this._y(x, y)); }
    lineTo(x, y) { if (!Number.isFinite(x) || !Number.isFinite(y)) return; this._lineDev(this._x(x, y), this._y(x, y)); }
    closePath() { if (!this._hasPoint) return; this._op(CV.CLOSE, []); this._cx = this._sx; this._cy = this._sy; }
    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
      if (!this._hasPoint) this._moveDev(this._x(c1x, c1y), this._y(c1x, c1y));
      const X = this._x(x, y), Y = this._y(x, y);
      this._op(CV.BEZIER, [this._x(c1x, c1y), this._y(c1x, c1y), this._x(c2x, c2y), this._y(c2x, c2y), X, Y]);
      this._cx = X; this._cy = Y;
    }
    quadraticCurveTo(cx, cy, x, y) {
      if (!this._hasPoint) this._moveDev(this._x(cx, cy), this._y(cx, cy));
      const qx = this._x(cx, cy), qy = this._y(cx, cy), X = this._x(x, y), Y = this._y(x, y);
      const p0x = this._cx, p0y = this._cy;
      this._op(CV.BEZIER, [p0x + (2 / 3) * (qx - p0x), p0y + (2 / 3) * (qy - p0y), X + (2 / 3) * (qx - X), Y + (2 / 3) * (qy - Y), X, Y]);
      this._cx = X; this._cy = Y;
    }
    // Elliptical arc in user space -> cubic Béziers in device space.
    ellipse(x, y, rx, ry, rotation, a0, a1, ccw = false) {
      if (![x, y, rx, ry, rotation, a0, a1].every(Number.isFinite)) return;
      if (rx < 0 || ry < 0) throw new RangeError('The radius provided is negative.');
      const TAU = Math.PI * 2;
      let sweep = a1 - a0;
      if (!ccw) { if (sweep >= TAU) sweep = TAU; else { sweep %= TAU; if (sweep < 0) sweep += TAU; } }
      else { if (-sweep >= TAU) sweep = -TAU; else { sweep %= TAU; if (sweep > 0) sweep -= TAU; } }
      const cr = Math.cos(rotation), sr = Math.sin(rotation);
      const pt = (t) => { const ex = rx * Math.cos(t), ey = ry * Math.sin(t); const ux = x + ex * cr - ey * sr, uy = y + ex * sr + ey * cr; return [this._x(ux, uy), this._y(ux, uy)]; };
      const d = (t) => { const ex = -rx * Math.sin(t), ey = ry * Math.cos(t); const ux = ex * cr - ey * sr, uy = ex * sr + ey * cr; const m = this._s.m; return [m[0] * ux + m[2] * uy, m[1] * ux + m[3] * uy]; };
      const [sx, sy] = pt(a0);
      if (this._hasPoint) this._lineDev(sx, sy); else this._moveDev(sx, sy);
      const segs = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
      const step = sweep / segs, k = (4 / 3) * Math.tan(step / 4);
      let t = a0;
      for (let i = 0; i < segs; i++) {
        const t2 = t + step;
        const [p0x, p0y] = pt(t), [d0x, d0y] = d(t), [p3x, p3y] = pt(t2), [d3x, d3y] = d(t2);
        this._op(CV.BEZIER, [p0x + k * d0x, p0y + k * d0y, p3x - k * d3x, p3y - k * d3y, p3x, p3y]);
        this._cx = p3x; this._cy = p3y;
        t = t2;
      }
    }
    arc(x, y, r, a0, a1, ccw = false) { this.ellipse(x, y, r, r, 0, a0, a1, ccw); }
    arcTo(x1, y1, x2, y2, r) {
      if (![x1, y1, x2, y2, r].every(Number.isFinite)) return;
      if (!this._hasPoint) { this.moveTo(x1, y1); return; }
      // current point back into user space
      const m = this._s.m, det = m[0] * m[3] - m[1] * m[2];
      if (!det) return;
      const dx = this._cx - m[4], dy = this._cy - m[5];
      const x0 = (m[3] * dx - m[2] * dy) / det, y0 = (-m[1] * dx + m[0] * dy) / det;
      const v1x = x0 - x1, v1y = y0 - y1, v2x = x2 - x1, v2y = y2 - y1;
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
      const cross = v1x * v2y - v1y * v2x;
      if (!l1 || !l2 || !r || Math.abs(cross) < 1e-9) { this.lineTo(x1, y1); return; }
      const angle = Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2))));
      const tl = r / Math.tan(angle / 2);
      const t1x = x1 + v1x / l1 * tl, t1y = y1 + v1y / l1 * tl, t2x = x1 + v2x / l2 * tl, t2y = y1 + v2y / l2 * tl;
      const bis = r / Math.sin(angle / 2);
      const bx = v1x / l1 + v2x / l2, by = v1y / l1 + v2y / l2, bl = Math.hypot(bx, by);
      const cx = x1 + bx / bl * bis, cy = y1 + by / bl * bis;
      this.lineTo(t1x, t1y);
      this.arc(cx, cy, r, Math.atan2(t1y - cy, t1x - cx), Math.atan2(t2y - cy, t2x - cx), cross > 0);
    }
    rect(x, y, w, h) {
      if (![x, y, w, h].every(Number.isFinite)) return;
      this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath();
    }
    roundRect(x, y, w, h, radii = 0) {
      const list = Array.isArray(radii) ? radii : [radii];
      const rv = list.map((v) => (typeof v === 'object' && v ? Math.min(v.x ?? 0, v.y ?? 0) : +v || 0));
      const [tl, tr, br, bl] = rv.length === 1 ? [rv[0], rv[0], rv[0], rv[0]] : rv.length === 2 ? [rv[0], rv[1], rv[0], rv[1]] : rv.length === 3 ? [rv[0], rv[1], rv[2], rv[1]] : rv;
      const lim = (v) => Math.max(0, Math.min(v, Math.abs(w) / 2, Math.abs(h) / 2));
      const a = lim(tl), b = lim(tr), c = lim(br), d = lim(bl);
      this.moveTo(x + a, y);
      this.lineTo(x + w - b, y); if (b) this.arc(x + w - b, y + b, b, -Math.PI / 2, 0);
      this.lineTo(x + w, y + h - c); if (c) this.arc(x + w - c, y + h - c, c, 0, Math.PI / 2);
      this.lineTo(x + d, y + h); if (d) this.arc(x + d, y + h - d, d, Math.PI / 2, Math.PI);
      this.lineTo(x, y + a); if (a) this.arc(x + a, y + a, a, Math.PI, Math.PI * 1.5);
      this.closePath();
    }
    _withPath(path, fn) {
      if (!(path instanceof Path2D)) return false;
      this._op(CV.BEGIN, []); this._hasPoint = false;
      for (const [m, args] of path._ops) this[m](...args);
      fn();
      return true;
    }
    fill(a, b) {
      const path = a instanceof Path2D ? a : null;
      const rule = (path ? b : a) === 'evenodd' ? 1 : 0;
      const go = () => { this._shadowWarn(); this._sendAlpha(); this._sendStyle('fill'); this._op(CV.FILL, [rule]); };
      if (path) { this._sizeCheck(); this.save(); this._withPath(path, go); this.restore(); return; }
      this._sizeCheck(); go();
    }
    stroke(path) {
      const go = () => { this._shadowWarn(); this._sendAlpha(); this._sendStyle('stroke'); this._sendLine(); this._op(CV.STROKE, []); };
      if (path instanceof Path2D) { this._sizeCheck(); this.save(); this._withPath(path, go); this.restore(); return; }
      this._sizeCheck(); go();
    }
    clip(a, b) {
      const path = a instanceof Path2D ? a : null;
      const rule = (path ? b : a) === 'evenodd' ? 1 : 0;
      if (path) this._withPath(path, () => {});
      this._op(CV.CLIP, [rule]);
    }
    isPointInPath() { return false; }
    isPointInStroke() { return false; }
    // ---- rectangles
    _axisAligned() { const m = this._s.m; return m[1] === 0 && m[2] === 0; }
    _quad(x, y, w, h) { return [this._x(x, y), this._y(x, y), this._x(x + w, y), this._y(x + w, y), this._x(x + w, y + h), this._y(x + w, y + h), this._x(x, y + h), this._y(x, y + h)]; }
    fillRect(x, y, w, h) {
      if (![x, y, w, h].every(Number.isFinite) || !w || !h) return;
      this._sizeCheck(); this._shadowWarn(); this._sendAlpha(); this._sendStyle('fill');
      if (this._axisAligned()) {
        const x0 = this._x(x, y), y0 = this._y(x, y), x1 = this._x(x + w, y + h), y1 = this._y(x + w, y + h);
        this._op(CV.FILL_RECT, [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)]);
      } else this._op(CV.FILL_QUAD, this._quad(x, y, w, h));
    }
    strokeRect(x, y, w, h) {
      if (![x, y, w, h].every(Number.isFinite)) return;
      this._sizeCheck(); this._sendAlpha(); this._sendStyle('stroke'); this._sendLine();
      this._op(CV.STROKE_QUAD, this._quad(x, y, w, h));
    }
    clearRect(x, y, w, h) {
      if (![x, y, w, h].every(Number.isFinite)) return;
      this._sizeCheck();
      const q = this._quad(x, y, w, h);
      const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
      const x0 = Math.min(...xs), y0 = Math.min(...ys);
      this._op(CV.CLEAR_RECT, [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0]);
    }
    // ---- text
    _sendFont() {
      const s = this._s;
      if (this._sent.font !== s.font) {
        this._sent.font = s.font;
        const f = parseCanvasFont(s.font) || { size: 10, weight: 400, italic: false, family: 'sans-serif' };
        this._op(CV.FONT, [this._str(f.family), f.size, f.weight, f.italic ? 1 : 0]);
      }
      const align = s.textAlign === 'center' ? 1 : s.textAlign === 'right' || (s.textAlign === 'end' && s.direction !== 'rtl') || (s.textAlign === 'start' && s.direction === 'rtl') ? 2 : 0;
      const base = { alphabetic: 0, top: 1, middle: 2, bottom: 3, hanging: 4, ideographic: 5 }[s.textBaseline] ?? 0;
      if (this._sent.align !== align || this._sent.base !== base) { this._sent.align = align; this._sent.base = base; this._op(CV.TEXT_ALIGN, [align, base]); }
    }
    _text(text, x, y, maxWidth, stroke) {
      const t = String(text ?? '');
      if (!t || !Number.isFinite(x) || !Number.isFinite(y)) return;
      this._sizeCheck(); this._sendAlpha(); this._sendTransform(); this._sendFont();
      if (stroke) { this._sendStyle('stroke'); this._sendLine(); } else this._sendStyle('fill');
      this._op(CV.TEXT, [stroke ? 1 : 0, this._str(t), x, y, Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : 0]);
    }
    fillText(text, x, y, maxWidth) { this._text(text, x, y, maxWidth, false); }
    strokeText(text, x, y, maxWidth) { this._text(text, x, y, maxWidth, true); }
    measureText(text) {
      const f = parseCanvasFont(this._s.font) || { size: 10, weight: 400, italic: false, family: 'sans-serif' };
      const t = String(text ?? '');
      let width = nt.measureText ? nt.measureText(f.family, f.size, f.weight, f.italic, t) : -1;
      if (!(width >= 0)) width = t.length * f.size * 0.55;
      const asc = f.size * 0.8, desc = f.size * 0.2;
      const left = this._s.textAlign === 'center' ? width / 2 : this._s.textAlign === 'right' || this._s.textAlign === 'end' ? width : 0;
      return { width, actualBoundingBoxLeft: left, actualBoundingBoxRight: width - left, actualBoundingBoxAscent: asc, actualBoundingBoxDescent: desc,
        fontBoundingBoxAscent: f.size * 0.9, fontBoundingBoxDescent: f.size * 0.25, emHeightAscent: asc, emHeightDescent: desc, alphabeticBaseline: 0, hangingBaseline: asc * 0.8, ideographicBaseline: -desc };
    }
    // ---- images
    drawImage(image, ...a) {
      if (!image) return;
      let iw = image.naturalWidth || image.width || 0, ih = image.naturalHeight || image.height || 0;
      let kind = 0, ref = -1;
      const canvasSrc = image instanceof HTMLCanvasElement ? image : image._ntSource && image._ntSource.canvas ? image._ntSource.canvas : null;
      if (canvasSrc) {
        const c = canvasSrc._ctx2d;
        if (!c) return; // never drawn: transparent
        c._sizeCheck(); c._flush();
        kind = 1; ref = c._id; iw = canvasSrc.width; ih = canvasSrc.height;
      } else {
        const src = image._ntSource;
        if (!src) { warnOnce('canvas-image-src', 'Canvas 2D drawImage: this image source is not supported (only loaded images and canvases)'); return; }
        const key = imageKey(src);
        if (!key) return;
        ref = this._str(key);
      }
      if (!iw || !ih) return;
      let sx = 0, sy = 0, sw = iw, sh = ih, dx, dy, dw, dh;
      if (a.length >= 8) [sx, sy, sw, sh, dx, dy, dw, dh] = a;
      else if (a.length >= 4) [dx, dy, dw, dh] = a;
      else { [dx, dy] = a; dw = iw; dh = ih; }
      if (![sx, sy, sw, sh, dx, dy, dw, dh].every(Number.isFinite) || !dw || !dh || !sw || !sh) return;
      this._sizeCheck(); this._sendAlpha(); this._sendTransform();
      this._op(CV.IMAGE, [kind, ref, sx, sy, sw, sh, dx, dy, dw, dh, this._s.imageSmoothingEnabled ? 1 : 0]);
      if (kind === 1) this._flush(); // the source may change before the next flush
    }
    // ---- pixels
    createImageData(w, h) { if (w && typeof w === 'object') return new ImageData(w.width, w.height); return new ImageData(Math.abs(w | 0), Math.abs(h | 0)); }
    getImageData(x, y, w, h) {
      this._sizeCheck(); this._flush();
      const out = new ImageData(Math.abs(w | 0) || 1, Math.abs(h | 0) || 1);
      const px = nt.canvasRead ? nt.canvasRead(this._id, x | 0, y | 0, out.width, out.height) : null;
      if (px) out.data.set(new Uint8Array(px).subarray(0, out.data.length));
      else warnOnce('canvas-read', 'Canvas 2D getImageData returns transparent pixels in this engine build');
      return out;
    }
    putImageData(img, dx, dy, dirtyX = 0, dirtyY = 0, dirtyW = img.width, dirtyH = img.height) {
      if (!img || !img.data) return;
      this._sizeCheck(); this._flush();
      if (dirtyX || dirtyY || dirtyW !== img.width || dirtyH !== img.height) warnOnce('canvas-put-dirty', 'putImageData dirty rectangle is ignored (whole image is written)');
      const data = img.data instanceof Uint8Array ? img.data : new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
      if (nt.canvasWrite) nt.canvasWrite(this._id, this._w, this._h, dx | 0, dy | 0, img.width, img.height, data);
      this.canvas._ntCanvasVersion++;
      uiNotify('paint', this.canvas);
    }
    // ---- gradients / patterns
    createLinearGradient(x0, y0, x1, y1) { return new CanvasGradient(1, [x0, y0, x1, y1, 0, 0]); }
    createRadialGradient(x0, y0, r0, x1, y1, r1) { return new CanvasGradient(2, [x0, y0, r0, x1, y1, r1]); }
    createConicGradient(a, x, y) { warnOnce('canvas-conic', 'createConicGradient is drawn as a radial gradient'); return new CanvasGradient(2, [x, y, 0, x, y, 100]); }
    createPattern(image, repetition) { return new CanvasPattern(image, repetition); }
    setLineDash(list) { if (Array.isArray(list) && list.every((v) => Number.isFinite(v) && v >= 0)) this._s.dash = list.length % 2 ? [...list, ...list] : list.slice(); }
    getLineDash() { return this._s.dash.slice(); }
    drawFocusIfNeeded() {}
    scrollPathIntoView() {}
  }
  for (const k of Object.keys(defaultCanvasState())) {
    if (k === 'm' || k === 'dash') continue;
    Object.defineProperty(CanvasRenderingContext2D.prototype, k, {
      get() { return this._s[k]; },
      set(v) {
        if (k === 'fillStyle' || k === 'strokeStyle') { if (!(v instanceof CanvasGradient || v instanceof CanvasPattern) && !parseCanvasColor(v)) return; }
        else if (k === 'lineWidth' || k === 'miterLimit') { v = +v; if (!(v > 0) || !Number.isFinite(v)) return; }
        else if (k === 'globalAlpha') { v = +v; if (!(v >= 0 && v <= 1)) return; }
        else if (k === 'font') { if (!parseCanvasFont(v)) return; }
        else if (k === 'globalCompositeOperation' && !(v in COMPOSITE)) warnOnce(`canvas-comp-${v}`, `Canvas 2D globalCompositeOperation '${v}' is drawn as source-over`);
        this._s[k] = v;
      },
    });
  }
  // Images by bytes are registered once with the native image cache.
  const imageKeys = new WeakMap();
  let nextImageKey = 1;
  function imageKey(src) {
    if (src.path) return src.path;
    if (!src.bytes) return null;
    let key = imageKeys.get(src.bytes);
    if (!key) {
      key = `nt-bytes:${nextImageKey++}`;
      imageKeys.set(src.bytes, key);
      if (nt.registerImage) nt.registerImage(key, src.bytes);
    }
    return key;
  }
  function flushCanvases() { for (const c of [...dirtyCanvases]) { c._sizeCheck(); c._flush(); } }
  class HTMLImageElement extends HTMLElement {
    constructor(tag = 'img', ns) { super(tag, ns); this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; this.width = 0; this.height = 0; this.crossOrigin = null; this.decoding = 'auto'; }
    get src() { return this._src ? (/^(data|blob):/i.test(this._src) ? this._src : new URL(this._src, documentURL).href) : ''; }
    set src(v) {
      this._src = String(v);
      this.setAttribute('src', this._src);
      // Images in the game folder load (the UI layer draws them natively;
      // 3D textures stay untextured). Anything else fails like a broken image
      // so THREE.TextureLoader calls onError and the game keeps running.
      let info = null;
      this._ntSource = null;
      if (/^blob:/i.test(this._src)) {
        // URL.createObjectURL(blob): the bytes are already in memory
        const blob = blobStore.get(this._src);
        info = blob && uiLayer ? uiLayer.sniffImage(blob._bytes) : null;
        if (info) this._ntSource = { bytes: blob._bytes };
      } else {
        const path = /^data:/i.test(this._src) ? this._src : toGamePath(this._src);
        info = path && uiLayer ? uiLayer.imageSize(path) : null;
        if (info) this._ntSource = /^data:/i.test(path) ? { bytes: dataUrlBytes(path) } : { path };
      }
      if (!info) warnOnce(`image:${this._src.slice(0, 80)}`, `Image could not be loaded: ${this._src.slice(0, 120)}`);
      setTimeout(() => {
        this.complete = true;
        if (info) {
          this.naturalWidth = info.w; this.naturalHeight = info.h;
          if (!this.width) this.width = info.w;
          if (!this.height) this.height = info.h;
          this.dispatchEvent(new Event('load'));
        } else this.dispatchEvent(new Event('error'));
      }, 0);
    }
    decode() { return this.naturalWidth ? Promise.resolve() : Promise.reject(new Error('Image could not be decoded')); }
  }
  function dataUrlBytes(url) {
    const comma = url.indexOf(',');
    const meta = url.slice(5, comma), payload = url.slice(comma + 1);
    if (/;base64/i.test(meta)) {
      const bin = atob(payload.replace(/\s+/g, ''));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    let text = payload;
    try { text = decodeURIComponent(payload); } catch { /* raw */ }
    return new TextEncoder().encode(text);
  }
  // Decoded pixels live natively: an ImageBitmap only remembers where its
  // encoded bytes are ({bytes} | {path} | {rgba,w,h} | {canvas}).
  class ImageBitmap {
    constructor(width, height, source) { this.width = width; this.height = height; this._ntSource = source; }
    // The engine may upload lazily (first render), so the bytes stay available.
    close() { this._closed = true; }
  }
  function createImageBitmap(source, ...rest) {
    return new Promise((resolve, reject) => {
      const fail = (why) => { const e = new Error(`createImageBitmap: ${why}`); e.name = 'InvalidStateError'; reject(e); };
      if (rest.length >= 4 && typeof rest[0] === 'number') unsupported('createImageBitmap crop rectangle', 'the whole image is used');
      try {
        if (source instanceof Blob) {
          const info = uiLayer ? uiLayer.sniffImage(source._bytes) : null;
          if (!info || !info.w || !info.h) { fail('the image data could not be decoded'); return; }
          resolve(new ImageBitmap(info.w, info.h, { bytes: source._bytes }));
        } else if (source instanceof HTMLImageElement) {
          if (!source.naturalWidth || !source._ntSource) { fail('the image is not loaded'); return; }
          resolve(new ImageBitmap(source.naturalWidth, source.naturalHeight, source._ntSource));
        } else if (source instanceof ImageBitmap) {
          resolve(new ImageBitmap(source.width, source.height, source._ntSource));
        } else if (source instanceof HTMLCanvasElement) {
          resolve(new ImageBitmap(source.width, source.height, { canvas: source }));
        } else if (source && source.data && source.width && source.height) { // ImageData
          resolve(new ImageBitmap(source.width, source.height, { rgba: source.data, w: source.width, h: source.height }));
        } else fail('unsupported source');
      } catch (e) { reject(e); }
    });
  }
  class HTMLMediaElement extends HTMLElement {
    play() { unsupported(`<${this.localName}> playback`); return Promise.resolve(); }
    pause() {}
    load() {}
    canPlayType() { return ''; }
  }

  const ELEMENT_CLASSES = { canvas: HTMLCanvasElement, img: HTMLImageElement, input: HTMLInputElement, button: HTMLButtonElement, script: HTMLScriptElement, video: HTMLMediaElement, audio: HTMLMediaElement, textarea: HTMLInputElement, select: HTMLInputElement };

  class Document extends Node {
    constructor() {
      super(9, '#document');
      this.ownerDocument = null;
      this.readyState = 'loading';
      this.visibilityState = 'visible';
      this.hidden = false;
      this.pointerLockElement = null;
      this.fullscreenElement = null;
      this.cookie = '';
      this.referrer = '';
      this.characterSet = 'UTF-8';
      this.compatMode = 'CSS1Compat';
      this.fonts = { ready: Promise.resolve(), add() {}, load: () => Promise.resolve([]), check: () => true, addEventListener() {} };
      this.defaultView = null;
      this.activeElement = null;
    }
    get documentElement() { return this.childNodes.find((n) => n.nodeType === 1) || null; }
    get head() { return this.documentElement && this.documentElement.children.find((e) => e.localName === 'head') || null; }
    get body() { return this.documentElement && this.documentElement.children.find((e) => e.localName === 'body') || null; }
    get title() { const t = this.querySelector('title'); return t ? t.textContent.trim() : ''; }
    set title(v) {
      let t = this.querySelector('title');
      if (!t) { t = this.createElement('title'); this.head && this.head.appendChild(t); }
      t.textContent = String(v);
      nt.setTitle(String(v));
    }
    get location() { return location; }
    get URL() { return documentURL; }
    get baseURI() { return documentURL; }
    get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
    createElement(tag) {
      const lower = String(tag).toLowerCase();
      const Cls = ELEMENT_CLASSES[lower] || HTMLElement;
      const el = new Cls(lower);
      el.ownerDocument = this;
      return el;
    }
    createElementNS(ns, tag) { const el = this.createElement(tag); el.namespaceURI = ns; return el; }
    createTextNode(t) { const n = new Text(t); n.ownerDocument = this; return n; }
    createComment(t) { return new Comment(t); }
    createDocumentFragment() { return new DocumentFragment(); }
    createTreeWalker(root, whatToShow, filter) { return new TreeWalker(root, whatToShow, filter); }
    createNodeIterator(root, whatToShow, filter) { return new NodeIterator(root, whatToShow, filter); }
    createEvent() { return new Event(''); }
    getElementById(id) { return findFirst(this, (e) => e.getAttribute('id') === id); }
    querySelector(s) { return querySelectorAll(this, s)[0] || null; }
    querySelectorAll(s) { return querySelectorAll(this, s); }
    getElementsByTagName(t) { return querySelectorAll(this, t); }
    getElementsByClassName(c) { return querySelectorAll(this, c.split(/\s+/).filter(Boolean).map((x) => '.' + x).join('')); }
    getElementsByName(n) { return querySelectorAll(this, `[name="${n}"]`); }
    hasFocus() { return true; }
    exitPointerLock() {}
    exitFullscreen() { return Promise.resolve(); }
    elementFromPoint(x, y) { return (uiLayer && uiLayer.hitTest(x, y)) || this.querySelector('canvas') || this.body; }
    elementsFromPoint(x, y) { const e = this.elementFromPoint(x, y); const out = []; for (let n = e; n && n.nodeType === 1; n = n.parentNode) out.push(n); return out; }
    execCommand() { return false; }
    _shallowClone() { return new Document(); }
  }
  function findFirst(root, pred) {
    for (const c of root.childNodes) {
      if (c.nodeType !== 1) continue;
      if (pred(c)) return c;
      const hit = findFirst(c, pred);
      if (hit) return hit;
    }
    return null;
  }

  // ---- selectors: tag, #id, .class, [attr], [attr=v], *, descendant ' ', child '>', groups ','
  function parseCompound(text) {
    const c = { tag: null, id: null, classes: [], attrs: [], pseudo: [] };
    const re = /(\*)|([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]|:([\w-]+)(?:\(([^)]*)\))?/y;
    let m;
    while (re.lastIndex < text.length && (m = re.exec(text))) {
      if (m[2]) c.tag = m[2].toLowerCase();
      else if (m[3]) c.id = m[3];
      else if (m[4]) c.classes.push(m[4]);
      else if (m[5]) c.attrs.push({ name: m[5].toLowerCase(), op: m[6], value: m[7] ?? m[8] ?? m[9] });
      else if (m[10]) c.pseudo.push({ name: m[10], arg: m[11] });
    }
    if (re.lastIndex !== text.length && text.length) throw new SyntaxError(`Unsupported selector: ${text}`);
    return c;
  }
  function parseSelectorGroups(selector) {
    return String(selector).split(',').map((g) => {
      const parts = [], tokens = g.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
      let combinator = ' ';
      for (const t of tokens) {
        if (t === '>') { combinator = '>'; continue; }
        parts.push({ combinator, compound: parseCompound(t) });
        combinator = ' ';
      }
      return parts;
    }).filter((g) => g.length);
  }
  function matchCompound(el, c) {
    if (el.nodeType !== 1) return false;
    if (c.tag && el.localName !== c.tag) return false;
    if (c.id && el.getAttribute('id') !== c.id) return false;
    for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
    for (const a of c.attrs) {
      const v = el.getAttribute(a.name);
      if (v === null) return false;
      if (!a.op) continue;
      if (a.op === '=' && v !== a.value) return false;
      if (a.op === '~=' && !v.split(/\s+/).includes(a.value)) return false;
      if (a.op === '^=' && !v.startsWith(a.value)) return false;
      if (a.op === '$=' && !v.endsWith(a.value)) return false;
      if (a.op === '*=' && !v.includes(a.value)) return false;
      if (a.op === '|=' && v !== a.value && !v.startsWith(a.value + '-')) return false;
    }
    for (const p of c.pseudo) {
      if (p.name === 'first-child' && el.parentNode && el.parentNode.children[0] !== el) return false;
      if (p.name === 'last-child' && el.parentNode && el.parentNode.children.at(-1) !== el) return false;
      if (p.name === 'not' && el.matches(p.arg)) return false;
      if (p.name === 'checked' && !el.checked) return false;
      if (p.name === 'disabled' && !el.disabled) return false;
    }
    return true;
  }
  function matchComplex(el, parts, index = parts.length - 1) {
    if (!matchCompound(el, parts[index].compound)) return false;
    if (index === 0) return true;
    const comb = parts[index].combinator;
    if (comb === '>') return !!el.parentNode && el.parentNode.nodeType === 1 && matchComplex(el.parentNode, parts, index - 1);
    for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) if (matchComplex(p, parts, index - 1)) return true;
    return false;
  }
  function querySelectorAll(root, selector) {
    const groups = parseSelectorGroups(selector), out = [];
    (function walk(node) {
      for (const c of node.childNodes) {
        if (c.nodeType !== 1) continue;
        if (groups.some((g) => matchComplex(c, g))) out.push(c);
        walk(c);
      }
    })(root);
    out.item = (i) => out[i] || null;
    return out;
  }

  // ---- HTML parsing (tolerant, enough for game shells)
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', middot: '·', hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»', deg: '°', times: '×' };
  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e] ?? m;
    });
  }
  const IMPLIED_END = { p: new Set(['p', 'div', 'ul', 'ol', 'table', 'section', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'footer', 'main', 'nav', 'form', 'pre']), li: new Set(['li']), option: new Set(['option']), tr: new Set(['tr']), td: new Set(['td', 'th', 'tr']), th: new Set(['td', 'th', 'tr']) };
  function parseInto(html, root) {
    let i = 0;
    const stack = [root];
    const top = () => stack[stack.length - 1];
    const attrRe = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    while (i < html.length) {
      const lt = html.indexOf('<', i);
      if (lt < 0) { top().appendChild(new Text(decodeEntities(html.slice(i)))); break; }
      if (lt > i) top().appendChild(new Text(decodeEntities(html.slice(i, lt))));
      if (html.startsWith('<!--', lt)) {
        const end = html.indexOf('-->', lt + 4);
        top().appendChild(new Comment(html.slice(lt + 4, end < 0 ? html.length : end)));
        i = end < 0 ? html.length : end + 3; continue;
      }
      if (html[lt + 1] === '!' || html[lt + 1] === '?') { const end = html.indexOf('>', lt); i = end < 0 ? html.length : end + 1; continue; }
      if (html[lt + 1] === '/') {
        const end = html.indexOf('>', lt);
        const name = html.slice(lt + 2, end < 0 ? html.length : end).trim().toLowerCase();
        i = end < 0 ? html.length : end + 1;
        for (let s = stack.length - 1; s > 0; s--) if (stack[s].localName === name) { stack.length = s; break; }
        continue;
      }
      const tagMatch = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(lt, lt + 64));
      if (!tagMatch) { top().appendChild(new Text('<')); i = lt + 1; continue; }
      const name = tagMatch[1].toLowerCase();
      // Find end of tag, honouring quoted attribute values.
      let j = lt + tagMatch[0].length, quote = null;
      for (; j < html.length; j++) {
        const ch = html[j];
        if (quote) { if (ch === quote) quote = null; } else if (ch === '"' || ch === "'") quote = ch; else if (ch === '>') break;
      }
      const attrText = html.slice(lt + tagMatch[0].length, j);
      const selfClosing = /\/\s*$/.test(attrText);
      i = j + 1;
      const implied = IMPLIED_END[top().localName];
      if (implied && implied.has(name)) stack.pop();
      const el = document.createElement(name);
      attrRe.lastIndex = 0;
      let a;
      while ((a = attrRe.exec(attrText.replace(/\/\s*$/, '')))) el.setAttribute(a[1], decodeEntities(a[2] ?? a[3] ?? a[4] ?? ''));
      top().appendChild(el);
      if (RAW_TAGS.has(name)) {
        const close = html.toLowerCase().indexOf(`</${name}`, i);
        const raw = html.slice(i, close < 0 ? html.length : close);
        if (raw) el.appendChild(new Text(name === 'script' || name === 'style' ? raw : decodeEntities(raw)));
        const gt = close < 0 ? html.length : html.indexOf('>', close);
        i = gt < 0 ? html.length : gt + 1;
        continue;
      }
      if (!VOID_TAGS.has(name) && !selfClosing) stack.push(el);
    }
  }
  function parseHTMLFragment(html) { const f = new DocumentFragment(); f.ownerDocument = document; parseInto(html, f); return f; }
  function parseDocument(html) {
    for (const c of document.childNodes.slice()) document.removeChild(c);
    const frag = parseHTMLFragment(html);
    let htmlEl = frag.children.find((e) => e.localName === 'html');
    if (!htmlEl) { htmlEl = document.createElement('html'); htmlEl.appendChild(frag); }
    document.appendChild(htmlEl);
    let head = htmlEl.children.find((e) => e.localName === 'head');
    let body = htmlEl.children.find((e) => e.localName === 'body');
    if (!head) { head = document.createElement('head'); htmlEl.insertBefore(head, htmlEl.firstChild); }
    if (!body) {
      body = document.createElement('body');
      for (const c of htmlEl.childNodes.slice()) if (c !== head) body.appendChild(c);
      htmlEl.appendChild(body);
    }
    // Head-only elements that were written in the body stay where they are.
    document.activeElement = body;
  }
  function serialize(node) {
    if (node.nodeType === 3) return node.data.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    if (node.nodeType === 8) return `<!--${node.data}-->`;
    if (node.nodeType !== 1) return node.childNodes.map(serialize).join('');
    const attrs = [...node._attrs].map(([k, v]) => ` ${k}="${v.replace(/"/g, '&quot;')}"`).join('');
    if (VOID_TAGS.has(node.localName)) return `<${node.localName}${attrs}>`;
    return `<${node.localName}${attrs}>${node.childNodes.map(serialize).join('')}</${node.localName}>`;
  }
  class DOMParser {
    parseFromString(text, type) {
      if (type !== 'text/html') unsupported(`DOMParser(${type})`);
      const doc = new Document();
      const frag = parseHTMLFragment(String(text));
      doc.appendChild(frag.children.find((e) => e.localName === 'html') || frag);
      return doc;
    }
  }

  // ------------------------------------------------------ timers & frames
  let timerSeq = 0;
  const timers = new Map();
  function setTimeout(fn, delay = 0, ...args) {
    const id = ++timerSeq;
    timers.set(id, { fn, args, due: state.now + Math.max(0, Number(delay) || 0), interval: null, seq: id });
    return id;
  }
  function setInterval(fn, delay = 0, ...args) {
    const id = ++timerSeq, interval = Math.max(1, Number(delay) || 0);
    timers.set(id, { fn, args, due: state.now + interval, interval, seq: id });
    return id;
  }
  function clearTimeout(id) { timers.delete(id); }
  let rafSeq = 0;
  let rafCallbacks = new Map();
  function requestAnimationFrame(cb) { const id = ++rafSeq; rafCallbacks.set(id, cb); return id; }
  function cancelAnimationFrame(id) { rafCallbacks.delete(id); }
  function runTimers() {
    // Run every timer that is due, in due-time order; new zero-delay timers
    // created during this pass run on the next frame (like a browser task).
    const due = [...timers.entries()].filter(([, t]) => t.due <= state.now).sort((a, b) => a[1].due - b[1].due || a[1].seq - b[1].seq);
    for (const [id, t] of due) {
      if (!timers.has(id)) continue;
      if (t.interval === null) timers.delete(id); else t.due = Math.max(t.due + t.interval, state.now);
      try { typeof t.fn === 'function' ? t.fn(...t.args) : (0, eval)(String(t.fn)); } catch (e) { reportError('timer', e); }
    }
  }

  // ------------------------------------------------------------- fetch
  class Headers {
    constructor(init) { this._m = new Map(); if (init) for (const [k, v] of (init instanceof Headers ? init._m : Symbol.iterator in init ? init : Object.entries(init))) this._m.set(String(k).toLowerCase(), String(v)); }
    get(k) { return this._m.get(String(k).toLowerCase()) ?? null; }
    set(k, v) { this._m.set(String(k).toLowerCase(), String(v)); }
    append(k, v) { this.set(k, v); }
    has(k) { return this._m.has(String(k).toLowerCase()); }
    delete(k) { this._m.delete(String(k).toLowerCase()); }
    forEach(fn) { for (const [k, v] of this._m) fn(v, k, this); }
    entries() { return this._m.entries(); }
    [Symbol.iterator]() { return this._m.entries(); }
  }
  class Blob {
    constructor(parts = [], options = {}) {
      const chunks = parts.map((p) => (typeof p === 'string' ? new TextEncoder().encode(p) : p instanceof ArrayBuffer ? new Uint8Array(p) : p instanceof Blob ? p._bytes : new Uint8Array(p.buffer, p.byteOffset, p.byteLength)));
      const size = chunks.reduce((n, c) => n + c.length, 0);
      this._bytes = new Uint8Array(size);
      let o = 0; for (const c of chunks) { this._bytes.set(c, o); o += c.length; }
      this.type = options.type || '';
    }
    get size() { return this._bytes.length; }
    arrayBuffer() { return Promise.resolve(this._bytes.slice().buffer); }
    text() { return Promise.resolve(new TextDecoder().decode(this._bytes)); }
    slice(a, b, type) { const blob = new Blob([], { type }); blob._bytes = this._bytes.slice(a, b); return blob; }
    stream() { return new ReadableStream({ _ntBytes: Promise.resolve(this._bytes) }); }
    bytes() { return Promise.resolve(this._bytes.slice()); }
  }
  // ---- minimal streams: enough for blob.stream().pipeThrough(new DecompressionStream('gzip'))
  // and new Response(stream).arrayBuffer() / stream.getReader().
  class ReadableStream {
    constructor(source) {
      // Internal form: whole payload as a promise of Uint8Array.
      if (source && source._ntBytes) { this._ntBytes = source._ntBytes; return; }
      const chunks = [];
      let done, fail;
      this._ntBytes = new Promise((res, rej) => { done = res; fail = rej; });
      const controller = {
        enqueue: (c) => chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c.buffer || c)),
        close: () => done(concatBytes(chunks)), error: (e) => fail(e), desiredSize: 1,
      };
      Promise.resolve().then(async () => {
        try {
          if (source && source.start) await source.start(controller);
          if (source && source.pull) { let guard = 0; while (!controller._closed && guard++ < 1e6) { const before = chunks.length; await source.pull(controller); if (chunks.length === before) break; } }
          if (!source || (!source.pull && !source.start)) controller.close();
        } catch (e) { fail(e); }
      });
      const close = controller.close; controller.close = () => { controller._closed = true; close(); };
    }
    pipeThrough(transform) { return transform._ntTransform(this); }
    pipeTo(dest) { return this._ntBytes.then((b) => dest.write && dest.write(b)).then(() => dest.close && dest.close()); }
    getReader() {
      let sent = false;
      return {
        read: () => (sent ? Promise.resolve({ done: true, value: undefined }) : this._ntBytes.then((value) => { sent = true; return { done: false, value }; })),
        releaseLock() {}, cancel: () => Promise.resolve(), closed: Promise.resolve(),
      };
    }
    cancel() { return Promise.resolve(); }
    tee() { return [new ReadableStream({ _ntBytes: this._ntBytes }), new ReadableStream({ _ntBytes: this._ntBytes })]; }
    get locked() { return false; }
  }
  function concatBytes(chunks) {
    const size = chunks.reduce((n, c) => n + c.length, 0), out = new Uint8Array(size);
    let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  // RFC 1951 inflate (+ zlib / gzip wrappers), pure JS.
  function inflateRaw(src, start = 0) {
    let pos = start, bitBuf = 0, bitCnt = 0, out = new Uint8Array(Math.max(1024, src.length * 4)), outLen = 0;
    const need = (n) => { while (bitCnt < n) { if (pos >= src.length) throw new Error('inflate: unexpected end of data'); bitBuf |= src[pos++] << bitCnt; bitCnt += 8; } };
    const bits = (n) => { need(n); const v = bitBuf & ((1 << n) - 1); bitBuf >>>= n; bitCnt -= n; return v; };
    const ensure = (n) => { if (outLen + n > out.length) { const bigger = new Uint8Array(Math.max(out.length * 2, outLen + n)); bigger.set(out.subarray(0, outLen)); out = bigger; } };
    function build(lengths) {
      const counts = new Uint16Array(16), offs = new Uint16Array(16);
      for (const l of lengths) counts[l]++;
      counts[0] = 0;
      for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
      const symbols = new Uint16Array(lengths.length);
      for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
      return { counts, symbols };
    }
    function decode(t) {
      let code = 0, first = 0, index = 0;
      for (let len = 1; len < 16; len++) {
        code |= bits(1);
        const count = t.counts[len];
        if (code - count < first) return t.symbols[index + (code - first)];
        index += count; first += count; first <<= 1; code <<= 1;
      }
      throw new Error('inflate: bad Huffman code');
    }
    const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    let fixedL = null, fixedD = null;
    let final = 0;
    while (!final) {
      final = bits(1);
      const type = bits(2);
      if (type === 0) {
        bitBuf = 0; bitCnt = 0;
        if (pos + 4 > src.length) throw new Error('inflate: truncated stored block');
        const len = src[pos] | (src[pos + 1] << 8); pos += 4;
        ensure(len); out.set(src.subarray(pos, pos + len), outLen); outLen += len; pos += len;
        continue;
      }
      let lt, dt;
      if (type === 1) {
        if (!fixedL) {
          const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
          fixedL = build(l); fixedD = build(new Uint8Array(30).fill(5));
        }
        lt = fixedL; dt = fixedD;
      } else if (type === 2) {
        const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
        const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[ORDER[i]] = bits(3);
        const ct = build(cl), lengths = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const sym = decode(ct);
          if (sym < 16) lengths[i++] = sym;
          else if (sym === 16) { const prev = lengths[i - 1]; for (let r = 3 + bits(2); r > 0; r--) lengths[i++] = prev; }
          else if (sym === 17) i += 3 + bits(3);
          else i += 11 + bits(7);
        }
        lt = build(lengths.subarray(0, hlit)); dt = build(lengths.subarray(hlit));
      } else throw new Error('inflate: invalid block type');
      for (;;) {
        const sym = decode(lt);
        if (sym < 256) { ensure(1); out[outLen++] = sym; }
        else if (sym === 256) break;
        else {
          const li = sym - 257, len = LBASE[li] + bits(LEXT[li]);
          const di = decode(dt), dist = DBASE[di] + bits(DEXT[di]);
          if (dist > outLen) throw new Error('inflate: distance too far back');
          ensure(len);
          for (let k = 0; k < len; k++, outLen++) out[outLen] = out[outLen - dist];
        }
      }
    }
    return { bytes: out.slice(0, outLen), end: pos };
  }
  function gunzip(src) {
    const chunks = [];
    let pos = 0;
    while (pos + 10 <= src.length && src[pos] === 0x1f && src[pos + 1] === 0x8b) {
      const flags = src[pos + 3];
      let p = pos + 10;
      if (flags & 4) p += 2 + (src[p] | (src[p + 1] << 8));
      if (flags & 8) while (src[p++] !== 0);
      if (flags & 16) while (src[p++] !== 0);
      if (flags & 2) p += 2;
      const r = inflateRaw(src, p);
      chunks.push(r.bytes);
      pos = r.end + 8; // CRC32 + ISIZE
    }
    if (!chunks.length) throw new TypeError('DecompressionStream: not gzip data');
    return concatBytes(chunks);
  }
  class DecompressionStream {
    constructor(format) {
      this.format = String(format);
      if (!['gzip', 'deflate', 'deflate-raw'].includes(this.format)) throw new TypeError(`Unsupported compression format: ${format}`);
    }
    _ntTransform(readable) {
      const fmt = this.format;
      return new ReadableStream({ _ntBytes: readable._ntBytes.then((b) => (fmt === 'gzip' ? gunzip(b) : fmt === 'deflate' ? inflateRaw(b, 2).bytes : inflateRaw(b).bytes)) });
    }
  }
  class CompressionStream {
    constructor(format) { this.format = format; }
    _ntTransform() { unsupported('CompressionStream', 'compressing data in the engine'); return new ReadableStream({ _ntBytes: Promise.reject(new TypeError('CompressionStream is not supported yet')) }); }
  }

  class File extends Blob { constructor(parts, name, o = {}) { super(parts, o); this.name = name; this.lastModified = o.lastModified || 0; } }
  class Response {
    constructor(body = null, init = {}) {
      this._body = body; this.status = init.status ?? 200; this.statusText = init.statusText ?? 'OK';
      this.ok = this.status >= 200 && this.status < 300; this.headers = new Headers(init.headers); this.url = init.url || '';
      this.redirected = false; this.type = 'basic'; this.bodyUsed = false;
    }
    // response.body as a stream (used for fetch(...).body.pipeThrough(...)).
    get body() {
      const b = this._body;
      if (b === null || b === undefined) return null;
      if (b._ntBytes) return b;
      if (!this._stream) this._stream = new ReadableStream({ _ntBytes: Promise.resolve().then(() => this._bytes()) });
      return this._stream;
    }
    _bytes() {
      this.bodyUsed = true;
      const b = this._body;
      if (b === null) return new Uint8Array(0);
      if (typeof b === 'string') return new TextEncoder().encode(b);
      if (b instanceof ArrayBuffer) return new Uint8Array(b);
      if (b instanceof Blob) return b._bytes;
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    }
    _bytesAsync() {
      if (this._body && this._body._ntBytes) { this.bodyUsed = true; return this._body._ntBytes; }
      try { return Promise.resolve(this._bytes()); } catch (e) { return Promise.reject(e); }
    }
    arrayBuffer() { return this._bytesAsync().then((u) => (u.byteOffset === 0 && u.byteLength === u.buffer.byteLength ? u.buffer : u.slice().buffer)); }
    bytes() { return this._bytesAsync().then((u) => u.slice()); }
    text() { if (typeof this._body === 'string') { this.bodyUsed = true; return Promise.resolve(this._body); } return this._bytesAsync().then((u) => new TextDecoder().decode(u)); }
    json() { return this.text().then(JSON.parse); }
    blob() { return this._bytesAsync().then((u) => new Blob([u], { type: this.headers.get('content-type') || '' })); }
    clone() { return new Response(this._body, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url }); }
  }
  class Request {
    constructor(input, init = {}) {
      this.url = input instanceof Request ? input.url : String(input);
      this.method = (init.method || 'GET').toUpperCase(); this.headers = new Headers(init.headers);
      this.credentials = init.credentials || 'same-origin'; this.signal = init.signal || null; this.mode = init.mode || 'cors';
    }
  }
  const MIME = { json: 'application/json', js: 'text/javascript', mjs: 'text/javascript', html: 'text/html', css: 'text/css', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', glb: 'model/gltf-binary', gltf: 'model/gltf+json', wav: 'audio/wav' };
  function fetch(input, init = {}) {
    return new Promise((resolve, reject) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') { reject(new TypeError(`fetch: ${method} is not supported offline`)); return; }
      if (url.startsWith('blob:')) {
        const blob = blobStore.get(url);
        if (blob) resolve(new Response(blob, { url })); else reject(new TypeError(`fetch: unknown blob ${url}`));
        return;
      }
      if (url.startsWith('data:')) {
        const m = /^data:([^,;]*)(;base64)?,(.*)$/s.exec(url);
        if (!m) { reject(new TypeError('fetch: bad data URL')); return; }
        const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
        const bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 255;
        resolve(new Response(bytes, { url, headers: { 'content-type': m[1] || 'text/plain' } }));
        return;
      }
      let path;
      try { path = toGamePath(url); } catch (e) { reject(e); return; }
      if (path === null) { reject(new TypeError(`fetch: network access is disabled in NativeThreeBridge (${url})`)); return; }
      try {
        const data = nt.readBinary(path);
        const ext = path.split('.').pop().toLowerCase();
        resolve(new Response(method === 'HEAD' ? null : data, { url: `${GAME_ORIGIN}/${path}`, headers: { 'content-type': MIME[ext] || 'application/octet-stream', 'content-length': String(data.byteLength) } }));
      } catch (e) {
        resolve(new Response(String(e && e.message || e), { status: 404, statusText: 'Not Found', url }));
      }
    });
  }
  class XMLHttpRequest extends EventTarget {
    constructor() { super(); this.readyState = 0; this.status = 0; this.response = null; this.responseText = ''; this.responseType = ''; this.timeout = 0; this.withCredentials = false; this.upload = new EventTarget(); }
    open(method, url) { this._method = method; this._url = url; this.readyState = 1; }
    setRequestHeader() {}
    overrideMimeType() {}
    getResponseHeader() { return null; }
    getAllResponseHeaders() { return ''; }
    abort() {}
    send() {
      fetch(this._url, { method: this._method }).then(async (r) => {
        this.status = r.status;
        if (this.responseType === 'arraybuffer') this.response = await r.arrayBuffer();
        else if (this.responseType === 'json') { this.responseText = await r.text(); try { this.response = JSON.parse(this.responseText); } catch { this.response = null; } }
        else if (this.responseType === 'blob') this.response = await r.blob();
        else { this.responseText = await r.text(); this.response = this.responseText; }
        this.readyState = 4;
        this.dispatchEvent(new Event('readystatechange'));
        this.dispatchEvent(new Event(r.ok ? 'load' : 'error'));
        this.dispatchEvent(new Event('loadend'));
      }, () => { this.readyState = 4; this.dispatchEvent(new Event('error')); this.dispatchEvent(new Event('loadend')); });
    }
  }

  // ------------------------------------------------------------ storage
  const storageError = (message, name) => Object.assign(new Error(message), { name });
  const persistentStorage = typeof nt.storageRead === 'function';
  const storageState = (name) => nt.storageRead(name) ?? { revision: 0 };
  const commitStorage = (name, state) => {
    const revision = state.revision;
    nt.storageWrite(name, { ...state, revision: revision + 1 }, revision);
  };

  // Native, per-webapp persistence for out-of-line string keys. Run requests
  // as tasks so saves and their Promise continuations don't run inside input.
  function openDatabase(name, version) {
    name = String(name);
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw new TypeError('Invalid database version');
    const key = 'idb:' + name;
    const request = new EventTarget();
    request.result = undefined;
    request.error = null;
    setTimeout(() => {
      try {
        const state = storageState(key);
        const oldVersion = state.version ?? 0;
        const target = version ?? (oldVersion || 1);
        if (target < oldVersion) throw storageError('Database version is newer', 'VersionError');
        state.version = target;
        state.stores ??= new Map();
        let upgrading = target > oldVersion, closed = false;
        const db = Object.assign(new EventTarget(), {
          name, version: target,
          objectStoreNames: { contains: (store) => state.stores.has(String(store)) },
          createObjectStore(store, options) {
            if (!upgrading) throw storageError('Upgrade required', 'InvalidStateError');
            store = String(store);
            if (options?.keyPath != null || options?.autoIncrement) throw storageError('Inline keys are unavailable', 'NotSupportedError');
            if (state.stores.has(store)) throw storageError('Store exists', 'ConstraintError');
            state.stores.set(store, new Map());
            return { name: store };
          },
          transaction(store, mode = 'readonly') {
            if (closed || upgrading) throw storageError('Database is unavailable', 'InvalidStateError');
            const names = (Array.isArray(store) ? store : [store]).map(String);
            if (!names.length || names.some((name) => !state.stores.has(name))) throw storageError('Store is unavailable', 'NotFoundError');
            if (mode !== 'readonly' && mode !== 'readwrite') throw new TypeError('Invalid transaction mode');
            return storageTransaction(key, target, names, mode);
          },
          close() { closed = true; },
        });
        request.result = db;
        if (upgrading) {
          request.dispatchEvent(Object.assign(new Event('upgradeneeded'), { oldVersion, newVersion: target }));
          commitStorage(key, state);
          upgrading = false;
        }
      } catch (error) {
        request.error = error;
        request.dispatchEvent(new Event('error'));
        return;
      }
      request.dispatchEvent(new Event('success'));
    }, 0);
    return request;
  }

  function storageTransaction(key, version, names, mode) {
    let active = true, aborted = false;
    const jobs = [];
    const tx = Object.assign(new EventTarget(), {
      error: null, mode,
      abort() {
        if (!active) throw storageError('Transaction is inactive', 'InvalidStateError');
        aborted = true;
      },
      objectStore(name) {
        name = String(name);
        if (!names.includes(name)) throw storageError('Store is unavailable', 'NotFoundError');
        function enqueue(action, key, value) {
          if (!active || aborted) throw storageError('Transaction is inactive', 'TransactionInactiveError');
          if (action !== 'get' && mode !== 'readwrite') throw storageError('Read-only transaction', 'ReadOnlyError');
          if (typeof key !== 'string' && !(typeof key === 'number' && !Number.isNaN(key))) throw storageError('Unsupported key', 'DataError');
          const request = Object.assign(new EventTarget(), { result: undefined, error: null, transaction: tx, readyState: 'pending' });
          jobs.push({ name, action, key, value: action === 'put' ? nt.storageClone(value) : undefined, request });
          return request;
        }
        return {
          name,
          get: (key) => enqueue('get', key),
          put: (value, key) => enqueue('put', key, value),
          delete: (key) => enqueue('delete', key),
        };
      },
    });
    setTimeout(() => {
      let i = 0;
      try {
        const state = storageState(key);
        if (state.version !== version) throw storageError('Database version changed', 'VersionError');
        let dirty = false;
        while (!aborted && i < jobs.length) {
          const job = jobs[i++];
          const store = state.stores.get(job.name);
          if (job.action === 'get') job.request.result = nt.storageClone(store.get(job.key));
          else {
            dirty = true;
            if (job.action === 'put') { store.set(job.key, job.value); job.request.result = job.key; }
            else store.delete(job.key);
          }
          job.request.readyState = 'done';
          job.request.dispatchEvent(new Event('success'));
        }
        if (aborted) throw storageError('Transaction aborted', 'AbortError');
        if (dirty) commitStorage(key, state);
      } catch (error) {
        active = false;
        tx.error = error;
        for (const { request } of jobs) {
          if (request.readyState === 'done') continue;
          request.error = error;
          request.readyState = 'done';
          request.dispatchEvent(new Event('error'));
        }
        tx.dispatchEvent(new Event('abort'));
        return;
      }
      active = false;
      tx.dispatchEvent(new Event('complete'));
    }, 0);
    return tx;
  }

  class Storage {
    constructor(name = null) {
      Object.defineProperties(this, { _m: { value: new Map() }, _name: { value: name } });
    }
    _values() { return this._name ? storageState(this._name).values ?? new Map() : this._m; }
    _update(change) {
      if (!this._name) { change(this._m); return; }
      const state = storageState(this._name);
      state.values ??= new Map();
      change(state.values);
      commitStorage(this._name, state);
    }
    get length() { return this._values().size; }
    key(i) { return [...this._values().keys()][i] ?? null; }
    getItem(k) { return this._values().get(String(k)) ?? null; }
    setItem(k, v) { this._update((values) => values.set(String(k), String(v))); }
    removeItem(k) { this._update((values) => values.delete(String(k))); }
    clear() { this._update((values) => values.clear()); }
  }

  // ---------------------------------------------------- observers & misc
  const resizeObservers = new Set();
  class ResizeObserver {
    constructor(cb) { this._cb = cb; this._targets = new Set(); }
    observe(el) { this._targets.add(el); resizeObservers.add(this); setTimeout(() => this._notify(), 0); }
    unobserve(el) { this._targets.delete(el); }
    disconnect() { this._targets.clear(); resizeObservers.delete(this); }
    _notify() {
      if (!this._targets.size) return;
      const entries = [...this._targets].map((target) => {
        const r = target.getBoundingClientRect();
        const box = [{ inlineSize: r.width, blockSize: r.height }];
        return { target, contentRect: r, contentBoxSize: box, borderBoxSize: box, devicePixelContentBoxSize: [{ inlineSize: r.width * state.pixelRatio, blockSize: r.height * state.pixelRatio }] };
      });
      try { this._cb(entries, this); } catch (e) { reportError('ResizeObserver', e); }
    }
  }
  class MutationObserver { observe() {} disconnect() {} takeRecords() { return []; } }
  class IntersectionObserver {
    constructor(cb) { this._cb = cb; }
    observe(el) { setTimeout(() => this._cb([{ target: el, isIntersecting: true, intersectionRatio: 1 }], this), 0); }
    unobserve() {} disconnect() {}
  }
  // matchMedia evaluates against the window size (UI layer) and re-checks on resize.
  const mediaLists = new Set();
  const mediaMatch = (q) => (uiLayer ? uiLayer.matchMedia(q) : /prefers-color-scheme:\s*dark/.test(q));
  const mediaQueries = (q) => {
    const list = new EventTarget();
    Object.assign(list, { media: String(q), onchange: null, _last: mediaMatch(q) });
    Object.defineProperty(list, 'matches', { get: () => mediaMatch(q) });
    list.addListener = (fn) => list.addEventListener('change', fn);
    list.removeListener = (fn) => list.removeEventListener('change', fn);
    mediaLists.add(list);
    return list;
  };

  // getComputedStyle: cascaded values from the UI layer; sizes from layout.
  function computedStyle(el) {
    const cs = uiLayer && el && el.nodeType === 1 ? uiLayer.computed(el) : null;
    const read = (prop) => {
      if (!cs) return prop === 'display' ? (el && el.hasAttribute && el.hasAttribute('hidden') ? 'none' : 'block') : el && el.style ? el.style.getPropertyValue(prop) : '';
      if (prop === 'width' || prop === 'height') {
        const r = el._layoutRect();
        const v = prop === 'width' ? r.w - (r.bl || 0) - (r.br || 0) - (r.pl || 0) - (r.pr || 0) : r.h - (r.bt || 0) - (r.bb || 0) - (r.pt || 0) - (r.pb || 0);
        return `${Math.max(0, v)}px`;
      }
      if (prop === 'font-size') return `${cs.__fs}px`;
      const v = cs[prop];
      if (v !== undefined) return String(v);
      return ({ display: 'inline', position: 'static', opacity: '1', visibility: 'visible', 'pointer-events': 'auto', 'z-index': 'auto', color: 'rgb(0, 0, 0)', 'background-color': 'rgba(0, 0, 0, 0)', 'box-sizing': 'content-box', overflow: 'visible', transform: 'none' })[prop] ?? (/^(margin|padding|border-.*-width|top|left|right|bottom)/.test(prop) ? '0px' : '');
    };
    return new Proxy({ getPropertyValue: read, getPropertyPriority: () => '', item: () => '', length: 0 }, {
      get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; return read(k.startsWith('--') ? k : camelToKebab(k)); },
    });
  }

  // ------------------------------------------------------------ globals
  const document = new Document();
  const localStorage = new Storage(persistentStorage ? 'local' : null);
  const sessionStorage = new Storage();
  function requestNavigation(target) {
    const url = new URL(target, documentURL);
    if (url.origin !== GAME_ORIGIN || url.pathname !== '/index.html') {
      unsupported('navigation', 'only the current webapp entry can be reloaded');
      return;
    }
    if (typeof nt.requestReload !== 'function') {
      warnOnce('reload', 'This host does not support reloading the webapp');
      return;
    }
    nt.requestReload(url.href, JSON.stringify({
      session: [...sessionStorage._values()],
      local: persistentStorage ? undefined : [...localStorage._values()],
    }));
  }
  const location = {
    get href() { return documentURL; }, set href(target) { requestNavigation(target); },
    protocol: 'nt:', host: 'game', hostname: 'game', port: '', origin: GAME_ORIGIN,
    pathname: '/index.html', get search() { return pageURL.search; }, get hash() { return pageURL.hash; },
    reload() { requestNavigation(documentURL); }, assign: requestNavigation, replace: requestNavigation,
    toString() { return documentURL; },
  };
  const navigator = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NativeThreeBridge',
    appName: 'NativeThreeBridge', platform: 'Win32', vendor: 'NativeThreeBridge',
    language: 'et-EE', languages: ['et-EE', 'et', 'en'], onLine: false, cookieEnabled: false,
    hardwareConcurrency: 4, maxTouchPoints: 0, deviceMemory: 8,
    getGamepads: () => [], vibrate: () => false,
    clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') },
    mediaDevices: undefined, xr: undefined, gpu: undefined,
    userActivation: { isActive: true, hasBeenActive: true },
  };
  const screen = { get width() { return state.width; }, get height() { return state.height; }, get availWidth() { return state.width; }, get availHeight() { return state.height; }, colorDepth: 24, pixelDepth: 24, orientation: { type: 'landscape-primary', angle: 0, addEventListener() {} } };

  const window = global;
  // window is an EventTarget whose listeners live outside the global object.
  const windowEvents = new EventTarget();
  const assign = {
    window, self: window, globalThis: window, top: window, parent: window, frames: window,
    document, location, navigator, screen, console,
    history: { length: 1, state: null, pushState() {}, replaceState() {}, back() {}, forward() {}, go() {} },
    localStorage, sessionStorage,
    ...(persistentStorage ? { indexedDB: { open: openDatabase } } : {}),
    setTimeout, setInterval, clearTimeout, clearInterval: clearTimeout,
    requestAnimationFrame, cancelAnimationFrame,
    requestIdleCallback: (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 8 }), 1),
    cancelIdleCallback: clearTimeout,
    addEventListener: (...a) => windowEvents.addEventListener(...a),
    removeEventListener: (...a) => windowEvents.removeEventListener(...a),
    dispatchEvent: (e) => { e.target = window; e.eventPhase = 2; windowEvents._invoke(e, false); e.currentTarget = null; return !e.defaultPrevented; },
    _invoke: (e, capture) => { windowEvents._invoke(e, capture); e.currentTarget = window; },
    getComputedStyle: (el, pseudo) => computedStyle(el, pseudo),
    matchMedia: mediaQueries,
    scrollTo() {}, scrollBy() {}, scroll() {}, focus() {}, blur() {}, close() {}, print() {}, stop() {}, postMessage() {},
    open() { warnOnce('open', 'window.open() is ignored'); return null; },
    alert(msg) { nt.log('info', `[alert] ${msg}`); },
    confirm(msg) { nt.log('info', `[confirm] ${msg} -> true`); return true; },
    prompt(msg, def = '') { nt.log('info', `[prompt] ${msg} -> ${def}`); return def; },
    isSecureContext: true, crossOriginIsolated: false, origin: GAME_ORIGIN, name: '', closed: false,
    scrollX: 0, scrollY: 0, pageXOffset: 0, pageYOffset: 0, screenX: 0, screenY: 0, screenLeft: 0, screenTop: 0,
    Node, Text, Comment, Element, HTMLElement, HTMLCanvasElement, HTMLImageElement, HTMLInputElement, HTMLButtonElement, HTMLScriptElement,
    HTMLVideoElement: HTMLMediaElement, HTMLAudioElement: HTMLMediaElement, HTMLMediaElement, SVGElement: Element, Document, HTMLDocument: Document, DocumentFragment,
    Image: class extends HTMLImageElement { constructor(w, h) { super('img'); if (w) this.width = w; if (h) this.height = h; this.ownerDocument = document; } },
    NodeFilter, TreeWalker, NodeIterator,
    EventTarget, Event, CustomEvent, ProgressEvent, ErrorEvent, UIEvent, FocusEvent, KeyboardEvent, MouseEvent, PointerEvent, WheelEvent,
    AbortController, AbortSignal, URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa,
    fetch, Headers, Request, Response, Blob, File, XMLHttpRequest, DOMParser,
    ReadableStream, DecompressionStream, CompressionStream,
    createImageBitmap, ImageBitmap, CanvasRenderingContext2D, CanvasGradient, CanvasPattern, ImageData, Path2D,
    ResizeObserver, MutationObserver, IntersectionObserver,
  };
  for (const [k, v] of Object.entries(assign)) {
    if (k === 'globalThis') continue;
    Object.defineProperty(global, k, { value: v, writable: true, configurable: true, enumerable: false });
  }
  for (const [k, getter] of Object.entries({
    innerWidth: () => state.width, innerHeight: () => state.height,
    outerWidth: () => state.width, outerHeight: () => state.height,
    devicePixelRatio: () => state.pixelRatio,
  })) Object.defineProperty(global, k, { get: getter, set() {}, configurable: true });
  for (const name of ['onload', 'onresize', 'onkeydown', 'onkeyup', 'onpointerdown', 'onpointermove', 'onpointerup', 'onmousedown', 'onmousemove', 'onmouseup', 'onwheel', 'onclick', 'onblur', 'onfocus', 'oncontextmenu', 'onerror', 'onunhandledrejection', 'onbeforeunload', 'onDOMContentLoaded']) {
    if (!(name in global)) global[name] = null;
  }
  // Event handler properties on window ('window.onresize = fn') are looked
  // up by the EventTarget logic through this delegate.
  Object.defineProperty(windowEvents, 'onload', { get: () => global.onload });
  for (const name of ['onresize', 'onkeydown', 'onkeyup', 'onpointerdown', 'onpointermove', 'onpointerup', 'onmousedown', 'onmousemove', 'onmouseup', 'onwheel', 'onclick', 'onblur', 'onfocus', 'oncontextmenu', 'onerror', 'onbeforeunload']) {
    Object.defineProperty(windowEvents, name, { get: () => global[name] });
  }
  document.defaultView = window;
  if (typeof global.structuredClone !== 'function') {
    global.structuredClone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  }
  if (typeof global.performance === 'undefined') {
    const start = Date.now();
    global.performance = { now: () => Date.now() - start, timeOrigin: start };
  }
  for (const m of ['mark', 'measure', 'clearMarks', 'clearMeasures']) if (typeof performance[m] !== 'function') performance[m] = () => {};
  if (typeof performance.getEntriesByName !== 'function') performance.getEntriesByName = () => [];
  if (typeof global.queueMicrotask !== 'function') global.queueMicrotask = (fn) => Promise.resolve().then(fn);
  if (typeof global.reportError !== 'function') global.reportError = (e) => reportError('reportError', e);

  // ------------------------------------------------------- input mapping
  let pointerButtons = 0, lastPointer = { x: 0, y: 0 }, modifiers = {};
  let captureTarget = null, downTarget = null, hoverTarget = null;
  let popupButtons = 0;
  const popupKeys = new Set();
  const BUTTON_BIT = [1, 4, 2, 8, 16];
  function eventTarget() {
    return (document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected) ? document.activeElement : (document.body || document);
  }
  function pointerTarget() {
    const canvas = document.querySelector('canvas');
    return canvas && canvas.isConnected ? canvas : (document.body || document);
  }
  // Element under the pointer: hit-tested HTML UI, else the 3D canvas.
  function hitTarget(x, y) {
    const hit = uiLayer ? uiLayer.hitTest(x, y) : null;
    if (hit && hit.isConnected) return hit;
    return pointerTarget();
  }
  function fire(target, event) {
    event.isTrusted = true;
    const start = performance.now();
    try {
      if (target === window) return window.dispatchEvent(event);
      return target.dispatchEvent(event);
    } finally {
      // Report long synchronous input listeners without changing event order.
      // The native window can appear hung while game pathfinding runs here.
      const ms = performance.now() - start;
      if (ms >= 35 && /^(?:pointerdown|pointerup|mousedown|mouseup|click|contextmenu)$/.test(event.type))
        nt.log('warn', `[input-perf] ${event.type} handler ${ms.toFixed(1)} ms`);
    }
  }
  const PTR = { bubbles: true, cancelable: true, composed: true };
  const chainOf = (n) => { const out = []; for (; n && n.nodeType === 1; n = n.parentNode) out.push(n); return out; };
  function commonAncestor(a, b) {
    if (!a || !b) return a || b;
    const set = new Set(chainOf(a));
    for (let n = b; n; n = n.parentNode) if (set.has(n)) return n;
    return document.body || document;
  }
  function disabledControl(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
      if (/^(button|input|select|textarea|fieldset)$/.test(n.localName) && (n.hasAttribute('disabled') || n._disabled)) return true;
    }
    return false;
  }
  function updateHover(target, init) {
    if (target === hoverTarget) return;
    const old = hoverTarget;
    hoverTarget = target;
    const oldChain = chainOf(old), newChain = chainOf(target);
    if (old && old.isConnected) {
      fire(old, new PointerEvent('pointerout', { ...init, relatedTarget: target }));
      fire(old, new MouseEvent('mouseout', { ...init, relatedTarget: target }));
      for (const n of oldChain) if (!newChain.includes(n)) { fire(n, new PointerEvent('pointerleave', { ...init, bubbles: false, relatedTarget: target })); fire(n, new MouseEvent('mouseleave', { ...init, bubbles: false, relatedTarget: target })); }
    }
    if (target) {
      fire(target, new PointerEvent('pointerover', { ...init, relatedTarget: old }));
      fire(target, new MouseEvent('mouseover', { ...init, relatedTarget: old }));
      for (const n of newChain.slice().reverse()) if (!oldChain.includes(n)) { fire(n, new PointerEvent('pointerenter', { ...init, bubbles: false, relatedTarget: old })); fire(n, new MouseEvent('mouseenter', { ...init, bubbles: false, relatedTarget: old })); }
    }
    if (uiLayer) uiLayer.setHover(target && target.nodeType === 1 ? target : null);
  }
  // Browser default actions after an unprevented click.
  function clickDefault(target) {
    for (let n = target; n && n.nodeType === 1; n = n.parentNode) {
      const tag = n.localName;
      if (tag === 'summary' && n.parentNode && n.parentNode.localName === 'details') {
        const d = n.parentNode;
        d.toggleAttribute('open', !d.hasAttribute('open'));
        d.dispatchEvent(new Event('toggle'));
        return;
      }
      if (tag === 'input') {
        const type = (n.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') { n.checked = !n.checked; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); }
        else if (type === 'radio' && !n.checked) {
          const name = n.getAttribute('name');
          if (name) for (const r of document.querySelectorAll(`input[name="${name}"]`)) if (r !== n) r.checked = false;
          n.checked = true; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return;
      }
      if (tag === 'select') {
        uiLayer?.openSelect?.(n);
        return;
      }
      if (tag === 'label') {
        const id = n.getAttribute('for');
        const control = id ? document.getElementById(id) : n.querySelector('input,select,textarea,button');
        if (control && control !== target && !control.contains(target) && !disabledControl(control)) {
          if (control.localName === 'select') {
            focusFor(control);
            if (fire(control, new MouseEvent('click', PTR))) clickDefault(control);
          } else control.click();
        }
        return;
      }
      if (tag === 'button' || tag === 'a') return;
    }
  }
  function focusFor(target) {
    for (let n = target; n && n.nodeType === 1; n = n.parentNode) {
      if (/^(button|input|select|textarea|a|summary)$/.test(n.localName) || n.hasAttribute('tabindex') || n.hasAttribute('contenteditable')) {
        if (document.activeElement !== n) { const old = document.activeElement; n.focus(); if (old && old !== n && old.isConnected) old.dispatchEvent(new FocusEvent('blur')); n.dispatchEvent(new FocusEvent('focus')); }
        return;
      }
    }
    if (document.activeElement && document.activeElement !== document.body) {
      const old = document.activeElement;
      old.blur();
      if (old.isConnected) old.dispatchEvent(new FocusEvent('blur'));
    }
  }
  function pointer(kind, x, y, button, mods) {
    const movementX = x - lastPointer.x, movementY = y - lastPointer.y;
    lastPointer = { x, y };
    const bit = BUTTON_BIT[button] || 0;
    // Keep both halves of a popup press out of the page, even if the
    // popup was dismissed before the release.
    if (!captureTarget) {
      const popupPress = kind === 'up' && (popupButtons & bit);
      const handled = uiLayer?.selectPointer?.(kind, x, y, button);
      if (kind === 'down' && handled) popupButtons |= bit;
      if (kind === 'up') popupButtons &= ~bit;
      if (handled || popupPress || popupButtons) return;
    }
    if (kind === 'up' && !(pointerButtons & bit)) return;
    if (kind === 'down') pointerButtons |= bit;
    if (kind === 'up') pointerButtons &= ~bit;
    const init = { ...PTR, ...mods, clientX: x, clientY: y, offsetX: x, offsetY: y, pageX: x, pageY: y, screenX: x, screenY: y, movementX, movementY, button: kind === 'move' ? -1 : button, buttons: pointerButtons, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const under = hitTarget(x, y);
    // Implicit capture: a drag that starts on the canvas stays with it.
    const target = captureTarget && captureTarget.isConnected ? captureTarget : under;
    if (kind === 'move' && !captureTarget) updateHover(under, init);
    if (kind === 'down') {
      if (!captureTarget) { captureTarget = under; downTarget = under; }
      if (uiLayer) uiLayer.setActive(under && under.nodeType === 1 ? under : null);
    }
    const pType = { down: 'pointerdown', up: 'pointerup', move: 'pointermove' }[kind];
    const mType = { down: 'mousedown', up: 'mouseup', move: 'mousemove' }[kind];
    const proceed = fire(target, new PointerEvent(pType, init));
    if (proceed) fire(target, new MouseEvent(mType, init));
    if (kind === 'down' && proceed && button === 0) focusFor(target);
    if (kind === 'up') {
      const clickTarget = commonAncestor(downTarget || target, under);
      if (!pointerButtons) {
        captureTarget = null; downTarget = null;
        if (uiLayer) uiLayer.setActive(null);
        updateHover(under, init);
      }
      if (button === 0 && clickTarget && !disabledControl(clickTarget)) {
        const notPrevented = fire(clickTarget, new MouseEvent('click', init));
        if (notPrevented) clickDefault(clickTarget);
      }
      if (button === 2) fire(clickTarget || target, new MouseEvent('contextmenu', init));
    }
  }
  // Typing into focused <input>/<textarea> (no IME, no selection).
  function editableTarget() {
    const el = document.activeElement;
    if (!el || !el.isConnected) return null;
    if (el.localName === 'textarea') return el;
    if (el.localName === 'input' && /^(text|search|email|url|tel|password|number|)$/.test((el.getAttribute('type') || '').toLowerCase())) return el;
    return null;
  }

  // --------------------------------------------- engine -> JS entry points
  const host = {
    state,
    resize(width, height, pixelRatio = 1) {
      const changed = width !== state.width || height !== state.height || pixelRatio !== state.pixelRatio;
      state.width = Math.max(1, width | 0); state.height = Math.max(1, height | 0); state.pixelRatio = pixelRatio || 1;
      if (changed && state.booted) {
        window.dispatchEvent(new UIEvent('resize'));
        for (const o of resizeObservers) o._notify();
        for (const list of mediaLists) {
          const m = list.matches;
          if (m !== list._last) {
            list._last = m;
            const ev = new Event('change'); ev.matches = m; ev.media = list.media;
            list.dispatchEvent(ev);
            if (typeof list.onchange === 'function') try { list.onchange(ev); } catch (e) { reportError('matchMedia change', e); }
          }
        }
      }
    },
    // Called once by the engine with the text of index.html.
    boot(html, url, storage) {
      if (url) {
        documentURL = url;
        pageURL = new URL(url);
      }
      if (storage) {
        const saved = JSON.parse(storage);
        for (const [key, value] of saved.session ?? []) sessionStorage.setItem(key, value);
        if (!persistentStorage) for (const [key, value] of saved.local ?? []) localStorage.setItem(key, value);
      }
      // Parser-inserted <script> tags run through host.boot(); scripts created
      // by those scripts are dynamic and must be handled by our queue.
      parsingInitialDocument = true;
      try { parseDocument(String(html)); } finally { parsingInitialDocument = false; }
      document.readyState = 'interactive';
      const scripts = querySelectorAll(document, 'script');
      const imports = [];
      for (const s of scripts) {
        if ((s.getAttribute('type') || '').toLowerCase() !== 'importmap') continue;
        try {
          const map = JSON.parse(s.textContent || '{}');
          for (const [k, v] of Object.entries(map.imports || {})) imports.push(k, String(v));
          if (map.scopes) unsupported('importmap scopes', 'only top-level "imports" are used');
        } catch (e) { reportError('importmap', e); }
      }
      nt.setImportMap(imports);
      const modules = [];
      let inline = 0;
      for (const s of scripts) {
        const type = (s.getAttribute('type') || 'text/javascript').toLowerCase().trim();
        const src = s.getAttribute('src');
        if (type === 'module') {
          s._ntScriptStarted = true;
          if (src) {
            const path = toGamePath(src);
            if (path === null) { reportError('script', new Error(`External module script is not available offline: ${src}`)); continue; }
            modules.push({ source: `import ${JSON.stringify('/' + path)};`, name: `index.html#module-${modules.length + 1}` });
          } else modules.push({ source: s.textContent, name: `index.html#inline-${++inline}` });
          continue;
        }
        if (!['text/javascript', 'application/javascript', 'javascript', ''].includes(type)) continue;
        s._ntScriptStarted = true;
        try {
          if (src) {
            const path = toGamePath(src);
            if (path === null) throw new Error(`External script is not available offline: ${src}`);
            nt.evalScript(nt.readText(path), path);
          } else nt.evalScript(s.textContent, `index.html#script-${++inline}`);
        } catch (e) { reportError(`script ${src || 'inline'}`, e); }
      }
      const finish = () => {
        state.booted = true;
        document.readyState = 'complete';
        document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
        document.dispatchEvent(new Event('readystatechange'));
        window.dispatchEvent(new Event('load'));
      };
      // Module scripts are deferred and run in document order.
      let chain = Promise.resolve();
      for (const m of modules) {
        chain = chain.then(() => nt.evalModule(m.source, m.name)).catch((e) => {
          state.bootError = state.bootError || e;
          reportError(`module ${m.name}`, e);
        });
      }
      chain.then(finish);
      if (!modules.length) state.booted = true;
      const t = document.title;
      if (t) nt.setTitle(t);
    },
    // Game timers and requestAnimationFrame run at the 3D rate; CSS/UI is separately scheduled.
    // The default keeps existing Node test hosts and legacy callers compatible.
    frame(timeMs, uiTick = true) {
      state.now = timeMs;
      state.frame++;
      const t0 = performance.now();
      runTimers();
      const tTimers = performance.now();
      const callbacks = rafCallbacks;
      rafCallbacks = new Map();
      for (const cb of callbacks.values()) {
        try { cb(timeMs); } catch (e) { reportError('requestAnimationFrame', e); }
      }
      const tRaf = performance.now();
      flushCanvases(); // Canvas 2D drawings of this frame -> native bitmaps
      const tCanvas = performance.now();
      if (uiTick !== false && uiLayer) uiLayer.frame();
      const tUi = performance.now();
      if (tUi - t0 >= 90 && timeMs - (state.lastSlowFrameReport || -Infinity) >= 1000) {
        state.lastSlowFrameReport = timeMs;
        nt.log('warn', `[js-perf] ${(tUi - t0).toFixed(1)} ms; timers ${(tTimers - t0).toFixed(1)} ms; rAF ${(tRaf - tTimers).toFixed(1)} ms; canvas ${(tCanvas - tRaf).toFixed(1)} ms; UI ${(tUi - tCanvas).toFixed(1)} ms`);
      }
    },
    key(down, key, code, repeat, alt, ctrl, shift, meta) {
      modifiers = { altKey: !!alt, ctrlKey: !!ctrl, shiftKey: !!shift, metaKey: !!meta };
      if (!down && popupKeys.delete(code || key)) return;
      if (down) {
        if (repeat && popupKeys.has(code || key)) {
          uiLayer?.selectKey?.(key);
          return;
        }
        if (uiLayer?.selectKey?.(key)) {
          if (!repeat) popupKeys.add(code || key);
          return;
        }
      }
      const keyCode = key.length === 1 ? key.toUpperCase().charCodeAt(0) : ({ Enter: 13, Escape: 27, ' ': 32, Tab: 9, Backspace: 8, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Shift: 16, Control: 17, Alt: 18, Delete: 46 }[key] || 0);
      const proceed = fire(eventTarget(), new KeyboardEvent(down ? 'keydown' : 'keyup', { bubbles: true, cancelable: true, key, code, repeat: !!repeat, keyCode, ...modifiers }));
      const focused = document.activeElement;
      if (down && proceed && !ctrl && !meta && focused?.localName === 'select' &&
          !disabledControl(focused) && ['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(key)) {
        uiLayer?.openSelect?.(focused);
        return;
      }
      const edit = down && proceed && !ctrl && !meta ? editableTarget() : null;
      if (edit && (key.length === 1 || key === 'Backspace' || (key === 'Enter' && edit.localName === 'textarea'))) {
        const v = edit.value;
        edit.value = key === 'Backspace' ? v.slice(0, -1) : v + (key === 'Enter' ? '\n' : key);
        edit.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (edit && key === 'Enter') edit.dispatchEvent(new Event('change', { bubbles: true }));
    },
    pointer(kind, x, y, button) { pointer(kind, x, y, button | 0, modifiers); },
    wheel(x, y, deltaX, deltaY) {
      if (uiLayer?.selectWheel?.(x, y, deltaY)) return;
      const target = hitTarget(x, y);
      const proceed = fire(target, new WheelEvent('wheel', { ...PTR, ...modifiers, clientX: x, clientY: y, deltaX, deltaY, deltaMode: 0, buttons: pointerButtons }));
      if (proceed && uiLayer && target && target.nodeType === 1) {
        const scrolled = uiLayer.wheel(target, deltaX, deltaY);
        if (scrolled) scrolled.dispatchEvent(new Event('scroll'));
      }
    },
    // Cursor name (CSS `cursor`) for the element under the pointer.
    cursor() { return uiLayer && hoverTarget ? uiLayer.cursorAt(hoverTarget) : 'auto'; },
    focus(focused) {
      if (!focused) {
        const captured = captureTarget;
        pointerButtons = popupButtons = 0;
        captureTarget = downTarget = null;
        popupKeys.clear();
        uiLayer?.setActive(null);
        uiLayer?.closeSelect?.();
        if (captured?.isConnected) fire(captured, new PointerEvent('pointercancel', {
          ...PTR, ...modifiers, pointerId: 1, pointerType: 'mouse', isPrimary: true,
          clientX: lastPointer.x, clientY: lastPointer.y,
        }));
      }
      document.hidden = false;
      window.dispatchEvent(new FocusEvent(focused ? 'focus' : 'blur'));
    },
    status() {
      return JSON.stringify({
        booted: state.booted, frame: state.frame, title: document.title,
        errors: state.errors.slice(-20), errorCount: state.errors.length,
        bootError: state.bootError ? String(state.bootError) : null,
        unsupported: [...state.unsupported],
      });
    },
    unsupported,
    warnOnce,
    get ui() { return uiLayer; },
    set ui(layer) { uiLayer = layer || null; },
  };
  Object.defineProperty(global, '__ntHost', { value: host, writable: false, configurable: false });
})(globalThis);
