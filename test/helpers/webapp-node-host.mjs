// Node mirror of native-dx12/webapp_host.cpp for tests: same shim, same
// NativeRenderer, same module resolution rules, a plain JS sandbox (vm)
// instead of QuickJS and a recording sink instead of DX12.
// Needs: node --experimental-vm-modules
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DRAW_FLOATS, LIGHT_FLOATS, PASS_HEADER_FLOATS } from '../../js/native-renderer.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function threeBuildDir() {
  const candidates = [process.env.THREE_BUILD_DIR, path.join(repo, 'node_modules/three/build')].filter(Boolean);
  for (const c of candidates) if (existsSync(path.join(c, 'three.module.min.js'))) return c;
  return null;
}

export const THREE_MODULE_SOURCE =
  "export * from 'nt:three.module.min.js';\n" +
  "import * as THREE_CORE from 'nt:three.core.min.js';\n" +
  "import { ShaderLib, UniformsUtils } from 'nt:three.module.min.js';\n" +
  "import { createNativeRendererClasses } from 'nt:native-renderer.mjs';\n" +
  "const { NativeRenderer } = createNativeRendererClasses(THREE_CORE, globalThis.__nt, globalThis.__ntHost, { ShaderLib, UniformsUtils });\n" +
  "export { NativeRenderer, NativeRenderer as WebGLRenderer };\n";

export function loadBuiltins(threeDir = threeBuildDir()) {
  const builtins = new Map();
  builtins.set('nt:three.core.min.js', readFileSync(path.join(threeDir, 'three.core.min.js'), 'utf8'));
  builtins.set('nt:three.module.min.js', readFileSync(path.join(threeDir, 'three.module.min.js'), 'utf8'));
  builtins.set('nt:native-renderer.mjs', readFileSync(path.join(repo, 'js/native-renderer.mjs'), 'utf8'));
  const jsm = path.join(threeDir, '..', 'examples', 'jsm');
  for (const addon of ['controls/OrbitControls.js', 'controls/PointerLockControls.js']) {
    const file = path.join(jsm, addon);
    if (existsSync(file)) builtins.set(`nt:addons/${addon}`, readFileSync(file, 'utf8'));
  }
  builtins.set('nt:three', THREE_MODULE_SOURCE);
  return builtins;
}

// ---- resolution: must stay identical to webappResolveModule() in C++.
function normalizeSegments(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (part === '..') { if (!out.length) return null; out.pop(); } else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}
const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); };
const isThreeBuildFile = (p) => ['three.module.js', 'three.module.min.js', 'three.core.js', 'three.core.min.js'].includes(p.split('/').pop());
const stripQH = (s) => s.replace(/[?#].*$/, '');

export function resolveModule(base, specifierIn, importMap, builtinNames) {
  let specifier = specifierIn, effectiveBase = base;
  if (specifier === 'three') return 'nt:three';
  for (const prefix of ['three/addons/', 'three/examples/jsm/']) {
    if (specifier.startsWith(prefix)) {
      const name = 'nt:addons/' + specifier.slice(prefix.length);
      if (builtinNames.includes(name)) return name;
    }
  }
  if (base.startsWith('nt:')) {
    if (specifier.startsWith('nt:')) return specifier;
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const joined = normalizeSegments(dirOf(base.slice(3)) + specifier);
      if (joined === null) throw new ReferenceError(`Engine module path escapes: ${specifier}`);
      return 'nt:' + joined;
    }
  }
  const relative = specifier.startsWith('/') || specifier.startsWith('./') || specifier.startsWith('../');
  if (!relative) {
    let best = '', bestValue = null, exact = false;
    for (let i = 0; i + 1 < importMap.length; i += 2) {
      const key = importMap[i];
      if (key === specifier) { bestValue = importMap[i + 1]; exact = true; break; }
      if (key.endsWith('/') && specifier.startsWith(key) && key.length > best.length) { best = key; bestValue = importMap[i + 1] + specifier.slice(key.length); }
    }
    if (exact || best) { specifier = bestValue; effectiveBase = 'index.html'; }
  }
  const lower = specifier.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('//')) {
    if (isThreeBuildFile(stripQH(specifier))) return 'nt:three';
    throw new ReferenceError(`Module '${specifierIn}' points to the internet (${specifier}). NativeThreeBridge runs offline: copy the file into the game folder and point the importmap to it.`);
  }
  if (specifier.startsWith('nt:')) {
    if (builtinNames.includes(specifier) || specifier === 'nt:three') return specifier;
    throw new ReferenceError(`Unknown engine module ${specifier}`);
  }
  if (!(specifier.startsWith('/') || specifier.startsWith('./') || specifier.startsWith('../'))) {
    throw new ReferenceError(`Bare module '${specifierIn}' is not in the importmap of index.html`);
  }
  const pathPart = stripQH(specifier);
  const baseFile = effectiveBase.replace(/#.*$/, '');
  const joined = pathPart[0] === '/' ? pathPart.slice(1) : dirOf(baseFile) + pathPart;
  const normalized = normalizeSegments(joined);
  if (!normalized) throw new ReferenceError(`Module path leaves the game folder: ${specifierIn}`);
  if (isThreeBuildFile(normalized)) return 'nt:three';
  return normalized;
}

function normalizeGamePath(p) {
  if (!p || /[\\:\0]/.test(p)) return null;
  const n = normalizeSegments(p);
  return n || null;
}

// Recording sink with the same validation as the C++ __nt functions.
export function createRecorder() {
  return {
    geometries: new Map(), instances: new Map(), textures: new Map(), canvases: new Map(), passes: [], framePasses: [], titles: [], logs: [],
    uploads: 0, instanceUploads: 0,
  };
}

export async function runWebapp(root, options = {}) {
  const { frames = 120, width = 1280, height = 720, frameMs = 1000 / 60, onFrame } = options;
  const builtins = options.builtins || loadBuiltins();
  const builtinNames = [...builtins.keys()];
  const rec = createRecorder();
  const context = vm.createContext({});
  const CtxArrayBuffer = vm.runInContext('ArrayBuffer', context);
  let importMap = [];
  const moduleCache = new Map();
  const warnedThree = new Set();

  const readGameFile = (rel) => {
    const clean = normalizeGamePath(rel);
    if (!clean) throw new ReferenceError(`Invalid game path: ${rel}`);
    const full = path.join(root, clean);
    if (!existsSync(full)) throw new ReferenceError(`File not found in game folder: ${clean}`);
    return readFileSync(full);
  };
  const metaURL = (name) => (name.startsWith('nt:') ? name : `nt://game/${name.replace(/#.*$/, '')}`);
  // Dynamic import(): same resolution as static imports (QuickJS uses the
  // same normalize/loader callbacks for both).
  const importDynamic = async (specifier, referrer) => {
    const base = referrer && referrer.identifier ? referrer.identifier : 'index.html';
    const m = await linker(specifier, { identifier: base });
    if (m.status === 'unlinked') await m.link(linker);
    if (m.status === 'linked') await m.evaluate();
    return m;
  };
  const makeModule = (source, name) => new vm.SourceTextModule(source, {
    context, identifier: name,
    initializeImportMeta(meta) { meta.url = metaURL(name); meta.main = false; },
    importModuleDynamically: (specifier, referrer) => importDynamic(specifier, referrer),
  });
  const linker = async (specifier, referencing) => {
    const name = resolveModule(referencing.identifier, specifier, importMap, builtinNames);
    if (name === 'nt:three' && specifier !== 'three' && !specifier.startsWith('nt:') && !warnedThree.has(specifier) && warnedThree.add(specifier)) rec.logs.push(['warn', `'${specifier}' replaced by built-in three`]);
    if (moduleCache.has(name)) return moduleCache.get(name);
    let source;
    if (name.startsWith('nt:')) {
      if (!builtins.has(name)) throw new ReferenceError(`Engine module ${name} is missing from this build`);
      source = builtins.get(name);
    } else {
      if (name.toLowerCase().endsWith('.json')) throw new TypeError(`JSON modules are not supported yet: ${name} (use fetch)`);
      source = readGameFile(name).toString('utf8');
    }
    const m = makeModule(source, name);
    moduleCache.set(name, m);
    return m;
  };

  const view = (v, what) => { if (!ArrayBuffer.isView(v)) throw new TypeError(`${what}: wrong typed array type`); return v; };
  const nt = {
    log(level, text) { rec.logs.push([String(level), String(text)]); },
    setTitle(t) { rec.titles.push(String(t)); },
    readText(p) { return readGameFile(String(p)).toString('utf8'); },
    readBinary(p) {
      const bytes = readGameFile(String(p));
      const ab = new CtxArrayBuffer(bytes.length);
      new Uint8Array(ab).set(bytes);
      return ab;
    },
    setImportMap(list) { importMap = Array.from(list, String); },
    evalScript(source, name) { return vm.runInContext(String(source), context, { filename: String(name), importModuleDynamically: (spec) => importDynamic(spec, { identifier: String(name).includes('#') ? 'index.html' : String(name) }) }); },
    async evalModule(source, name) {
      const m = makeModule(String(source), String(name));
      await m.link(linker);
      await m.evaluate();
    },
    registerColorPatch(id, source) {
      rec.colorPatches ??= new Map();
      rec.colorPatches.set(id, source);
      return true;
    },
    uploadGeometry(id, positions, normals, colors, indices, uvs, gpuLocal = false) {
      view(positions, 'positions');
      if (positions.length % 3) throw new RangeError('positions not 3 per vertex');
      if (normals && normals.length !== positions.length) throw new RangeError('normals length');
      if (colors && colors.length !== positions.length && colors.length !== positions.length / 3 * 4) throw new RangeError('colors length');
      const vertexCount = positions.length / 3;
      if (uvs && uvs.length !== vertexCount * 2) throw new RangeError('uvs length');
      if (indices) for (const i of indices) if (i >= vertexCount) throw new RangeError('Geometry index out of range');
      rec.uploads++;
      let alphaMin = null, alphaMax = null;
      if (colors && colors.length === vertexCount * 4) {
        alphaMin = Infinity; alphaMax = -Infinity;
        for (let i = 0; i < vertexCount; i++) {
          const a = colors[i * 4 + 3];
          alphaMin = Math.min(alphaMin, a);
          alphaMax = Math.max(alphaMax, a);
        }
      }
      rec.geometries.set(id, { vertexCount, indexCount: indices ? indices.length : 0, hasNormals: !!normals, hasColors: !!colors, colorChannels: colors ? colors.length / (positions.length / 3) : 0, hasUvs: !!uvs, alphaMin, alphaMax, gpuLocal });
    },
    // Encoded image bytes (width 0) or raw RGBA8 pixels. The engine decodes
    // natively with WIC; here only the header is checked.
    uploadTexture(id, data, width, height, flags) {
      view(data, 'texture data');
      let info;
      if (width > 0) {
        if (data.length < width * height * 4) throw new RangeError('uploadTexture: pixel data too short');
        info = { w: width, h: height, type: 'rgba' };
      } else info = context.__ntHost.ui.sniffImage(data);
      if (!info) return false;
      rec.textures.set(id, { ...info, flags, bytes: data.length });
      rec.textureUploads = (rec.textureUploads || 0) + 1;
      return true;
    },
    releaseTexture(id) { rec.textures.delete(id); },
    // Canvas 2D command batches (executed by Direct2D in the engine).
    canvasCommands(id, width, height, ops, floats, strings) {
      view(ops, 'canvas commands');
      if (floats > ops.length) throw new RangeError('canvasCommands: floats > length');
      const c = rec.canvases.get(id) || { width, height, batches: 0, ops: [], strings: [] };
      c.width = width; c.height = height; c.batches++;
      const list = String(strings).split('\u001f');
      for (let o = 0; o < floats;) {
        const op = ops[o], n = ops[o + 1];
        if (!(n >= 0) || o + 2 + n > floats) throw new RangeError('canvasCommands: truncated command');
        c.ops.push([op, ...ops.subarray(o + 2, o + 2 + n)]);
        if (op === 30) c.strings.push(list[ops[o + 3]]);
        o += 2 + n;
      }
      if (c.ops.length > 50000) c.ops.splice(0, c.ops.length - 50000);
      rec.canvases.set(id, c);
    },
    canvasRead(id, x, y, w, h) { return null; },
    canvasWrite(id, cw, ch, x, y, w, h, bytes) { view(bytes, 'pixels'); if (bytes.length < w * h * 4) throw new RangeError('canvasWrite: too few bytes'); },
    registerImage(key, bytes) { view(bytes, 'image bytes'); (rec.registeredImages ||= new Map()).set(String(key), bytes.length); },
    uploadCanvasTexture(id, canvasId, flags) {
      if (!rec.canvases.has(canvasId)) return false;
      rec.textures.set(id, { canvas: canvasId, flags });
      rec.textureUploads = (rec.textureUploads || 0) + 1;
      return true;
    },
    releaseGeometry(id) { rec.geometries.delete(id); },
    uploadInstances(id, matrices, colors, count) {
      if (matrices.length < count * 16) throw new RangeError('instance matrices');
      if (colors && colors.length < count * 3) throw new RangeError('instance colors');
      rec.instanceUploads++;
      rec.instances.set(id, { count, hasColors: !!colors, first: Array.from(matrices.slice(0, 16)) });
    },
    releaseInstances(id) { rec.instances.delete(id); },
    submitUi(packet, floats, strings) {
      if (floats > packet.length || (packet[0] !== 1 && packet[0] !== 2)) throw new RangeError('submitUi: bad packet');
      rec.uiSubmits = (rec.uiSubmits || 0) + 1;
      rec.ui = { floats: Float32Array.from(packet.subarray(0, floats)), strings: String(strings).split('\u001f') };
    },
    submitPass(packet, floats) {
      const lights = packet[35], draws = packet[43];
      if (PASS_HEADER_FLOATS + lights * LIGHT_FLOATS + draws * DRAW_FLOATS !== floats) throw new RangeError('submitPass: header counts do not match packet size');
      rec.framePasses.push(Float32Array.from(packet.subarray(0, floats)));
    },
  };
  context.__nt = nt;
  vm.runInContext(readFileSync(path.join(repo, 'js/webapp-shim.js'), 'utf8'), context, { filename: 'nt:webapp-shim.js' });
  vm.runInContext(readFileSync(path.join(repo, 'js/webapp-ui.js'), 'utf8'), context, { filename: 'nt:webapp-ui.js' });
  const host = context.__ntHost;
  const settle = () => new Promise((r) => setImmediate(r));

  host.resize(width, height, 1);
  host.boot(readGameFile('index.html').toString('utf8'));
  for (let i = 0; i < 20 && !host.state.booted && !host.state.bootError; i++) await settle();
  let t = 0;
  for (let f = 0; f < frames; f++) {
    rec.framePasses = [];
    host.frame(t);
    await settle();
    if (rec.framePasses.length) rec.passes = rec.framePasses;
    if (onFrame) await onFrame({ frame: f, host, rec, context });
    t += frameMs;
  }
  return { rec, host, status: JSON.parse(host.status()), context };
}

// Decodes one pass packet into objects (for assertions).
export function decodePass(p) {
  const lightCount = p[35], drawCount = p[43];
  const pass = {
    view: Array.from(p.subarray(0, 16)), projection: Array.from(p.subarray(16, 32)),
    cameraPosition: [p[32], p[33], p[34]], clear: [p[36], p[37], p[38], p[39]],
    ambient: [p[40], p[41], p[42]], flags: p[44], size: [p[45], p[46]], exposure: p[47], toneMapping: p[48], lights: [], draws: [],
  };
  let o = PASS_HEADER_FLOATS;
  for (let i = 0; i < lightCount; i++, o += LIGHT_FLOATS) pass.lights.push({ type: p[o], color: [p[o + 1], p[o + 2], p[o + 3]], position: [p[o + 4], p[o + 5], p[o + 6]], distance: p[o + 7], direction: [p[o + 8], p[o + 9], p[o + 10]], decay: p[o + 11], extra: [p[o + 12], p[o + 13], p[o + 14]] });
  for (let i = 0; i < drawCount; i++, o += DRAW_FLOATS) pass.draws.push({ geometryId: p[o], instanceId: p[o + 1], instanceCount: p[o + 2], flags: p[o + 3], start: p[o + 4], count: p[o + 5], roughness: p[o + 6], metalness: p[o + 7], color: [p[o + 8], p[o + 9], p[o + 10]], opacity: p[o + 11], emissive: [p[o + 12], p[o + 13], p[o + 14]], shininess: p[o + 15], matrix: Array.from(p.subarray(o + 16, o + 32)), textureId: p[o + 32], alphaTest: p[o + 33], uvTransform: Array.from(p.subarray(o + 34, o + 40)), reflection: Array.from(p.subarray(o + 40, o + 48)), colorStage: p[o + 48], colorUniforms: Array.from(p.subarray(o + 49, o + 61)), materialTextures: Array.from(p.subarray(o + 61, o + 70)) });
  return pass;
}
