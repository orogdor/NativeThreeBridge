// NativeThreeBridge HTML/CSS UI layer (classic script, embedded in the EXE
// and evaluated right after webapp-shim.js).
//
// Turns the game's DOM + stylesheets into pixels drawn by the engine:
//   stylesheets (<link>, <style>, @import, @media) -> cascade (specificity,
//   !important, inheritance, var()) -> layout (block/inline text, flex, grid,
//   absolute/fixed, overflow + scrolling) -> a compact display list
//   (rects, borders, gradients, shadows, images, text lines) that the native
//   side rasterises (Direct2D/DirectWrite/WIC) and composites over the 3D scene.
// It also hit-tests pointer input so clicks reach the right <button>, and
// answers getBoundingClientRect()/getComputedStyle() with real layout values.
//
// Not a browser: no CSS animations/transitions (end state is used), no
// filters, no transforms other than translate/scale, no web fonts.
//
// Native side (optional, everything degrades gracefully without it):
//   __nt.submitUi(Float32Array, floatCount, stringsJoinedWith\u001f)
//   __nt.measureText(family, sizePx, weight, italic, text) -> width | -1
(function installWebappUi(global) {
  'use strict';
  const host = global.__ntHost;
  const nt = global.__nt;
  if (!host || !nt) return;
  const document = global.document;
  const state = host.state;

  // ------------------------------------------------------------ utilities
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const isWs = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';

  // Split on `sep` outside quotes and brackets ("a, rgb(1,2,3)" -> 2 parts).
  function splitTop(text, sep) {
    const out = [];
    let depth = 0, quote = null, start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (depth === 0 && (sep === ' ' ? isWs(c) : c === sep)) {
        const part = text.slice(start, i).trim();
        if (part || sep !== ' ') out.push(part);
        start = i + 1;
      }
    }
    const last = text.slice(start).trim();
    if (last || (sep !== ' ' && out.length)) out.push(last);
    return sep === ' ' ? out.filter(Boolean) : out;
  }
  const unquote = (s) => {
    s = s.trim();
    if ((s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) s = s.slice(1, -1);
    return s.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, '$1');
  };

  // Game-folder paths: CSS url() is relative to the stylesheet, attributes
  // to the document. Returns 'dir/file.png', 'data:...' or null (internet).
  function resolveRef(baseDir, ref) {
    ref = String(ref || '').trim();
    if (!ref) return null;
    if (/^data:/i.test(ref)) return ref;
    if (/^(https?:)?\/\//i.test(ref) || /^(blob|javascript|about):/i.test(ref)) return null;
    ref = ref.replace(/^nt:\/\/game\//i, '/').replace(/[?#].*$/, '');
    try { ref = decodeURI(ref); } catch { /* keep raw */ }
    const parts = (ref[0] === '/' ? ref.slice(1) : baseDir + ref).split('/');
    const out = [];
    for (const p of parts) {
      if (p === '..') { if (!out.length) return null; out.pop(); } else if (p && p !== '.') out.push(p);
    }
    return out.length ? out.join('/') : null;
  }
  const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); };

  // ---------------------------------------------------------------- colours
  const NAMED = {
    transparent: [0, 0, 0, 0], black: '000', white: 'fff', red: 'f00', lime: '0f0', blue: '00f', yellow: 'ff0', cyan: '0ff', aqua: '0ff',
    magenta: 'f0f', fuchsia: 'f0f', gray: '808080', grey: '808080', silver: 'c0c0c0', maroon: '800000', olive: '808000', green: '008000',
    purple: '800080', teal: '008080', navy: '000080', orange: 'ffa500', aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aquamarine: '7fffd4',
    azure: 'f0ffff', beige: 'f5f5dc', bisque: 'ffe4c4', blanchedalmond: 'ffebcd', blueviolet: '8a2be2', brown: 'a52a2a', burlywood: 'deb887',
    cadetblue: '5f9ea0', chartreuse: '7fff00', chocolate: 'd2691e', coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc',
    crimson: 'dc143c', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b', darkgray: 'a9a9a9', darkgrey: 'a9a9a9',
    darkgreen: '006400', darkkhaki: 'bdb76b', darkmagenta: '8b008b', darkolivegreen: '556b2f', darkorange: 'ff8c00', darkorchid: '9932cc',
    darkred: '8b0000', darksalmon: 'e9967a', darkseagreen: '8fbc8f', darkslateblue: '483d8b', darkslategray: '2f4f4f', darkslategrey: '2f4f4f',
    darkturquoise: '00ced1', darkviolet: '9400d3', deeppink: 'ff1493', deepskyblue: '00bfff', dimgray: '696969', dimgrey: '696969',
    dodgerblue: '1e90ff', firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22', gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff',
    gold: 'ffd700', goldenrod: 'daa520', greenyellow: 'adff2f', honeydew: 'f0fff0', hotpink: 'ff69b4', indianred: 'cd5c5c', indigo: '4b0082',
    ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa', lavenderblush: 'fff0f5', lawngreen: '7cfc00', lemonchiffon: 'fffacd',
    lightblue: 'add8e6', lightcoral: 'f08080', lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3', lightgrey: 'd3d3d3',
    lightgreen: '90ee90', lightpink: 'ffb6c1', lightsalmon: 'ffa07a', lightseagreen: '20b2aa', lightskyblue: '87cefa', lightslategray: '778899',
    lightslategrey: '778899', lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', limegreen: '32cd32', linen: 'faf0e6', mediumaquamarine: '66cdaa',
    mediumblue: '0000cd', mediumorchid: 'ba55d3', mediumpurple: '9370db', mediumseagreen: '3cb371', mediumslateblue: '7b68ee',
    mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc', mediumvioletred: 'c71585', midnightblue: '191970', mintcream: 'f5fffa',
    mistyrose: 'ffe4e1', moccasin: 'ffe4b5', navajowhite: 'ffdead', oldlace: 'fdf5e6', olivedrab: '6b8e23', orangered: 'ff4500',
    orchid: 'da70d6', palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee', palevioletred: 'db7093', papayawhip: 'ffefd5',
    peachpuff: 'ffdab9', peru: 'cd853f', pink: 'ffc0cb', plum: 'dda0dd', powderblue: 'b0e0e6', rebeccapurple: '663399', rosybrown: 'bc8f8f',
    royalblue: '4169e1', saddlebrown: '8b4513', salmon: 'fa8072', sandybrown: 'f4a460', seagreen: '2e8b57', seashell: 'fff5ee',
    sienna: 'a0522d', skyblue: '87ceeb', slateblue: '6a5acd', slategray: '708090', slategrey: '708090', snow: 'fffafa',
    springgreen: '00ff7f', steelblue: '4682b4', tan: 'd2b48c', thistle: 'd8bfd8', tomato: 'ff6347', turquoise: '40e0d0', violet: 'ee82ee',
    wheat: 'f5deb3', whitesmoke: 'f5f5f5', yellowgreen: '9acd32',
    canvas: 'fff', canvastext: '000', buttonface: 'efefef', buttontext: '000', buttonborder: '767676', field: 'fff', fieldtext: '000',
    graytext: '6d6d6d', highlight: '3390ff', highlighttext: 'fff', linktext: '0000ee', visitedtext: '551a8b', activetext: 'ff0000',
  };
  function hexColor(h) {
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8 || /[^0-9a-f]/i.test(h)) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    if (!s) return [l, l, l];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
  }
  const colorCache = new Map();
  // -> [r,g,b,a] in 0..1, or null. `current` is the element's `color`.
  function parseColor(text, current) {
    if (text == null) return null;
    let s = String(text).trim().toLowerCase();
    if (s === 'currentcolor') return current || [0, 0, 0, 1];
    if (colorCache.has(s)) return colorCache.get(s);
    let out = null;
    if (s[0] === '#') out = hexColor(s.slice(1));
    else if (hasOwn(NAMED, s)) out = typeof NAMED[s] === 'string' ? hexColor(NAMED[s]) : NAMED[s];
    else {
      const m = /^(rgba?|hsla?|color-mix)\((.*)\)$/.exec(s);
      if (m && m[1] === 'color-mix') {
        // color-mix(in srgb, a 30%, b) — linear mix, enough for UI tints.
        const parts = splitTop(m[2], ',').slice(1).map((p) => {
          const pm = /^(.*?)\s+([\d.]+)%$/.exec(p.trim());
          return { c: parseColor(pm ? pm[1] : p, current), w: pm ? parseFloat(pm[2]) / 100 : null };
        });
        if (parts.length === 2 && parts[0].c && parts[1].c) {
          let w0 = parts[0].w, w1 = parts[1].w;
          if (w0 == null && w1 == null) { w0 = 0.5; w1 = 0.5; } else if (w0 == null) w0 = 1 - w1; else if (w1 == null) w1 = 1 - w0;
          const t = w0 + w1 || 1;
          out = [0, 1, 2, 3].map((i) => (parts[0].c[i] * w0 + parts[1].c[i] * w1) / t);
        }
      } else if (m) {
        const args = m[2].replace(/\//g, ' / ').split(/[\s,]+/).filter((a) => a && a !== '/');
        const num = (a, scale) => (a.endsWith('%') ? parseFloat(a) / 100 : parseFloat(a) / scale);
        if (args.length >= 3) {
          const alpha = args.length > 3 ? clamp(num(args[3], 1), 0, 1) : 1;
          if (m[1][0] === 'r') out = [num(args[0], 255), num(args[1], 255), num(args[2], 255), alpha].map((v) => clamp(v, 0, 1));
          else {
            const rgb = hslToRgb(parseFloat(args[0]) * (args[0].endsWith('turn') ? 360 : 1), clamp(num(args[1], 100), 0, 1), clamp(num(args[2], 100), 0, 1));
            out = [...rgb, alpha];
          }
          if (out.some((v) => Number.isNaN(v))) out = null;
        }
      }
    }
    if (colorCache.size > 4000) colorCache.clear();
    colorCache.set(s, out);
    return out;
  }

  // ------------------------------------------------------------ CSS parser
  function stripComments(css) {
    let out = '', i = 0;
    while (i < css.length) {
      const c = css[i];
      if (c === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i + 2); i = e < 0 ? css.length : e + 2; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < css.length && css[j] !== c) { if (css[j] === '\\') j++; if (css[j] === '\n') break; j++; }
        out += css.slice(i, j + 1); i = j + 1; continue;
      }
      out += c; i++;
    }
    return out;
  }
  // Index of the bracket that closes the one at `open`, honouring strings.
  function matchBrace(text, open) {
    let depth = 0, quote = null;
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '{') depth++;
      else if (c === '}') { if (--depth === 0) return i; }
    }
    return text.length;
  }
  function parseDeclarations(block) {
    const out = [];
    for (const part of splitTop(block, ';')) {
      const colon = part.indexOf(':');
      if (colon <= 0) continue;
      const prop = part.slice(0, colon).trim();
      let value = part.slice(colon + 1).trim();
      let important = false;
      const bang = /!\s*important\s*$/i.exec(value);
      if (bang) { important = true; value = value.slice(0, bang.index).trim(); }
      if (!prop || value === '') continue;
      out.push({ p: prop.startsWith('--') ? prop : prop.toLowerCase(), v: value, i: important });
    }
    return out;
  }
  let ruleOrder = 0;
  // Parsed sheet: { rules: [{ sel: [...complex], decls, order, media }], imports: [{ path, media }] }
  function parseSheet(css, baseDir, media) {
    const sheet = { rules: [], imports: [] };
    parseBlock(stripComments(css), baseDir, media || null, sheet);
    return sheet;
  }
  function parseBlock(text, baseDir, media, sheet) {
    let i = 0;
    while (i < text.length) {
      while (i < text.length && (isWs(text[i]) || text[i] === ';')) i++;
      if (i >= text.length) break;
      if (text[i] === '@') {
        const nameMatch = /^@([\w-]+)/.exec(text.slice(i, i + 40));
        const name = nameMatch ? nameMatch[1].toLowerCase() : '';
        const brace = text.indexOf('{', i), semi = text.indexOf(';', i);
        if (semi >= 0 && (brace < 0 || semi < brace)) {
          if (name === 'import') {
            const rest = text.slice(i + 7, semi).trim();
            const m = /^(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?\s*(.*)$/.exec(rest);
            if (m) {
              const path = resolveRef(baseDir, m[1]);
              if (path && !path.startsWith('data:')) sheet.imports.push({ path, media: joinMedia(media, m[2].trim() || null), order: ruleOrder++ });
            }
          }
          i = semi + 1; continue;
        }
        if (brace < 0) break;
        const close = matchBrace(text, brace);
        const prelude = text.slice(i + 1 + name.length, brace).trim();
        const inner = text.slice(brace + 1, close);
        if (name === 'media') parseBlock(inner, baseDir, joinMedia(media, prelude), sheet);
        else if (name === 'supports') { if (supportsCondition(prelude)) parseBlock(inner, baseDir, media, sheet); }
        else if (name === 'layer' || name === 'container' || name === 'scope' || name === 'document') parseBlock(inner, baseDir, media, sheet);
        // @font-face, @keyframes, @page, @property, @counter-style: not drawn.
        i = close + 1; continue;
      }
      const brace = text.indexOf('{', i);
      if (brace < 0) break;
      const close = matchBrace(text, brace);
      const selectorText = text.slice(i, brace).trim();
      const body = text.slice(brace + 1, close);
      i = close + 1;
      // CSS nesting (`&:hover {}` inside a rule) is rare in games; nested
      // blocks are dropped and only the plain declarations are used.
      const decls = parseDeclarations(body.indexOf('{') >= 0 ? body.replace(/[^;{}]*\{[^{}]*\}/g, '') : body);
      if (!decls.length) continue;
      const sel = parseSelectorList(selectorText);
      if (!sel.length) continue;
      sheet.rules.push({ sel, decls, order: ruleOrder++, media, baseDir });
    }
  }
  const joinMedia = (a, b) => (a && b ? `${a} and ${b}` : a || b || null);
  function supportsCondition(cond) {
    if (/selector\(/.test(cond)) return true;
    if (/^not\s/i.test(cond.trim())) return !supportsCondition(cond.trim().slice(4));
    const m = /\(\s*([\w-]+)\s*:/.exec(cond);
    if (!m) return true;
    return !/^(backdrop-filter|-webkit-backdrop-filter|container-type|anchor-name|view-transition-name)$/.test(m[1]);
  }

  // Media queries against the window size (CSS px = window px here).
  const mediaCache = new Map();
  function mediaMatches(query) {
    if (!query) return true;
    const key = `${state.width}x${state.height}|${query}`;
    let v = mediaCache.get(key);
    if (v === undefined) {
      v = splitTop(query, ',').some((q) => mediaQueryOne(q.trim().toLowerCase()));
      if (mediaCache.size > 2000) mediaCache.clear();
      mediaCache.set(key, v);
    }
    return v;
  }
  function mediaQueryOne(q) {
    let negate = false;
    if (q.startsWith('not ')) { negate = true; q = q.slice(4); }
    q = q.replace(/^only\s+/, '');
    let ok = true;
    for (const part of q.split(/\s+and\s+/)) {
      const p = part.trim();
      if (!p) continue;
      if (p === 'all' || p === 'screen') continue;
      if (p === 'print' || p === 'speech') { ok = false; break; }
      if (!mediaFeature(p.replace(/^\(|\)$/g, '').trim())) { ok = false; break; }
    }
    return negate ? !ok : ok;
  }
  function mediaLength(v) {
    v = v.trim();
    const n = parseFloat(v);
    if (v.endsWith('em') || v.endsWith('rem')) return n * 16;
    return n;
  }
  function mediaFeature(f) {
    const W = state.width, H = state.height;
    // Range syntax: (width >= 600px), (400px < width <= 800px)
    const range = /^(?:([\d.]+[a-z%]*)\s*(<=|<|>=|>)\s*)?(width|height|aspect-ratio)\s*(?:(<=|<|>=|>|=)\s*([\d.]+[a-z%]*))?$/.exec(f);
    if (range && (range[1] || range[5])) {
      const val = range[3] === 'width' ? W : range[3] === 'height' ? H : W / H;
      const cmp = (a, op, b) => (op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : op === '>=' ? a >= b : a === b);
      if (range[1] && !cmp(mediaLength(range[1]), range[2], val)) return false;
      if (range[5] && !cmp(val, range[4], mediaLength(range[5]))) return false;
      return true;
    }
    const i = f.indexOf(':');
    const name = (i < 0 ? f : f.slice(0, i)).trim(), value = i < 0 ? null : f.slice(i + 1).trim();
    switch (name) {
      case 'min-width': return W >= mediaLength(value);
      case 'max-width': return W <= mediaLength(value);
      case 'min-height': return H >= mediaLength(value);
      case 'max-height': return H <= mediaLength(value);
      case 'width': return value == null || Math.abs(W - mediaLength(value)) < 0.5;
      case 'height': return value == null || Math.abs(H - mediaLength(value)) < 0.5;
      case 'orientation': return value === (W >= H ? 'landscape' : 'portrait');
      case 'min-aspect-ratio': case 'max-aspect-ratio': case 'aspect-ratio': {
        const [a, b = '1'] = String(value).split('/');
        const r = parseFloat(a) / parseFloat(b), cur = W / H;
        return name[1] === 'i' ? cur >= r : name[1] === 'a' ? cur <= r : Math.abs(cur - r) < 0.01;
      }
      case 'hover': return value == null || value === 'hover';
      case 'any-hover': return value == null || value === 'hover';
      case 'pointer': case 'any-pointer': return value == null || value === 'fine';
      case 'prefers-color-scheme': return value === 'dark';
      case 'prefers-reduced-motion': return value === 'reduce';
      case 'prefers-contrast': return value === 'no-preference';
      case 'display-mode': return value === 'fullscreen' || value === 'standalone';
      case 'min-resolution': case 'max-resolution': case 'resolution': case '-webkit-min-device-pixel-ratio': case 'min-device-pixel-ratio': {
        const dpr = state.pixelRatio || 1;
        const r = String(value).endsWith('dpi') ? parseFloat(value) / 96 : parseFloat(value);
        return name.startsWith('max') ? dpr <= r : dpr >= r;
      }
      case 'color': case 'color-gamut': case 'update': case 'scan': case 'grid': return name !== 'grid';
      case 'forced-colors': case 'inverted-colors': return value === 'none';
      default: return false;
    }
  }

  // ---------------------------------------------------------- selectors
  // Complex selector: { parts: [{ comb, c: compound }], spec, pseudoEl }
  // compound: { tag, id, cls[], attrs[], pcs[] (pseudo-classes) }
  const selectorCache = new Map();
  function parseSelectorList(text) {
    if (selectorCache.has(text)) return selectorCache.get(text);
    const out = [];
    for (const g of splitTop(text, ',')) {
      const c = parseComplex(g.trim());
      if (c) out.push(c);
    }
    if (selectorCache.size > 20000) selectorCache.clear();
    selectorCache.set(text, out);
    return out;
  }
  function parseComplex(text) {
    if (!text) return null;
    const parts = [];
    let comb = ' ', i = 0, pseudoEl = null;
    let spec = 0;
    while (i < text.length) {
      while (i < text.length && isWs(text[i])) { i++; if (parts.length && comb === null) comb = ' '; }
      if (i >= text.length) break;
      const ch = text[i];
      if (ch === '>' || ch === '+' || ch === '~') { comb = ch; i++; continue; }
      const res = parseCompound(text, i);
      if (!res) return null;
      if (res.pseudoEl) {
        if (pseudoEl) return null;
        pseudoEl = res.pseudoEl;
      }
      parts.push({ comb: parts.length ? (comb || ' ') : ' ', c: res.c });
      spec += res.spec;
      comb = null;
      i = res.end;
    }
    if (!parts.length) return null;
    if (pseudoEl && pseudoEl !== 'before' && pseudoEl !== 'after') return { parts, spec, pseudoEl, never: true };
    return { parts, spec, pseudoEl };
  }
  // Specificity packed as a*10000 + b*100 + c.
  function parseCompound(text, start) {
    const c = { tag: null, id: null, cls: [], attrs: [], pcs: [] };
    let i = start, spec = 0, pseudoEl = null, any = false;
    const ident = () => {
      const m = /^(?:\\.|[\w -￿-])+/.exec(text.slice(i));
      if (!m) return null;
      i += m[0].length;
      return m[0].replace(/\\(.)/g, '$1');
    };
    while (i < text.length) {
      const ch = text[i];
      if (ch === '*') { i++; any = true; continue; }
      if (ch === '&') { i++; any = true; continue; }
      if (/[\w\\-]/.test(ch) || ch.charCodeAt(0) > 127) {
        if (any && c.tag) return null;
        c.tag = ident().toLowerCase(); spec += 1; any = true; continue;
      }
      if (ch === '#') { i++; c.id = ident(); if (c.id === null) return null; spec += 10000; any = true; continue; }
      if (ch === '.') { i++; const n = ident(); if (n === null) return null; c.cls.push(n); spec += 100; any = true; continue; }
      if (ch === '[') {
        const end = text.indexOf(']', i);
        if (end < 0) return null;
        const m = /^\[\s*([\w:-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*))\s*([is])?)?\s*\]$/.exec(text.slice(i, end + 1));
        if (!m) return null;
        c.attrs.push({ name: m[1].toLowerCase(), op: m[2] || null, value: m[3] ?? m[4] ?? m[5] ?? '', ci: m[6] === 'i' });
        i = end + 1; spec += 100; any = true; continue;
      }
      if (ch === ':') {
        const el = text[i + 1] === ':';
        i += el ? 2 : 1;
        const name = (ident() || '').toLowerCase();
        let arg = null;
        if (text[i] === '(') {
          let depth = 0, j = i;
          for (; j < text.length; j++) { if (text[j] === '(') depth++; else if (text[j] === ')' && --depth === 0) break; }
          arg = text.slice(i + 1, j);
          i = j + 1;
        }
        if (el || name === 'before' || name === 'after' || name === 'first-line' || name === 'first-letter') {
          pseudoEl = name; spec += 1; any = true; continue;
        }
        const pc = { name, arg };
        if (name === 'not' || name === 'is' || name === 'matches' || name === 'where' || name === '-webkit-any' || name === 'has') {
          pc.list = name === 'has' ? parseRelativeList(arg || '') : parseSelectorList(arg || '');
          if (name !== 'where') spec += pc.list.reduce((m, s) => Math.max(m, s.spec), 0);
        } else if (name.startsWith('nth-')) {
          const m = /^\s*(.*?)(?:\s+of\s+(.*))?\s*$/.exec(arg || '');
          pc.nth = parseNth(m[1]);
          if (m[2]) pc.of = parseSelectorList(m[2]);
          spec += 100;
        } else spec += 100;
        c.pcs.push(pc);
        any = true; continue;
      }
      break;
    }
    if (!any) return null;
    return { c, end: i, spec, pseudoEl };
  }
  function parseRelativeList(text) {
    return splitTop(text, ',').map((g) => {
      g = g.trim();
      let lead = ' ';
      if (/^[>+~]/.test(g)) { lead = g[0]; g = g.slice(1).trim(); }
      const c = parseComplex(g);
      if (c) c.lead = lead;
      return c;
    }).filter(Boolean);
  }
  function parseNth(t) {
    t = (t || '').replace(/\s+/g, '').toLowerCase();
    if (t === 'odd') return [2, 1];
    if (t === 'even') return [2, 0];
    const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(t);
    if (m) return [m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0];
    const n = parseInt(t, 10);
    return Number.isNaN(n) ? [0, -1] : [0, n];
  }
  const nthMatch = ([a, b], pos) => (a === 0 ? pos === b : (pos - b) / a >= 0 && (pos - b) % a === 0);

  // Interaction state used by :hover/:active/:focus.
  const interact = { hover: null, active: null };
  const isInChain = (el, target) => { for (let n = target; n; n = n.parentNode) if (n === el) return true; return false; };
  const elementChildren = (p) => (p ? p.childNodes.filter((c) => c.nodeType === 1) : []);

  function matchCompound(el, c) {
    if (c.tag && el.localName !== c.tag) return false;
    if (c.id !== null && el.getAttribute('id') !== c.id) return false;
    if (c.cls.length) {
      const cls = el._ntClassSet || classSet(el);
      for (const k of c.cls) if (!cls.has(k)) return false;
    }
    for (const a of c.attrs) {
      let v = el.getAttribute(a.name);
      if (v === null) return false;
      if (!a.op) continue;
      let want = a.value;
      if (a.ci) { v = v.toLowerCase(); want = want.toLowerCase(); }
      switch (a.op) {
        case '=': if (v !== want) return false; break;
        case '~=': if (!v.split(/\s+/).includes(want)) return false; break;
        case '^=': if (!want || !v.startsWith(want)) return false; break;
        case '$=': if (!want || !v.endsWith(want)) return false; break;
        case '*=': if (!want || !v.includes(want)) return false; break;
        case '|=': if (v !== want && !v.startsWith(want + '-')) return false; break;
      }
    }
    for (const p of c.pcs) if (!matchPseudo(el, p)) return false;
    return true;
  }
  function classSet(el) {
    const s = new Set((el.getAttribute('class') || '').split(/\s+/).filter(Boolean));
    el._ntClassSet = s;
    return s;
  }
  function isDisabled(el) {
    if (!/^(button|input|select|textarea|option|fieldset)$/.test(el.localName)) return false;
    if (el.hasAttribute('disabled') || el._disabled) return true;
    return false;
  }
  function matchPseudo(el, p) {
    switch (p.name) {
      case 'not': return !p.list.some((s) => matchSelector(el, s));
      case 'is': case 'matches': case 'where': case '-webkit-any': return p.list.some((s) => matchSelector(el, s));
      case 'has': return p.list.some((s) => matchHas(el, s));
      case 'first-child': return elementChildren(el.parentNode)[0] === el;
      case 'last-child': { const k = elementChildren(el.parentNode); return k[k.length - 1] === el; }
      case 'only-child': return elementChildren(el.parentNode).length === 1;
      case 'first-of-type': return elementChildren(el.parentNode).find((e) => e.localName === el.localName) === el;
      case 'last-of-type': { const k = elementChildren(el.parentNode).filter((e) => e.localName === el.localName); return k[k.length - 1] === el; }
      case 'only-of-type': return elementChildren(el.parentNode).filter((e) => e.localName === el.localName).length === 1;
      case 'nth-child': case 'nth-last-child': case 'nth-of-type': case 'nth-last-of-type': {
        let sibs = elementChildren(el.parentNode);
        if (p.name.endsWith('of-type')) sibs = sibs.filter((e) => e.localName === el.localName);
        if (p.of) sibs = sibs.filter((e) => p.of.some((s) => matchSelector(e, s)));
        let idx = sibs.indexOf(el);
        if (idx < 0) return false;
        if (p.name.includes('last')) idx = sibs.length - 1 - idx;
        return nthMatch(p.nth, idx + 1);
      }
      case 'empty': return !el.childNodes.some((n) => n.nodeType === 1 || (n.nodeType === 3 && n.data.length));
      case 'root': return el === document.documentElement;
      case 'scope': return el === document.documentElement;
      case 'hover': return !!interact.hover && isInChain(el, interact.hover);
      case 'active': return !!interact.active && isInChain(el, interact.active);
      case 'focus': return document.activeElement === el && el !== document.body;
      case 'focus-visible': return false;
      case 'focus-within': return !!document.activeElement && document.activeElement !== document.body && isInChain(el, document.activeElement);
      case 'disabled': return isDisabled(el);
      case 'enabled': return /^(button|input|select|textarea|option|fieldset)$/.test(el.localName) && !isDisabled(el);
      case 'checked': return el.localName === 'option' ? el.hasAttribute('selected') : !!el.checked;
      case 'indeterminate': return false;
      case 'link': case 'any-link': return el.localName === 'a' && el.hasAttribute('href');
      case 'visited': case 'target': case 'fullscreen': case 'modal': case 'popover-open': case 'user-invalid': case 'invalid': return false;
      case 'valid': case 'defined': return true;
      case 'open': return el.hasAttribute('open');
      case 'closed': return !el.hasAttribute('open');
      case 'placeholder-shown': return el.hasAttribute('placeholder') && !(el.value || '');
      case 'read-only': return el.hasAttribute('readonly');
      case 'read-write': return /^(input|textarea)$/.test(el.localName) && !el.hasAttribute('readonly');
      case 'required': return el.hasAttribute('required');
      case 'optional': return /^(input|select|textarea)$/.test(el.localName) && !el.hasAttribute('required');
      case 'lang': {
        const want = unquote(p.arg || '').toLowerCase();
        for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
          const l = n.getAttribute('lang');
          if (l !== null) return l.toLowerCase() === want || l.toLowerCase().startsWith(want + '-');
        }
        return false;
      }
      case 'dir': return (p.arg || '').trim() === 'ltr';
      default:
        if (!warnedPseudo.has(p.name)) { warnedPseudo.add(p.name); host.warnOnce(`ui-pseudo-${p.name}`, `CSS :${p.name} is not supported by the UI layer (rule skipped)`); }
        return false;
    }
  }
  const warnedPseudo = new Set();
  function matchHas(el, rel) {
    const test = (cand) => matchSelector(cand, rel);
    if (rel.lead === '>') return elementChildren(el).some(test);
    if (rel.lead === '+') { const n = el.nextElementSibling; return !!n && test(n); }
    if (rel.lead === '~') { for (let n = el.nextElementSibling; n; n = n.nextElementSibling) if (test(n)) return true; return false; }
    const stack = elementChildren(el).slice();
    while (stack.length) {
      const n = stack.pop();
      if (test(n)) return true;
      for (const c of n.childNodes) if (c.nodeType === 1) stack.push(c);
    }
    return false;
  }
  function matchSelector(el, sel) {
    if (sel.never) return false;
    return matchFrom(el, sel.parts, sel.parts.length - 1);
  }
  function matchFrom(el, parts, idx) {
    if (!el || el.nodeType !== 1 || !matchCompound(el, parts[idx].c)) return false;
    if (idx === 0) return true;
    const comb = parts[idx].comb;
    if (comb === '>') return matchFrom(el.parentNode, parts, idx - 1);
    if (comb === ' ') {
      for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) if (matchFrom(p, parts, idx - 1)) return true;
      return false;
    }
    if (comb === '+') return matchFrom(prevElement(el), parts, idx - 1);
    if (comb === '~') { for (let s = prevElement(el); s; s = prevElement(s)) if (matchFrom(s, parts, idx - 1)) return true; return false; }
    return false;
  }
  function prevElement(el) {
    const p = el.parentNode;
    if (!p) return null;
    const sibs = p.childNodes;
    for (let i = sibs.indexOf(el) - 1; i >= 0; i--) if (sibs[i].nodeType === 1) return sibs[i];
    return null;
  }

  // ---------------------------------------------------- values & lengths
  const ctx = { vw: 1280, vh: 720, rootFs: 16 };
  // Resolves a CSS length/calc() to px. `base` resolves %, `fs` resolves em.
  // Returns NaN for auto/none/invalid.
  function px(value, base, fs) {
    if (value == null) return NaN;
    if (typeof value === 'number') return value;
    const s = String(value).trim();
    if (!s) return NaN;
    const c = s.charCodeAt(0);
    if ((c >= 48 && c <= 57) || c === 46 || c === 45 || c === 43) {
      const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/i.exec(s);
      if (m) return unitToPx(parseFloat(m[1]), m[2].toLowerCase(), base, fs);
    }
    if (/^(calc|min|max|clamp|-webkit-calc)\(/i.test(s)) {
      try { const v = new CalcParser(s, base, fs).parse(); return typeof v === 'number' ? v : NaN; } catch { return NaN; }
    }
    if (/^env\(/i.test(s)) { const parts = splitTop(s.slice(4, -1), ','); return parts.length > 1 ? px(parts.slice(1).join(','), base, fs) : 0; }
    return NaN;
  }
  function unitToPx(n, unit, base, fs) {
    switch (unit) {
      case 'px': case '': return n;
      case '%': return base == null || Number.isNaN(base) ? NaN : (n * base) / 100;
      case 'em': return n * (fs || 16);
      case 'rem': return n * ctx.rootFs;
      case 'vw': case 'svw': case 'lvw': case 'dvw': return (n * ctx.vw) / 100;
      case 'vh': case 'svh': case 'lvh': case 'dvh': return (n * ctx.vh) / 100;
      case 'vmin': return (n * Math.min(ctx.vw, ctx.vh)) / 100;
      case 'vmax': return (n * Math.max(ctx.vw, ctx.vh)) / 100;
      case 'pt': return (n * 4) / 3;
      case 'pc': return n * 16;
      case 'in': return n * 96;
      case 'cm': return (n * 96) / 2.54;
      case 'mm': return (n * 96) / 25.4;
      case 'q': return (n * 96) / 101.6;
      case 'ch': return n * (fs || 16) * 0.5;
      case 'ex': return n * (fs || 16) * 0.5;
      case 'lh': return n * (fs || 16) * 1.2;
      case 'cqw': case 'cqi': return base == null ? (n * ctx.vw) / 100 : (n * base) / 100;
      case 'cqh': case 'cqb': return (n * ctx.vh) / 100;
      default: return NaN;
    }
  }
  // calc() with + - * / ( ) and min/max/clamp/env nested.
  class CalcParser {
    constructor(text, base, fs) { this.t = text; this.i = 0; this.base = base; this.fs = fs; }
    ws() { while (this.i < this.t.length && isWs(this.t[this.i])) this.i++; }
    parse() { this.ws(); const v = this.sum(); return v; }
    sum() {
      let v = this.product();
      for (;;) {
        this.ws();
        const ch = this.t[this.i];
        if (ch === '+' || (ch === '-' && !/[\d.]/.test(this.t[this.i + 1] || '') ) || (ch === '-' && isWs(this.t[this.i - 1] || ' '))) {
          this.i++;
          const r = this.product();
          v = ch === '+' ? v + r : v - r;
        } else return v;
      }
    }
    product() {
      let v = this.unary();
      for (;;) {
        this.ws();
        const ch = this.t[this.i];
        if (ch === '*' || ch === '/') { this.i++; const r = this.unary(); v = ch === '*' ? v * r : v / r; } else return v;
      }
    }
    unary() {
      this.ws();
      const rest = this.t.slice(this.i);
      const fn = /^([a-z-]+)\(/i.exec(rest);
      if (fn) {
        const name = fn[1].toLowerCase();
        this.i += fn[0].length;
        const args = [];
        for (;;) {
          this.ws();
          args.push(name === 'env' ? this.envArg() : this.sum());
          this.ws();
          if (this.t[this.i] === ',') { this.i++; continue; }
          if (this.t[this.i] === ')') { this.i++; break; }
          throw new Error('calc');
        }
        switch (name) {
          case 'calc': case '-webkit-calc': return args[0];
          case 'min': return Math.min(...args);
          case 'max': return Math.max(...args);
          case 'clamp': return Math.max(args[0], Math.min(args[1], args[2]));
          case 'env': return args.length > 1 ? args[1] : 0;
          case 'abs': return Math.abs(args[0]);
          case 'round': return Math.round(args[args.length > 1 ? 1 : 0]);
          default: throw new Error('calc fn');
        }
      }
      if (this.t[this.i] === '(') { this.i++; const v = this.sum(); this.ws(); this.i++; return v; }
      const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)/i.exec(rest);
      if (!m) throw new Error('calc token');
      this.i += m[0].length;
      const v = unitToPx(parseFloat(m[1]), m[2].toLowerCase(), this.base, this.fs);
      if (Number.isNaN(v)) throw new Error('calc unit');
      return v;
    }
    envArg() { const m = /^[\w-]+/.exec(this.t.slice(this.i)); if (m) this.i += m[0].length; return 0; }
  }

  // ------------------------------------------------------------- cascade
  const INHERITED = new Set(['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'line-height',
    'letter-spacing', 'word-spacing', 'text-align', 'text-transform', 'white-space', 'visibility', 'cursor', 'pointer-events',
    'word-break', 'overflow-wrap', 'word-wrap', 'text-shadow', 'direction', 'list-style-type', 'text-indent', 'text-wrap',
    '-webkit-text-fill-color', 'font-stretch', 'tab-size', 'hyphens', 'caret-color', 'accent-color']);
  const DEFAULTS = {
    display: 'inline', position: 'static', 'box-sizing': 'content-box', color: '#000', opacity: '1', visibility: 'visible',
    'font-size': '16px', 'font-weight': '400', 'font-style': 'normal', 'font-family': 'Segoe UI', 'line-height': 'normal',
    'text-align': 'start', 'white-space': 'normal', 'pointer-events': 'auto', 'flex-direction': 'row', 'flex-wrap': 'nowrap',
    'justify-content': 'normal', 'align-items': 'normal', 'align-content': 'normal', 'flex-grow': '0', 'flex-shrink': '1', 'flex-basis': 'auto',
    'background-repeat': 'repeat', 'background-size': 'auto', 'background-position': '0% 0%', 'object-fit': 'fill',
    'z-index': 'auto', 'overflow-x': 'visible', 'overflow-y': 'visible', 'letter-spacing': 'normal',
  };
  // Shorthand expansion. `set(prop, value)` receives longhands.
  const SIDES = ['top', 'right', 'bottom', 'left'];
  function boxValues(v) {
    const p = splitTop(v, ' ');
    if (!p.length) return null;
    return [p[0], p[1] ?? p[0], p[2] ?? p[0], p[3] ?? p[1] ?? p[0]];
  }
  const BORDER_STYLES = /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/i;
  function borderParts(v) {
    let width = 'medium', style = 'none', color = 'currentcolor';
    for (const t of splitTop(v, ' ')) {
      if (BORDER_STYLES.test(t)) style = t.toLowerCase();
      else if (/^(thin|medium|thick)$/i.test(t) || !Number.isNaN(px(t, 0, 16))) width = t;
      else color = t;
    }
    return { width, style, color };
  }
  function expandShorthand(prop, v, set) {
    const lower = v.trim().toLowerCase();
    const global = lower === 'inherit' || lower === 'initial' || lower === 'unset' || lower === 'revert' || lower === 'revert-layer';
    const all = (props) => { for (const p of props) set(p, v); return true; };
    switch (prop) {
      case 'margin': case 'padding': {
        if (global) return all(SIDES.map((s) => `${prop}-${s}`));
        const b = boxValues(v); if (b) SIDES.forEach((s, i) => set(`${prop}-${s}`, b[i])); return true;
      }
      case 'inset': {
        if (global) return all(SIDES);
        const b = boxValues(v); if (b) SIDES.forEach((s, i) => set(s, b[i])); return true;
      }
      case 'margin-inline': case 'padding-inline': case 'margin-block': case 'padding-block': case 'inset-inline': case 'inset-block': {
        const base = prop.startsWith('inset') ? '' : prop.split('-')[0] + '-';
        const p = splitTop(v, ' ');
        const sides = prop.endsWith('inline') ? ['left', 'right'] : ['top', 'bottom'];
        set(base + sides[0], p[0]); set(base + sides[1], p[1] ?? p[0]); return true;
      }
      case 'margin-inline-start': set('margin-left', v); return true;
      case 'margin-inline-end': set('margin-right', v); return true;
      case 'margin-block-start': set('margin-top', v); return true;
      case 'margin-block-end': set('margin-bottom', v); return true;
      case 'padding-inline-start': set('padding-left', v); return true;
      case 'padding-inline-end': set('padding-right', v); return true;
      case 'padding-block-start': set('padding-top', v); return true;
      case 'padding-block-end': set('padding-bottom', v); return true;
      case 'inset-inline-start': set('left', v); return true;
      case 'inset-inline-end': set('right', v); return true;
      case 'inset-block-start': set('top', v); return true;
      case 'inset-block-end': set('bottom', v); return true;
      case 'inline-size': set('width', v); return true;
      case 'block-size': set('height', v); return true;
      case 'min-inline-size': set('min-width', v); return true;
      case 'max-inline-size': set('max-width', v); return true;
      case 'min-block-size': set('min-height', v); return true;
      case 'max-block-size': set('max-height', v); return true;
      case 'border': case 'border-top': case 'border-right': case 'border-bottom': case 'border-left':
      case 'border-inline': case 'border-block': case 'border-inline-start': case 'border-inline-end': case 'border-block-start': case 'border-block-end': {
        const sides = prop === 'border' ? SIDES : prop === 'border-inline' ? ['left', 'right'] : prop === 'border-block' ? ['top', 'bottom']
          : prop === 'border-inline-start' ? ['left'] : prop === 'border-inline-end' ? ['right'] : prop === 'border-block-start' ? ['top']
          : prop === 'border-block-end' ? ['bottom'] : [prop.slice(7)];
        if (global) { for (const s of sides) { set(`border-${s}-width`, v); set(`border-${s}-style`, v); set(`border-${s}-color`, v); } return true; }
        const b = borderParts(v);
        for (const s of sides) { set(`border-${s}-width`, b.width); set(`border-${s}-style`, b.style); set(`border-${s}-color`, b.color); }
        return true;
      }
      case 'border-width': case 'border-style': case 'border-color': {
        const kind = prop.slice(7);
        if (global) return all(SIDES.map((s) => `border-${s}-${kind}`));
        const b = boxValues(v); if (b) SIDES.forEach((s, i) => set(`border-${s}-${kind}`, b[i])); return true;
      }
      case 'border-radius': {
        const corners = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'];
        if (global) return all(corners);
        const b = boxValues(splitTop(v, '/')[0]); if (b) corners.forEach((c, i) => set(c, b[i])); return true;
      }
      case 'background': {
        if (global) return all(['background-color', 'background-image', 'background-size', 'background-position', 'background-repeat']);
        const layers = splitTop(v, ',');
        const images = [], sizes = [], positions = [], repeats = [];
        let color = 'transparent';
        layers.forEach((layer, li) => {
          let image = 'none', size = 'auto', pos = [], repeat = 'repeat';
          const toks = splitTop(layer, ' ');
          for (let k = 0; k < toks.length; k++) {
            const t = toks[k], tl = t.toLowerCase();
            if (/^(url|linear-gradient|radial-gradient|repeating-linear-gradient|repeating-radial-gradient|conic-gradient|image-set|-webkit-image-set|-webkit-linear-gradient|-webkit-radial-gradient)\(/i.test(t) || tl === 'none') image = t;
            else if (/^(repeat|repeat-x|repeat-y|no-repeat|space|round)$/.test(tl)) repeat = repeat !== 'repeat' && repeat !== tl ? `${repeat} ${tl}` : tl;
            else if (/^(scroll|fixed|local|border-box|padding-box|content-box|text)$/.test(tl)) { /* ignored */ }
            else if (t === '/') { size = toks[k + 1] || 'auto'; k++; if (toks[k + 1] && !/^(repeat|no-repeat|repeat-x|repeat-y|scroll|fixed|border-box|padding-box|content-box)$/i.test(toks[k + 1]) && parseColor(toks[k + 1]) === null) { size += ' ' + toks[k + 1]; k++; } }
            else if (t.includes('/')) { const [a, b] = t.split('/'); if (a) pos.push(a); size = b || 'auto'; if (toks[k + 1] && !Number.isNaN(px(toks[k + 1], 100, 16)) || toks[k + 1] === 'auto') { size += ' ' + toks[k + 1]; k++; } }
            else if (/^(left|right|top|bottom|center)$/.test(tl) || !Number.isNaN(px(t, 100, 16))) pos.push(t);
            else if (li === layers.length - 1 && parseColor(t)) color = t;
          }
          images.push(image); sizes.push(size); positions.push(pos.length ? pos.join(' ') : '0% 0%'); repeats.push(repeat);
        });
        set('background-image', images.join(', ')); set('background-size', sizes.join(', '));
        set('background-position', positions.join(', ')); set('background-repeat', repeats.join(', '));
        set('background-color', color);
        return true;
      }
      case 'font': {
        if (global) return all(['font-style', 'font-weight', 'font-size', 'line-height', 'font-family']);
        if (/^(caption|icon|menu|message-box|small-caption|status-bar)$/.test(lower)) { set('font-family', 'Segoe UI'); set('font-size', '13px'); return true; }
        const toks = splitTop(v, ' ');
        let k = 0, style = 'normal', weight = '400';
        for (; k < toks.length; k++) {
          const t = toks[k].toLowerCase();
          if (t === 'italic' || t === 'oblique') style = t;
          else if (t === 'bold' || t === 'bolder' || t === 'lighter' || /^[1-9]00$/.test(t)) weight = t;
          else if (t === 'normal' || t === 'small-caps' || /^(ultra-|extra-|semi-)?(condensed|expanded)$/.test(t)) continue;
          else break;
        }
        const sizePart = toks[k] || '16px';
        const [size, lh] = sizePart.split('/');
        let lineHeight = lh;
        let rest = toks.slice(k + 1);
        if (!lineHeight && rest[0] === '/') { lineHeight = rest[1]; rest = rest.slice(2); } else if (!lineHeight && rest[0] && rest[0].startsWith('/')) { lineHeight = rest[0].slice(1); rest = rest.slice(1); }
        set('font-style', style); set('font-weight', weight); set('font-size', size);
        set('line-height', lineHeight || 'normal');
        if (rest.length) set('font-family', rest.join(' '));
        return true;
      }
      case 'flex': {
        if (global) return all(['flex-grow', 'flex-shrink', 'flex-basis']);
        if (lower === 'none') { set('flex-grow', '0'); set('flex-shrink', '0'); set('flex-basis', 'auto'); return true; }
        if (lower === 'auto') { set('flex-grow', '1'); set('flex-shrink', '1'); set('flex-basis', 'auto'); return true; }
        const t = splitTop(v, ' ');
        let grow = '1', shrink = '1', basis = '0%';
        const isNum = (x) => /^[+-]?(\d+\.?\d*|\.\d+)$/.test(x);
        if (t.length === 1) { if (isNum(t[0])) grow = t[0]; else { basis = t[0]; } }
        else if (t.length === 2) { grow = t[0]; if (isNum(t[1])) shrink = t[1]; else basis = t[1]; }
        else { grow = t[0]; shrink = t[1]; basis = t[2]; }
        set('flex-grow', grow); set('flex-shrink', shrink); set('flex-basis', basis);
        return true;
      }
      case 'flex-flow': {
        for (const t of splitTop(v, ' ')) {
          if (/wrap/.test(t)) set('flex-wrap', t); else set('flex-direction', t);
        }
        return true;
      }
      case 'gap': case 'grid-gap': {
        const t = splitTop(v, ' '); set('row-gap', t[0]); set('column-gap', t[1] ?? t[0]); return true;
      }
      case 'grid-row-gap': set('row-gap', v); return true;
      case 'grid-column-gap': set('column-gap', v); return true;
      case 'place-items': { const t = splitTop(v, ' '); set('align-items', t[0]); set('justify-items', t[1] ?? t[0]); return true; }
      case 'place-content': { const t = splitTop(v, ' '); set('align-content', t[0]); set('justify-content', t[1] ?? t[0]); return true; }
      case 'place-self': { const t = splitTop(v, ' '); set('align-self', t[0]); set('justify-self', t[1] ?? t[0]); return true; }
      case 'overflow': { const t = splitTop(v, ' '); set('overflow-x', t[0]); set('overflow-y', t[1] ?? t[0]); return true; }
      case 'grid-column': case 'grid-row': {
        const [a, b] = v.split('/').map((s) => s.trim());
        set(`${prop}-start`, a); set(`${prop}-end`, b ?? (a && a.startsWith('span') ? 'auto' : /^-?\d+$/.test(a) ? 'auto' : a)); return true;
      }
      case 'grid-area': {
        const p = v.split('/').map((s) => s.trim());
        set('grid-row-start', p[0]); set('grid-column-start', p[1] ?? (/^-?\d+$/.test(p[0]) ? 'auto' : p[0]));
        set('grid-row-end', p[2] ?? 'auto'); set('grid-column-end', p[3] ?? 'auto'); return true;
      }
      case 'grid-template': {
        const [rows, cols] = v.split('/').map((s) => s.trim());
        set('grid-template-rows', rows); if (cols) set('grid-template-columns', cols); return true;
      }
      case 'grid': {
        const [rows, cols] = v.split('/').map((s) => s.trim());
        if (cols !== undefined) { set('grid-template-rows', rows); set('grid-template-columns', cols); }
        return true;
      }
      case 'text-decoration': {
        const t = splitTop(v, ' ').map((x) => x.toLowerCase());
        set('text-decoration-line', t.filter((x) => /^(none|underline|overline|line-through)$/.test(x)).join(' ') || 'none');
        return true;
      }
      case 'word-wrap': set('overflow-wrap', v); return true;
      case 'columns': case 'column-count': case 'list-style': case 'outline': case 'transition': case 'animation':
      case 'mask': case '-webkit-mask': case 'border-image': case 'scroll-margin': case 'scroll-padding':
        return true; // not drawn
    }
    return false;
  }

  // User-agent stylesheet (Chromium-like defaults for what games use).
  const UA_CSS = `
html,address,blockquote,body,dd,div,dl,dt,fieldset,form,frame,frameset,h1,h2,h3,h4,h5,h6,noframes,ol,p,ul,center,dir,hr,menu,pre,
header,footer,nav,main,section,article,aside,figure,figcaption,hgroup,legend,details,summary,dialog,search,address{display:block}
li{display:list-item}
head,script,style,link,meta,title,template,noscript,datalist,param,base,area,[hidden],dialog:not([open]),input[type=hidden]{display:none}
table{display:table}tr{display:table-row}td,th{display:table-cell}thead,tbody,tfoot{display:table-row-group}caption{display:block}
body{margin:8px}
p,dl,blockquote,figure{margin:1em 0}
h1{font-size:2em;margin:.67em 0;font-weight:bold}h2{font-size:1.5em;margin:.83em 0;font-weight:bold}
h3{font-size:1.17em;margin:1em 0;font-weight:bold}h4{margin:1.33em 0;font-weight:bold}
h5{font-size:.83em;margin:1.67em 0;font-weight:bold}h6{font-size:.67em;margin:2.33em 0;font-weight:bold}
ul,ol,menu{margin:1em 0;padding-left:40px}
b,strong,th{font-weight:bold}i,em,cite,var,dfn{font-style:italic}
small{font-size:smaller}big{font-size:larger}sub,sup{font-size:smaller}
code,kbd,samp,pre,tt{font-family:monospace}pre{white-space:pre;margin:1em 0}
u,ins{text-decoration:underline}s,strike,del{text-decoration:line-through}
a:any-link{color:#0000ee;text-decoration:underline;cursor:pointer}
hr{border:1px inset #888;margin:.5em 0}
button,input,select,textarea{display:inline-block;font:13.333px Arial;color:fieldtext;letter-spacing:normal;text-align:start}
button{padding:1px 6px;border:2px outset buttonborder;background-color:buttonface;color:buttontext;text-align:center;cursor:default}
input,textarea{padding:1px 2px;border:2px inset #767676;background-color:field}
input{width:153px;height:15px}
input[type=checkbox],input[type=radio]{width:13px;height:13px;margin:3px 3px 3px 4px;padding:0;border:1px solid #767676;background-color:#fff}
input[type=range]{width:129px;height:16px;padding:0;border:0;background-color:transparent}
input[type=button],input[type=submit],input[type=reset]{width:auto;height:auto;padding:1px 6px;border:2px outset buttonborder;background-color:buttonface;text-align:center}
select{padding:1px 2px;border:1px solid #767676;border-radius:3px;background-color:field;height:19px}
textarea{width:178px;height:32px;white-space:pre-wrap}
progress,meter{display:inline-block;width:160px;height:16px;vertical-align:-.2em}
img,canvas,video,svg,iframe,embed,object{display:inline}
summary{display:block;cursor:pointer}
details:not([open])>:not(summary){display:none}
dialog[open]{position:absolute;left:0;right:0;width:fit-content;height:fit-content;margin:auto;border:solid;padding:1em;background-color:canvas;color:canvastext}
fieldset{margin:0 2px;padding:.35em .75em .625em;border:2px groove #c0c0c0}
legend{padding:0 2px}
optgroup,option{display:none}
label{cursor:default}
center{text-align:center}
`;
  const uaSheet = parseSheet(UA_CSS, '', null);
  for (const r of uaSheet.rules) r.ua = true;

  // ---- stylesheet collection (cached by text)
  const parsedByText = new Map();
  let sheets = [];          // [{ sheet, media }]
  let sheetSignature = '';
  let ruleIndex = null;
  let pseudoIndex = null;
  let hoverRules = false;
  function readCss(path) {
    try { return nt.readText(path); } catch (e) { host.warnOnce(`ui-css-${path}`, `Stylesheet not found in game folder: ${path}`); return null; }
  }
  function sheetFor(text, baseDir, cacheKey) {
    const key = cacheKey || `${baseDir}\u0000${text}`;
    let s = parsedByText.get(key);
    if (!s) { s = parseSheet(text, baseDir, null); parsedByText.set(key, s); }
    return s;
  }
  function collectSheets() {
    const nodes = [];
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue;
        const tag = c.localName;
        if (tag === 'style') nodes.push(c);
        else if (tag === 'link' && /(^|\s)stylesheet(\s|$)/i.test(c.getAttribute('rel') || '') && !c.hasAttribute('disabled')) nodes.push(c);
        if (tag !== 'svg' && tag !== 'template') walk(c);
      }
    })(document);
    let sig = '';
    for (const n of nodes) sig += n.localName === 'style' ? `s${n.textContent.length}:${hashText(n.textContent)}|` : `l${n.getAttribute('href')}|${n.getAttribute('media') || ''}|`;
    if (sig === sheetSignature && ruleIndex) return false;
    sheetSignature = sig;
    sheets = [{ sheet: uaSheet, media: null }];
    const seen = new Set();
    const addImports = (sheet, depth) => {
      for (const imp of sheet.imports) {
        if (depth > 8 || seen.has(imp.path)) continue;
        seen.add(imp.path);
        const text = readCss(imp.path);
        if (text == null) continue;
        const s = sheetFor(text, dirOf(imp.path), `file:${imp.path}`);
        addImports(s, depth + 1);
        sheets.push({ sheet: s, media: imp.media });
      }
    };
    for (const n of nodes) {
      const media = n.getAttribute('media');
      if (n.localName === 'style') {
        const s = sheetFor(n.textContent, '');
        addImports(s, 0);
        sheets.push({ sheet: s, media: media && media !== 'all' ? media : null });
      } else {
        const path = resolveRef('', n.getAttribute('href'));
        if (!path || path.startsWith('data:')) continue;
        const text = readCss(path);
        if (text == null) continue;
        const s = sheetFor(text, dirOf(path), `file:${path}`);
        addImports(s, 0);
        sheets.push({ sheet: s, media: media && media !== 'all' ? media : null });
      }
    }
    buildIndex();
    return true;
  }
  function hashText(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }
  function buildIndex() {
    ruleIndex = { id: new Map(), cls: new Map(), tag: new Map(), any: [] };
    pseudoIndex = { id: new Map(), cls: new Map(), tag: new Map(), any: [] };
    hoverRules = false;
    let seq = 0;
    for (const { sheet, media } of sheets) {
      for (const rule of sheet.rules) {
        for (const sel of rule.sel) {
          if (sel.never) continue;
          const entry = { sel, rule, spec: sel.spec, order: seq++, media: joinMedia(media, rule.media) };
          if (!hoverRules && /hover|active|focus/.test(JSON.stringify(sel.parts.map((p) => p.c.pcs.map((x) => x.name))))) hoverRules = true;
          const last = sel.parts[sel.parts.length - 1].c;
          const idx = sel.pseudoEl ? pseudoIndex : ruleIndex;
          if (last.id !== null) push(idx.id, last.id, entry);
          else if (last.cls.length) push(idx.cls, last.cls[0], entry);
          else if (last.tag) push(idx.tag, last.tag, entry);
          else idx.any.push(entry);
        }
      }
    }
  }
  const push = (map, key, v) => { const l = map.get(key); if (l) l.push(v); else map.set(key, [v]); };
  function candidates(idx, el) {
    const out = idx.any.slice();
    const t = idx.tag.get(el.localName); if (t) for (const e of t) out.push(e);
    const id = el.getAttribute('id');
    if (id) { const l = idx.id.get(id); if (l) for (const e of l) out.push(e); }
    const cls = el._ntClassSet || classSet(el);
    for (const c of cls) { const l = idx.cls.get(c); if (l) for (const e of l) out.push(e); }
    return out;
  }

  // var() substitution with fallbacks; cycles resolve to the fallback.
  function substituteVars(value, custom, depth = 0) {
    if (value.indexOf('var(') < 0) return value;
    if (depth > 16) return '';
    let out = '', i = 0;
    for (;;) {
      const at = value.indexOf('var(', i);
      if (at < 0) { out += value.slice(i); break; }
      out += value.slice(i, at);
      let d = 0, j = at + 3;
      for (; j < value.length; j++) { if (value[j] === '(') d++; else if (value[j] === ')' && --d === 0) break; }
      const inner = value.slice(at + 4, j);
      const comma = splitTop(inner, ',');
      const name = comma[0].trim();
      const fallback = comma.length > 1 ? inner.slice(inner.indexOf(',') + 1) : null;
      let v = custom[name];
      if (v !== undefined && v !== null) v = substituteVars(String(v), custom, depth + 1);
      if ((v === undefined || v === null || v === '' ) && fallback !== null) v = substituteVars(fallback.trim(), custom, depth + 1);
      if (v === undefined || v === null) return '';
      out += v;
      i = j + 1;
    }
    return out;
  }

  const inlineCache = new Map();
  function inlineDecls(el) {
    const text = el.style && el.style.cssText;
    if (!text) return null;
    let d = inlineCache.get(text);
    if (!d) { d = parseDeclarations(text); if (inlineCache.size > 5000) inlineCache.clear(); inlineCache.set(text, d); }
    return d;
  }

  // Computed style: plain object of longhand strings + __fs (font px) + __custom.
  function cascade(el, entries, inline, parent) {
    const list = [];
    for (const e of entries) {
      const ua = e.rule.ua;
      const decls = e.rule.decls;
      for (let k = 0; k < decls.length; k++) {
        const d = decls[k];
        const w = ua ? (d.i ? -2e9 : -3e9) + e.spec : d.i ? 2e9 + e.spec : e.spec;
        list.push({ d, w, o: e.order * 256 + k, base: e.rule.baseDir });
      }
    }
    if (inline) inline.forEach((d, k) => list.push({ d, w: d.i ? 3e9 : 1e9, o: 1e12 + k, base: '' }));
    list.sort((a, b) => a.w - b.w || a.o - b.o);
    const pcs = parent ? parent.__custom : null;
    const custom = Object.create(pcs || null);
    for (const { d } of list) if (d.p.charCodeAt(0) === 45 && d.p.charCodeAt(1) === 45) custom[d.p] = d.v === 'initial' ? null : d.v;
    const spec = Object.create(null);
    const bases = Object.create(null);
    for (const { d, base } of list) {
      if (d.p.charCodeAt(0) === 45 && d.p.charCodeAt(1) === 45) continue;
      let v = d.v.indexOf('var(') >= 0 ? substituteVars(d.v, custom) : d.v;
      if (v === '') v = 'unset';
      const setter = (p, val) => { spec[p] = val; if (base) bases[p] = base; };
      let p = d.p;
      if (p.startsWith('-webkit-') && !/^-webkit-(line-clamp|text-fill-color|box-orient)$/.test(p)) p = p.slice(8);
      else if (p.startsWith('-moz-') || p.startsWith('-ms-')) continue;
      if (!expandShorthand(p, v, setter)) setter(p, v);
    }
    const cs = Object.create(null);
    cs.__custom = custom;
    cs.__bases = bases;
    for (const p in spec) {
      let v = spec[p];
      const lv = v.length < 12 ? v.toLowerCase() : '';
      if (lv === 'inherit' || (lv === 'unset' && INHERITED.has(p)) || (lv === 'revert' && INHERITED.has(p))) {
        if (parent && parent[p] !== undefined) cs[p] = parent[p];
        continue;
      }
      if (lv === 'initial' || lv === 'unset' || lv === 'revert' || lv === 'revert-layer') continue;
      cs[p] = v;
    }
    if (parent) for (const p of INHERITED) if (cs[p] === undefined && parent[p] !== undefined) cs[p] = parent[p];
    // font-size resolves here so children can use em.
    // Inherited values are computed values: font-size and length/percent
    // line-heights become px here so children do not re-apply em/%.
    const pfs = parent ? parent.__fs : 16;
    const own = spec['font-size'];
    const fs = own !== undefined && cs['font-size'] === own ? fontSizePx(own, pfs) : pfs;
    cs.__fs = fs;
    cs['font-size'] = `${fs}px`;
    const lh = spec['line-height'];
    if (lh !== undefined && cs['line-height'] === lh && /[a-z%]$/i.test(lh.trim()) && lh.trim().toLowerCase() !== 'normal') {
      const v = px(lh, fs, fs);
      if (!Number.isNaN(v)) cs['line-height'] = `${v}px`;
    }
    return cs;
  }
  const FONT_KEYWORDS = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };
  function fontSizePx(v, parentFs) {
    const l = String(v).trim().toLowerCase();
    if (hasOwn(FONT_KEYWORDS, l)) return FONT_KEYWORDS[l];
    if (l === 'smaller') return parentFs / 1.2;
    if (l === 'larger') return parentFs * 1.2;
    const n = px(l, parentFs, parentFs);
    return Number.isNaN(n) || n < 0 ? parentFs : n;
  }

  // Styles every element (and ::before/::after) of the document.
  let styleGeneration = 0;
  function styleTree() {
    styleGeneration++;
    const root = document.documentElement;
    if (!root) return;
    ctx.vw = state.width; ctx.vh = state.height;
    const walk = (el, parentCs) => {
      const entries = candidates(ruleIndex, el).filter((e) => (!e.media || mediaMatches(e.media)) && matchSelector(el, e.sel));
      const cs = cascade(el, entries, inlineDecls(el), parentCs);
      if (el === root) { ctx.rootFs = cs.__fs; }
      el._ntStyle = cs;
      el._ntPseudo = null;
      const pc = candidates(pseudoIndex, el);
      if (pc.length) {
        const before = [], after = [];
        for (const e of pc) {
          if (e.media && !mediaMatches(e.media)) continue;
          if (!matchSelector(el, e.sel)) continue;
          (e.sel.pseudoEl === 'before' ? before : after).push(e);
        }
        if (before.length || after.length) {
          el._ntPseudo = {};
          if (before.length) el._ntPseudo.before = cascade(el, before, null, cs);
          if (after.length) el._ntPseudo.after = cascade(el, after, null, cs);
        }
      }
      for (const c of el.childNodes) if (c.nodeType === 1) walk(c, cs);
    };
    walk(root, null);
  }

  // ------------------------------------------------------------- images
  // Intrinsic sizes come from the file header; pixels are decoded natively.
  const imageInfo = new Map();
  function imageSize(src) {
    if (!src) return null;
    if (imageInfo.has(src)) return imageInfo.get(src);
    let info = null;
    try {
      let bytes = null;
      if (src.startsWith('data:')) {
        const comma = src.indexOf(',');
        const meta = src.slice(5, comma), payload = src.slice(comma + 1);
        if (/;base64/i.test(meta)) {
          const bin = global.atob(payload.replace(/\s+/g, ''));
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } else {
          let text = payload;
          try { text = decodeURIComponent(payload); } catch { /* raw */ }
          bytes = new TextEncoder().encode(text);
        }
      } else bytes = new Uint8Array(nt.readBinary(src));
      info = sniffImage(bytes);
    } catch { info = null; }
    imageInfo.set(src, info);
    return info;
  }
  function sniffImage(b) {
    const u32be = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { w: u32be(16), h: u32be(20), type: 'png' };
    if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8), type: 'gif' };
    if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d) return { w: Math.abs(b[18] | (b[19] << 8) | (b[20] << 16) | (b[21] << 24)), h: Math.abs(b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24)), type: 'bmp' };
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let o = 2;
      while (o + 9 < b.length) {
        if (b[o] !== 0xff) { o++; continue; }
        const marker = b[o + 1];
        const len = (b[o + 2] << 8) | b[o + 3];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: (b[o + 5] << 8) | b[o + 6], w: (b[o + 7] << 8) | b[o + 8], type: 'jpeg' };
        }
        o += 2 + len;
      }
      return null;
    }
    if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
      const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (chunk === 'VP8 ') return { w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff, type: 'webp' };
      if (chunk === 'VP8L') { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1, type: 'webp' }; }
      if (chunk === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), type: 'webp' };
      return null;
    }
    // SVG: width/height attributes or viewBox of the root element.
    const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 4096)));
    const svg = /<svg\b[^>]*>/i.exec(head);
    if (svg) {
      const attr = (n) => { const m = new RegExp(`\\s${n}\\s*=\\s*["']([^"']*)["']`, 'i').exec(svg[0]); return m ? m[1] : null; };
      const vb = (attr('viewBox') || '').split(/[\s,]+/).map(Number);
      let w = px(attr('width') || '', NaN, 16), h = px(attr('height') || '', NaN, 16);
      if (Number.isNaN(w) && vb.length === 4) w = vb[2];
      if (Number.isNaN(h) && vb.length === 4) h = vb[3];
      if (Number.isNaN(w) && !Number.isNaN(h) && vb.length === 4 && vb[3]) w = (h * vb[2]) / vb[3];
      if (Number.isNaN(h) && !Number.isNaN(w) && vb.length === 4 && vb[2]) h = (w * vb[3]) / vb[2];
      return { w: Number.isNaN(w) ? 300 : w, h: Number.isNaN(h) ? 150 : h, type: 'svg' };
    }
    return null;
  }
  // Inline <svg> markup is drawn as an SVG image.
  function inlineSvgSource(el) {
    const ser = (n) => {
      if (n.nodeType === 3) return n.data.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      if (n.nodeType !== 1) return '';
      const attrs = [...n._attrs].map(([k, v]) => ` ${k}="${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
      return `<${n.localName}${attrs}>${n.childNodes.map(ser).join('')}</${n.localName}>`;
    };
    let text = ser(el);
    if (!/\sxmlns=/.test(text.slice(0, 200))) text = text.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    // currentColor resolves against the element's CSS color.
    const c = parseColor(el._ntStyle && el._ntStyle.color);
    if (c) text = text.replace(/currentColor/gi, `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`);
    return 'data:image/svg+xml,' + encodeURIComponent(text);
  }

  // --------------------------------------------------------------- fonts
  const GENERIC = {
    'sans-serif': 'Segoe UI', 'system-ui': 'Segoe UI', '-apple-system': 'Segoe UI', blinkmacsystemfont: 'Segoe UI', 'ui-sans-serif': 'Segoe UI',
    serif: 'Times New Roman', 'ui-serif': 'Times New Roman', monospace: 'Consolas', 'ui-monospace': 'Consolas', cursive: 'Comic Sans MS',
    fantasy: 'Impact', 'ui-rounded': 'Segoe UI', emoji: 'Segoe UI Emoji', math: 'Cambria Math', fangsong: 'SimSun',
  };
  const fontCache = new Map();
  function fontOf(cs) {
    const familyText = cs['font-family'] || 'Segoe UI';
    const weightText = String(cs['font-weight'] || '400').toLowerCase();
    const italic = /italic|oblique/.test(cs['font-style'] || '') ? 1 : 0;
    const size = cs.__fs;
    const key = `${familyText}|${weightText}|${italic}|${size}`;
    let f = fontCache.get(key);
    if (f) return f;
    const families = splitTop(familyText, ',').map((x) => {
      const n = unquote(x);
      return GENERIC[n.toLowerCase()] || n;
    }).filter(Boolean);
    const weight = weightText === 'bold' || weightText === 'bolder' ? 700 : weightText === 'normal' || weightText === 'lighter' ? 400 : parseInt(weightText, 10) || 400;
    f = { family: families.join(','), size, weight, italic, key };
    f.space = measureRaw(' ', f);
    if (fontCache.size > 2000) fontCache.clear();
    fontCache.set(key, f);
    return f;
  }
  const textCache = new Map();
  let nativeMeasure = typeof nt.measureText === 'function';
  function measureRaw(text, f) {
    if (!text) return 0;
    const key = f.key + '\u0001' + text;
    let w = textCache.get(key);
    if (w !== undefined) return w;
    w = -1;
    if (nativeMeasure) {
      try { w = Number(nt.measureText(f.family, f.size, f.weight, f.italic, text)); } catch { nativeMeasure = false; w = -1; }
      if (!(w >= 0)) w = -1;
    }
    if (w < 0) w = approxWidth(text, f);
    if (textCache.size > 50000) textCache.clear();
    textCache.set(key, w);
    return w;
  }
  // Fallback metrics (Segoe UI-like) when the engine cannot measure text.
  function approxWidth(text, f) {
    let em = 0;
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if (c === 32) em += 0.274;
      else if ('iljI.,:;!|\'`'.includes(ch)) em += 0.26;
      else if ('ftr()[]{}"-/\\'.includes(ch)) em += 0.36;
      else if ('mwMW@'.includes(ch)) em += 0.84;
      else if (c >= 65 && c <= 90) em += 0.63;
      else if (c >= 48 && c <= 57) em += 0.55;
      else if (c >= 0x2e80) em += 1.0;
      else if (c > 0x2000) em += 0.9;
      else em += 0.52;
    }
    return em * f.size * (f.weight >= 600 ? 1.06 : 1) * (/consolas|courier|mono/i.test(f.family) ? 1.1 : 1);
  }
  function measureText(text, f, cs) {
    let w = measureRaw(text, f);
    const ls = letterSpacing(cs);
    if (ls) w += ls * [...text].length;
    return w;
  }
  const letterSpacing = (cs) => { const v = cs['letter-spacing']; if (!v || v === 'normal') return 0; const n = px(v, 0, cs.__fs); return Number.isNaN(n) ? 0 : n; };
  function lineHeightOf(cs) {
    const v = String(cs['line-height'] || 'normal').trim().toLowerCase();
    if (v === 'normal') return Math.round(cs.__fs * 1.25 * 100) / 100;
    if (/^[\d.]+$/.test(v)) return parseFloat(v) * cs.__fs;
    const n = px(v, cs.__fs, cs.__fs);
    return Number.isNaN(n) ? cs.__fs * 1.25 : n;
  }

  // ------------------------------------------------------------ box tree
  const get = (cs, p) => (cs[p] !== undefined ? cs[p] : DEFAULTS[p]);
  const lower = (v) => (v == null ? '' : String(v).trim().toLowerCase());
  function displayOf(cs, el) {
    let d = lower(get(cs, 'display')) || 'inline';
    if (d === 'list-item' || d === 'flow-root' || d === '-webkit-box' || d === 'table' || d === 'table-row-group' || d === 'table-caption' ||
        d === 'table-header-group' || d === 'table-footer-group' || d === 'table-cell' || d === 'ruby' || d === 'block flow' || d === 'block flow-root') d = 'block';
    else if (d === 'table-row') d = 'flex';
    else if (d === 'inline-table' || d === 'inline-flow-root' || d === '-webkit-inline-box') d = 'inline-block';
    else if (d === 'inline flex') d = 'inline-flex';
    else if (d === 'inline grid') d = 'inline-grid';
    else if (d === 'block flex') d = 'flex';
    else if (d === 'block grid') d = 'grid';
    else if (d === 'table-column' || d === 'table-column-group') d = 'none';
    if (!/^(none|contents|block|inline|inline-block|flex|inline-flex|grid|inline-grid)$/.test(d)) d = el && /^(div|section|p)$/.test(el.localName) ? 'block' : 'inline';
    return d;
  }
  const REPLACED = new Set(['img', 'canvas', 'video', 'iframe', 'svg', 'input', 'select', 'textarea', 'progress', 'meter', 'embed', 'object']);
  function positionOf(cs) { const p = lower(get(cs, 'position')); return p === 'absolute' || p === 'fixed' || p === 'relative' || p === 'sticky' ? p : 'static'; }

  let boxSeq = 0;
  function makeBox(el, cs, parent) {
    const pos = positionOf(cs);
    let display = displayOf(cs, el);
    const outOfFlow = pos === 'absolute' || pos === 'fixed';
    const fl = lower(cs.float);
    const floated = !outOfFlow && (fl === 'left' || fl === 'right');
    const blockified = outOfFlow || floated || (parent && (parent.inner === 'flex' || parent.inner === 'grid'));
    if (blockified) {
      if (display === 'inline' || display === 'inline-block') display = 'block';
      else if (display === 'inline-flex') display = 'flex';
      else if (display === 'inline-grid') display = 'grid';
    }
    const box = {
      id: ++boxSeq, el, cs, parent, children: [], pos, display, floated: floated ? fl : null,
      outer: display === 'inline' ? 'inline' : display.startsWith('inline') ? 'atom' : 'block',
      inner: display.endsWith('flex') ? 'flex' : display.endsWith('grid') ? 'grid' : 'flow',
      alpha: 1,
      x: 0, y: 0, w: 0, h: 0, frags: null, abs: null,
    };
    const op = String(get(cs, 'opacity')).trim();
    const opNum = op.endsWith('%') ? parseFloat(op) / 100 : parseFloat(op);
    box.alpha = (parent ? parent.alpha : 1) * (Number.isNaN(opNum) ? 1 : clamp(opNum, 0, 1));
    if (el) el._ntBox = box;
    if (el && REPLACED.has(el.localName)) {
      box.replaced = el.localName;
      if (box.outer === 'inline') box.outer = 'atom';
    }
    return box;
  }
  const visible = (cs) => lower(get(cs, 'visibility')) === 'visible' || lower(get(cs, 'visibility')) === '';

  function textTransform(text, cs) {
    const t = lower(cs['text-transform']);
    if (t === 'uppercase') return text.toUpperCase();
    if (t === 'lowercase') return text.toLowerCase();
    if (t === 'capitalize') return text.replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase());
    return text;
  }
  function pseudoContent(cs, el) {
    const c = String(cs.content ?? 'normal').trim();
    if (c === 'normal' || c === 'none' || c === '') return null;
    let text = '', image = null;
    for (const t of splitTop(c, ' ')) {
      if (t[0] === '"' || t[0] === "'") text += unquote(t);
      else if (/^attr\(/i.test(t)) text += el.getAttribute(t.slice(5, -1).trim()) || '';
      else if (/^url\(/i.test(t)) image = cssUrl(t, cs, 'content');
      else if (/^(open-quote|close-quote)$/.test(t)) text += t[0] === 'o' ? '“' : '”';
      else if (/^counter/.test(t)) text += '';
    }
    return { text, image };
  }
  function cssUrl(token, cs, prop) {
    const m = /^url\(\s*(.*?)\s*\)$/is.exec(token.trim());
    if (!m) return null;
    const base = (cs.__bases && cs.__bases[prop]) || '';
    return resolveRef(base, unquote(m[1]));
  }

  // DOM -> boxes. Inline elements without decoration are flattened into
  // text runs; decorated inline elements become atomic boxes.
  function buildBoxes(el, parentBox) {
    const cs = el._ntStyle;
    if (!cs) return null;
    const box = makeBox(el, cs, parentBox);
    if (box.display === 'none') return null;
    if (box.display === 'contents') { box.contents = true; }
    if (box.outer === 'inline' && !box.contents && inlineDecorated(box)) box.outer = 'atom', box.display = 'inline-block';
    if (box.pos === 'relative' || box.pos === 'sticky' || box.pos === 'absolute' || box.pos === 'fixed' || hasTransform(cs)) box.isCB = true;
    if (!box.replaced) {
      const kids = [];
      const pseudo = el._ntPseudo;
      if (pseudo && pseudo.before) addPseudo(box, pseudo.before, kids, 'before');
      for (const n of el.childNodes) {
        if (n.nodeType === 3) {
          if (n.data) kids.push({ text: n.data, cs, el, parent: box, isText: true });
        } else if (n.nodeType === 1) {
          if (n.localName === 'br') { kids.push({ isBr: true, cs, parent: box }); continue; }
          const c = buildBoxes(n, box);
          if (!c) continue;
          if (c.contents) { for (const k of c.children) { k.parent = box; kids.push(k); } }
          else kids.push(c);
        }
      }
      if (pseudo && pseudo.after) addPseudo(box, pseudo.after, kids, 'after');
      box.children = kids;
      // <details> shows only <summary> when closed (UA sheet handles children).
    }
    return box;
  }
  function addPseudo(box, pcs, kids, which) {
    const content = pseudoContent(pcs, box.el);
    if (!content) return;
    const pb = makeBox(null, pcs, box);
    if (pb.display === 'none') return;
    pb.pseudo = which;
    pb.ownerEl = box.el;
    if (pb.outer === 'inline' && (inlineDecorated(pb) || content.image)) { pb.outer = 'atom'; pb.display = 'inline-block'; }
    if (pb.pos === 'relative' || pb.pos === 'absolute' || pb.pos === 'fixed' || hasTransform(pcs)) pb.isCB = true;
    if (content.image && !content.text) { pb.replaced = 'img'; pb.src = content.image; }
    else if (content.text) pb.children = [{ text: content.text, cs: pcs, el: box.el, parent: pb, isText: true }];
    kids.push(pb);
  }
  function inlineDecorated(box) {
    const cs = box.cs;
    if (lower(cs['background-image']) && lower(cs['background-image']) !== 'none') return true;
    const bg = parseColor(cs['background-color']);
    if (bg && bg[3] > 0) return true;
    for (const s of SIDES) {
      const st = lower(cs[`border-${s}-style`]);
      if (st && st !== 'none' && st !== 'hidden' && px(cs[`border-${s}-width`] ?? 'medium', 0, cs.__fs) > 0) return true;
      const p = px(cs[`padding-${s}`], 0, cs.__fs);
      if (p > 0) return true;
    }
    if (lower(cs.width) && lower(cs.width) !== 'auto') return true;
    if (lower(cs['box-shadow']) && lower(cs['box-shadow']) !== 'none') return true;
    return false;
  }
  const hasTransform = (cs) => { const t = lower(cs.transform); return (t && t !== 'none') || (lower(cs.translate) && lower(cs.translate) !== 'none'); };

  // -------------------------------------------------------------- layout
  // Geometry is stored on boxes: x,y,w,h = border box in window px.
  let layoutGen = 0;
  let viewportBox = null;
  const BORDER_KW = { thin: 1, medium: 3, thick: 5 };
  function sideBorder(cs, s) {
    const st = lower(cs[`border-${s}-style`]);
    if (!st || st === 'none' || st === 'hidden') return 0;
    const v = lower(cs[`border-${s}-width`] ?? 'medium');
    if (hasOwn(BORDER_KW, v)) return BORDER_KW[v];
    const n = px(v, 0, cs.__fs);
    return Number.isNaN(n) || n < 0 ? 0 : n;
  }
  function resolveEdges(box, cbW) {
    const cs = box.cs, fs = cs.__fs;
    const m = (p) => { const v = cs[p]; if (v == null) return 0; if (lower(v) === 'auto') return NaN; const n = px(v, cbW, fs); return Number.isNaN(n) ? 0 : n; };
    const pd = (p) => { const v = cs[p]; if (v == null) return 0; const n = px(v, cbW, fs); return Number.isNaN(n) || n < 0 ? 0 : n; };
    box.mtA = Number.isNaN(box.mt = m('margin-top')); box.mrA = Number.isNaN(box.mr = m('margin-right'));
    box.mbA = Number.isNaN(box.mb = m('margin-bottom')); box.mlA = Number.isNaN(box.ml = m('margin-left'));
    if (box.mtA) box.mt = 0; if (box.mrA) box.mr = 0; if (box.mbA) box.mb = 0; if (box.mlA) box.ml = 0;
    box.pt = pd('padding-top'); box.pr = pd('padding-right'); box.pb = pd('padding-bottom'); box.pl = pd('padding-left');
    box.bt = sideBorder(cs, 'top'); box.br = sideBorder(cs, 'right'); box.bb = sideBorder(cs, 'bottom'); box.bl = sideBorder(cs, 'left');
  }
  const hEdges = (b) => b.pl + b.pr + b.bl + b.br;
  const vEdges = (b) => b.pt + b.pb + b.bt + b.bb;
  const borderBoxSizing = (cs) => lower(cs['box-sizing']) === 'border-box';
  // Specified size as border-box px; NaN for auto; keywords return markers.
  function specSize(box, prop, base) {
    const v = box.cs[prop];
    if (v == null) return NaN;
    const l = lower(v);
    if (l === 'auto' || l === 'none' || l === '') return NaN;
    if (l === 'fit-content' || l === '-webkit-fit-content' || l === '-moz-fit-content' || l === 'max-content' || l === 'min-content' || l.startsWith('fit-content(')) return NaN;
    if (l.includes('%') && (base == null || Number.isNaN(base))) return NaN;
    const n = px(v, base, box.cs.__fs);
    if (Number.isNaN(n)) return NaN;
    const edges = prop.includes('width') ? hEdges(box) : vEdges(box);
    return Math.max(0, borderBoxSizing(box.cs) ? Math.max(n, edges) : n + edges);
  }
  const sizeKeyword = (box, prop) => { const l = lower(box.cs[prop]); return l === 'fit-content' || l === '-webkit-fit-content' || l === 'max-content' || l === 'min-content' ? l : null; };
  function clampW(box, w, base) {
    const mx = specSize(box, 'max-width', base), mn = specSize(box, 'min-width', base);
    if (!Number.isNaN(mx)) w = Math.min(w, mx);
    if (!Number.isNaN(mn)) w = Math.max(w, mn);
    return Math.max(w, hEdges(box));
  }
  function clampH(box, h, base) {
    const mx = specSize(box, 'max-height', base), mn = specSize(box, 'min-height', base);
    if (!Number.isNaN(mx)) h = Math.min(h, mx);
    if (!Number.isNaN(mn)) h = Math.max(h, mn);
    return Math.max(h, vEdges(box));
  }
  function aspectRatio(box) {
    const v = lower(box.cs['aspect-ratio']);
    if (!v || v === 'auto') return NaN;
    const m = /([\d.]+)\s*(?:\/\s*([\d.]+))?/.exec(v);
    return m ? parseFloat(m[1]) / (m[2] ? parseFloat(m[2]) : 1) : NaN;
  }

  // ---- replaced elements
  function naturalSize(box) {
    const el = box.el;
    switch (box.replaced) {
      case 'img': {
        const src = box.src || imgSrc(el);
        const info = src ? imageSize(src) : null;
        if (info) return [info.w, info.h];
        if (el) { const w = parseFloat(el.getAttribute('width')), h = parseFloat(el.getAttribute('height')); if (w > 0 && h > 0) return [w, h]; }
        return [0, 0];
      }
      case 'canvas': return [el._width ?? 300, el._height ?? 150];
      case 'svg': {
        const w = px(el.getAttribute('width') || '', NaN, 16), h = px(el.getAttribute('height') || '', NaN, 16);
        const vb = (el.getAttribute('viewBox') || el.getAttribute('viewbox') || '').split(/[\s,]+/).map(Number);
        if (!Number.isNaN(w) && !Number.isNaN(h)) return [w, h];
        if (vb.length === 4 && vb[2] > 0) { if (!Number.isNaN(w)) return [w, (w * vb[3]) / vb[2]]; if (!Number.isNaN(h)) return [(h * vb[2]) / vb[3], h]; return [vb[2], vb[3]]; }
        return [300, 150];
      }
      case 'video': case 'iframe': case 'embed': case 'object': return [300, 150];
      default: return [0, 0];
    }
  }
  function imgSrc(el) {
    if (!el) return null;
    const s = el.getAttribute('src');
    return s ? resolveRef('', s) : null;
  }
  // Natural content size for form controls / images, honouring one specified side.
  function replacedSize(box, availW, availH) {
    let w = specSize(box, 'width', availW), h = specSize(box, 'height', availH);
    const formControl = /^(input|select|textarea|progress|meter)$/.test(box.replaced);
    if (formControl) {
      if (Number.isNaN(w)) w = (box.replaced === 'select' ? selectWidth(box) : 150) + hEdges(box);
      if (Number.isNaN(h)) h = lineHeightOf(box.cs) + vEdges(box);
      return [clampW(box, w, availW), clampH(box, h, availH)];
    }
    const [nw, nh] = naturalSize(box);
    const ratio = !Number.isNaN(aspectRatio(box)) ? aspectRatio(box) : nh > 0 ? nw / nh : NaN;
    if (Number.isNaN(w) && Number.isNaN(h)) { w = nw + hEdges(box); h = nh + vEdges(box); }
    else if (Number.isNaN(w)) w = (Number.isNaN(ratio) ? nw : (h - vEdges(box)) * ratio) + hEdges(box);
    else if (Number.isNaN(h)) h = (Number.isNaN(ratio) || !ratio ? nh : (w - hEdges(box)) / ratio) + vEdges(box);
    return [clampW(box, w, availW), clampH(box, h, availH)];
  }
  function selectWidth(box) {
    const f = fontOf(box.cs);
    let w = 40;
    for (const o of (box.el ? box.el.childNodes : [])) if (o.nodeType === 1 && o.localName === 'option') w = Math.max(w, measureText(o.textContent.trim(), f, box.cs) + 24);
    return w;
  }

  // ---- intrinsic widths (margin-box contribution)
  function intrinsic(box, kind) {
    const k = kind === 'min' ? '_imin' : '_imax';
    if (box[k + 'g'] === layoutGen) return box[k];
    resolveEdges(box, 0);
    let content;
    const sw = specSize(box, 'width', NaN);
    if (!Number.isNaN(sw)) content = sw;
    else if (box.replaced) content = replacedSize(box, NaN, NaN)[0];
    else {
      let inner = 0;
      if (box.inner === 'flex') inner = flexIntrinsic(box, kind);
      else if (box.inner === 'grid') inner = gridIntrinsic(box, kind);
      else inner = flowIntrinsic(box, kind);
      content = clampW(box, inner + hEdges(box), NaN);
    }
    const v = content + box.ml + box.mr;
    box[k] = v; box[k + 'g'] = layoutGen;
    return v;
  }
  function flowIntrinsic(box, kind) {
    let best = 0, run = [];
    const flush = () => { if (run.length) { best = Math.max(best, inlineIntrinsic(run, kind)); run = []; } };
    for (const c of box.children) {
      if (c.isText || c.isBr || c.outer === 'inline' || c.outer === 'atom') { run.push(c); continue; }
      if (c.pos === 'absolute' || c.pos === 'fixed') continue;
      flush();
      best = Math.max(best, intrinsic(c, kind));
    }
    flush();
    return best;
  }
  function inlineIntrinsic(items, kind) {
    const toks = inlineTokens(items);
    let line = 0, best = 0;
    for (const t of toks) {
      if (t.t === 'br') { best = Math.max(best, line); line = 0; continue; }
      if (t.t === 'abs') continue;
      const w = t.t === 'atom' ? intrinsic(t.box, kind) : t.w;
      if (kind === 'min') {
        if (t.t === 'space' && !t.nowrap) { best = Math.max(best, line); line = 0; continue; }
        if (t.t === 'word' && t.breakAll) { best = Math.max(best, Math.min(w, t.f.size)); continue; }
        line += w;
        if (t.t === 'atom' && !t.nowrapCtx) { best = Math.max(best, line); line = 0; }
      } else line += w;
    }
    return Math.max(best, line);
  }
  function flexIntrinsic(box, kind) {
    const row = !lower(get(box.cs, 'flex-direction')).startsWith('column');
    const wrap = lower(get(box.cs, 'flex-wrap')) !== 'nowrap';
    const items = flexItems(box, false);
    const gap = px(box.cs['column-gap'] ?? '0', 0, box.cs.__fs) || 0;
    if (!row) return items.reduce((m, it) => Math.max(m, intrinsic(it, kind)), 0);
    if (kind === 'min' && wrap) return items.reduce((m, it) => Math.max(m, intrinsic(it, 'min')), 0);
    return items.reduce((s, it) => s + intrinsic(it, kind), 0) + Math.max(0, items.length - 1) * gap;
  }
  function gridIntrinsic(box, kind) {
    const items = flexItems(box, false);
    if (!items.length) return 0;
    const fs = box.cs.__fs;
    const gap = px(box.cs['column-gap'] ?? '0', 0, fs) || 0;
    const tracks = parseTracks(box.cs['grid-template-columns'], NaN, gap, fs);
    const n = Math.max(1, tracks.length);
    if (tracks.length && tracks.every((t) => t.kind === 'px')) return tracks.reduce((s, t) => s + t.px, 0) + (n - 1) * gap;
    const widest = items.reduce((m, it) => Math.max(m, intrinsic(it, kind)), 0);
    return n * widest + (n - 1) * gap;
  }

  // ---- main entry for one box. (x,y) = margin-box origin.
  // opt: { w, h } forced border-box size, shrink (shrink-to-fit width),
  //      fill (available margin-box width), center (auto margins centre).
  function layoutBox(box, x, y, availW, availH, opt = {}) {
    const fW = opt.w ?? NaN, fH = opt.h ?? NaN;
    const fill = opt.fill ?? availW;
    const key = `${fW}|${fH}|${availW}|${availH}|${opt.shrink ? 1 : 0}|${fill}|${opt.center ? 1 : 0}`;
    if (box._gen === layoutGen && box._key === key) {
      const dx = x - box._ox, dy = y - box._oy;
      if (dx || dy) shiftBox(box, dx, dy);
      box._ox = x; box._oy = y;
      for (const a of box._escapes) { a.staticX += dx; a.staticY += dy; a.cbBox.abs.push(a); }
      return;
    }
    box._gen = layoutGen; box._key = key; box._ox = x; box._oy = y;
    box.abs = []; box._escapes = []; box.frags = null; box.atoms = null;
    resolveEdges(box, availW);
    const cs = box.cs;
    let w;
    if (!Number.isNaN(fW)) w = fW;
    else if (box.replaced) w = replacedSize(box, availW, availH)[0];
    else {
      w = specSize(box, 'width', availW);
      const kw = sizeKeyword(box, 'width');
      if (Number.isNaN(w)) {
        const room = Math.max(0, fill - box.ml - box.mr);
        if (kw === 'max-content') w = intrinsic(box, 'max') - box.ml - box.mr;
        else if (kw === 'min-content') w = intrinsic(box, 'min') - box.ml - box.mr;
        else if (opt.shrink || kw) w = Math.min(Math.max(intrinsic(box, 'min') - box.ml - box.mr, room), intrinsic(box, 'max') - box.ml - box.mr);
        else w = room;
      }
      if (Number.isNaN(specSize(box, 'width', availW)) && !Number.isNaN(aspectRatio(box))) {
        const sh = specSize(box, 'height', availH);
        if (!Number.isNaN(sh)) w = (sh - vEdges(box)) * aspectRatio(box) + hEdges(box);
      }
      w = clampW(box, w, availW);
    }
    if (opt.center && (box.mlA || box.mrA)) {
      const free = fill - w - box.ml - box.mr;
      if (free > 0) {
        if (box.mlA && box.mrA) { box.ml += free / 2; box.mr += free / 2; }
        else if (box.mlA) box.ml += free;
        else box.mr += free;
      }
    }
    box.x = x + box.ml; box.y = y + box.mt; box.w = Math.max(0, w);
    const cx = box.x + box.bl + box.pl, cy = box.y + box.bt + box.pt;
    const cw = Math.max(0, box.w - hEdges(box));
    let specH = !Number.isNaN(fH) ? fH : box.replaced ? replacedSize(box, availW, availH)[1] : specSize(box, 'height', availH);
    if (Number.isNaN(specH) && !box.replaced && !Number.isNaN(aspectRatio(box)) && Number.isNaN(fH)) specH = cw / aspectRatio(box) + vEdges(box);
    if (!Number.isNaN(specH) && Number.isNaN(fH)) specH = clampH(box, specH, availH);
    const chDef = Number.isNaN(specH) ? NaN : Math.max(0, specH - vEdges(box));
    let contentH = 0;
    if (box.replaced) contentH = 0;
    else if (box.inner === 'flex') contentH = layoutFlex(box, cx, cy, cw, chDef);
    else if (box.inner === 'grid') contentH = layoutGrid(box, cx, cy, cw, chDef);
    else contentH = layoutFlow(box, cx, cy, cw, chDef);
    let h = Number.isNaN(specH) ? contentH + vEdges(box) : specH;
    if (Number.isNaN(fH)) h = clampH(box, h, availH);
    box.h = Math.max(0, h);
    box.contentH = contentH;
    // absolutely positioned descendants whose containing block is this box
    box.abs = [...new Set(box.abs)];
    for (const a of box.abs) layoutAbs(a, box);
    finishBox(box);
  }
  // Scrolling, relative offsets and translate() after the box has its size.
  function finishBox(box) {
    const cs = box.cs;
    const ox = lower(get(cs, 'overflow-x')), oy = lower(get(cs, 'overflow-y'));
    box.clips = (ox !== 'visible' && ox !== '') || (oy !== 'visible' && oy !== '');
    if (box.clips && box.el && !box.replaced) {
      const pbx = box.x + box.bl, pby = box.y + box.bt, pbw = box.w - box.bl - box.br, pbh = box.h - box.bt - box.bb;
      let maxX = pbx + pbw, maxY = pby + pbh;
      const extent = (b) => {
        if (b.isText || b.isBr) return;
        maxX = Math.max(maxX, b.x + b.w + (b.mr || 0)); maxY = Math.max(maxY, b.y + b.h + (b.mb || 0));
      };
      for (const c of box.children) if (!c.isText && !c.isBr && c.pos !== 'fixed' && c._gen === layoutGen) extent(c);
      for (const a of box.abs) extent(a);
      if (box.frags) for (const f of box.frags) { maxX = Math.max(maxX, f.x + f.w); maxY = Math.max(maxY, f.y + f.h); }
      maxY += box.pb; maxX += box.pr;
      box.scrollW = maxX - pbx; box.scrollH = maxY - pby;
      const el = box.el;
      const sx = clamp(el._ntScrollLeft || 0, 0, Math.max(0, box.scrollW - pbw));
      const sy = clamp(el._ntScrollTop || 0, 0, Math.max(0, box.scrollH - pbh));
      el._ntScrollLeft = sx; el._ntScrollTop = sy;
      box.scrollable = (oy === 'auto' || oy === 'scroll') && box.scrollH > pbh + 0.5 || (ox === 'auto' || ox === 'scroll') && box.scrollW > pbw + 0.5;
      if (sx || sy) {
        for (const c of box.children) if (!c.isText && !c.isBr && c.pos !== 'fixed' && c._gen === layoutGen) shiftBox(c, -sx, -sy);
        for (const a of box.abs) shiftBox(a, -sx, -sy);
        if (box.frags) for (const f of box.frags) { f.x -= sx; f.y -= sy; }
      }
    }
    let dx = 0, dy = 0;
    if (box.pos === 'relative' || box.pos === 'sticky') {
      const l = px(cs.left, box.parent ? box.parent.w : 0, cs.__fs), r = px(cs.right, box.parent ? box.parent.w : 0, cs.__fs);
      const t = px(cs.top, box.parent ? box.parent.h : 0, cs.__fs), b = px(cs.bottom, box.parent ? box.parent.h : 0, cs.__fs);
      dx = !Number.isNaN(l) ? l : !Number.isNaN(r) ? -r : 0;
      dy = !Number.isNaN(t) ? t : !Number.isNaN(b) ? -b : 0;
      if (box.pos === 'sticky') { dx = 0; dy = 0; }
    }
    const tr = translateOf(box);
    dx += tr[0]; dy += tr[1];
    box.scale = tr[2];
    if (dx || dy) shiftBox(box, dx, dy);
  }
  // translate()/translateX/Y/translate3d and the `translate` property; scale() is kept for paint.
  function translateOf(box) {
    const cs = box.cs;
    let tx = 0, ty = 0, sc = 1;
    const t = lower(cs.transform);
    if (t && t !== 'none') {
      const re = /([a-z0-9]+)\(([^)]*)\)/g;
      let m;
      while ((m = re.exec(t))) {
        const a = splitTop(m[2].replace(/,/g, ' '), ' ');
        switch (m[1]) {
          case 'translate': case 'translate3d': tx += px(a[0], box.w, cs.__fs) || 0; ty += px(a[1] ?? '0', box.h, cs.__fs) || 0; break;
          case 'translatex': tx += px(a[0], box.w, cs.__fs) || 0; break;
          case 'translatey': ty += px(a[0], box.h, cs.__fs) || 0; break;
          case 'scale': case 'scale3d': sc *= parseFloat(a[0]) || 1; break;
          case 'matrix': if (a.length >= 6) { tx += parseFloat(a[4]) || 0; ty += parseFloat(a[5]) || 0; } break;
        }
      }
    }
    const tp = lower(cs.translate);
    if (tp && tp !== 'none') { const a = splitTop(tp, ' '); tx += px(a[0], box.w, cs.__fs) || 0; ty += px(a[1] ?? '0', box.h, cs.__fs) || 0; }
    return [tx, ty, sc];
  }
  // Moves a laid-out subtree. Abs/fixed boxes move with the box that is
  // their containing block (b.abs); inline atoms move with their line (b.atoms).
  function shiftBox(b, dx, dy) {
    if (b.isText || b.isBr) return;
    b.x += dx; b.y += dy;
    if (b._ox !== undefined) { b._ox += dx; b._oy += dy; }
    if (b.frags) for (const f of b.frags) { f.x += dx; f.y += dy; }
    for (const c of b.children) {
      if (c.isText) { if (!b.anonText && c.anon && c.anon._gen === layoutGen) shiftBox(c.anon, dx, dy); continue; }
      if (c.isBr || c._gen !== layoutGen || c.pos === 'fixed' || c.pos === 'absolute' || c.outer === 'atom') continue;
      shiftBox(c, dx, dy);
    }
    if (b.abs) for (const a of new Set(b.abs)) shiftBox(a, dx, dy);
    if (b.atoms) for (const a of b.atoms) shiftBox(a, dx, dy);
  }

  // ---- absolute / fixed
  function registerAbs(box, sx, sy) {
    box.staticX = sx; box.staticY = sy;
    let cb = null;
    for (let p = box.parent; p; p = p.parent) {
      if (box.pos === 'fixed' ? hasTransform(p.cs || {}) : p.isCB) { cb = p; break; }
    }
    if (!cb) cb = viewportBox;
    box.cbBox = cb;
    for (let p = box.parent; p && p !== cb; p = p.parent) if (p._escapes) p._escapes.push(box);
    cb.abs.push(box);
  }
  function layoutAbs(a, cb) {
    const isVp = cb === viewportBox;
    const px0 = isVp ? 0 : cb.x + cb.bl, py0 = isVp ? 0 : cb.y + cb.bt;
    const pw = isVp ? ctx.vw : cb.w - cb.bl - cb.br, ph = isVp ? ctx.vh : cb.h - cb.bt - cb.bb;
    resolveEdges(a, pw);
    const cs = a.cs, fs = cs.__fs;
    const L = px(cs.left, pw, fs), R = px(cs.right, pw, fs), T = px(cs.top, ph, fs), B = px(cs.bottom, ph, fs);
    const hasL = !Number.isNaN(L), hasR = !Number.isNaN(R), hasT = !Number.isNaN(T), hasB = !Number.isNaN(B);
    const opt = { fill: Math.max(0, pw - (hasL ? L : 0) - (hasR ? R : 0)) };
    if (!a.replaced) {
      const w = specSize(a, 'width', pw), h = specSize(a, 'height', ph);
      if (!Number.isNaN(w)) opt.w = clampW(a, w, pw);
      else if (hasL && hasR && !sizeKeyword(a, 'width')) opt.w = clampW(a, Math.max(0, pw - L - R - a.ml - a.mr), pw);
      else opt.shrink = true;
      if (!Number.isNaN(h)) opt.h = clampH(a, h, ph);
      else if (hasT && hasB) opt.h = clampH(a, Math.max(0, ph - T - B - a.mt - a.mb), ph);
    }
    layoutBox(a, hasL ? px0 + L : a.staticX, hasT ? py0 + T : a.staticY, pw, ph, opt);
    // auto margins centre between both insets; right/bottom anchor otherwise
    let x = a.x, y = a.y;
    if (hasL && hasR && (a.mlA || a.mrA)) {
      const free = pw - L - R - a.w - a.ml - a.mr;
      x = px0 + L + a.ml + (a.mlA && a.mrA ? free / 2 : a.mlA ? free : 0);
    } else if (!hasL && hasR) x = px0 + pw - R - a.mr - a.w;
    if (hasT && hasB && (a.mtA || a.mbA)) {
      const free = ph - T - B - a.h - a.mt - a.mb;
      y = py0 + T + a.mt + (a.mtA && a.mbA ? free / 2 : a.mtA ? free : 0);
    } else if (!hasT && hasB) y = py0 + ph - B - a.mb - a.h;
    if (x !== a.x || y !== a.y) shiftBox(a, x - a.x, y - a.y);
  }

  // ---- block flow
  function layoutFlow(box, cx, cy, cw, chDef) {
    let y = cy, prevMB = 0, run = [];
    const flush = () => {
      if (!run.length) return;
      const h = layoutInline(box, run, cx, y, cw);
      run = [];
      if (h > 0) { y += h; prevMB = 0; }
    };
    for (const c of box.children) {
      if (c.isText || c.isBr || c.outer === 'inline' || c.outer === 'atom') { run.push(c); continue; }
      if (c.pos === 'absolute' || c.pos === 'fixed') {
        if (run.length) run.push({ absMarker: c, parent: box });
        else registerAbs(c, cx, y);
        continue;
      }
      flush();
      resolveEdges(c, cw);
      const collapse = prevMB > 0 && c.mt > 0 ? Math.min(prevMB, c.mt) : 0;
      layoutBox(c, cx, y - collapse, cw, chDef, { fill: cw, center: !c.floated });
      y = c.y + c.h + c.mb;
      prevMB = c.mb;
    }
    flush();
    return Math.max(0, y - cy);
  }

  // ---- inline formatting
  const WS_COLLAPSE = /[ \t\n\r\f]+/g;
  function inlineTokens(items) {
    const toks = [];
    let lastSpace = true;
    const visit = (it) => {
      if (it.absMarker) { toks.push({ t: 'abs', box: it.absMarker }); return; }
      if (it.isBr) { toks.push({ t: 'br', cs: it.cs }); lastSpace = true; return; }
      if (it.isText) {
        const cs = it.cs;
        const ws = lower(get(cs, 'white-space'));
        const f = fontOf(cs);
        const nowrap = ws === 'nowrap' || ws === 'pre';
        const pre = ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces';
        const preLine = ws === 'pre-line';
        const wb = lower(cs['word-break']), ow = lower(cs['overflow-wrap']);
        const breakAll = wb === 'break-all' || ow === 'anywhere' || ow === 'break-word' || wb === 'break-word';
        let text = textTransform(it.text, cs);
        if (pre || preLine) {
          const lines = text.split('\n');
          lines.forEach((ln, i) => {
            if (i) { toks.push({ t: 'br', cs }); lastSpace = true; }
            if (preLine) ln = ln.replace(/[ \t]+/g, ' ');
            if (ln) pushWords(ln.replace(/\t/g, '    '), cs, f, it.el, nowrap || pre, breakAll, true);
          });
          return;
        }
        text = text.replace(WS_COLLAPSE, ' ');
        pushWords(text, cs, f, it.el, nowrap, breakAll, false);
        return;
      }
      if (it.outer === 'inline' && !it.replaced) { for (const c of it.children) visit(c); return; }
      toks.push({ t: 'atom', box: it, nowrapCtx: false });
      lastSpace = false;
    };
    const pushWords = (text, cs, f, el, nowrap, breakAll, keepSpaces) => {
      let i = 0;
      while (i < text.length) {
        if (text[i] === ' ') {
          let j = i; while (j < text.length && text[j] === ' ') j++;
          if (keepSpaces) toks.push({ t: 'space', w: measureText(text.slice(i, j), f, cs), f, cs, el, nowrap, text: text.slice(i, j) });
          else if (!lastSpace) toks.push({ t: 'space', w: f.space + letterSpacing(cs), f, cs, el, nowrap, text: ' ' });
          lastSpace = true; i = j; continue;
        }
        let j = i; while (j < text.length && text[j] !== ' ') j++;
        const word = text.slice(i, j);
        toks.push({ t: 'word', text: word, w: measureText(word, f, cs), f, cs, el, breakAll });
        lastSpace = false; i = j;
      }
    };
    for (const it of items) visit(it);
    return toks;
  }
  function fontMetrics(cs) {
    const fs = cs.__fs, lh = lineHeightOf(cs);
    const asc = fs * 0.92, desc = fs * 0.24;
    const A = (lh - (asc + desc)) / 2 + asc;
    return { A, D: lh - A, lh };
  }
  function layoutInline(box, items, cx, cy, cw) {
    const toks = inlineTokens(items);
    if (!toks.length) return 0;
    // Collapsible-space-only runs make no line box.
    if (toks.every((t) => t.t === 'space' && t.text === ' ' || t.t === 'abs')) { for (const t of toks) if (t.t === 'abs') registerAbs(t.box, cx, cy); return 0; }
    const lines = [];
    let line = { items: [], w: 0 };
    const pushLine = () => {
      while (line.items.length && line.items[line.items.length - 1].tok.t === 'space' && line.items[line.items.length - 1].tok.text === ' ') { line.w -= line.items.pop().w; }
      lines.push(line); line = { items: [], w: 0 };
    };
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.t === 'br') { line.brCs = t.cs; pushLine(); continue; }
      if (t.t === 'abs') { line.items.push({ tok: t, w: 0 }); continue; }
      if (t.t === 'space') {
        if (!line.items.length && t.text === ' ') continue;
        line.items.push({ tok: t, w: t.w }); line.w += t.w; continue;
      }
      let w;
      if (t.t === 'atom') {
        const a = t.box;
        layoutBox(a, 0, 0, cw, NaN, { shrink: true, fill: cw });
        w = a.w + a.ml + a.mr;
      } else w = t.w;
      // break opportunity before this item if the previous item is a wrapping space
      const prev = line.items[line.items.length - 1];
      const canBreak = line.items.length && (!prev || prev.tok.t !== 'space' || !prev.tok.nowrap) && !(t.t === 'word' && prev && prev.tok.t === 'word' && !t.breakAll);
      if (line.w + w > cw + 0.01 && line.items.length && canBreak && (prev.tok.t === 'space' || prev.tok.t === 'atom' || t.t === 'atom')) pushLine();
      if (t.t === 'word' && w > cw + 0.01 && t.breakAll && cw > t.f.size) {
        // split an overlong word by characters
        let rest = t.text;
        while (rest) {
          let n = rest.length;
          while (n > 1 && line.w + measureText(rest.slice(0, n), t.f, t.cs) > cw) n--;
          const part = rest.slice(0, n);
          const pw = measureText(part, t.f, t.cs);
          line.items.push({ tok: { ...t, text: part, w: pw }, w: pw }); line.w += pw;
          rest = rest.slice(n);
          if (rest) pushLine();
        }
        continue;
      }
      line.items.push({ tok: t, w }); line.w += w;
    }
    if (line.items.length) pushLine();
    // vertical metrics + placement
    const strut = fontMetrics(box.cs);
    const align = lower(get(box.cs, 'text-align'));
    const ellipsis = lower(box.cs['text-overflow']) === 'ellipsis' && lower(get(box.cs, 'overflow-x')) !== 'visible';
    let y = cy;
    if (!box.frags) box.frags = [];
    for (const ln of lines) {
      let A = strut.A, D = strut.D;
      const hasContent = ln.items.some((it) => it.tok.t !== 'abs');
      for (const it of ln.items) {
        const t = it.tok;
        if (t.t === 'word' || t.t === 'space') { const m = fontMetrics(t.cs); it.A = m.A; it.D = m.D; it.lh = m.lh; }
        else if (t.t === 'atom') {
          const a = t.box, H = a.h + a.mt + a.mb;
          const va = lower(a.cs['vertical-align']);
          if (va === 'middle') { it.A = H / 2 + box.cs.__fs * 0.3; it.D = H - it.A; }
          else if (va === 'top' || va === 'text-top') { it.A = strut.A; it.D = H - strut.A; }
          else if (va === 'bottom' || va === 'text-bottom') { it.A = H - strut.D; it.D = strut.D; }
          else {
            const off = va && va !== 'baseline' ? px(va, lineHeightOf(a.cs), a.cs.__fs) : 0;
            const sh = Number.isNaN(off) ? 0 : off;
            const base = a.replaced || !a.frags || !a.frags.length ? H : Math.min(H, a.frags[a.frags.length - 1].y + fontMetrics(a.frags[a.frags.length - 1].cs).A - a.y + a.mt + a.pb + a.bb);
            it.A = base + sh; it.D = H - base - sh;
          }
        } else continue;
        A = Math.max(A, it.A); D = Math.max(D, it.D);
      }
      if (!hasContent && !ln.brCs) { for (const it of ln.items) registerAbs(it.tok.box, cx, y); continue; }
      const lineH = A + D;
      const baseline = y + A;
      let free = cw - ln.w;
      let x = cx;
      if (free > 0) {
        if (align === 'center' || align === '-webkit-center') x += free / 2;
        else if (align === 'right' || align === 'end' || align === '-webkit-right') x += free;
      }
      // ellipsis truncation for single-line overflowing text
      if (ellipsis && ln.w > cw + 0.5) truncateLine(ln, cw);
      let cur = null;
      for (const it of ln.items) {
        const t = it.tok;
        if (t.t === 'abs') { registerAbs(t.box, x, y); continue; }
        if (t.t === 'atom') {
          const a = t.box;
          shiftBox(a, x - (a.x - a.ml), baseline - it.A - (a.y - a.mt));
          (box.atoms || (box.atoms = [])).push(a);
          x += it.w; cur = null; continue;
        }
        const top = baseline - it.A;
        if (cur && cur.cs === t.cs && cur.el === t.el && Math.abs(cur.y - top) < 0.01) { cur.text += t.text; cur.w += it.w; }
        else { cur = { x, y: top, w: it.w, h: it.lh, text: t.text, cs: t.cs, f: t.f, el: t.el, box }; box.frags.push(cur); }
        x += it.w;
      }
      y += lineH;
    }
    // drop space-only fragments
    box.frags = box.frags.filter((f) => f.text.trim() || /pre/.test(lower(get(f.cs, 'white-space'))));
    return y - cy;
  }
  function truncateLine(ln, cw) {
    const ellW = (it) => measureText('…', it.tok.f, it.tok.cs);
    let used = 0;
    for (let i = 0; i < ln.items.length; i++) {
      const it = ln.items[i];
      if (used + it.w <= cw - (it.tok.f ? ellW(it) : 0) || it.tok.t === 'abs') { used += it.w; continue; }
      if (it.tok.t === 'word' || it.tok.t === 'space') {
        const room = cw - used - ellW(it);
        let text = it.tok.text;
        while (text && measureText(text, it.tok.f, it.tok.cs) > room) text = text.slice(0, -1);
        text = text.replace(/\s+$/, '') + '…';
        const w = measureText(text, it.tok.f, it.tok.cs);
        ln.items[i] = { ...it, tok: { ...it.tok, text, t: 'word' }, w };
        ln.items.length = i + 1;
      } else ln.items.length = i;
      break;
    }
    ln.w = ln.items.reduce((s, it) => s + it.w, 0);
  }

  // ---- flexbox
  function flexItems(box, register, cx = 0, cy = 0) {
    const out = [];
    for (const c of box.children) {
      if (c.isBr) continue;
      if (c.isText) {
        if (!c.text.trim() && !/pre/.test(lower(get(c.cs, 'white-space')))) continue;
        // anonymous block around loose text
        if (!c.anon) { c.anon = { id: ++boxSeq, el: null, anonText: true, cs: anonStyle(c.cs), parent: box, children: [c], pos: 'static', display: 'block', outer: 'block', inner: 'flow', alpha: box.alpha, x: 0, y: 0, w: 0, h: 0 }; }
        out.push(c.anon); continue;
      }
      if (c.pos === 'absolute' || c.pos === 'fixed') { if (register) registerAbs(c, cx, cy); continue; }
      out.push(c);
    }
    return out;
  }
  const anonCache = new WeakMap();
  function anonStyle(cs) {
    let a = anonCache.get(cs);
    if (!a) {
      a = Object.create(null);
      for (const p of INHERITED) if (cs[p] !== undefined) a[p] = cs[p];
      a.__fs = cs.__fs; a.__custom = cs.__custom; a.__bases = cs.__bases; a.display = 'block';
      anonCache.set(cs, a);
    }
    return a;
  }
  const gapPx = (v, base, fs) => { if (v == null || lower(v) === 'normal') return 0; const n = px(v, base, fs); return Number.isNaN(n) ? 0 : n; };
  function layoutFlex(box, cx, cy, cw, chDef) {
    const cs = box.cs, fs = cs.__fs;
    const dir = lower(get(cs, 'flex-direction'));
    const row = !dir.startsWith('column'), rev = dir.endsWith('reverse');
    const wrapMode = lower(get(cs, 'flex-wrap'));
    const wrap = wrapMode === 'wrap' || wrapMode === 'wrap-reverse';
    const rowGap = gapPx(cs['row-gap'], chDef, fs), colGap = gapPx(cs['column-gap'], cw, fs);
    const mainGap = row ? colGap : rowGap, crossGap = row ? rowGap : colGap;
    const items = flexItems(box, true, cx, cy);
    items.forEach((it, i) => { it._order = (parseInt(it.cs.order, 10) || 0) * 1e6 + i; });
    items.sort((a, b) => a._order - b._order);
    const mainAvail = row ? cw : chDef;
    const definiteMain = !Number.isNaN(mainAvail);
    const alignItems = lower(get(cs, 'align-items'));
    const data = items.map((it) => {
      resolveEdges(it, cw);
      const ics = it.cs, ifs = ics.__fs;
      const mMain = row ? it.ml + it.mr : it.mt + it.mb;
      const mCross = row ? it.mt + it.mb : it.ml + it.mr;
      const selfAlign = lower(ics['align-self']) && lower(ics['align-self']) !== 'auto' ? lower(ics['align-self']) : alignItems;
      const stretch = (selfAlign === 'stretch' || selfAlign === 'normal' || selfAlign === '') && !(row ? it.mtA || it.mbA : it.mlA || it.mrA);
      const crossSpec = row ? specSize(it, 'height', chDef) : specSize(it, 'width', cw);
      // used cross size when it must be known before the main size (column)
      let crossForMain = NaN;
      if (!row) {
        if (!Number.isNaN(crossSpec)) crossForMain = crossSpec;
        else if (stretch && !it.replaced) crossForMain = clampW(it, Math.max(0, cw - mCross), cw);
        else crossForMain = clampW(it, Math.min(Math.max(intrinsic(it, 'min') - mCross, cw - mCross), intrinsic(it, 'max') - mCross), cw);
      }
      const fb = lower(ics['flex-basis'] ?? 'auto');
      let basis = NaN;
      if (fb !== 'auto' && fb !== 'content' && fb !== '') {
        const n = px(fb, mainAvail, ifs);
        if (!Number.isNaN(n)) basis = borderBoxSizing(ics) ? Math.max(n, row ? hEdges(it) : vEdges(it)) : n + (row ? hEdges(it) : vEdges(it));
      }
      if (Number.isNaN(basis)) basis = row ? (it.replaced ? replacedSize(it, cw, chDef)[0] : specSize(it, 'width', cw)) : (it.replaced ? replacedSize(it, cw, chDef)[1] : specSize(it, 'height', chDef));
      let contentMain = NaN;
      const measureColumn = () => { layoutBox(it, 0, 0, cw, NaN, { w: crossForMain }); return it.h; };
      if (Number.isNaN(basis)) {
        if (row) basis = Math.max(0, intrinsic(it, 'max') - mMain);
        else basis = contentMain = measureColumn();
      }
      const ov = lower(get(ics, 'overflow-x')) !== 'visible' || lower(get(ics, 'overflow-y')) !== 'visible';
      let minMain = row ? specSize(it, 'min-width', cw) : specSize(it, 'min-height', chDef);
      if (Number.isNaN(minMain)) {
        if (ov) minMain = row ? hEdges(it) : vEdges(it);
        else if (row) {
          const sw = specSize(it, 'width', cw);
          minMain = Math.max(0, intrinsic(it, 'min') - mMain);
          if (!Number.isNaN(sw)) minMain = Math.min(minMain, sw);
          if (it.replaced) minMain = Math.min(minMain, replacedSize(it, cw, chDef)[0]);
        } else {
          const sh = specSize(it, 'height', chDef);
          minMain = Number.isNaN(contentMain) ? (Number.isNaN(sh) ? measureColumn() : Math.min(sh, measureColumn())) : contentMain;
          if (!Number.isNaN(sh)) minMain = Math.min(minMain, sh);
        }
      }
      let maxMain = row ? specSize(it, 'max-width', cw) : specSize(it, 'max-height', chDef);
      if (Number.isNaN(maxMain)) maxMain = Infinity;
      const grow = Math.max(0, parseFloat(ics['flex-grow']) || 0);
      const shrinkF = ics['flex-shrink'] === undefined ? 1 : Math.max(0, parseFloat(ics['flex-shrink']) || 0);
      const hyp = clamp(basis, minMain, Math.max(minMain, maxMain));
      return { it, basis, hyp, minMain, maxMain, grow, shrink: shrinkF, mMain, mCross, stretch, selfAlign, crossSpec, crossForMain, main: hyp };
    });
    // lines
    const lines = [];
    if (!wrap || !definiteMain) lines.push(data);
    else {
      let cur = [], used = 0;
      for (const d of data) {
        const outer = d.hyp + d.mMain;
        if (cur.length && used + mainGap + outer > mainAvail + 0.01) { lines.push(cur); cur = []; used = 0; }
        used += (cur.length ? mainGap : 0) + outer;
        cur.push(d);
      }
      if (cur.length) lines.push(cur);
    }
    // resolve flexible lengths per line
    for (const ln of lines) {
      if (!definiteMain) { for (const d of ln) d.main = d.hyp; continue; }
      const gaps = Math.max(0, ln.length - 1) * mainGap;
      for (const d of ln) { d.frozen = false; d.main = d.hyp; }
      for (let iter = 0; iter < 5; iter++) {
        let used = gaps, sumGrow = 0, sumShrink = 0;
        for (const d of ln) {
          used += (d.frozen ? d.main : d.basis) + d.mMain;
          if (!d.frozen) { sumGrow += d.grow; sumShrink += d.shrink * d.basis; }
        }
        const free = mainAvail - used;
        let clampedAny = false;
        for (const d of ln) {
          if (d.frozen) continue;
          let target = d.basis;
          if (free > 0 && sumGrow > 0) target = d.basis + (free * d.grow) / Math.max(1, sumGrow) * (sumGrow < 1 ? sumGrow : 1);
          else if (free < 0 && sumShrink > 0) target = d.basis + (free * d.shrink * d.basis) / sumShrink;
          else target = d.hyp;
          const c = clamp(target, d.minMain, Math.max(d.minMain, d.maxMain));
          if (Math.abs(c - target) > 0.01) { d.main = c; d.frozen = true; clampedAny = true; } else d.main = target;
        }
        if (!clampedAny) break;
      }
    }
    // cross sizes
    const crossDef = row ? chDef : cw;
    for (const ln of lines) {
      let lineCross = 0;
      for (const d of ln) {
        const it = d.it;
        if (row) {
          const h = !Number.isNaN(d.crossSpec) ? d.crossSpec : NaN;
          layoutBox(it, 0, 0, cw, chDef, { w: d.main, h });
          d.cross = it.h;
        } else {
          layoutBox(it, 0, 0, cw, NaN, { w: d.crossForMain, h: d.main });
          d.cross = it.w;
        }
        lineCross = Math.max(lineCross, d.cross + d.mCross);
      }
      ln.cross = lineCross;
    }
    if (lines.length === 1 && !Number.isNaN(crossDef)) lines[0].cross = crossDef;
    else if (lines.length > 1 && !Number.isNaN(crossDef) && /^(stretch|normal|)$/.test(lower(get(cs, 'align-content')))) {
      const total = lines.reduce((s, l) => s + l.cross, 0) + (lines.length - 1) * crossGap;
      if (total < crossDef) { const extra = (crossDef - total) / lines.length; for (const l of lines) l.cross += extra; }
    }
    // align-content offsets
    let crossPos = 0;
    const totalCross = lines.reduce((s, l) => s + l.cross, 0) + Math.max(0, lines.length - 1) * crossGap;
    const ac = lower(get(cs, 'align-content'));
    let acGap = crossGap;
    if (!Number.isNaN(crossDef) && lines.length > 1) {
      const free = crossDef - totalCross;
      if (free > 0) {
        if (ac === 'center') crossPos = free / 2;
        else if (ac === 'flex-end' || ac === 'end') crossPos = free;
        else if (ac === 'space-between') acGap += free / (lines.length - 1);
        else if (ac === 'space-around') { crossPos = free / lines.length / 2; acGap += free / lines.length; }
        else if (ac === 'space-evenly') { crossPos = free / (lines.length + 1); acGap += free / (lines.length + 1); }
      }
    }
    const jc = lower(get(cs, 'justify-content'));
    const orderedLines = wrapMode === 'wrap-reverse' ? lines.slice().reverse() : lines;
    let contentMainMax = 0;
    for (const ln of orderedLines) {
      const sumMain = ln.reduce((s, d) => s + d.main + d.mMain, 0) + Math.max(0, ln.length - 1) * mainGap;
      const lineMain = definiteMain ? mainAvail : sumMain;
      contentMainMax = Math.max(contentMainMax, sumMain);
      let free = lineMain - sumMain;
      let autoCount = 0;
      for (const d of ln) autoCount += row ? (d.it.mlA ? 1 : 0) + (d.it.mrA ? 1 : 0) : (d.it.mtA ? 1 : 0) + (d.it.mbA ? 1 : 0);
      let pos = 0, between = mainGap;
      const autoShare = autoCount && free > 0 ? free / autoCount : 0;
      if (!autoCount && free > 0) {
        if (jc === 'center') pos = free / 2;
        else if (jc === 'flex-end' || jc === 'end' || jc === 'right') pos = free;
        else if (jc === 'space-between' && ln.length > 1) between += free / (ln.length - 1);
        else if (jc === 'space-between' && ln.length === 1) pos = 0;
        else if (jc === 'space-around') { pos = free / ln.length / 2; between += free / ln.length; }
        else if (jc === 'space-evenly') { pos = free / (ln.length + 1); between += free / (ln.length + 1); }
      }
      const seq = rev ? ln.slice().reverse() : ln;
      if (rev && !autoCount) pos = lineMain - sumMain - pos;
      if (rev && autoCount) pos = 0;
      for (const d of seq) {
        const it = d.it;
        const a1 = row ? it.mlA : it.mtA, a2 = row ? it.mrA : it.mbA;
        if (a1) pos += autoShare;
        // cross
        let crossSize = NaN;
        let crossOff = 0;
        const outerCross = d.cross + d.mCross;
        const sa = d.selfAlign;
        if (d.stretch && Number.isNaN(d.crossSpec) && !it.replaced) crossSize = Math.max(0, ln.cross - d.mCross);
        else if (sa === 'center') crossOff = (ln.cross - outerCross) / 2;
        else if (sa === 'flex-end' || sa === 'end' || sa === 'self-end') crossOff = ln.cross - outerCross;
        const crossAuto1 = row ? it.mtA : it.mlA, crossAuto2 = row ? it.mbA : it.mrA;
        if (crossAuto1 || crossAuto2) { const fr = ln.cross - outerCross; crossOff = crossAuto1 && crossAuto2 ? fr / 2 : crossAuto1 ? fr : 0; }
        if (row) {
          const h = !Number.isNaN(crossSize) ? clampH(it, crossSize, chDef) : !Number.isNaN(d.crossSpec) ? d.crossSpec : NaN;
          layoutBox(it, cx + pos, cy + crossPos + crossOff, cw, chDef, { w: d.main, h });
        } else {
          const w = !Number.isNaN(crossSize) ? clampW(it, crossSize, cw) : d.crossForMain;
          layoutBox(it, cx + crossPos + crossOff, cy + pos, cw, NaN, { w, h: d.main });
        }
        pos += d.main + d.mMain + between;
        if (a2) pos += autoShare;
      }
      crossPos += ln.cross + acGap;
    }
    return row ? totalCross : contentMainMax;
  }

  // ---- grid
  function parseTracks(text, avail, gap, fs) {
    const out = [];
    if (!text || lower(text) === 'none' || lower(text) === 'subgrid' || lower(text) === 'masonry') return out;
    const toks = splitTop(String(text).replace(/\[[^\]]*\]/g, ' '), ' ');
    const one = (t) => {
      const l = lower(t);
      if (l.endsWith('fr') && /^[\d.]+fr$/.test(l)) return { kind: 'fr', fr: parseFloat(l), min: 0 };
      if (l === 'auto' || l === 'min-content' || l === 'max-content') return { kind: 'auto', min: 0, cap: Infinity };
      if (l.startsWith('fit-content(')) { const c = px(t.slice(12, -1), avail, fs); return { kind: 'auto', min: 0, cap: Number.isNaN(c) ? Infinity : c }; }
      if (l.startsWith('minmax(')) {
        const [a, b] = splitTop(t.slice(7, -1), ',');
        const lo = px(a, avail, fs), lb = lower(b);
        if (/^[\d.]+fr$/.test(lb)) return { kind: 'fr', fr: parseFloat(lb), min: Number.isNaN(lo) ? 0 : lo };
        const hi = px(b, avail, fs);
        if (!Number.isNaN(hi) && !Number.isNaN(lo)) return { kind: 'minmax', min: lo, max: hi };
        if (!Number.isNaN(hi)) return { kind: 'auto', min: 0, cap: hi };
        return { kind: 'auto', min: Number.isNaN(lo) ? 0 : lo, cap: Infinity };
      }
      const n = px(t, avail, fs);
      return Number.isNaN(n) ? { kind: 'auto', min: 0, cap: Infinity } : { kind: 'px', px: n };
    };
    for (const t of toks) {
      if (/^repeat\(/i.test(t)) {
        const inner = t.slice(7, -1);
        const comma = inner.indexOf(',');
        const countText = lower(inner.slice(0, comma));
        const list = splitTop(inner.slice(comma + 1), ' ').map(one);
        let count = parseInt(countText, 10);
        if (countText === 'auto-fill' || countText === 'auto-fit') {
          const unit = list.reduce((s, tr) => s + (tr.kind === 'px' ? tr.px : tr.kind === 'minmax' || tr.kind === 'fr' ? tr.min || 0 : 0), 0) || 0;
          count = unit > 0 && !Number.isNaN(avail) ? Math.max(1, Math.floor((avail + gap) / (unit + gap * list.length))) : 1;
        }
        for (let r = 0; r < Math.min(count || 1, 200); r++) for (const tr of list) out.push({ ...tr });
      } else out.push(one(t));
    }
    return out;
  }
  function gridLine(v) {
    const l = lower(v);
    if (!l || l === 'auto') return { auto: true, span: 1 };
    const span = /^span\s+(\d+)/.exec(l);
    if (span) return { auto: true, span: parseInt(span[1], 10) };
    const n = parseInt(l, 10);
    if (!Number.isNaN(n)) return { line: n, span: 1 };
    return { auto: true, span: 1 };
  }
  function layoutGrid(box, cx, cy, cw, chDef) {
    const cs = box.cs, fs = cs.__fs;
    const colGap = gapPx(cs['column-gap'], cw, fs), rowGap = gapPx(cs['row-gap'], chDef, fs);
    let cols = parseTracks(cs['grid-template-columns'], cw, colGap, fs);
    const rowsT = parseTracks(cs['grid-template-rows'], chDef, rowGap, fs);
    const autoRow = parseTracks(cs['grid-auto-rows'] || 'auto', chDef, rowGap, fs)[0] || { kind: 'auto', min: 0, cap: Infinity };
    const autoCol = parseTracks(cs['grid-auto-columns'] || 'auto', cw, colGap, fs)[0] || { kind: 'auto', min: 0, cap: Infinity };
    const columnFlow = lower(cs['grid-auto-flow']).startsWith('column');
    const items = flexItems(box, true, cx, cy);
    items.forEach((it, i) => { it._order = (parseInt(it.cs.order, 10) || 0) * 1e6 + i; });
    items.sort((a, b) => a._order - b._order);
    const explicitCols = cols.length;
    const nColsBase = Math.max(1, explicitCols);
    const resolveLine = (ln, count) => (ln < 0 ? count + 1 + ln + 1 : ln);
    // placement
    const occupied = new Set();
    const placed = [];
    let curR = 0, curC = 0;
    let nCols = nColsBase;
    const free = (r, c, rs, csn) => { for (let i = r; i < r + rs; i++) for (let j = c; j < c + csn; j++) if (occupied.has(i * 4096 + j) || (j >= nCols && explicitCols)) return false; return true; };
    for (const it of items) {
      const ics = it.cs;
      const cS = gridLine(ics['grid-column-start']), cE = gridLine(ics['grid-column-end']);
      const rS = gridLine(ics['grid-row-start']), rE = gridLine(ics['grid-row-end']);
      let c0 = cS.auto ? null : resolveLine(cS.line, nColsBase) - 1;
      let cspan = cS.auto ? (cE.auto ? Math.max(cS.span, cE.span) : 1) : 1;
      if (!cS.auto && !cE.auto) cspan = Math.max(1, resolveLine(cE.line, nColsBase) - 1 - c0);
      else if (!cS.auto && cE.auto) cspan = cE.span;
      else if (cS.auto && !cE.auto) { const e = resolveLine(cE.line, nColsBase) - 1; cspan = cS.span; c0 = Math.max(0, e - cspan); }
      let r0 = rS.auto ? null : resolveLine(rS.line, Math.max(1, rowsT.length)) - 1;
      let rspan = rS.auto ? (rE.auto ? Math.max(rS.span, rE.span) : 1) : 1;
      if (!rS.auto && !rE.auto) rspan = Math.max(1, resolveLine(rE.line, Math.max(1, rowsT.length)) - 1 - r0);
      else if (!rS.auto && rE.auto) rspan = rE.span;
      cspan = Math.min(cspan, Math.max(nCols, cspan));
      if (c0 !== null && c0 + cspan > nCols) nCols = c0 + cspan;
      if (c0 === null && cspan > nCols) nCols = cspan;
      if (c0 !== null && r0 !== null) { /* fixed */ }
      else if (c0 !== null) { r0 = 0; while (!free(r0, c0, rspan, cspan)) r0++; }
      else if (r0 !== null) { c0 = 0; while (!free(r0, c0, rspan, cspan) && c0 < nCols) c0++; if (c0 + cspan > nCols) { c0 = nCols; nCols += cspan; } }
      else if (columnFlow) {
        // fill rows top to bottom first (approximation of column flow)
        let r = 0, c = curC;
        const rowsLimit = Math.max(1, rowsT.length);
        for (;;) { if (r + rspan > rowsLimit) { r = 0; c++; } if (free(r, c, rspan, cspan)) break; r++; }
        if (c + cspan > nCols) nCols = c + cspan;
        r0 = r; c0 = c; curC = c;
      } else {
        let r = curR, c = curC;
        for (let guard = 0; guard < 100000; guard++) {
          if (c + cspan > nCols) { c = 0; r++; continue; }
          if (free(r, c, rspan, cspan)) break;
          c++;
        }
        r0 = r; c0 = c; curR = r; curC = c + cspan;
      }
      for (let i = r0; i < r0 + rspan; i++) for (let j = c0; j < c0 + cspan; j++) occupied.add(i * 4096 + j);
      placed.push({ it, r0, c0, rspan, cspan });
    }
    while (cols.length < nCols) cols.push({ ...autoCol });
    if (!cols.length) cols = [{ kind: 'auto', min: 0, cap: Infinity }];
    nCols = cols.length;
    const nRows = Math.max(rowsT.length, placed.reduce((m, p) => Math.max(m, p.r0 + p.rspan), 0));
    const rows = rowsT.slice();
    while (rows.length < nRows) rows.push({ ...autoRow });
    // column sizes
    const colSize = new Array(nCols).fill(0);
    const gapsW = Math.max(0, nCols - 1) * colGap;
    let fixed = 0, frTotal = 0;
    cols.forEach((t, i) => {
      if (t.kind === 'px') colSize[i] = t.px;
      else if (t.kind === 'minmax') colSize[i] = t.min;
      else if (t.kind === 'auto') {
        let m = t.min || 0;
        for (const p of placed) if (p.c0 === i && p.cspan === 1) {
          resolveEdges(p.it, cw);
          m = Math.max(m, Math.min(intrinsic(p.it, 'max'), t.cap));
        }
        colSize[i] = m;
      } else frTotal += t.fr;
      if (t.kind !== 'fr') fixed += colSize[i];
    });
    if (!Number.isNaN(cw)) {
      let left = cw - gapsW - fixed;
      // shrink auto tracks towards min-content when overflowing
      if (left < 0) {
        const autos = cols.map((t, i) => (t.kind === 'auto' ? i : -1)).filter((i) => i >= 0);
        if (autos.length) {
          for (const i of autos) {
            let mn = cols[i].min || 0;
            for (const p of placed) if (p.c0 === i && p.cspan === 1) mn = Math.max(mn, intrinsic(p.it, 'min'));
            const reducible = colSize[i] - mn;
            const cut = Math.min(reducible, -left);
            colSize[i] -= cut; left += cut;
          }
        }
      }
      if (frTotal > 0) {
        const frs = cols.map((t, i) => (t.kind === 'fr' ? i : -1)).filter((i) => i >= 0);
        let unit = Math.max(0, left) / frTotal;
        // honour fr minimums
        for (let it = 0; it < 3; it++) {
          let fixedMin = 0, flexFr = 0;
          for (const i of frs) { if (cols[i].fr * unit < cols[i].min) fixedMin += cols[i].min; else flexFr += cols[i].fr; }
          unit = flexFr ? Math.max(0, left - fixedMin) / flexFr : 0;
        }
        for (const i of frs) colSize[i] = Math.max(cols[i].min, cols[i].fr * unit);
      } else if (left > 0) {
        const jc = lower(get(cs, 'justify-content'));
        const autos = cols.map((t, i) => (t.kind === 'auto' ? i : -1)).filter((i) => i >= 0);
        if (autos.length && (jc === 'normal' || jc === 'stretch' || jc === '')) for (const i of autos) colSize[i] += left / autos.length;
      }
    } else {
      cols.forEach((t, i) => { if (t.kind === 'fr') { let m = t.min; for (const p of placed) if (p.c0 === i && p.cspan === 1) m = Math.max(m, intrinsic(p.it, 'max')); colSize[i] = m; } });
    }
    const colX = []; { let x = 0; for (let i = 0; i < nCols; i++) { colX.push(x); x += colSize[i] + colGap; } }
    const spanW = (p) => colX[Math.min(nCols - 1, p.c0 + p.cspan - 1)] + colSize[Math.min(nCols - 1, p.c0 + p.cspan - 1)] - colX[p.c0];
    // row sizes
    const rowSize = new Array(nRows).fill(0);
    const ji = lower(get(cs, 'justify-items'));
    const ai = lower(get(cs, 'align-items'));
    for (const p of placed) {
      const it = p.it;
      const js = lower(it.cs['justify-self']) && lower(it.cs['justify-self']) !== 'auto' ? lower(it.cs['justify-self']) : ji;
      const areaW = spanW(p);
      resolveEdges(it, areaW);
      const stretchW = (js === 'stretch' || js === 'normal' || js === '' || js === 'legacy') && Number.isNaN(specSize(it, 'width', areaW)) && !it.replaced;
      p.w = stretchW ? clampW(it, Math.max(0, areaW - it.ml - it.mr), areaW) : NaN;
      p.js = js;
      layoutBox(it, 0, 0, areaW, NaN, Number.isNaN(p.w) ? { shrink: true, fill: areaW } : { w: p.w });
      p.h = it.h + it.mt + it.mb;
    }
    rows.forEach((t, i) => {
      if (t.kind === 'px') rowSize[i] = t.px;
      else if (t.kind === 'minmax') rowSize[i] = t.min;
      else rowSize[i] = t.min || 0;
    });
    for (const p of placed) if (p.rspan === 1 && rows[p.r0].kind !== 'px') rowSize[p.r0] = Math.max(rowSize[p.r0], Math.min(p.h, rows[p.r0].cap ?? Infinity, rows[p.r0].kind === 'minmax' ? rows[p.r0].max : Infinity));
    for (const p of placed) if (p.rspan > 1) {
      const sum = rowSize.slice(p.r0, p.r0 + p.rspan).reduce((s, v) => s + v, 0) + (p.rspan - 1) * rowGap;
      if (p.h > sum) rowSize[p.r0 + p.rspan - 1] += p.h - sum;
    }
    const frRows = rows.map((t, i) => (t.kind === 'fr' ? i : -1)).filter((i) => i >= 0);
    if (frRows.length && !Number.isNaN(chDef)) {
      const used = rowSize.reduce((s, v, i) => s + (rows[i].kind === 'fr' ? 0 : v), 0) + Math.max(0, nRows - 1) * rowGap;
      const tot = frRows.reduce((s, i) => s + rows[i].fr, 0);
      const unit = Math.max(0, chDef - used) / tot;
      for (const i of frRows) rowSize[i] = Math.max(rowSize[i], rows[i].fr * unit);
    } else if (!Number.isNaN(chDef) && !frRows.length) {
      const ac = lower(get(cs, 'align-content'));
      const used = rowSize.reduce((s, v) => s + v, 0) + Math.max(0, nRows - 1) * rowGap;
      const autos = rows.map((t, i) => (t.kind === 'auto' ? i : -1)).filter((i) => i >= 0);
      if (used < chDef && autos.length && (ac === 'normal' || ac === 'stretch' || ac === '')) for (const i of autos) rowSize[i] += (chDef - used) / autos.length;
    }
    const rowY = []; { let y = 0; for (let i = 0; i < nRows; i++) { rowY.push(y); y += rowSize[i] + rowGap; } }
    for (const p of placed) {
      const it = p.it;
      const areaW = spanW(p);
      const last = p.r0 + p.rspan - 1;
      const areaH = rowY[last] + rowSize[last] - rowY[p.r0];
      const as = lower(it.cs['align-self']) && lower(it.cs['align-self']) !== 'auto' ? lower(it.cs['align-self']) : ai;
      const stretchH = (as === 'stretch' || as === 'normal' || as === '') && Number.isNaN(specSize(it, 'height', areaH)) && !it.replaced && !it.mtA && !it.mbA;
      const h = stretchH ? clampH(it, Math.max(0, areaH - it.mt - it.mb), areaH) : NaN;
      const opt = Number.isNaN(p.w) ? { shrink: true, fill: areaW } : { w: p.w };
      if (!Number.isNaN(h)) opt.h = h;
      layoutBox(it, 0, 0, areaW, areaH, opt);
      let ox = 0, oy = 0;
      const outerW = it.w + it.ml + it.mr, outerH = it.h + it.mt + it.mb;
      if (p.js === 'center') ox = (areaW - outerW) / 2; else if (p.js === 'end' || p.js === 'right' || p.js === 'flex-end') ox = areaW - outerW;
      if (as === 'center') oy = (areaH - outerH) / 2; else if (as === 'end' || as === 'flex-end') oy = areaH - outerH;
      if (it.mlA && it.mrA) ox = (areaW - outerW) / 2;
      if (it.mtA && it.mbA) oy = (areaH - outerH) / 2;
      layoutBox(it, cx + colX[p.c0] + ox, cy + rowY[p.r0] + oy, areaW, areaH, opt);
    }
    return nRows ? rowY[nRows - 1] + rowSize[nRows - 1] : 0;
  }

  // --------------------------------------------------------------- paint
  // Display list ops (same numbers in native-dx12/webapp_ui.h).
  const OP = { CLIP: 1, RECT: 2, BORDER: 3, IMAGE: 4, TEXT: 5, LGRAD: 6, RGRAD: 7, SHADOW: 8 };
  let prims = [], hits = [], holeAt = -1, hitHoleAt = -1, holeRect = null;
  let strings = new Map();
  const str = (s) => { let i = strings.get(s); if (i === undefined) { i = strings.size; strings.set(s, i); } return i; };

  function radiiOf(b, w = b.w, h = b.h) {
    const cs = b.cs;
    const one = (p) => { const v = cs[p]; if (v == null) return 0; const t = splitTop(String(v), ' ')[0]; const n = px(t, Math.min(w, h), cs.__fs); return Number.isNaN(n) || n < 0 ? 0 : n; };
    let r = [one('border-top-left-radius'), one('border-top-right-radius'), one('border-bottom-right-radius'), one('border-bottom-left-radius')];
    const f = Math.min(1, w / Math.max(1e-6, r[0] + r[1]), w / Math.max(1e-6, r[3] + r[2]), h / Math.max(1e-6, r[0] + r[3]), h / Math.max(1e-6, r[1] + r[2]));
    if (f < 1) r = r.map((v) => v * f);
    return r;
  }
  const innerRadii = (r, b) => [Math.max(0, r[0] - Math.max(b.bl, b.bt)), Math.max(0, r[1] - Math.max(b.br, b.bt)), Math.max(0, r[2] - Math.max(b.br, b.bb)), Math.max(0, r[3] - Math.max(b.bl, b.bb))];
  function clipIntersect(a, b) {
    if (!a) return b;
    if (!b) return a;
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const r = Math.min(a.x + a.w, b.x + b.w), btm = Math.min(a.y + a.h, b.y + b.h);
    const out = { x, y, w: Math.max(0, r - x), h: Math.max(0, btm - y), r: 0 };
    const same = (c) => Math.abs(c.x - out.x) < 0.01 && Math.abs(c.y - out.y) < 0.01 && Math.abs(c.w - out.w) < 0.01 && Math.abs(c.h - out.h) < 0.01;
    if (same(b)) out.r = b.r; else if (same(a)) out.r = a.r;
    return out;
  }
  function innerClip(b, outer) {
    if (!b.clips || b.isText) return outer;
    const r = innerRadii(radiiOf(b), b);
    return clipIntersect(outer, { x: b.x + b.bl, y: b.y + b.bt, w: Math.max(0, b.w - b.bl - b.br), h: Math.max(0, b.h - b.bt - b.bb), r: Math.max(...r) });
  }
  function zIndexOf(b) { const z = parseInt(b.cs['z-index'], 10); return Number.isNaN(z) ? 0 : z; }
  function formsContext(b) {
    if (b.anonText) return false;
    const cs = b.cs;
    if (b.pos !== 'static') return true;
    const zi = lower(cs['z-index']);
    if (zi && zi !== 'auto' && b.parent && (b.parent.inner === 'flex' || b.parent.inner === 'grid')) return true;
    if (b.alpha < 1 && (!b.parent || b.parent.alpha > b.alpha)) return true;
    if (hasTransform(cs)) return true;
    if (lower(cs.isolation) === 'isolate') return true;
    return false;
  }
  function paintChildren(b) {
    const out = [];
    const visit = (list) => {
      for (const c of list) {
        if (c.isText) { if (!b.anonText && c.anon && c.anon._gen === layoutGen) out.push(c.anon); continue; }
        if (c.isBr) continue;
        if (c.outer === 'inline' && !c.replaced && c._gen !== layoutGen) { visit(c.children); continue; }
        if (c._gen !== layoutGen) continue;
        out.push(c);
      }
    };
    visit(b.children);
    return out;
  }
  function paintAll(root) {
    prims = []; hits = []; holeAt = -1; hitHoleAt = -1; holeRect = null; strings = new Map();
    // body background propagates to the root (and so sits behind the 3D canvas)
    const body = document.body && document.body._ntBox;
    root._propagatedBg = null;
    if (body && !hasBackground(root.cs) && hasBackground(body.cs)) { root._propagatedBg = body.cs; body._bgOnRoot = true; }
    paintContext(root, null);
  }
  function hasBackground(cs) {
    const c = parseColor(cs['background-color']);
    return (c && c[3] > 0) || (lower(cs['background-image']) && lower(cs['background-image']) !== 'none');
  }
  function paintContext(b, clipOuter) {
    paintOwn(b, clipOuter);
    b._clipInner = innerClip(b, clipOuter);
    const neg = [], zero = [], pos = [], flow = [];
    let seq = 0;
    const clipFor = (c, clip) => {
      if (c.pos === 'absolute' || c.pos === 'fixed') return c.cbBox && c.cbBox !== viewportBox ? (c.cbBox._clipInner ?? null) : null;
      return clip;
    };
    const collect = (p, clip) => {
      for (const c of paintChildren(p)) {
        const cc = clipFor(c, clip);
        if (formsContext(c)) {
          const z = zIndexOf(c);
          (z < 0 ? neg : z === 0 ? zero : pos).push({ box: c, clip: cc, z, seq: seq++ });
          continue;
        }
        flow.push({ box: c, clip: cc });
        c._clipInner = innerClip(c, cc);
        collect(c, c._clipInner);
      }
    };
    collect(b, b._clipInner);
    neg.sort((a, c) => a.z - c.z || a.seq - c.seq);
    pos.sort((a, c) => a.z - c.z || a.seq - c.seq);
    for (const e of neg) paintContext(e.box, e.clip);
    for (const e of flow) paintOwn(e.box, e.clip);
    for (const e of zero) paintContext(e.box, e.clip);
    for (const e of pos) paintContext(e.box, e.clip);
  }
  const prim = (clip, d) => prims.push({ clip, d });
  const colorWithAlpha = (c, a) => [c[0], c[1], c[2], c[3] * a];
  function paintOwn(b, clip) {
    const el = b.el || b.ownerEl || (b.parent && (b.parent.el || b.parent.ownerEl));
    const cs = b.cs;
    const vis = visible(cs);
    const alpha = b.alpha;
    if (!b.anonText && vis && alpha > 0.001 && b.w > 0 && b.h > 0) {
      const r = radiiOf(b);
      const current = parseColor(cs.color) || [0, 0, 0, 1];
      // outer box-shadows (first listed is on top)
      const shadow = cs['box-shadow'];
      if (shadow && lower(shadow) !== 'none') {
        for (const s of splitTop(shadow, ',').reverse()) {
          const toks = splitTop(s, ' ');
          if (toks.some((t) => lower(t) === 'inset')) continue;
          let color = null; const lens = [];
          for (const t of toks) { const n = px(t, 0, cs.__fs); if (!Number.isNaN(n)) lens.push(n); else color = parseColor(t, current); }
          if (!color) color = current;
          if (color[3] <= 0 || lens.length < 2) continue;
          const [ox, oy, blur = 0, spread = 0] = lens;
          prim(clip, [OP.SHADOW, b.x + ox - spread, b.y + oy - spread, b.w + 2 * spread, b.h + 2 * spread, ...r.map((v) => Math.max(0, v + spread)), Math.max(0, blur), ...colorWithAlpha(color, alpha)]);
        }
      }
      const bgCs = b === viewportRoot && b._propagatedBg ? b._propagatedBg : b._bgOnRoot ? null : cs;
      if (bgCs) paintBackground(b, bgCs, r, clip, alpha, current);
      // border
      const w = [b.bt, b.br, b.bb, b.bl];
      if (w.some((v) => v > 0)) {
        const cols = SIDES.map((s) => parseColor(cs[`border-${s}-color`] ?? 'currentcolor', current) || current);
        if (cols.some((c, i) => w[i] > 0 && c[3] > 0)) prim(clip, [OP.BORDER, b.x, b.y, b.w, b.h, ...r, ...w, ...cols.flatMap((c) => colorWithAlpha(c, alpha))]);
      }
      if (b.replaced) paintReplaced(b, clip, r, alpha, current);
    }
    if (b.frags) for (const f of b.frags) paintText(f, clip, alpha);
    if (el && vis && b.w > 0 && b.h > 0 && lower(get(cs, 'pointer-events')) !== 'none' && !b.anonText) {
      hits.push({ el, x: b.x, y: b.y, w: b.w, h: b.h, clip, box: b });
    }
    if (b.frags) for (const f of b.frags) if (f.el && f.el !== el && visible(f.cs) && lower(get(f.cs, 'pointer-events')) !== 'none') hits.push({ el: f.el, x: f.x, y: f.y, w: f.w, h: f.h, clip });
  }
  function paintText(f, clip, alpha) {
    if (!visible(f.cs) || !f.text) return;
    const cs = f.cs;
    const color = parseColor(cs['-webkit-text-fill-color'] || cs.color) || [0, 0, 0, 1];
    if (color[3] <= 0 && !cs['text-shadow']) return;
    const deco = lower(cs['text-decoration-line']);
    const flags = (deco.includes('underline') ? 1 : 0) | (deco.includes('line-through') ? 2 : 0) | (deco.includes('overline') ? 4 : 0);
    const fi = str(f.f.family), ti = str(f.text);
    const ls = letterSpacing(cs);
    const ts = cs['text-shadow'];
    if (ts && lower(ts) !== 'none') {
      const first = splitTop(ts, ',')[0];
      const toks = splitTop(first, ' ');
      let sc = null; const lens = [];
      for (const t of toks) { const n = px(t, 0, cs.__fs); if (!Number.isNaN(n)) lens.push(n); else sc = parseColor(t, color); }
      sc = sc || color;
      if (lens.length >= 2 && sc[3] > 0) {
        const blur = lens[2] || 0;
        // soft shadows are approximated with a lighter copy
        const a = blur > 0 ? Math.min(1, 0.75 - Math.min(0.45, blur / 30)) : 1;
        prim(clip, [OP.TEXT, f.x + lens[0], f.y + lens[1], f.w + 2, f.h, ti, fi, f.f.size, f.f.weight, f.f.italic, sc[0], sc[1], sc[2], sc[3] * alpha * a, flags, ls]);
      }
    }
    if (color[3] > 0) prim(clip, [OP.TEXT, f.x, f.y, f.w + 2, f.h, ti, fi, f.f.size, f.f.weight, f.f.italic, color[0], color[1], color[2], color[3] * alpha, flags, ls]);
  }

  // background-position components -> px offset
  function bgPos(spec, area, tile) {
    const toks = splitTop(spec || '0% 0%', ' ').map((t) => t.trim());
    let x = '0%', y = '0%';
    const isY = (t) => t === 'top' || t === 'bottom';
    const isX = (t) => t === 'left' || t === 'right';
    if (toks.length === 1) {
      if (isY(lower(toks[0]))) { x = '50%'; y = toks[0]; } else { x = toks[0]; y = '50%'; }
    } else if (toks.length >= 2) {
      if (toks.length === 4) {
        // left 10px top 5px
        const [a, av, c, cv] = toks;
        const off = (kw, v, area2, t2) => { const n = px(v, area2 - t2, 16); return lower(kw) === 'right' || lower(kw) === 'bottom' ? area2 - t2 - n : n; };
        if (isY(lower(a))) return [off(c, cv, area[0], tile[0]), off(a, av, area[1], tile[1])];
        return [off(a, av, area[0], tile[0]), off(c, cv, area[1], tile[1])];
      }
      [x, y] = toks;
      if (isY(lower(x)) || isX(lower(y))) [x, y] = [y, x];
    }
    const conv = (t, ar, ti) => {
      const l = lower(t);
      if (l === 'left' || l === 'top') return 0;
      if (l === 'center') return (ar - ti) / 2;
      if (l === 'right' || l === 'bottom') return ar - ti;
      if (l.endsWith('%')) return ((ar - ti) * parseFloat(l)) / 100;
      const n = px(t, ar - ti, 16);
      return Number.isNaN(n) ? 0 : n;
    };
    return [conv(x, area[0], tile[0]), conv(y, area[1], tile[1])];
  }
  function bgSize(spec, area, natural) {
    const l = lower(spec || 'auto');
    const [nw, nh] = natural || area;
    if (l === 'cover' || l === 'contain') {
      if (!nw || !nh) return area;
      const s = l === 'cover' ? Math.max(area[0] / nw, area[1] / nh) : Math.min(area[0] / nw, area[1] / nh);
      return [nw * s, nh * s];
    }
    const t = splitTop(l, ' ');
    let w = t[0] === 'auto' || !t[0] ? NaN : px(t[0], area[0], 16);
    let h = !t[1] || t[1] === 'auto' ? NaN : px(t[1], area[1], 16);
    if (Number.isNaN(w) && Number.isNaN(h)) return natural ? [nw, nh] : area;
    if (Number.isNaN(w)) w = natural && nh ? (h * nw) / nh : area[0];
    if (Number.isNaN(h)) h = natural && nw ? (w * nh) / nw : area[1];
    return [w, h];
  }
  function paintBackground(b, cs, r, clip, alpha, current) {
    const box = b === viewportRoot ? { x: 0, y: 0, w: Math.max(ctx.vw, b.w), h: Math.max(ctx.vh, b.h) } : b;
    const bg = parseColor(cs['background-color'], current);
    if (bg && bg[3] > 0) prim(clip, [OP.RECT, box.x, box.y, box.w, box.h, ...r, ...colorWithAlpha(bg, alpha)]);
    const imgs = cs['background-image'];
    if (!imgs || lower(imgs) === 'none') return;
    const layers = splitTop(imgs, ',');
    const sizes = splitTop(cs['background-size'] || 'auto', ',');
    const poses = splitTop(cs['background-position'] || '0% 0%', ',');
    const reps = splitTop(cs['background-repeat'] || 'repeat', ',');
    const ax = box.x + (b.bl || 0), ay = box.y + (b.bt || 0);
    const aw = Math.max(0, box.w - (b.bl || 0) - (b.br || 0)), ah = Math.max(0, box.h - (b.bt || 0) - (b.bb || 0));
    const boxClip = clipIntersect(clip, { x: box.x, y: box.y, w: box.w, h: box.h, r: Math.max(...r) });
    for (let i = layers.length - 1; i >= 0; i--) {
      let layer = layers[i].trim();
      const ll = lower(layer);
      if (ll === 'none') continue;
      if (/^(-webkit-)?image-set\(/.test(ll)) { const m = /url\([^)]*\)|"[^"]*"|'[^']*'/i.exec(layer); if (!m) continue; layer = m[0].startsWith('url') ? m[0] : `url(${m[0]})`; }
      const sizeSpec = sizes[i % sizes.length], posSpec = poses[i % poses.length], rep = lower(reps[i % reps.length]);
      if (/^url\(/i.test(layer)) {
        const src = cssUrl(layer, cs, 'background-image');
        if (!src) continue;
        const info = imageSize(src);
        if (!info || !info.w || !info.h) continue;
        const [tw, th] = bgSize(sizeSpec, [aw, ah], [info.w, info.h]);
        if (tw <= 0 || th <= 0) continue;
        const [ox, oy] = bgPos(posSpec, [aw, ah], [tw, th]);
        const repX = rep === 'repeat' || rep === 'repeat-x' || rep.startsWith('repeat ') || rep === 'space' || rep === 'round';
        const repY = rep === 'repeat' || rep === 'repeat-y' || rep.endsWith(' repeat') || rep === 'space' || rep === 'round';
        const si = str(src);
        let x0 = ax + ox, y0 = ay + oy;
        let nx = 1, ny = 1;
        if (repX) { while (x0 > box.x) x0 -= tw; nx = Math.ceil((box.x + box.w - x0) / tw); }
        if (repY) { while (y0 > box.y) y0 -= th; ny = Math.ceil((box.y + box.h - y0) / th); }
        if (nx * ny > 900) { nx = Math.min(nx, 30); ny = Math.min(ny, 30); }
        for (let yy = 0; yy < ny; yy++) for (let xx = 0; xx < nx; xx++) prim(boxClip, [OP.IMAGE, x0 + xx * tw, y0 + yy * th, tw, th, si, 0, 0, 0, 0, alpha, 0, 1]);
      } else if (/gradient\(/.test(ll)) {
        const g = parseGradient(layer, current);
        if (!g) continue;
        // gradients default to covering the whole background area
        const [gw, gh] = lower(sizeSpec) === 'auto' || !sizeSpec ? [aw || box.w, ah || box.h] : bgSize(sizeSpec, [aw, ah], null);
        const [ox, oy] = bgPos(posSpec, [aw, ah], [gw, gh]);
        const gx = (lower(sizeSpec) === 'auto' || !sizeSpec) ? box.x : ax + ox, gy = (lower(sizeSpec) === 'auto' || !sizeSpec) ? box.y : ay + oy;
        const gW = (lower(sizeSpec) === 'auto' || !sizeSpec) ? box.w : gw, gH = (lower(sizeSpec) === 'auto' || !sizeSpec) ? box.h : gh;
        const stops = g.stops.flatMap((s) => [s.pos, ...colorWithAlpha(s.color, alpha)]);
        const rr = gW === box.w && gH === box.h ? r : [0, 0, 0, 0];
        if (g.type === 'linear') {
          const a = (g.angle * Math.PI) / 180;
          const len = Math.abs(gW * Math.sin(a)) + Math.abs(gH * Math.cos(a));
          const cx = gx + gW / 2, cy = gy + gH / 2;
          const dx = (Math.sin(a) * len) / 2, dy = (-Math.cos(a) * len) / 2;
          prim(boxClip, [OP.LGRAD, gx, gy, gW, gH, ...rr, cx - dx, cy - dy, cx + dx, cy + dy, g.stops.length, ...stops]);
        } else {
          const cx = gx + g.cx(gW), cy = gy + g.cy(gH);
          const [rx, ry] = g.radii(gW, gH, cx - gx, cy - gy);
          prim(boxClip, [OP.RGRAD, gx, gy, gW, gH, ...rr, cx, cy, rx, ry, g.stops.length, ...stops]);
        }
      }
    }
  }
  function parseGradient(text, current) {
    const m = /^(-webkit-)?(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/is.exec(text.trim());
    if (!m || m[3] === 'conic') return null;
    const args = splitTop(m[4], ',');
    const out = { type: m[3], stops: [] };
    let first = lower(args[0] || '');
    let stopArgs = args;
    if (m[3] === 'linear') {
      out.angle = 180;
      const ang = /^(-?[\d.]+)(deg|turn|rad|grad)$/.exec(first);
      if (ang) {
        let a = parseFloat(ang[1]);
        a = ang[2] === 'turn' ? a * 360 : ang[2] === 'rad' ? (a * 180) / Math.PI : ang[2] === 'grad' ? a * 0.9 : a;
        out.angle = m[1] ? 90 - a : a;
        stopArgs = args.slice(1);
      } else if (first.startsWith('to ') || (m[1] && /^(top|bottom|left|right)/.test(first))) {
        const dir = first.replace(/^to\s+/, '');
        const map = { top: 0, right: 90, bottom: 180, left: 270, 'top right': 45, 'right top': 45, 'bottom right': 135, 'right bottom': 135, 'bottom left': 225, 'left bottom': 225, 'top left': 315, 'left top': 315 };
        out.angle = map[dir] ?? 180;
        if (m[1]) out.angle = (out.angle + 180) % 360;
        stopArgs = args.slice(1);
      }
    } else {
      let cxs = '50%', cys = '50%', shape = 'ellipse', size = 'farthest-corner', explicit = null;
      if (!parseColor(splitTop(args[0], ' ')[0], current)) {
        stopArgs = args.slice(1);
        const [shapePart, atPart] = first.split(/\s*\bat\b\s*/);
        for (const t of splitTop(shapePart || '', ' ')) {
          if (t === 'circle' || t === 'ellipse') shape = t;
          else if (/^(closest|farthest)-(side|corner)$/.test(t)) size = t;
          else { const n = px(t, 100, 16); if (!Number.isNaN(n) || t.endsWith('%')) (explicit || (explicit = [])).push(t); }
        }
        if (atPart) { const p = splitTop(atPart, ' '); cxs = p[0]; cys = p[1] ?? '50%'; if (p[0] === 'top' || p[0] === 'bottom') [cxs, cys] = ['50%', p[0]]; }
      }
      const posFn = (s) => (w) => { const l = lower(s); if (l === 'left' || l === 'top') return 0; if (l === 'right' || l === 'bottom') return w; if (l === 'center') return w / 2; const n = px(s, w, 16); return Number.isNaN(n) ? w / 2 : n; };
      out.cx = posFn(cxs); out.cy = posFn(cys);
      out.radii = (w, h, cx, cy) => {
        if (explicit) { const rx = px(explicit[0], w, 16); const ry = explicit[1] ? px(explicit[1], h, 16) : rx; return [rx, shape === 'circle' ? rx : ry]; }
        const dx = Math.max(cx, w - cx), dy = Math.max(cy, h - cy), sx = Math.min(cx, w - cx), sy = Math.min(cy, h - cy);
        if (shape === 'circle') {
          const v = size === 'closest-side' ? Math.min(sx, sy) : size === 'farthest-side' ? Math.max(dx, dy) : size === 'closest-corner' ? Math.hypot(sx, sy) : Math.hypot(dx, dy);
          return [v, v];
        }
        if (size === 'closest-side') return [sx, sy];
        if (size === 'farthest-side') return [dx, dy];
        const k = size === 'closest-corner' ? Math.SQRT2 : Math.SQRT2;
        return size === 'closest-corner' ? [sx * k, sy * k] : [dx * k, dy * k];
      };
    }
    for (const a of stopArgs) {
      const toks = splitTop(a, ' ');
      if (!toks.length) continue;
      let color = parseColor(toks[0], current), rest = toks.slice(1);
      if (!color && toks.length > 1) { color = parseColor(toks[toks.length - 1], current); rest = toks.slice(0, -1); }
      if (!color) continue;
      const poss = rest.map((t) => (t.endsWith('%') ? parseFloat(t) / 100 : NaN)).filter((v) => !Number.isNaN(v));
      if (!poss.length) out.stops.push({ pos: NaN, color });
      for (const p of poss) out.stops.push({ pos: p, color });
    }
    if (!out.stops.length) return null;
    if (out.stops.length === 1) out.stops.push({ ...out.stops[0] });
    const st = out.stops;
    if (Number.isNaN(st[0].pos)) st[0].pos = 0;
    if (Number.isNaN(st[st.length - 1].pos)) st[st.length - 1].pos = 1;
    for (let i = 1; i < st.length; i++) if (!Number.isNaN(st[i].pos) && st[i].pos < st[i - 1].pos) st[i].pos = st[i - 1].pos;
    for (let i = 1; i < st.length - 1; i++) {
      if (!Number.isNaN(st[i].pos)) continue;
      let j = i; while (Number.isNaN(st[j].pos)) j++;
      const a = st[i - 1].pos, bpos = st[j].pos;
      for (let k = i; k < j; k++) st[k].pos = a + ((bpos - a) * (k - i + 1)) / (j - i + 1);
    }
    return out;
  }
  function objectFit(box, cx, cy, cw, ch, nw, nh) {
    const fit = lower(box.cs['object-fit'] || 'fill');
    if (!nw || !nh || fit === 'fill') return { dx: cx, dy: cy, dw: cw, dh: ch, sx: 0, sy: 0, sw: 0, sh: 0 };
    let s;
    if (fit === 'contain') s = Math.min(cw / nw, ch / nh);
    else if (fit === 'cover') s = Math.max(cw / nw, ch / nh);
    else if (fit === 'none') s = 1;
    else s = Math.min(1, Math.min(cw / nw, ch / nh));
    const dw = nw * s, dh = nh * s;
    const [ox, oy] = bgPos(box.cs['object-position'] || '50% 50%', [cw, ch], [dw, dh]);
    let dx = cx + ox, dy = cy + oy;
    // crop to the content box in source space
    const x0 = Math.max(dx, cx), y0 = Math.max(dy, cy), x1 = Math.min(dx + dw, cx + cw), y1 = Math.min(dy + dh, cy + ch);
    return { dx: x0, dy: y0, dw: Math.max(0, x1 - x0), dh: Math.max(0, y1 - y0), sx: (x0 - dx) / s, sy: (y0 - dy) / s, sw: (x1 - x0) / s, sh: (y1 - y0) / s };
  }
  function paintReplaced(b, clip, r, alpha, current) {
    const el = b.el;
    const cx = b.x + b.bl + b.pl, cy = b.y + b.bt + b.pt;
    const cw = Math.max(0, b.w - hEdges(b)), ch = Math.max(0, b.h - vEdges(b));
    const ir = innerRadii(r, b);
    const contentClip = clipIntersect(clip, { x: b.x + b.bl, y: b.y + b.bt, w: b.w - b.bl - b.br, h: b.h - b.bt - b.bb, r: Math.max(...ir) });
    const f = () => fontOf(b.cs);
    const text = (t, x, y, w, h, color, center) => {
      if (!t) return;
      const fo = f();
      const tw = measureText(t, fo, b.cs);
      const tx = center ? x + (w - tw) / 2 : x;
      prim(contentClip, [OP.TEXT, tx, y, Math.min(tw + 2, Math.max(w, tw + 2)), h, str(t), str(fo.family), fo.size, fo.weight, fo.italic, color[0], color[1], color[2], color[3] * alpha, 0, letterSpacing(b.cs)]);
    };
    switch (b.replaced) {
      case 'img': {
        const src = b.src || imgSrc(el);
        if (!src) return;
        const info = imageSize(src);
        const fit = objectFit(b, cx, cy, cw, ch, info && info.w, info && info.h);
        if (fit.dw > 0 && fit.dh > 0) prim(contentClip, [OP.IMAGE, fit.dx, fit.dy, fit.dw, fit.dh, str(src), fit.sx, fit.sy, fit.sw, fit.sh, alpha, 0, lower(b.cs['image-rendering']) === 'pixelated' ? 0 : 1]);
        return;
      }
      case 'svg': {
        if (!el._ntSvgSrc || el._ntSvgGen !== styleGeneration) { el._ntSvgSrc = inlineSvgSource(el); el._ntSvgGen = styleGeneration; }
        if (cw > 0 && ch > 0) prim(contentClip, [OP.IMAGE, cx, cy, cw, ch, str(el._ntSvgSrc), 0, 0, 0, 0, alpha, 0, 1]);
        return;
      }
      case 'canvas':
        if (el && el._ntRendererCanvas) { holeAt = prims.length; hitHoleAt = hits.length; holeRect = clipIntersect(clip, { x: b.x, y: b.y, w: b.w, h: b.h, r: 0 }); }
        return;
      case 'input': {
        const type = lower(el.getAttribute('type') || 'text');
        if (type === 'checkbox' || type === 'radio') {
          if (el.checked) {
            const acc = parseColor(b.cs['accent-color']) || [0.0, 0.46, 0.85, 1];
            if (type === 'radio') prim(contentClip, [OP.RECT, cx + cw * 0.25, cy + ch * 0.25, cw * 0.5, ch * 0.5, cw * 0.25, cw * 0.25, cw * 0.25, cw * 0.25, ...colorWithAlpha(acc, alpha)]);
            else {
              prim(contentClip, [OP.RECT, b.x + b.bl, b.y + b.bt, b.w - b.bl - b.br, b.h - b.bt - b.bb, ...ir, ...colorWithAlpha(acc, alpha)]);
              const fo = { ...f(), size: Math.max(8, ch * 0.95), weight: 700 };
              const tw = measureRaw('✓', fo);
              prim(contentClip, [OP.TEXT, b.x + (b.w - tw) / 2, b.y, tw + 2, b.h, str('✓'), str('Segoe UI Symbol,Segoe UI'), fo.size, 700, 0, 1, 1, 1, alpha, 0, 0]);
            }
          }
          return;
        }
        if (type === 'range') {
          const min = parseFloat(el.getAttribute('min') ?? '0') || 0, max = parseFloat(el.getAttribute('max') ?? '100');
          const v = clamp((parseFloat(el.value) - min) / ((Number.isNaN(max) ? 100 : max) - min || 1), 0, 1);
          const acc = parseColor(b.cs['accent-color']) || [0.0, 0.46, 0.85, 1];
          prim(contentClip, [OP.RECT, cx, cy + ch / 2 - 2, cw, 4, 2, 2, 2, 2, 0.75, 0.75, 0.75, alpha]);
          prim(contentClip, [OP.RECT, cx, cy + ch / 2 - 2, cw * v, 4, 2, 2, 2, 2, ...colorWithAlpha(acc, alpha)]);
          prim(contentClip, [OP.RECT, cx + cw * v - ch / 2, cy, ch, ch, ch / 2, ch / 2, ch / 2, ch / 2, ...colorWithAlpha(acc, alpha)]);
          return;
        }
        if (type === 'button' || type === 'submit' || type === 'reset') { text(el.value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : ''), cx, cy, cw, ch, current, true); return; }
        if (type === 'color') { const c = parseColor(el.value || '#000000') || [0, 0, 0, 1]; prim(contentClip, [OP.RECT, cx, cy, cw, ch, 0, 0, 0, 0, ...colorWithAlpha(c, alpha)]); return; }
        if (type === 'file' || type === 'hidden') return;
        const value = el.value || '';
        const shown = type === 'password' ? '•'.repeat(value.length) : value;
        if (shown) text(shown, cx, cy, cw, ch, current, false);
        else if (el.getAttribute('placeholder')) text(el.getAttribute('placeholder'), cx, cy, cw, ch, [0.46, 0.46, 0.46, 1], false);
        return;
      }
      case 'textarea': {
        const fo = f(), lh = lineHeightOf(b.cs);
        const lines = (el.value || el.textContent || '').split('\n');
        lines.forEach((ln, i) => { if (ln && i * lh < ch) prim(contentClip, [OP.TEXT, cx, cy + i * lh, cw, lh, str(ln), str(fo.family), fo.size, fo.weight, fo.italic, current[0], current[1], current[2], current[3] * alpha, 0, 0]); });
        return;
      }
      case 'select': {
        const opts = el.childNodes.filter((n) => n.nodeType === 1 && n.localName === 'option');
        let sel = opts.find((o) => o.hasAttribute('selected')) || opts[0];
        if (el._value !== undefined) sel = opts.find((o) => (o.getAttribute('value') ?? o.textContent) === el._value) || sel;
        if (sel) text(sel.textContent.trim(), cx, cy, cw - 14, ch, current, false);
        text('▾', cx + cw - 12, cy, 12, ch, current, false);
        return;
      }
      case 'progress': case 'meter': {
        const max = parseFloat(el.getAttribute('max') ?? '1') || 1;
        const raw = el.getAttribute('value');
        const val = el._value !== undefined ? parseFloat(el._value) : raw === null ? NaN : parseFloat(raw);
        const bgc = parseColor(b.cs['background-color']);
        if (!bgc || bgc[3] === 0) prim(contentClip, [OP.RECT, b.x, b.y, b.w, b.h, ...r, 0.88, 0.88, 0.88, alpha]);
        if (!Number.isNaN(val)) {
          const acc = parseColor(b.cs['accent-color']) || parseColor(b.cs.color) || [0.0, 0.46, 0.85, 1];
          const frac = clamp(val / max, 0, 1);
          prim(contentClip, [OP.RECT, cx, cy, cw * frac, ch, ...ir, ...colorWithAlpha(acc, alpha)]);
        }
        return;
      }
      default:
    }
  }

  // Encodes visible display-list entries (from the 3D canvas upward).
  let lastFloats = null, lastStrings = '', submitted = 0;
  function encode() {
    const out = [1, state.width, state.height, 0];
    let count = 0, curClip;
    for (let i = 0; i < prims.length; i++) {
      const p = prims[i];
      if (i < holeAt && coveredByCanvas(p.d[1], p.d[2], p.d[3], p.d[4])) continue;
      if (p.clip !== curClip) {
        const c = p.clip;
        out.push(OP.CLIP, c ? c.x : 0, c ? c.y : 0, c ? c.w : -1, c ? c.h : -1, c ? c.r || 0 : 0);
        curClip = c; count++;
      }
      for (const v of p.d) out.push(v);
      count++;
    }
    out[3] = count;
    const floats = Float32Array.from(out);
    const joined = [...strings.keys()].join('\u001f');
    return { floats, joined };
  }
  // Painted before the 3D canvas and completely under it: hidden, like in a browser.
  function coveredByCanvas(x, y, w, h) {
    const r = holeRect;
    return !!r && x >= r.x - 0.5 && y >= r.y - 0.5 && x + w <= r.x + r.w + 0.5 && y + h <= r.y + r.h + 0.5;
  }
  function submit(floats, joined) {
    let same = lastFloats && lastFloats.length === floats.length && joined === lastStrings;
    if (same) for (let i = 0; i < floats.length; i++) if (floats[i] !== lastFloats[i]) { same = false; break; }
    if (same) return false;
    lastFloats = floats; lastStrings = joined;
    if (typeof nt.submitUi === 'function') {
      try { nt.submitUi(floats, floats.length, joined); submitted++; } catch (e) { host.warnOnce('ui-submit', `UI submit failed: ${e && e.message}`); }
    }
    return true;
  }

  // -------------------------------------------------------------- driver
  let viewportRoot = null;
  let needStyle = true, needLayout = true, needPaint = true;
  const styleRoots = new Set();
  let lastSize = '';
  let siblingRules = true;
  let frameErrors = 0;
  const timing = { style: 0, layout: 0, paint: 0, frames: 0 };

  function styleElement(el, parentCs) {
    const root = document.documentElement;
    const entries = candidates(ruleIndex, el).filter((e) => (!e.media || mediaMatches(e.media)) && matchSelector(el, e.sel));
    const cs = cascade(el, entries, inlineDecls(el), parentCs);
    if (lower(cs['font-weight']) === 'bolder' || lower(cs['font-weight']) === 'lighter') {
      const pw = parentCs ? parseInt(parentCs['font-weight'], 10) || (lower(parentCs['font-weight']) === 'bold' ? 700 : 400) : 400;
      cs['font-weight'] = String(lower(cs['font-weight']) === 'bolder' ? (pw < 600 ? 700 : 900) : (pw > 500 ? 400 : 100));
    }
    if (el === root) ctx.rootFs = cs.__fs;
    el._ntStyle = cs;
    el._ntPseudo = null;
    const pc = candidates(pseudoIndex, el);
    if (pc.length) {
      const before = [], after = [];
      for (const e of pc) {
        if (e.media && !mediaMatches(e.media)) continue;
        if (!matchSelector(el, e.sel)) continue;
        (e.sel.pseudoEl === 'before' ? before : after).push(e);
      }
      if (before.length || after.length) {
        el._ntPseudo = {};
        if (before.length) el._ntPseudo.before = cascade(el, before, null, cs);
        if (after.length) el._ntPseudo.after = cascade(el, after, null, cs);
      }
    }
    for (const c of el.childNodes) if (c.nodeType === 1) styleElement(c, cs);
  }
  function fullRestyle() {
    styleGeneration++;
    ctx.vw = state.width; ctx.vh = state.height;
    const root = document.documentElement;
    if (root) styleElement(root, null);
  }
  function partialRestyle(roots) {
    styleGeneration++;
    const list = [...roots].filter((r) => r && r.nodeType === 1 && r.isConnected);
    // skip roots inside other roots
    const set = new Set(list);
    for (const r of list) {
      let covered = false;
      for (let p = r.parentNode; p; p = p.parentNode) if (set.has(p)) { covered = true; break; }
      if (covered) continue;
      const parent = r.parentNode;
      styleElement(r, parent && parent.nodeType === 1 ? parent._ntStyle || null : null);
    }
  }
  function layoutAll() {
    layoutGen++;
    ctx.vw = state.width; ctx.vh = state.height;
    const rootEl = document.documentElement;
    viewportBox = { id: 0, isViewport: true, abs: [], x: 0, y: 0, w: ctx.vw, h: ctx.vh, cs: {}, children: [], _escapes: [] };
    if (!rootEl || !rootEl._ntStyle) { viewportRoot = null; return null; }
    const root = buildBoxes(rootEl, null);
    viewportRoot = root;
    if (!root) return null;
    layoutBox(root, 0, 0, ctx.vw, ctx.vh, { fill: ctx.vw });
    viewportBox.abs = [...new Set(viewportBox.abs)];
    for (const a of viewportBox.abs) layoutAbs(a, viewportBox);
    return root;
  }
  function ensureLayout() {
    if (!document.documentElement) return false;
    const size = `${state.width}x${state.height}`;
    if (size !== lastSize) { lastSize = size; needStyle = true; }
    if (!needStyle && !styleRoots.size && !needLayout) return false;
    const t0 = now();
    if (collectSheets()) needStyle = true;
    siblingRules = true;
    if (needStyle || styleRoots.size > 64) fullRestyle();
    else if (styleRoots.size) partialRestyle(styleRoots);
    needStyle = false; styleRoots.clear();
    const t1 = now();
    layoutAll();
    const t2 = now();
    timing.style += t1 - t0; timing.layout += t2 - t1;
    needLayout = false; needPaint = true;
    return true;
  }
  const now = () => (global.performance && performance.now ? performance.now() : Date.now());
  function ensurePaint() {
    ensureLayout();
    if (!needPaint) return false;
    needPaint = false;
    if (!viewportRoot) { prims = []; hits = []; holeAt = -1; hitHoleAt = -1; holeRect = null; strings = new Map(); return true; }
    const t0 = now();
    paintAll(viewportRoot);
    timing.paint += now() - t0;
    return true;
  }

  // ---- hit testing
  function hitTest(x, y) {
    try { ensurePaint(); } catch (e) { reportFrameError(e); return null; }
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i];
      if (i < hitHoleAt && coveredByCanvas(h.x, h.y, h.w, h.h)) continue;
      if (x < h.x || y < h.y || x >= h.x + h.w || y >= h.y + h.h) continue;
      const c = h.clip;
      if (c && (x < c.x || y < c.y || x >= c.x + c.w || y >= c.y + c.h)) continue;
      return h.el;
    }
    return null;
  }
  function boxOf(el) {
    const b = el && el._ntBox;
    return b && b._gen === layoutGen ? b : null;
  }
  function scrollableAncestor(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
      const b = boxOf(n);
      if (b && b.scrollable) return b;
    }
    return null;
  }
  function reportFrameError(e) {
    frameErrors++;
    if (frameErrors <= 3) nt.log('error', `[NativeThreeBridge UI] ${e && e.stack ? e.stack : e}`);
  }

  const api = {
    invalidate(kind, node, name) {
      switch (kind) {
        case 'tree':
          if (node && node.nodeType === 1 && node.isConnected) { styleRoots.add(node); needLayout = true; }
          else if (node && node.nodeType === 9) { needStyle = true; needLayout = true; }
          break;
        case 'text': if (!node || node.isConnected) needLayout = true; break;
        case 'attr':
          if (node && node.isConnected) {
            if (name === 'class') node._ntClassSet = null;
            const p = node.parentNode;
            styleRoots.add(siblingRules && p && p.nodeType === 1 && name !== 'style' ? p : node);
            needLayout = true;
          } else if (node && name === 'class') node._ntClassSet = null;
          break;
        case 'style': if (node && node.isConnected) { styleRoots.add(node); needLayout = true; } break;
        case 'layout': needLayout = true; break;
        default: needStyle = true; needLayout = true;
      }
    },
    frame() {
      // Adaptive rate: when restyle/layout gets expensive (DOM changing every
      // frame), the overlay refreshes less often instead of costing FPS.
      // Input hit tests still force an up-to-date layout.
      const t = now();
      if (t - lastFrameUpdate < minInterval && (needLayout || styleRoots.size || needStyle)) return;
      try {
        const t0 = now();
        const changed = needLayout || styleRoots.size > 0 || needStyle || needPaint;
        ensurePaint();
        if (changed) {
          const cost = now() - t0;
          minInterval = cost < 4 ? 0 : Math.min(100, cost * 2);
          lastFrameUpdate = t;
        }
        if (lastSubmittedGen !== layoutGen || needSubmit) {
          const { floats, joined } = encode();
          submit(floats, joined);
          lastSubmittedGen = layoutGen; needSubmit = false;
        }
        timing.frames++;
      } catch (e) { reportFrameError(e); }
    },
    hitTest,
    // Border box of an element in window px, or null when it has no box.
    rect(el) {
      try { ensureLayout(); } catch (e) { reportFrameError(e); }
      const b = boxOf(el);
      if (!b) return null;
      return { x: b.x, y: b.y, w: b.w, h: b.h, bl: b.bl, br: b.br, bt: b.bt, bb: b.bb, scrollW: b.scrollW, scrollH: b.scrollH, pl: b.pl, pt: b.pt, pr: b.pr, pb: b.pb };
    },
    computed(el) {
      try { ensureLayout(); } catch (e) { reportFrameError(e); }
      return el && el._ntStyle ? el._ntStyle : null;
    },
    matchMedia: mediaMatches,
    imageSize(src) { return imageSize(src); },
    resolve(base, ref) { return resolveRef(base, ref); },
    setHover(el) {
      if (interact.hover === el) return;
      const old = interact.hover;
      interact.hover = el;
      if (hoverRules) markInteraction(old, el);
    },
    setActive(el) {
      if (interact.active === el) return;
      const old = interact.active;
      interact.active = el;
      if (hoverRules) markInteraction(old, el);
    },
    focusChanged(oldEl, newEl) { if (hoverRules) markInteraction(oldEl, newEl); },
    // Default action of a wheel event: scrolls the nearest scrollable box.
    wheel(target, dx, dy) {
      const b = scrollableAncestor(target);
      if (!b) return null;
      const el = b.el;
      const pbw = b.w - b.bl - b.br, pbh = b.h - b.bt - b.bb;
      const ny = clamp((el._ntScrollTop || 0) + dy, 0, Math.max(0, b.scrollH - pbh));
      const nx = clamp((el._ntScrollLeft || 0) + dx, 0, Math.max(0, b.scrollW - pbw));
      if (ny === (el._ntScrollTop || 0) && nx === (el._ntScrollLeft || 0)) return null;
      el._ntScrollTop = ny; el._ntScrollLeft = nx;
      needLayout = true;
      return el;
    },
    cursorAt(el) {
      for (let n = el; n && n.nodeType === 1; n = n.parentNode) if (n._ntStyle) return lower(n._ntStyle.cursor) || 'auto';
      return 'auto';
    },
    stats() {
      return { boxes: boxSeq, prims: prims.length, visible: prims.filter((p, i) => !(i < holeAt && coveredByCanvas(p.d[1], p.d[2], p.d[3], p.d[4]))).length, hits: hits.length, submitted, sheets: sheets.length, rules: sheets.reduce((s, x) => s + x.sheet.rules.length, 0), timing: { ...timing }, hole: holeAt >= 0 };
    },
    // test hooks
    _debug: { get prims() { return prims; }, get holeAt() { return holeAt; }, get strings() { return strings; }, encode, parseColor, px, parseSheet, parseSelectorList },
  };
  let lastSubmittedGen = -1, needSubmit = false;
  let lastFrameUpdate = -1e9, minInterval = 0;
  // Restyle the topmost element that entered or left the hover/active chain.
  function markInteraction(a, b) {
    const chainA = [], chainB = [];
    for (let n = a; n && n.nodeType === 1; n = n.parentNode) chainA.unshift(n);
    for (let n = b; n && n.nodeType === 1; n = n.parentNode) chainB.unshift(n);
    let i = 0;
    while (i < chainA.length && i < chainB.length && chainA[i] === chainB[i]) i++;
    const roots = [chainA[i], chainB[i]].filter(Boolean);
    for (const r of roots) { const p = r.parentNode; styleRoots.add(siblingRules && p && p.nodeType === 1 ? p : r); }
    if (roots.length) needLayout = true;
  }
  host.ui = api;
})(globalThis);
