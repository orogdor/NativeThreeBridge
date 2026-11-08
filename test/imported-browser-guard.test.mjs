import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dx=readFileSync(new URL('../native-dx12/NativeThree-DX12.cpp',import.meta.url),'utf8');
const workflow=readFileSync(new URL('../.github/workflows/native-threejs.yml',import.meta.url),'utf8');

test('forest battle remains the main-branch engine smoke scene, not this game package',()=>{
  assert.match(workflow,/ThreeSceneSmoke\.exe/);
  assert.match(workflow,/Copy-Item game\/SOURCE\.txt dist\/game\/SOURCE\.txt/);
  assert.doesNotMatch(workflow,/Copy-Item game\/scene\.js dist\/game\/scene\.js/);
});

test('downloaded browser source is rejected before DX12 or QuickJS initialization',()=>{
  const marker=dx.indexOf('.native-three-game-manifest.json');
  const dxStart=dx.indexOf('initializeDX12();',marker);
  const jsStart=dx.indexOf('NativeThreeJS_Init();',marker);
  assert.ok(marker>0 && dxStart>marker && jsStart>marker);
  assert.match(dx,/No downloaded game code was executed/);
  assert.match(dx,/return 42;/);
});

test('separate game package fetches and verifies the latest stable engine release',()=>{
  assert.match(workflow,/NativeThreeBridge\/releases\/latest/);
  assert.match(workflow,/engine-update-v1\.json/);
  assert.match(workflow,/Get-FileHash dist\/NativeThree-Game\.exe -Algorithm SHA256/);
});
