import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const dx=readFileSync(new URL('../native-dx12/NativeThree-DX12.cpp',import.meta.url),'utf8');
const js=readFileSync(new URL('../game/scene.js',import.meta.url),'utf8');
const host=readFileSync(new URL('../native-dx12/three_js_host.cpp',import.meta.url),'utf8');

test('stress scene contains 10000 physical trees and 1000 individual A* soldiers',()=>{
  assert.match(js,/GRID=360, CELL=3, FOREST_SIDE=100, TREES=10000, PER_ARMY=500/);
  assert.match(js,/FOREST_MIN=30, FOREST_MAX=329/);
  assert.match(js,/const MAX_PLANS_PER_FRAME=4/);
  assert.match(js,/protectedFormationCell/);
  assert.match(host,/MATRIX_FLOATS = 11000 \* 16/);
  assert.match(dx,/TREE_COUNT=10000, LIGHT_COUNT=1000, PER_ARMY=500, INSTANCE_COUNT=11000/);
});
test('10k tree transforms live in structured GPU SRV, not invalid >64KB CBV',()=>{
  assert.match(dx,/StructuredBuffer<float4x4> gTreeInstances : register\(t3\)/);
  assert.match(dx,/gTreeSRV/);
  assert.match(dx,/treeView\.Buffer\.NumElements=TREE_COUNT/);
  assert.match(dx,/treeView\.Buffer\.StructureByteStride=sizeof\(XMFLOAT4X4\)/);
  assert.match(dx,/D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE/);
  assert.match(dx,/gSoldierBuffers\[frame\]=uploadBuffer\(nullptr,65536\)/);
  assert.match(dx,/gLightBuffers\[frame\]=uploadBuffer\(nullptr,49152\)/);
});
test('CPU frustum compaction preserves 10k trees, only draws visible instances',()=>{
  assert.match(dx,/updateMainTreeVisibility\(matrices\.data\(\),view\*proj,proj\)/);
  assert.match(dx,/gMainVisibleTrees/);
  assert.match(dx,/SHADOW_COUNT\*INSTANCE_COUNT\+TREE_COUNT/);
  assert.match(dx,/draw\.shadowOffset=SHADOW_COUNT\*INSTANCE_COUNT/);
  assert.match(dx,/p==1\|\|p==2\?gMainVisibleTrees:PER_ARMY/);
});
test('10k test reports outlier frames and retains the moving night lights',()=>{
  assert.match(dx,/gWorstFrameMs/);
  assert.match(dx,/gFenceWaitTotal/);
  assert.match(dx,/NIGHT %s/);
  assert.match(dx,/F7/);
  assert.match(dx,/SHADOW_COUNT=16/);
});
