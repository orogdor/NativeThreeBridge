import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../game/scene.js',import.meta.url),'utf8');
function create() {
  const world={THREE};
  vm.runInNewContext(source,world,{filename:'game/scene.js'});
  return world;
}
function alive(w,id){return w.__nativeThreeBattleInspect(id);}

test('front survives four strikes, dies on fifth; flank dies on third; rear dies on first',()=>{
  const w=create();
  let stats=w.__nativeThreeBattleStatus();
  assert.equal(stats.aliveRed,500);
  assert.equal(stats.aliveBlue,500);
  assert.equal(stats.hits,0);
  // Unit 500 is facing west, directly towards the red attack line.
  for(let i=0;i<4;i++){
    assert.equal(w.__nativeThreeTestStrike(0,500),true);
    assert.equal(alive(w,500).dead,false);
    assert.equal(alive(w,500).armor,15-(i+1)*3);
  }
  w.__nativeThreeTestStrike(0,500);
  assert.equal(alive(w,500).dead,true);
  // Turn unit 501 north; the western strike is from its side.
  assert.equal(w.__nativeThreeBattleFace(501,0),true);
  for(let i=0;i<2;i++){
    w.__nativeThreeTestStrike(0,501);
    assert.equal(alive(w,501).dead,false);
  }
  w.__nativeThreeTestStrike(0,501);
  assert.equal(alive(w,501).dead,true);
  assert.equal(w.__nativeThreeBattleFace(502,Math.PI/2),true);
  w.__nativeThreeTestStrike(0,502);
  assert.equal(alive(w,502).dead,true);
  stats=w.__nativeThreeBattleStatus();
  assert.equal(stats.frontHits,5);
  assert.equal(stats.sideHits,3);
  assert.equal(stats.rearHits,1);
  assert.equal(stats.deaths,3);
  assert.equal(stats.aliveRed,500);
  assert.equal(stats.aliveBlue,497);
  assert.equal(w.__nativeThreeTestStrike(0,500),false,'dead cannot be hit again');
  // Force the last enemies down in a deterministic unit test, then verify
  // surviving 500 soldiers receive individual return-to-origin orders.
  for(let id=503;id<1000;id++){
    w.__nativeThreeBattleFace(id,Math.PI/2);
    w.__nativeThreeTestStrike(0,id);
  }
  w.__nativeThreeFrame(1/60);
  stats=w.__nativeThreeBattleStatus();
  assert.equal(stats.aliveBlue,0);
  assert.equal(stats.winner,0);
  assert.equal(stats.finished,true);
  assert.equal(stats.returned,500);
  assert.equal(stats.returning,0);
  const nav=w.__nativeNavTest();
  assert.equal(nav.occupancy.filter(id=>id>=0).length,500);
  assert.equal(new Set(nav.occupancy.filter(id=>id>=0)).size,500);
  for(let id=0;id<500;id++)
    assert.equal(nav.goals[id],nav.cells[id]);
  for(let id=500;id<1000;id++)
    assert.equal(nav.occupancy[nav.cells[id]],-1);
});
test('F12 quick skirmish relocates both detachments collision-free and attacks happen',()=>{
  const w=create();
  assert.equal(w.__nativeThreeQuickBattle(),true);
  assert.equal(w.__nativeThreeQuickBattle(),true,'setup repeat allowed before battle begins');
  const nav=w.__nativeNavTest();
  assert.equal(new Set(nav.cells).size,1000);
  for(let id=0;id<1000;id++){
    assert.equal(nav.occupancy[nav.cells[id]],id);
    assert.equal(nav.blocked[nav.cells[id]],0);
  }
  const d0=w.__nativeThreeBattleInspect(0),d500=w.__nativeThreeBattleInspect(500);
  assert.ok(Math.hypot(d0.position[0]-d500.position[0],
                       d0.position[1]-d500.position[1])<45);
  let stats;
  for(let frame=0;frame<330;frame++){
    w.__nativeThreeFrame(1/30);
    if(frame%66===0){
      const state=w.__nativeNavTest();
      for(let id=0;id<1000;id++)
        if(!w.__nativeThreeBattleInspect(id).dead)
          assert.equal(state.occupancy[state.cells[id]],id);
    }
  }
  stats=w.__nativeThreeBattleStatus();
  assert.ok(stats.attacks>0,'troops never entered melee');
  assert.ok(stats.hits>0,'attacks never connected');
  assert.ok(stats.deaths>0,'no soldiers lost after eleven seconds of combat');
  assert.ok(stats.deaths===1000-stats.aliveRed-stats.aliveBlue);
  assert.ok(stats.hits===stats.frontHits+stats.sideHits+stats.rearHits);
  assert.ok(ArrayBuffer.isView(w.__nativeThreeCombatFrame()));
  assert.equal(w.__nativeThreeCombatFrame().length,4000);
});

test('native battle test has visible scoreboard and the F12 battle shortcut',()=>{
  const dx=readFileSync(new URL('../native-dx12/NativeThree-DX12.cpp',import.meta.url),'utf8');
  const host=readFileSync(new URL('../native-dx12/three_js_host.cpp',import.meta.url),'utf8');
  assert.match(dx,/gBattleHud=CreateWindowExW/);
  assert.match(dx,/FIGHTING %d/);
  assert.match(dx,/VICTORY: %s/);
  assert.match(dx,/if\(wp==VK_F12\)/);
  assert.match(dx,/gForceBattleCameraSnap=true/);
  assert.match(dx,/gCombatStates\[1000\]/);
  assert.match(dx,/SetGraphicsRootConstantBufferView\(11,gCombatCB->GetGPUVirtualAddress\(\)\)/);
  assert.equal((dx.match(/SetGraphicsRootConstantBufferView\(11,gCombatCB->GetGPUVirtualAddress\(\)\)/g)||[]).length,2);
  assert.match(host,/NativeThreeJS_CombatStates/);
  assert.match(host,/NativeThreeJS_GetBattleStatus/);
});
