// EffectComposer + UnrealBloomPass + OutputPass from three.js addons: every
// full-screen pass is a translated GLSL stage (defines, uniform arrays,
// constant-bound loops), drawn into render targets, OutputPass to the window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass, threeBuildDir } from './helpers/webapp-node-host.mjs';
import { DrawFlags } from '../js/native-renderer.mjs';

const fixture = fileURLToPath(new URL('./fixtures/webapp-postprocessing', import.meta.url));
const skip = threeBuildDir() ? false : 'three is not installed (npm install)';

test('bloom and output passes run as translated shaders on render targets', { skip }, async () => {
  const { rec, status } = await runWebapp(fixture, { frames: 3 });
  assert.equal(status.bootError, null);
  assert.ok(!status.unsupported.some((u) => /ShaderMaterial|Render targets/.test(u)), status.unsupported.join(', '));
  const passes = rec.framePasses.map(decodePass);
  // RenderPass, bright pass, 5 mips x 2 blur passes, composite, blend, output.
  assert.equal(passes.length, 15, `passes: ${passes.length}`);
  assert.ok(passes[0].target > 0, 'the scene renders into the composer buffer');
  assert.equal(passes.at(-1).target, 0, 'OutputPass draws to the window');
  const sources = [...rec.colorPatches.values()];
  assert.ok(sources.some((s) => /\[unroll\] for \(\s*int i = 1; i < 22;/.test(s)), 'the blur loop is translated with its define');
  assert.ok(sources.some((s) => /bloomFactors\[4\]/.test(s)), 'uniform arrays are translated');
  for (const pass of passes.slice(1, -1)) {
    assert.ok(pass.target > 0, 'bloom passes render into targets');
    assert.equal(pass.draws.length, 1);
    assert.ok(pass.draws[0].colorStage > 0, 'each full-screen pass is a translated stage');
  }
  const blend = passes.at(-2).draws[0];
  assert.ok(blend.flags & DrawFlags.ADDITIVE, 'the bloom is added onto the scene');
  const output = passes.at(-1).draws[0];
  assert.ok(output.flags & DrawFlags.MAP, 'OutputPass samples the composer buffer');
  assert.ok(!(output.flags & DrawFlags.NO_TONE_MAP), 'OutputPass applies the renderer tone mapping');
  assert.equal(passes.at(-1).toneMapping, 4);
  // Gaussian coefficients and invSize of the first blur reach the draw.
  const blur = passes[2].draws[0];
  assert.ok(blur.colorUniforms.some((v) => Math.abs(v - 0.39894 / 2) < 1e-4), 'gaussian weights (sigma 2) are packed');
});
