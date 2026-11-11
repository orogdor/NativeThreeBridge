import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, threeBuildDir } from './helpers/webapp-node-host.mjs';

const raw = fileURLToPath(new URL('./fixtures/raw-webgl2-dx12', import.meta.url));
const three = fileURLToPath(new URL('../samples/hello-webapp', import.meta.url));
const skipThree = threeBuildDir() ? false : 'three dependency is not installed';

test('raw WebGL2 prototype is opt-in per canvas and cannot steal a 2D context', async () => {
  const { context, rec, status } = await runWebapp(raw, { frames: 6 });
  assert.equal(status.bootError, null);
  assert.deepEqual(status.errors, []);
  const canvas = context.document.getElementById('raw');
  const gl = canvas.getContext('webgl2');
  assert.ok(gl, 'explicitly marked raw canvas retains WebGL2 prototype');
  assert.equal(canvas._ntGraphicsOwner, 'raw-webgl2');
  assert.strictEqual(canvas.getContext('webgl2'), gl, 'same context on repeated lookup');
  assert.strictEqual(canvas.getContext('2d'), null, 'WebGL2 canvas cannot become a 2D canvas');

  canvas.removeAttribute('data-native-webgl2-prototype');
  assert.strictEqual(canvas.getContext('webgl2'), gl, 'removing marker cannot replace a live context');

  const ordinary = context.document.createElement('canvas');
  assert.strictEqual(ordinary.getContext('webgl2'), null, 'raw context is unavailable by default');
  const ctx2d = ordinary.getContext('2d');
  assert.ok(ctx2d);
  ordinary.setAttribute('data-native-webgl2-prototype', '');
  assert.strictEqual(ordinary.getContext('webgl2'), null, 'opt-in cannot steal an existing 2D context');
  assert.strictEqual(ordinary.getContext('2d'), ctx2d);
  assert.equal(rec.passes.length, 1, 'raw render still emits a native pass');
});

test('normal Three.js app keeps its native renderer when raw WebGL2 opt-in is added later',
  { skip: skipThree }, async () => {
    const { context, rec, status } = await runWebapp(three, { frames: 12 });
    assert.equal(status.bootError, null);
    assert.deepEqual(status.errors, []);
    const canvas = context.document.getElementById('view');
    assert.equal(canvas._ntGraphicsOwner, 'native-three');
    assert.equal(canvas._ntRendererCanvas, true);
    assert.equal(canvas._nativeGL2, undefined, 'raw prototype never initialized in Three.js');
    canvas.setAttribute('data-native-webgl2-prototype', '');
    assert.strictEqual(canvas.getContext('webgl2'), null,
      'opt-in cannot replace an active Three.js NativeRenderer');
    assert.strictEqual(canvas.getContext('2d'), null,
      'Three.js rendering canvas cannot be stolen by Canvas 2D');
    assert.equal(canvas._nativeGL2, undefined);
    assert.equal(canvas._ntGraphicsOwner, 'native-three');
    assert.equal(rec.passes.length, 1, 'native Three.js still emits its own pass');
    assert.equal(rec.geometries.size, 6, 'standard Three.js geometry unaffected');
  });
