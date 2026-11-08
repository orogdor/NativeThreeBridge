import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const dx=read('native-dx12/NativeThree-DX12.cpp');
const interpolation=read('native-dx12/transform_interpolation.h');
const scene=read('game/scene.js');
const core=read('native-dx12/core_smoke.cpp');

test('real scene interpolates orientation as well as XYZ without altering A*',()=>{
  assert.match(dx,/#include "transform_interpolation.h"/);
  assert.match(dx,/native_three::interpolateAffine\(previous\.data\(\)\+off,/);
  assert.match(interpolation,/std::atan2\(std::sin\(b-a\),std::cos\(b-a\)\)/);
  assert.match(interpolation,/quatFromMatrix/);
  assert.match(interpolation,/out\[12\]|for\(const int k:\{12,13,14\}\)/);
  assert.match(scene,/const desiredYaw=Math\.atan2\(tx-sx,tz-sz\)/);
  assert.match(scene,/const maxTurn=dt\*9\.0/);
  assert.doesNotMatch(scene,/unit\.yaw=Math\.atan2\(tx-sx,tz-sz\)/);
  assert.match(core,/PASS: sub-frame affine and shortest-arc rotation interpolation/);
  assert.match(core,/return 64; \/\/ shortest arc/);
});

test('follow camera reads exactly the same render-frame transform as the soldier',()=>{
  assert.match(dx,/gCameraFocusX=gCameraMode==0\?0\.f:renderMatrices\[followIndex\*16\+12\]/);
  assert.match(dx,/gCameraFocusZ=gCameraMode==0\?0\.f:renderMatrices\[followIndex\*16\+14\]/);
  assert.doesNotMatch(dx,/gCameraFocusX=gCameraMode==0\?0\.f:matrices\[followIndex\*16\+12\]/);
});

test('attack, damage and death shader pose interpolates between simulation ticks',()=>{
  assert.match(dx,/static std::array<float,LIGHT_COUNT\*4> previousCombatStates\{\}/);
  assert.match(dx,/static std::array<float,LIGHT_COUNT\*4> currentCombatStates\{\}/);
  assert.match(dx,/previousCombatStates=currentCombatStates/);
  assert.match(dx,/combatStates\[i\]=previousCombatStates\[i\]\+/);
  assert.match(dx,/gCombatCB->Map/);
  assert.equal((dx.match(/NativeThreeJS_CombatStates\(currentCombatStates\.data\(\),currentCombatStates\.size\(\)\)/g)||[]).length,2);
  assert.doesNotMatch(dx,/NativeThreeJS_CombatStates\(combatStates\.data\(\),combatStates\.size\(\)\)/);
});

test('F12 stage refreshes real THREE.InstancedMesh before first native camera frame',()=>{
  assert.match(scene,/updateSoldiers\(0\);\s*return true;\s*\}\s*globalThis\.__nativeThreeQuickBattle=quickBattle/);
  assert.match(dx,/gForceBattleCameraSnap/);
  assert.match(dx,/gPreviousFrameSeconds=now/);
});
