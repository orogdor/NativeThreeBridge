// GLSL stages compile in the background: while a stage is compiling its
// draws wait (engine side); a stage that fails to compile is dropped and
// its materials are worked out again without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runWebapp, decodePass, threeBuildDir } from './helpers/webapp-node-host.mjs';

const fixture = fileURLToPath(new URL('./fixtures/webapp-postprocessing', import.meta.url));
const skip = threeBuildDir() ? false : 'three is not installed (npm install)';

test('a stage that fails in the background is no longer used', { skip }, async () => {
  let failed = 0;
  const { rec, status } = await runWebapp(fixture, {
    frames: 4,
    beforeFrame: ({ frame, rec: r }) => {
      if (frame === 0) r.patchStatusDefault = 0; // still compiling
      if (frame !== 2 || !r.colorPatches) return;
      // every stage registered so far failed to compile
      r.patchStatus = new Map([...r.colorPatches.keys()].map((id) => [id, -1]));
      failed = r.colorPatches.size;
    },
  });
  assert.equal(status.bootError, null);
  assert.ok(failed > 0, 'stages were registered');
  const last = rec.framePasses.map(decodePass);
  const staged = last.flatMap((p) => p.draws).filter((d) => d.colorStage > 0 && d.colorStage <= failed);
  assert.equal(staged.length, 0, 'no draw uses a failed stage');
});
