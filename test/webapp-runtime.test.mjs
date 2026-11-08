// v0.28 webapp runtime: an unchanged Three.js webapp folder (index.html +
// ES modules) runs through the same shim, NativeRenderer and module
// resolution rules that the native engine uses. Node's vm stands in for
// QuickJS; the Windows CI runs the identical sample in WebappSmoke.exe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runWebapp, decodePass, resolveModule, threeBuildDir, THREE_MODULE_SOURCE } from './helpers/webapp-node-host.mjs';
import { DrawFlags, LightType, PASS_HEADER_FLOATS, DRAW_FLOATS, LIGHT_FLOATS, MAX_LIGHTS } from '../js/native-renderer.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sample = new URL('../samples/hello-webapp', import.meta.url).pathname;
const edge = new URL('./fixtures/webapp-edge', import.meta.url).pathname;
const badImport = new URL('./fixtures/webapp-bad-import', import.meta.url).pathname;
const haveThree = !!threeBuildDir();
const skip = haveThree ? false : 'three is not installed (npm install)';

test('hello-webapp boots without errors and renders its whole scene', { skip }, async () => {
  const { rec, status } = await runWebapp(sample, { frames: 60 });
  assert.equal(status.booted, true);
  assert.deepEqual(status.errors, []);
  assert.equal(status.bootError, null);
  assert.deepEqual(status.unsupported, [], 'the sample only uses supported features');
  assert.equal(rec.passes.length, 1, 'one render() per frame');
  const pass = decodePass(rec.passes[0]);
  // ground, instanced blocks, knot, sphere, glass, lamp marker
  assert.equal(pass.draws.length, 6);
  assert.deepEqual(pass.lights.map((l) => l.type).sort(), [LightType.HEMISPHERE, LightType.DIRECTIONAL, LightType.POINT, LightType.SPOT].sort());
  assert.deepEqual(pass.size, [1280, 720]);
  assert.equal(pass.flags & 3, 3, 'autoClear clears colour and depth');
  // scene.background 0x1d2633 is sent as display (sRGB) values
  assert.ok(Math.abs(pass.clear[0] - 0x1d / 255) < 0.01 && Math.abs(pass.clear[2] - 0x33 / 255) < 0.01);
  const instanced = pass.draws.find((d) => d.instanceId > 0);
  assert.equal(instanced.instanceCount, 100);
  assert.ok(instanced.flags & DrawFlags.INSTANCE_COLORS);
  assert.ok(pass.draws.at(-1).flags & DrawFlags.TRANSPARENT, 'transparent glass is drawn last');
  assert.ok(pass.draws.some((d) => d.flags & DrawFlags.UNLIT), 'MeshBasicMaterial lamp marker is unlit');
  assert.ok(pass.draws.some((d) => d.metalness > 0.5), 'MeshStandardMaterial parameters arrive');
});

test('geometry and instance buffers cross to native once, not every frame', { skip }, async () => {
  const { rec } = await runWebapp(sample, { frames: 120 });
  assert.equal(rec.uploads, 6);
  assert.equal(rec.geometries.size, 6);
  assert.equal(rec.instanceUploads, 1);
});

test('pointer drag, wheel, keyboard and resize reach the webapp like in a browser', { skip }, async () => {
  const views = [];
  let afterKey = null;
  const { rec } = await runWebapp(sample, {
    frames: 12,
    onFrame: ({ frame, host, rec: r }) => {
      views[frame] = decodePass(r.passes[0]).view;
      if (frame === 2) { host.pointer('down', 400, 300, 0); host.pointer('move', 460, 320, 0); host.pointer('up', 460, 320, 0); }
      if (frame === 5) host.wheel(400, 300, 0, 120);
      if (frame === 7) host.key(true, 'l', 'KeyL', false, false, false, false, false);
      if (frame === 8) afterKey = decodePass(r.passes[0]);
      if (frame === 9) host.resize(800, 600, 1);
    },
  });
  assert.notDeepEqual(views[2], views[3], 'drag orbits the camera');
  assert.notDeepEqual(views[5], views[6], 'wheel zooms');
  assert.equal(afterKey.lights.length, 3, 'L hides the point light');
  assert.equal(afterKey.draws.length, 5, '…and its child marker');
  assert.deepEqual(decodePass(rec.passes[0]).size, [800, 600], 'resize listener updates the renderer');
});

test('edge webapp: importmap prefixes, classic scripts, built-in OrbitControls, DOM, fetch, timers', { skip }, async () => {
  const { context: w, status, rec } = await runWebapp(edge, {
    frames: 8,
    onFrame: ({ frame, context }) => { if (frame === 2) context.document.getElementById('go').click(); },
  });
  assert.equal(status.bootError, null);
  assert.deepEqual(status.errors, []);
  assert.deepEqual([...w.classicOrder], ['classic', 'module']); // values from the sandbox realm
  assert.equal(w.fetchedValue, 'loaded from game folder');
  assert.equal(w.metaUrl, 'nt://game/index.html');
  assert.match(w.networkBlocked, /network access is disabled/);
  assert.equal(w.textureFailedGracefully, true);
  assert.deepEqual(JSON.parse(JSON.stringify(w.counts)), { lis: 3, panels: 1 });
  assert.equal(w.timeoutRan, true);
  assert.equal(w.clicked, 'fast');
  assert.equal(w.document.getElementById('score').textContent, '7');
  assert.equal(w.document.title, 'Edge & cases');
  for (const feature of ['ShaderMaterial / custom GLSL', 'THREE.Points', 'Image/texture decoding']) assert.ok(status.unsupported.includes(feature), feature);
  const pass = decodePass(rec.passes[0]);
  assert.ok(pass.draws.some((d) => d.flags & DrawFlags.NORMAL_COLOR));
  assert.ok(pass.draws.some((d) => (d.flags & DrawFlags.LINES) && (d.flags & DrawFlags.VERTEX_COLORS)), 'GridHelper lines');
});

test('a bare import that is not in the importmap stops only that module, with a clear message', { skip }, async () => {
  const { context, status } = await runWebapp(badImport, { frames: 3 });
  assert.match(status.bootError, /Bare module 'canvas-confetti' is not in the importmap/);
  assert.equal(context.shouldNotRun, undefined);
});

test('module resolution rules (mirrored in webapp_host.cpp)', () => {
  const builtins = ['nt:three.core.min.js', 'nt:three.module.min.js', 'nt:native-renderer.mjs', 'nt:addons/controls/OrbitControls.js', 'nt:three'];
  const map = ['three', 'https://unpkg.com/three/build/three.module.js', '@lib/', './lib/', 'cannon', './vendor/cannon.js', 'remote', 'https://cdn.example/x.js'];
  const r = (base, spec) => resolveModule(base, spec, map, builtins);
  assert.equal(r('main.js', 'three'), 'nt:three');
  assert.equal(r('main.js', 'three/addons/controls/OrbitControls.js'), 'nt:addons/controls/OrbitControls.js');
  assert.equal(r('main.js', 'three/examples/jsm/controls/OrbitControls.js'), 'nt:addons/controls/OrbitControls.js');
  assert.equal(r('nt:three.module.min.js', './three.core.min.js'), 'nt:three.core.min.js');
  assert.equal(r('src/game/main.js', './util.js'), 'src/game/util.js');
  assert.equal(r('src/game/main.js', '../shared/a.js?v=3'), 'src/shared/a.js');
  assert.equal(r('src/game/main.js', '/root.js'), 'root.js');
  assert.equal(r('index.html#inline-1', './main.js'), 'main.js');
  assert.equal(r('src/deep/x.js', '@lib/thing.js'), 'lib/thing.js', 'importmap values resolve from index.html');
  assert.equal(r('src/x.js', 'cannon'), 'vendor/cannon.js');
  assert.equal(r('main.js', './vendor/three.module.js'), 'nt:three', 'vendored three is replaced');
  assert.throws(() => r('main.js', 'remote'), /points to the internet/);
  assert.throws(() => r('main.js', 'lodash'), /Bare module 'lodash' is not in the importmap/);
  assert.throws(() => r('main.js', '../../etc/passwd'), /leaves the game folder/);
  assert.throws(() => r('main.js', 'three/addons/loaders/GLTFLoader.js'), /points to the internet|Bare module/);
});

test('C++ host mirrors the resolver, packet layout and engine three module', () => {
  const cpp = read('native-dx12/webapp_host.cpp'), h = read('native-dx12/webapp_host.h');
  assert.ok(cpp.includes(THREE_MODULE_SOURCE.split('\n').map((l) => l && `        "${l}\\n"`).filter(Boolean).join('\n')), 'virtual three module text is identical');
  for (const message of ['points to the internet', 'is not in the importmap of index.html', 'Module path leaves the game folder', 'nt:addons/', 'three/examples/jsm/']) assert.ok(cpp.includes(message), message);
  assert.match(h, new RegExp(`kWebappPassHeaderFloats = ${PASS_HEADER_FLOATS};`));
  assert.match(h, new RegExp(`kWebappLightFloats = ${LIGHT_FLOATS};`));
  assert.match(h, new RegExp(`kWebappDrawFloats = ${DRAW_FLOATS};`));
  assert.match(h, new RegExp(`kWebappMaxLights = ${MAX_LIGHTS};`));
  assert.match(cpp, /JS_SetModuleLoaderFunc\(s\.rt, moduleNormalize, moduleLoader/);
});

test('webapp mode is a separate path: forest battle stays the default scene', () => {
  const dx = read('native-dx12/NativeThree-DX12.cpp');
  const webapp = dx.indexOf('NativeWebapp_Run(');
  const marker = dx.indexOf('.native-three-game-manifest.json');
  const battle = dx.indexOf('initializeDX12();', marker);
  assert.ok(webapp > marker && webapp < battle, 'webapp check runs after the manifest guard and before the battle scene');
  assert.match(dx, /--webapp/);
  assert.match(dx, /index\.html/);
});
