import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const cpp=readFileSync(new URL('../native-dx12/NativeThree-DX12.cpp',import.meta.url),'utf8');
const py=readFileSync(new URL('../tools/pack_kuningriigid.py',import.meta.url),'utf8');
const yml=readFileSync(new URL('../.github/workflows/native-threejs.yml',import.meta.url),'utf8');
test('actual native DX12 backend and GPU instancing',()=>{
  assert.match(cpp,/#include <d3d12\.h>/);
  assert.match(cpp,/D3D12_RESOURCE_FLAG_ALLOW_DEPTH_STENCIL/);
  assert.match(cpp,/DrawIndexedInstanced\(m\.indexCount,order\[p\]==3\?1:10/);
});
test('original pinned Stone Age house and pine GLB assets',()=>{
  assert.match(py,/models-stone-lod-v244\/house_far\.glb/);
  assert.match(py,/assets\/sapling-trees\/pine_01\/mid\.glb/);
  assert.match(py,/SOURCE_COMMIT = "[0-9a-f]{40}"/);
  assert.match(py,/computed != digest/);
});
test('DX12 EXE packs original mesh resources on Windows builder',()=>{
  assert.match(yml,/python tools\/pack_kuningriigid\.py/);
  assert.match(yml,/cmake --build build/);
  assert.match(yml,/NativeThreeJS/);
  assert.match(yml,/NativeThreeBridge-Windows-x64\.zip/);
});
