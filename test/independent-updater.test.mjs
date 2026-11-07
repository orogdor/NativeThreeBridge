import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const updater=readFileSync(new URL('../launcher/NativeThree-Updater.c',import.meta.url),'utf8');
const host=readFileSync(new URL('../native-dx12/three_js_host.cpp',import.meta.url),'utf8');
const dx=readFileSync(new URL('../native-dx12/NativeThree-DX12.cpp',import.meta.url),'utf8');
const flow=readFileSync(new URL('../.github/workflows/native-threejs.yml',import.meta.url),'utf8');
test('independent updater targets separate EXE and editable JS',()=>{
 assert.match(updater,/update-v2\.txt/);
 assert.match(updater,/NativeThree-Game\.exe/);
 assert.match(updater,/game\\scene\.js/);
 assert.match(updater,/sha256File\(/);
 assert.match(updater,/applyAll\(/);
});
test('real official Three.js runtime loads scene.js from the game directory',()=>{
 assert.match(host,/loadGameScene\(/);
 assert.match(host,/GetModuleFileNameW/);
 assert.match(host,/game\\scene\.js/);
 assert.match(host,/JS_Eval\(context, gameScript\.data\(\)/);
});
test('DX12 projection uses correct row-vector convention',()=>{
 assert.match(dx,/XMMatrixTranspose\(view\*proj\)/);
 assert.match(dx,/mul\(float4\(p,1\),gViewProjection\)/);
});
test('release includes two distinct EXE files and separate JS',()=>{
 assert.match(flow,/NativeThree-Updater\.exe/);
 assert.match(flow,/NativeThree-Game\.exe/);
 assert.match(flow,/game\/scene\.js/);
 assert.match(flow,/update-v2\.txt/);
});
