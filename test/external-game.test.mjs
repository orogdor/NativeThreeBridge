import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('../game/scene.js',import.meta.url),'utf8');
function create(){
  const world={THREE};
  vm.runInNewContext(source,world,{filename:'game/scene.js'});
  return world;
}
function near(a,b,epsilon=1e-4){return Math.abs(a-b)<epsilon;}
function safePositions(nav){
  const current=nav.occupancy.filter(n=>n>=0);
  const reserved=nav.reservations.filter(n=>n>=0);
  assert.equal(new Set(current).size,1000,'soldiers occupy unique source tiles');
  assert.equal(new Set(reserved).size,reserved.length,'duplicate in-transit destination');
  for(let i=0;i<1000;i++){
    assert.equal(nav.occupancy[nav.cells[i]],i,'own source tile must remain occupied');
    assert.equal(nav.blocked[nav.cells[i]],0,'soldier walked into a tree');
    if(nav.nextCells[i]!==-1){
      assert.equal(nav.reservations[nav.nextCells[i]],i,'missing destination reservation');
      assert.equal(nav.occupancy[nav.nextCells[i]],-1,'unit crossed occupied cell');
      assert.equal(nav.blocked[nav.nextCells[i]],0,'reserved tree cell');
      const a=nav.cells[i],b=nav.nextCells[i];
      assert.ok(Math.abs(a-b)===1||Math.abs(a-b)===360,'non-cardinal movement');
      if(Math.abs(a-b)===1)assert.equal(Math.floor(a/360),Math.floor(b/360));
    }
  }
}
test('initializes 10000 randomized trees, 1000 spotlights and ZERO precomputed soldier routes',()=>{
  const x=create(),d=x.__nativeThreeDiagnostics(),nav=x.__nativeNavTest();
  assert.equal(d.treeCount,10000);
  assert.equal(d.unitCount,1000);
  assert.deepEqual(Array.from(d.soldierCounts),[500,500]);
  assert.equal(d.lights,1000);
  assert.equal(d.shadowLights,1000);
  assert.equal(d.floats,11000*16);
  assert.equal(d.lightFloatCount,1000*8);
  assert.equal(d.routes,0);
  assert.equal(d.searches,0);
  assert.equal(d.unplanned,1000);
  const native=x.__nativeThreeNavStats();
  assert.equal(native.searches,0);
  assert.equal(native.planned,0);
  assert.equal(native.replans,0);
  assert.equal(native.blockedMoves,0);
  assert.ok(nav.paths.every(path=>path.length===0),'no A* routes calculated at load time');
  assert.ok(nav.planCounts.every(count=>count===0));
  safePositions(nav);
});
test('forest keeps random spacing and maps 10000 physical trunks to blocked navigation cells',()=>{
  const x=create(),nav=x.__nativeNavTest(),points=nav.worldTreePositions;
  assert.equal(points.length,10000);
  assert.equal(new Set(nav.trees.map(([gx,gz])=>gz*360+gx)).size,10000);
  const xs=new Set(),zs=new Set();
  for(let i=0;i<10000;i++){
    const [x,z]=points[i],[gx,gz]=nav.trees[i];
    assert.equal(nav.blocked[gz*360+gx],1);
    xs.add(Math.round(x*1000));zs.add(Math.round(z*1000));
  }
  assert.ok(xs.size>9880 && zs.size>9880,'must not form rows');
  // Neighbour-cell hash checks spacing without quadratic 50-million pairs.
  const owners=new Map(nav.trees.map(([gx,gz],i)=>[gz*360+gx,i]));
  for(let i=0;i<points.length;i++){
    const [gx,gz]=nav.trees[i];
    for(let dz=-3;dz<=3;dz++)for(let dx=-3;dx<=3;dx++){
      const j=owners.get((gz+dz)*360+gx+dx);
      if(j===undefined||j<=i)continue;
      const ax=points[i][0]-points[j][0],az=points[i][1]-points[j][1];
      assert.ok(ax*ax+az*az>6.1*6.1,'tree trunks overlap');
    }
  }
});
test('visual route request plans only the twelve sampled units, not all 1000',()=>{
  const x=create();
  assert.equal(x.__nativeThreeDiagnostics().routes,0);
  const segments=x.__nativeThreeDebugSegments();
  assert.ok(ArrayBuffer.isView(segments));
  assert.equal(segments.length%5,0);
  assert.ok(segments.length>5000);
  const d=x.__nativeThreeDiagnostics();
  assert.equal(d.routes,12);
  assert.equal(d.unplanned,988);
  const nav=x.__nativeNavTest();
  for(let i=0;i<1000;i++){
    if(!nav.planCounts[i])continue;
    const own=nav.cells[i];
    assert.equal(nav.paths[i][0],own);
    for(const cell of nav.paths[i]){
      assert.equal(nav.blocked[cell],0);
      assert.ok(nav.occupancy[cell]===-1 || cell===own,'A* planned through another soldier');
      assert.equal(nav.reservations[cell],-1);
    }
  }
});
test('all soldiers individually plan while running and nobody shares occupied/reserved tiles',()=>{
  const x=create();
  x.__nativeThreeDebugSegments(); // user-requested F4 overlay; only 12 routes
  for(let i=0;i<450;i++){
    x.__nativeThreeFrame(1/30);
    if(i%10===0)safePositions(x.__nativeNavTest());
  }
  const d=x.__nativeThreeDiagnostics();
  console.log(`STRESS: moved=${d.moved} planned=${d.routes} searches=${d.searches} replans=${d.replans} blocked=${d.blockedMoves}`);
  assert.equal(d.unplanned,0,'every soldier must eventually request its own A* route');
  assert.ok(d.searches>=1000,'must run a separate search per soldier');
  const native=x.__nativeThreeNavStats();
  assert.equal(native.planned,1000);
  assert.equal(native.searches,d.searches);
  assert.equal(native.replans,d.replans);
  assert.ok(d.moved>600,`1000-agent stress moved only ${d.moved} units, planned ${d.routes}, unplanned ${d.unplanned}`);
  assert.ok(d.routeSteps>0);
  safePositions(x.__nativeNavTest());
  assert.equal(d.routeFailures,0);
});
test('can issue a new destination while running and replans that soldier only when required',()=>{
  const x=create();
  for(let i=0;i<5;i++)x.__nativeThreeFrame(1/30);
  const before=x.__nativeNavTest();
  assert.equal(x.__nativeThreeSetDestination(0,8,90),true);
  const redirect=x.__nativeNavTest();
  assert.equal(redirect.goals[0],90*360+8);
  // Re-issue a valid clear goal (near the red army), then let the
  // unit choose a new route itself in subsequent simulation frames.
  assert.equal(x.__nativeThreeSetDestination(0,8,90),true);
  for(let i=0;i<60;i++)x.__nativeThreeFrame(1/30);
  const after=x.__nativeNavTest();
  assert.ok(after.planCounts[0]>=2,'the soldier did not re-plan after a new order');
  assert.ok(Math.hypot(after.positions[0][0]-before.positions[0][0],
                       after.positions[0][1]-before.positions[0][1])>0.5);
  safePositions(after);
});
test('a soldier cannot enter another soldier current cell, then can replan when vacated',()=>{
  const x=create();
  // Soldier 1 holds cell (12,50); soldier 0 targets that exact cell.
  assert.equal(x.__nativeThreeSetDestination(1,12,90),true);
  assert.equal(x.__nativeThreeSetDestination(0,12,90),true);
  for(let i=0;i<30;i++)x.__nativeThreeFrame(1/30);
  let nav=x.__nativeNavTest();
  assert.equal(nav.cells[0],90*360+10,'soldier walked into occupied destination');
  assert.equal(nav.cells[1],90*360+12);
  safePositions(nav);
  // Soldier 1 leaves, allowing soldier 0 to find a new route later.
  assert.equal(x.__nativeThreeSetDestination(1,12,84),true);
  for(let i=0;i<120;i++){
    x.__nativeThreeFrame(1/30);
    if(i%10===0)safePositions(x.__nativeNavTest());
  }
  nav=x.__nativeNavTest();
  assert.ok(nav.planCounts[0]>1,'blocked soldier did not retry route planning');
  assert.ok(nav.cells[0]!==nav.cells[1],'soldiers overlap');
});
test('all lights remain attached to their dynamically moving soldiers',()=>{
  const x=create(),before=Array.from(x.__nativeThreeLightFrame());
  for(let i=0;i<220;i++)x.__nativeThreeFrame(1/60);
  const after=Array.from(x.__nativeThreeLightFrame()),nav=x.__nativeNavTest();
  assert.equal(after.length,1000*8);
  for(let i=0;i<1000;i++){
    const p=i*8;
    assert.ok(near(after[p],nav.positions[i][0]+6,0.001));
    assert.ok(near(after[p+2],nav.positions[i][1]+4,0.001));
    assert.equal(after[p+1],12.5);
  }
  assert.ok(Math.hypot(after[0]-before[0],after[2]-before[2])>3);
  assert.ok(Math.hypot(after[500*8]-before[500*8],after[500*8+2]-before[500*8+2])>3);
});

test('night scene uses dark ambient and oblique moving spotlights',()=>{
 const x=create(),scene=x.__nativeThreeScene;
 assert.equal(scene.background.getHex(),0x030611);
 const lamps=scene.children.filter(o=>o.isSpotLight);
 assert.equal(lamps.length,1000);
 for(const l of lamps){
   assert.ok(l.castShadow);
   assert.ok(Math.abs(l.position.y-12.5)<1e-6);
   assert.ok(Math.abs(l.position.x-l.target.position.x-6)<1e-5);
   assert.ok(Math.abs(l.position.z-l.target.position.z-4)<1e-5);
 }
});
test('native transforms directly match official Three.js InstancedMesh buffers',()=>{
 const x=create();
 const red=x.__nativeThreeScene.getObjectByName('Red army 500');
 const blue=x.__nativeThreeScene.getObjectByName('Blue army 500');
 assert.ok(red?.isInstancedMesh&&blue?.isInstancedMesh);
 for(let i=0;i<20;i++)x.__nativeThreeFrame(1/60);
 const matrices=x.__nativeThreeFrame(0);
 for(let i=0;i<500*16;i++){
   assert.ok(near(matrices[10000*16+i],red.instanceMatrix.array[i],1e-6));
   assert.ok(near(matrices[(10000+500)*16+i],blue.instanceMatrix.array[i],1e-6));
 }
});
