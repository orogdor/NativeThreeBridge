import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const game=source('../launcher/GameUpdater.cs');
const engine=source('../launcher/EngineUpdater.cs');
const common=source('../launcher/UpdaterCommon.cs');
const dx=source('../native-dx12/NativeThree-DX12.cpp');
const flow=source('../.github/workflows/native-threejs.yml');

test('game updater pins a Git commit, checks blobs and swaps only game directory',()=>{
  assert.match(game,/commits\/main/);
  assert.match(game,/git\/trees\/\{commit\}\?recursive=1/);
  assert.match(game,/raw\.githubusercontent\.com/);
  assert.match(game,/GitBlobSha\(bytes\) != sha/);
  assert.match(game,/Common\.Sha256File\(current\) != oldFile\.Sha256/);
  assert.match(game,/Directory\.Move\(game, previous\)/);
  assert.doesNotMatch(game,/Process\.Start|ShellExecute/);
});

test('engine updater verifies release EXE and leaves game tree untouched',()=>{
  assert.match(engine,/engine-update-v1\.json/);
  assert.match(engine,/Common\.Sha256\(exe\) != manifest\.Sha256/);
  assert.match(engine,/File\.Move\(gameExe, backup\)/);
  assert.doesNotMatch(engine,/Path\.Combine\(Common\.Root, "game"\)/);
});

test('downloaded browser game is refused before DX12 and JavaScript startup',()=>{
  const check=dx.indexOf('const bool importedGame');
  const start=dx.indexOf('initializeDX12();',check);
  assert.ok(check>0 && start>check);
  assert.match(dx,/No downloaded game code was executed/);
  assert.match(dx,/return 42;/);
  assert.match(common,/RejectLinks/);
});

test('Windows package builds exactly three EXEs with Kuningriigid as source',()=>{
  for(const exe of ['Game-Updater.exe','Engine-Updater.exe','NativeThree-Game.exe'])
    assert.ok(flow.includes(exe));
  assert.match(flow,/\$executables\.Count -ne 3/);
  assert.match(flow,/Test-Path verify\/game\/scene\.js/);
  assert.match(flow,/--prerelease/);
});
