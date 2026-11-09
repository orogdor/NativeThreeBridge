import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const host = read('native-dx12/three_js_host.cpp');
const dx = read('native-dx12/NativeThree-DX12.cpp');
const flow = read('.github/workflows/native-threejs.yml');
const launcher = read('launcher/Game-Launcher.c');
const engineUpdater = read('launcher/UpdateEngine.cs');
const gameUpdater = read('launcher/UpdateKuningriigid.cs');

test('real official Three.js runtime loads scene.js from the selected game folder', () => {
  assert.match(host, /loadGameScene\(/);
  assert.match(host, /GetModuleFileNameW/);
  assert.match(host, /NativeThree_SceneFolder\(\) \+ L"\\\\scene\.js"/);
  assert.match(host, /JS_Eval\(context, gameScript\.data\(\)/);
  assert.match(dx, /--scene/, 'engine accepts --scene <folder>');
});

test('DX12 projection uses correct row-vector convention', () => {
  assert.match(dx, /XMMatrixTranspose\(view\*proj\)/);
  assert.match(dx, /mul\(float4\(p,1\),gViewProjection\)/);
});

test('Game1 opens the forest battle in game1, Game2 the webapp in game2', () => {
  assert.match(launcher, /--scene game1/);
  assert.match(launcher, /--webapp \\"%s\\\\game2\\"/);
  assert.match(launcher, /game2\\\\index\.html/);
  assert.match(launcher, /UpdateKuningriigid\.exe/, 'empty game2 explains what to run');
  assert.match(flow, /\/DNTB_GAME=\$n launcher\/Game-Launcher\.c \/Fe:dist\/Game\$n\.exe/);
  assert.match(flow, /\$g2\.ExitCode -ne 42/, 'CI checks Game2 stops on an empty game2');
});

test('UpdateEngine replaces only engine files from a SHA-256 checked stable release', () => {
  assert.match(engineUpdater, /releases\/latest/);
  assert.match(engineUpdater, /engine-update-v2\.json/);
  assert.match(engineUpdater, /Common\.Sha256\(zip\) != sha/);
  assert.match(engineUpdater, /prerelease/);
  assert.match(engineUpdater, /engine\.previous/);
  assert.match(engineUpdater, /StartsWith\("game", StringComparison\.OrdinalIgnoreCase\)/, 'game folders are never engine files');
  assert.match(flow, /dotnet publish launcher\/\$u\.csproj/);
});

test('UpdateKuningriigid compares GitHub commits and updates game2 with a rollback copy', () => {
  assert.match(gameUpdater, /orogdor\/Kuningriigid/);
  assert.match(gameUpdater, /GameFolder = "game2"/);
  assert.match(gameUpdater, /GitBlobSha\(bytes\) != sha/);
  assert.match(gameUpdater, /old\.Commit == commit/, 'no download when already current');
  assert.match(gameUpdater, /\.previous/);
});

test('package keeps game1, an empty game2 and both updaters', () => {
  for (const f of ['Game1.exe', 'Game2.exe', 'NativeThree-Engine.exe', 'UpdateEngine.exe', 'UpdateKuningriigid.exe', 'game1/scene.js'])
    assert.ok(flow.includes(`'${f}'`), f);
  assert.match(flow, /game2 must be empty in the ZIP/);
});
