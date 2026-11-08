import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const dx=readFileSync(new URL('../native-dx12/NativeThree-DX12.cpp',import.meta.url),'utf8');
const workflow=readFileSync(new URL('../.github/workflows/native-threejs.yml',import.meta.url),'utf8');

test('game/index.html is the default native Three.js webapp; no custom meta tag needed',()=>{
  assert.match(dx,/NativeWebapp_FindRoot\(commandLine,executable,webappRoot\)/);
  assert.match(dx,/return NativeWebapp_Run\(instance,webappRoot,useV8\)/);
  assert.doesNotMatch(dx,/if\(!importedGame\)\s*\{\s*std::filesystem::path webappRoot/);
  assert.match(workflow,/Copy-Item samples\/hello-webapp\/index\.html dist\/game\/index\.html/);
  assert.match(workflow,/Copy-Item samples\/hello-webapp\/main\.js dist\/game\/main\.js/);
  assert.match(workflow,/WebappSmoke\.exe verify\/game 6 expect-resize/);
  assert.match(workflow,/--check-default-webapp/);
});
test('old forest battle DX12 benchmark remains available and untouched',()=>{
  assert.match(dx,/const bool forceBattle=args==L"--battle"/);
  assert.match(workflow,/Copy-Item game\/scene\.js dist\/game\/scene\.js/);
  assert.match(workflow,/Test-Path verify\/game\/scene\.js/);
  assert.match(dx,/NativeThreeJS_Init\(\)/);
});
test('missing index.html is reported clearly; safe legacy fallback remains',()=>{
  assert.match(dx,/The installed game has no game\/index\.html/);
  assert.match(dx,/No game\/index\.html or legacy game\/scene\.js found/);
  assert.match(dx,/return 42;/);
});
test('stable engine release includes an engine-only checksum manifest',()=>{
  assert.match(workflow,/engine-update-v1\.json/);
  assert.match(workflow,/Get-FileHash dist\/NativeThree-Game\.exe -Algorithm SHA256/);
});
