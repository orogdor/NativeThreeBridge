import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const get=(p)=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const dx=get('native-dx12/NativeThree-DX12.cpp');
const gait=get('native-dx12/walk_animation.h');
const core=get('native-dx12/core_smoke.cpp');

test('walking is independently driven by actual instance distance and fades to idle',()=>{
  assert.match(gait,/distance=std::sqrt\(dx\*dx\+dz\*dz\)/);
  assert.match(gait,/std::fmod\(a.phase\+distance\*1\.05f/);
  assert.match(gait,/const float target=enabled\?/);
  assert.match(core,/WalkAnimation<2> walk/);
});
test('1000 soldier animations have dedicated in-flight state buffers',()=>{
  assert.match(dx,/cbuffer SoldierWalk : register\(b6\)/);
  assert.match(dx,/gWalkStates\[1000\]/);
  assert.match(dx,/gWalkBuffers\[FRAME_COUNT\]/);
  assert.match(dx,/gWalkBuffers\[frame\]=uploadBuffer\(nullptr,LIGHT_COUNT\*4\*sizeof\(float\)\)/);
  assert.match(dx,/soldierWalk.update\(renderMatrices.data\(\)\+TREE_COUNT\*16/);
  assert.match(dx,/rs.NumParameters=11/);
});
test('exact same gait deformation affects both rendered soldiers and their real shadows',()=>{
  assert.match(dx,/float4 walk=gWalkStates\[soldierIndex\]/);
  assert.match(dx,/float legSin=legSide\*walk.x\*walk.z\*0\.48/);
  assert.match(dx,/localPos=lerp\(v.p,swung,lowerBody\)/);
  assert.match(dx,/localNormal=normalize\(lerp\(v.n,swungNormal,lowerBody\)\)/);
  assert.match(dx,/gCmd->SetGraphicsRootConstantBufferView\(9,gWalkCB->GetGPUVirtualAddress\(\)\)/);
  assert.equal((dx.match(/SetGraphicsRootConstantBufferView\(9,gWalkCB->GetGPUVirtualAddress\(\)\)/g)||[]).length,2);
  assert.match(dx,/if\(wp==VK_F8\)gWalkEnabled=!gWalkEnabled/);
});
