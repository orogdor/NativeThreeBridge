import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const host = read('native-dx12/three_js_host.cpp');
const dx = read('native-dx12/NativeThree-DX12.cpp');
const flow = read('.github/workflows/native-threejs.yml');
const launcher = read('launcher/Game-Launcher.c');
const engineUpdater = read('launcher/EngineUpdater.cs');
const gameUpdater = read('launcher/GameUpdater.cs');
const common = read('launcher/UpdaterCommon.cs');
const launcherApp = read('launcher/Launcher.cpp');
const helper = read('launcher/Program.cs');

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

test('Game1 opens the forest battle; Launcher.exe opens the game folder only after updating', () => {
  assert.match(launcher, /--scene game1/);
  assert.match(flow, /\/DNTB_GAME=1 launcher\/Game-Launcher\.c \/Fe:dist\/Game1\.exe/);
  assert.match(launcherApp, /--webapp \\""/, 'the launcher starts the engine on the game folder');
  assert.match(launcherApp, /update-engine/);
  assert.match(launcherApp, /update-game/);
  assert.match(launcherApp, /Phase::Ready/);
  assert.match(launcherApp, /startAllowed/, 'the start button waits for the updates');
  assert.match(launcherApp, /findGameWindow/, 'stays open until the game window is visible');
  assert.match(launcherApp, /Laen mängu/);
  assert.match(flow, /Launcher\.cpp \/Fe:dist\/Launcher\.exe/);
  assert.match(flow, /Launcher end to end/);
});

test('UpdateEngine replaces only engine files from a SHA-256 checked stable release', () => {
  assert.match(engineUpdater, /releases\/latest/);
  assert.match(engineUpdater, /engine-update-v2\.json/);
  assert.match(engineUpdater, /Common\.Sha256\(zip\) != sha/);
  assert.match(engineUpdater, /prerelease/);
  assert.match(engineUpdater, /engine\.previous/);
  assert.match(engineUpdater, /StartsWith\("game", StringComparison\.OrdinalIgnoreCase\)/, 'game folders are never engine files');
  assert.match(flow, /dotnet publish launcher\/NativeThree-Updater\.csproj/);
});

test('the game updater compares GitHub commits and updates game2 with a rollback copy', () => {
  assert.match(common, /GameRepository = "orogdor\/Kuningriigid"/);
  assert.match(common, /GameFolder = "game2"/);
  assert.match(helper, /"update-game"/);
  assert.match(gameUpdater, /GitBlobSha\(bytes\) != sha/);
  assert.match(gameUpdater, /old\.Commit == commit/, 'no download when already current');
  assert.match(gameUpdater, /\.previous/);
});

test('package keeps game1, an empty game2, the launcher and its helper', () => {
  for (const f of ['Game1.exe', 'Launcher.exe', 'NativeThree-Updater.exe', 'launcher.json', 'NativeThree-Engine.exe', 'game1/scene.js'])
    assert.ok(flow.includes(`'${f}'`), f);
  assert.match(flow, /game2 must be empty in the ZIP/);
  assert.ok(!flow.includes("'Game2.exe'"), 'Game2.exe is replaced by Launcher.exe');
});
