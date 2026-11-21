// WebGLRenderTarget: render() into a native texture, then sample it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass, threeBuildDir } from './helpers/webapp-node-host.mjs';
import { DrawFlags } from '../js/native-renderer.mjs';

const fixture = fileURLToPath(new URL('./fixtures/webapp-render-target', import.meta.url));
const skip = threeBuildDir() ? false : 'three is not installed (npm install)';

test('render target pass first, then a material samples its texture', { skip }, async () => {
  const { rec, status } = await runWebapp(fixture, { frames: 3 });
  assert.equal(status.bootError, null);
  assert.ok(!status.unsupported.some((u) => /Render targets/.test(u)), status.unsupported.join(', '));
  const [targetPass, screenPass] = rec.framePasses.map(decodePass);
  assert.ok(targetPass.target > 0, 'first pass renders into the target');
  assert.deepEqual(rec.renderTargets.get(targetPass.target), { width: 256, height: 256 });
  assert.deepEqual(targetPass.size, [256, 256]);
  assert.equal(screenPass.target, 0, 'second pass draws to the window');
  const screen = screenPass.draws.find((d) => d.textureId === targetPass.target);
  assert.ok(screen && screen.flags & DrawFlags.MAP, 'the screen plane samples the target');
  assert.ok(screen.uvTransform[3] < 0, 'v is flipped for a render target texture');
});
