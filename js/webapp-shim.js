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
  const documentURL = `${GAME_ORIGIN}/index.html`;

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
      return child;
    }
    removeChild(child) {
      const i = this.childNodes.indexOf(child);
      if (i >= 0) { this.childNodes.splice(i, 1); child.parentNode = null; }
      return child;
    }
    replaceChild(newChild, oldChild) { this.insertBefore(newChild, oldChild); return this.removeChild(oldChild); }
    contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
    get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
    set textContent(v) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; if (v !== '' && v != null) this.appendChild(new Text(String(v))); }
    cloneNode(deep) {
      const copy = this._shallowClone();
      if (deep) for (const c of this.childNodes) copy.appendChild(c.cloneNode(true));
      return copy;
    }
    getRootNode() { let n = this; while (n.parentNode) n = n.parentNode; return n; }
  }
  class Text extends Node {
    constructor(data = '') { super(3, '#text'); this.data = String(data); }
    get textContent() { return this.data; }
    set textContent(v) { this.data = String(v); }
    get nodeValue() { return this.data; }
    _shallowClone() { return new Text(this.data); }
  }
  class Comment extends Node {
    constructor(data = '') { super(8, '#comment'); this.data = String(data); }
    get textContent() { return ''; }
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
  function makeStyle() {
    const props = new Map();
    const target = {
      setProperty(k, v) { props.set(k, String(v)); },
      getPropertyValue(k) { return props.get(k) || ''; },
      removeProperty(k) { const v = props.get(k) || ''; props.delete(k); return v; },
      get cssText() { return [...props].map(([k, v]) => `${k}: ${v}`).join('; '); },
      set cssText(text) { props.clear(); for (const decl of String(text).split(';')) { const i = decl.indexOf(':'); if (i > 0) props.set(decl.slice(0, i).trim(), decl.slice(i + 1).trim()); } },
    };
    return new Proxy(target, {
      get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; return props.get(camelToKebab(k)) || ''; },
      set(t, k, v) { if (k === 'cssText') { t.cssText = v; return true; } if (typeof k === 'string') props.set(camelToKebab(k), String(v)); return true; },
    });
  }

  class Element extends Node {
    constructor(tagName, namespaceURI = 'http://www.w3.org/1999/xhtml') {
      const lower = String(tagName).toLowerCase();
      super(1, lower.toUpperCase());
      this.localName = lower; this.tagName = lower.toUpperCase(); this.namespaceURI = namespaceURI;
      this._attrs = new Map();
      this.style = makeStyle();
      this.classList = new DOMTokenList(this);
      this.dataset = {};
      this.scrollTop = 0; this.scrollLeft = 0;
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
      if (n === 'style') this.style.cssText = v;
      this._attributeChanged(n, v);
    }
    _attributeChanged() {}
    hasAttribute(n) { return this._attrs.has(String(n).toLowerCase()); }
    removeAttribute(n) { this._attrs.delete(String(n).toLowerCase()); }
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
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    before(...n) { for (const c of n) this.parentNode && this.parentNode.insertBefore(typeof c === 'string' ? new Text(c) : c, this); }
    after(...n) { const next = this.nextSibling; for (const c of n) this.parentNode && this.parentNode.insertBefore(typeof c === 'string' ? new Text(c) : c, next); }
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
    getBoundingClientRect() {
      const w = this._fullView() ? state.width : 0, h = this._fullView() ? state.height : 0;
      return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h, toJSON() { return this; } };
    }
    getClientRects() { return [this.getBoundingClientRect()]; }
    get clientWidth() { return this._fullView() ? state.width : 0; }
    get clientHeight() { return this._fullView() ? state.height : 0; }
    get offsetWidth() { return this.clientWidth; }
    get offsetHeight() { return this.clientHeight; }
    get offsetLeft() { return 0; }
    get offsetTop() { return 0; }
    get offsetParent() { return this.parentElement; }
    get scrollWidth() { return this.clientWidth; }
    get scrollHeight() { return this.clientHeight; }
    focus() { document.activeElement = this; }
    blur() { if (document.activeElement === this) document.activeElement = document.body; }
    click() { this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
    scrollIntoView() {}
    scrollTo() {}
    animate() { unsupported('Element.animate'); return { finished: Promise.resolve(), cancel() {}, play() {}, pause() {} }; }
    requestPointerLock() { unsupported('Pointer Lock', 'cursor stays free'); return Promise.resolve(); }
    requestFullscreen() { unsupported('Fullscreen API'); return Promise.resolve(); }
    setPointerCapture() {}
    releasePointerCapture() {}
    hasPointerCapture() { return false; }
    attachShadow() { unsupported('Shadow DOM'); const f = new DocumentFragment(); f.host = this; return f; }
    _shallowClone() { const e = document.createElement(this.localName); for (const [k, v] of this._attrs) e.setAttribute(k, v); return e; }
  }
  class HTMLElement extends Element {
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(v) { this.toggleAttribute('hidden', !!v); }
    get title() { return this.getAttribute('title') || ''; }
    set title(v) { this.setAttribute('title', v); }
    get tabIndex() { return Number(this.getAttribute('tabindex') ?? -1); }
    set tabIndex(v) { this.setAttribute('tabindex', v); }
  }
  class HTMLInputElement extends HTMLElement {
    get value() { return this._value ?? this.getAttribute('value') ?? ''; }
    set value(v) { this._value = String(v); }
    get checked() { return this._checked ?? this.hasAttribute('checked'); }
    set checked(v) { this._checked = !!v; }
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
    get src() { return this.getAttribute('src') || ''; }
    set src(v) { this.setAttribute('src', v); }
    get type() { return this.getAttribute('type') || ''; }
    set type(v) { this.setAttribute('type', v); }
    get text() { return this.textContent; }
    set text(v) { this.textContent = v; }
  }
  class HTMLCanvasElement extends HTMLElement {
    constructor(tag = 'canvas', ns) { super(tag, ns); this._width = 300; this._height = 150; }
    get width() { return this._width; }
    set width(v) { this._width = Math.max(0, v | 0); }
    get height() { return this._height; }
    set height(v) { this._height = Math.max(0, v | 0); }
    _attributeChanged(n, v) { if (n === 'width') this._width = v | 0; if (n === 'height') this._height = v | 0; }
    getContext(kind) {
      if (kind === '2d') {
        unsupported('Canvas 2D drawing', 'calls are ignored (canvas textures stay blank)');
        if (!this._ctx2d) this._ctx2d = makeContext2D(this);
        return this._ctx2d;
      }
      // WebGL is never exposed: THREE.WebGLRenderer is the NativeRenderer.
      unsupported(`canvas.getContext('${kind}')`, 'use THREE.WebGLRenderer, which renders natively');
      return null;
    }
    toDataURL() { unsupported('canvas.toDataURL'); return 'data:,'; }
    toBlob(cb) { unsupported('canvas.toBlob'); setTimeout(() => cb(null), 0); }
    captureStream() { unsupported('canvas.captureStream'); return null; }
    transferControlToOffscreen() { unsupported('OffscreenCanvas'); return null; }
  }
  function makeContext2D(canvas) {
    const noop = () => {};
    const gradient = { addColorStop: noop };
    return new Proxy({ canvas, measureText: (t) => ({ width: String(t).length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
      createLinearGradient: () => gradient, createRadialGradient: () => gradient, createPattern: () => null,
      getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), isPointInPath: () => false },
    { get(t, k) { return k in t ? t[k] : noop; }, set(t, k, v) { t[k] = v; return true; } });
  }
  class HTMLImageElement extends HTMLElement {
    constructor(tag = 'img', ns) { super(tag, ns); this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; this.width = 0; this.height = 0; this.crossOrigin = null; this.decoding = 'auto'; }
    get src() { return this._src || ''; }
    set src(v) {
      this._src = String(v);
      // Image decoding arrives in a later engine version. Fail like a broken
      // image so THREE.TextureLoader calls onError and the game keeps running.
      unsupported('Image/texture decoding', 'textures stay untextured (planned for v0.30)');
      setTimeout(() => { this.complete = true; this.dispatchEvent(new Event('error')); }, 0);
    }
    decode() { return Promise.reject(new Error('Image decoding not supported yet')); }
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
    elementFromPoint() { return this.querySelector('canvas') || this.body; }
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
  }
  class File extends Blob { constructor(parts, name, o = {}) { super(parts, o); this.name = name; this.lastModified = o.lastModified || 0; } }
  class Response {
    constructor(body = null, init = {}) {
      this._body = body; this.status = init.status ?? 200; this.statusText = init.statusText ?? 'OK';
      this.ok = this.status >= 200 && this.status < 300; this.headers = new Headers(init.headers); this.url = init.url || '';
      this.redirected = false; this.type = 'basic'; this.bodyUsed = false; this.body = undefined;
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
    arrayBuffer() { const u = this._bytes(); return Promise.resolve(u.byteOffset === 0 && u.byteLength === u.buffer.byteLength ? u.buffer : u.slice().buffer); }
    text() { return Promise.resolve(typeof this._body === 'string' ? (this.bodyUsed = true, this._body) : new TextDecoder().decode(this._bytes())); }
    json() { return this.text().then(JSON.parse); }
    blob() { return Promise.resolve(new Blob([this._bytes()], { type: this.headers.get('content-type') || '' })); }
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
  class Storage {
    constructor() { Object.defineProperty(this, '_m', { value: new Map() }); }
    get length() { return this._m.size; }
    key(i) { return [...this._m.keys()][i] ?? null; }
    getItem(k) { return this._m.has(String(k)) ? this._m.get(String(k)) : null; }
    setItem(k, v) { this._m.set(String(k), String(v)); }
    removeItem(k) { this._m.delete(String(k)); }
    clear() { this._m.clear(); }
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
  const mediaQueries = (q) => ({ matches: /prefers-color-scheme:\s*dark/.test(q), media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

  // ------------------------------------------------------------ globals
  const document = new Document();
  const location = {
    href: documentURL, protocol: 'nt:', host: 'game', hostname: 'game', port: '', origin: GAME_ORIGIN,
    pathname: '/index.html', search: '', hash: '',
    reload() { warnOnce('reload', 'location.reload() is ignored'); }, assign() {}, replace() {}, toString() { return documentURL; },
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
    localStorage: new Storage(), sessionStorage: new Storage(),
    setTimeout, setInterval, clearTimeout, clearInterval: clearTimeout,
    requestAnimationFrame, cancelAnimationFrame,
    requestIdleCallback: (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 8 }), 1),
    cancelIdleCallback: clearTimeout,
    addEventListener: (...a) => windowEvents.addEventListener(...a),
    removeEventListener: (...a) => windowEvents.removeEventListener(...a),
    dispatchEvent: (e) => { e.target = window; e.eventPhase = 2; windowEvents._invoke(e, false); e.currentTarget = null; return !e.defaultPrevented; },
    _invoke: (e, capture) => { windowEvents._invoke(e, capture); e.currentTarget = window; },
    getComputedStyle: (el) => new Proxy(el.style, { get: (t, k) => (k === 'getPropertyValue' ? (p) => t.getPropertyValue(p) : t[k] || (k === 'display' ? 'block' : '')) }),
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
    EventTarget, Event, CustomEvent, UIEvent, FocusEvent, KeyboardEvent, MouseEvent, PointerEvent, WheelEvent,
    AbortController, AbortSignal, URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa,
    fetch, Headers, Request, Response, Blob, File, XMLHttpRequest, DOMParser,
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
  const BUTTON_BIT = [1, 4, 2, 8, 16];
  function eventTarget() {
    return (document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected) ? document.activeElement : (document.body || document);
  }
  function pointerTarget() {
    const canvas = document.querySelector('canvas');
    return canvas && canvas.isConnected ? canvas : (document.body || document);
  }
  function fire(target, event) {
    event.isTrusted = true;
    if (target === window) return window.dispatchEvent(event);
    return target.dispatchEvent(event);
  }
  const PTR = { bubbles: true, cancelable: true, composed: true };
  function pointer(kind, x, y, button, mods) {
    const movementX = x - lastPointer.x, movementY = y - lastPointer.y;
    lastPointer = { x, y };
    if (kind === 'down') pointerButtons |= BUTTON_BIT[button] || 0;
    if (kind === 'up') pointerButtons &= ~(BUTTON_BIT[button] || 0);
    const init = { ...PTR, ...mods, clientX: x, clientY: y, offsetX: x, offsetY: y, movementX, movementY, button: kind === 'move' ? -1 : button, buttons: pointerButtons, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const target = pointerTarget();
    const pType = { down: 'pointerdown', up: 'pointerup', move: 'pointermove' }[kind];
    const mType = { down: 'mousedown', up: 'mouseup', move: 'mousemove' }[kind];
    const proceed = fire(target, new PointerEvent(pType, init));
    if (proceed) fire(target, new MouseEvent(mType, init));
    if (kind === 'up') {
      if (button === 0) fire(target, new MouseEvent('click', init));
      if (button === 2) fire(target, new MouseEvent('contextmenu', init));
    }
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
      }
    },
    // Called once by the engine with the text of index.html.
    boot(html) {
      parseDocument(String(html));
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
          if (src) {
            const path = toGamePath(src);
            if (path === null) { reportError('script', new Error(`External module script is not available offline: ${src}`)); continue; }
            modules.push({ source: `import ${JSON.stringify('/' + path)};`, name: `index.html#module-${modules.length + 1}` });
          } else modules.push({ source: s.textContent, name: `index.html#inline-${++inline}` });
          continue;
        }
        if (!['text/javascript', 'application/javascript', 'javascript', ''].includes(type)) continue;
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
    // Called by the engine once per displayed frame with a millisecond clock.
    frame(timeMs) {
      state.now = timeMs;
      state.frame++;
      runTimers();
      const callbacks = rafCallbacks;
      rafCallbacks = new Map();
      for (const cb of callbacks.values()) {
        try { cb(timeMs); } catch (e) { reportError('requestAnimationFrame', e); }
      }
    },
    key(down, key, code, repeat, alt, ctrl, shift, meta) {
      modifiers = { altKey: !!alt, ctrlKey: !!ctrl, shiftKey: !!shift, metaKey: !!meta };
      const keyCode = key.length === 1 ? key.toUpperCase().charCodeAt(0) : ({ Enter: 13, Escape: 27, ' ': 32, Tab: 9, Backspace: 8, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Shift: 16, Control: 17, Alt: 18, Delete: 46 }[key] || 0);
      fire(eventTarget(), new KeyboardEvent(down ? 'keydown' : 'keyup', { bubbles: true, cancelable: true, key, code, repeat: !!repeat, keyCode, ...modifiers }));
    },
    pointer(kind, x, y, button) { pointer(kind, x, y, button | 0, modifiers); },
    wheel(x, y, deltaX, deltaY) {
      fire(pointerTarget(), new WheelEvent('wheel', { ...PTR, ...modifiers, clientX: x, clientY: y, deltaX, deltaY, deltaMode: 0, buttons: pointerButtons }));
    },
    focus(focused) {
      if (!focused) pointerButtons = 0;
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
  };
  Object.defineProperty(global, '__ntHost', { value: host, writable: false, configurable: false });
})(globalThis);
