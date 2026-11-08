import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const cmake=read('../CMakeLists.txt');
const host=read('../native-dx12/three_js_host.cpp');
const dx12=read('../native-dx12/NativeThree-DX12.cpp');
const workflow=read('../.github/workflows/native-threejs.yml');
const html=read('../webapp/index.html');
const browser=read('../webapp/main.mjs');
const builder=read('../tools/build-webapp.mjs');

test('webapp owns battle simulation source rather than importing game/scene.js',()=>{
 assert.ok(html.includes('type="application/x-nativethree-scene" src="./battle-scene.js"'));
 assert.ok(browser.includes("fetch('./battle-scene.js')"));
 assert.ok(builder.includes("join(root,'webapp','battle-scene.js')"));
 assert.ok(!builder.includes("join(root,'game','scene.js')"));
});
test('WebApp native engine and smoke test use dedicated scene path',()=>{
 assert.ok(cmake.includes('add_executable(NativeThreeWebApp WIN32'));
 assert.ok(cmake.includes('add_executable(WebAppSceneSmoke'));
 assert.ok(cmake.includes('NATIVE_THREE_WEBAPP=1'));
 assert.ok(host.includes('filename += L"\\\\webapp\\\\native-scene.js"'));
 assert.ok(dx12.includes('scenePath,L"%s\\\\webapp\\\\native-scene.js"'));
});
test('Windows CI builds complete WebApp ZIP with no game/scene.js',()=>{
 assert.ok(workflow.includes('WebAppSceneSmoke.exe'));
 assert.ok(workflow.includes('ThreeSceneSmoke.exe'));
 assert.ok(workflow.includes('Copy-Item build/Release/webapp/native-scene.js'));
 assert.ok(workflow.includes('NativeThree-WebApp-Battle-Windows-x64.zip'));
 assert.ok(workflow.includes('Test-Path "$dir/game/scene.js"'));
});
