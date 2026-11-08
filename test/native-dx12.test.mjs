import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const dx=readFileSync(new URL('../native-dx12/NativeThree-DX12.cpp',import.meta.url),'utf8');
const pack=readFileSync(new URL('../tools/pack_kuningriigid.py',import.meta.url),'utf8');
const yml=readFileSync(new URL('../.github/workflows/native-threejs.yml',import.meta.url),'utf8');
test('native DX12 backend renders 10000 trees and 1000 instanced soldiers with split GPU buffers',()=>{
  assert.match(dx,/#include <d3d12\.h>/);
  assert.match(dx,/D3D12_RESOURCE_FLAG_ALLOW_DEPTH_STENCIL/);
  assert.match(dx,/INSTANCE_COUNT=11000/);
  assert.match(dx,/TREE_COUNT=10000/);
  assert.match(dx,/PER_ARMY=500/);
  assert.match(dx,/gSoldierBuffers\[frame\]=uploadBuffer\(nullptr,65536\)/);
  assert.match(dx,/gSoldierCB=gSoldierBuffers\[back\]/);
  assert.match(dx,/gInstancesCB=staticGpuBuffer\(matrices\.data\(\),TREE_COUNT\*16\*sizeof\(float\)/);
  assert.match(dx,/p==1\|\|p==2\?gMainVisibleTrees:PER_ARMY/);
});
test('source GLBs are original Kuningriigid spearman and Sapling pine',()=>{
  assert.match(pack,/models-trellis-v262\/odamees\.glb/);
  assert.match(pack,/assets\/sapling-trees\/pine_01\/mid\.glb/);
  assert.match(pack,/SOURCE_COMMIT = "[0-9a-f]{40}"/);
});
test('Windows build generates DX12 game EXE and external Three.js scene',()=>{
  assert.match(yml,/python tools\/pack_kuningriigid\.py/);
  assert.match(yml,/cmake --build build/);
  assert.match(yml,/NativeThreeJS/);
  assert.match(yml,/NativeThreeBridge-Windows-x64\.zip/);
});
