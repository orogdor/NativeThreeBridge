import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../game/scene.js',import.meta.url),'utf8');
function create(){const box={THREE};vm.runInNewContext(src,box,{filename:'scene.js'});return box;}
test('forest 10 times larger with 1000 pines, 500 soldiers and 500 moving spotlights',()=>{
  const box=create(),d=box.__nativeThreeDiagnostics();
  assert.equal(d.treeCount,1000);
  assert.equal(d.forestSide,32);
  assert.deepEqual(Array.from(d.soldierCounts),[250,250]);
  assert.equal(d.unitCount,500);
  assert.equal(d.lights,500);
  assert.equal(d.shadowLights,500);
  assert.equal(d.lightsAreSpotLights,true);
  assert.equal(d.lightFloatCount,500*8);
  assert.equal(d.floats,1500*16);
  assert.equal(d.routes,500);
  assert.equal(d.routeFailures,0);
});
test('1000 distinct trees cover an approximately 32x32 square and paths avoid tree cells',()=>{
  const box=create(),nav=box.__nativeNavTest();
  const trees=new Set(nav.trees.map(([x,z])=>z*160+x));
  assert.equal(trees.size,1000);
  const xs=[...new Set(nav.trees.map(x=>x[0]))],zs=[...new Set(nav.trees.map(x=>x[1]))];
  assert.ok(xs.length>=32);assert.ok(zs.length>=32);
  for(const path of nav.paths){
    assert.ok(path.length>1);
    for(let i=0;i<path.length;i++){
      assert.equal(nav.blocked[path[i]],0,'A* traversed blocked tree cell');
      if(i){const diff=Math.abs(path[i]-path[i-1]);
        assert.ok(diff===1||diff===160,'nonadjacent A* step');
        if(diff===1)assert.equal(Math.floor(path[i]/160),Math.floor(path[i-1]/160));
      }
    }
  }
});
test('500 THREE.SpotLight objects follow both armies and stay warm/cool',()=>{
  const box=create(),lights=[];
  box.__nativeThreeScene.traverse(o=>{if(o.isSpotLight)lights.push(o);});
  assert.equal(lights.length,500);
  for(const lamp of lights){assert.equal(lamp.castShadow,true);assert.equal(lamp.shadow.mapSize.x,256);}
  const before=Array.from(box.__nativeThreeLightFrame());
  for(let i=0;i<80;i++)box.__nativeThreeFrame(1/60);
  const after=Array.from(box.__nativeThreeLightFrame());
  assert.equal(after.length,4000);
  assert.ok(Math.hypot(after[0]-before[0],after[2]-before[2])>3);
  assert.ok(Math.hypot(after[250*8]-before[250*8],after[250*8+2]-before[250*8+2])>3);
  assert.ok(after[4]>after[6]&&after[250*8+6]>after[250*8+4]);
  for(let i=0;i<500;i++){
    const b=i*8;assert.equal(after[b+1],9.5);assert.ok(Number.isFinite(after[b]));
  }
  assert.equal(box.__nativeThreeDiagnostics().moved,500);
});


test('A* movement advances at the same real-time speed at 5 FPS and 60 FPS',()=>{
  const low=create(),high=create();
  for(let i=0;i<20;i++)low.__nativeThreeFrame(0.2);
  for(let i=0;i<240;i++)high.__nativeThreeFrame(1/60);
  const a=low.__nativeNavTest().positions;
  const b=high.__nativeNavTest().positions;
  for(const i of [0,1,20,80,249,250,270,499]){
    assert.ok(Math.hypot(a[i][0]-b[i][0],a[i][1]-b[i][1])<0.04,
      'Soldier '+i+' moves at different simulation rates at 5 vs 60 FPS');
  }
  const status=low.__nativeThreeNavStats();
  assert.equal(status.routeFailures,0);
  assert.equal(status.moved,500);
  assert.ok(status.routeSteps>0,'Soldiers must advance through A* waypoints');
  assert.ok(status.active>0 && status.active<=500);
});
test('long GPU frames are not limited to old 60ms movement cap',()=>{
  const a=create(),b=create();
  a.__nativeThreeFrame(0.2);
  b.__nativeThreeFrame(0.06);
  const ax=a.__nativeNavTest().positions;
  const bx=b.__nativeNavTest().positions;
  for(const i of [0,250]){
    const init=i<250?[(20-(160-1)/2)*3, (68-(160-1)/2)*3]:[(139-(160-1)/2)*3,(68-(160-1)/2)*3];
    const da=Math.hypot(ax[i][0]-init[0],ax[i][1]-init[1]);
    const db=Math.hypot(bx[i][0]-init[0],bx[i][1]-init[1]);
    assert.ok(da>db*2.7, '200ms frame wrongly capped to 60ms');
  }
});

test('tree barrier forces real A* detours and exports visible route geometry',()=>{
  const x=create(), nav=x.__nativeNavTest();
  const barrier=nav.trees.filter(([cx,cz])=>cx===79 && cz>=36 && cz<=121);
  assert.ok(barrier.length>=65, 'visible forest barrier did not generate');
  const routes=nav.paths;
  let forcedDetours=0, turned=0;
  for(let i=0;i<routes.length;i++){
    const path=routes[i];
    const start=path[0],goal=path[path.length-1];
    const sx=start%160,sz=Math.floor(start/160);
    const tx=goal%160,tz=Math.floor(goal/160);
    const manhattan=Math.abs(tx-sx)+Math.abs(tz-sz);
    if(path.length-1>manhattan)forcedDetours++;
    let previous=0, turns=0;
    for(let k=1;k<path.length;k++){
      const direction=path[k]-path[k-1];
      if(previous && direction!==previous)turns++;
      previous=direction;
    }
    if(turns>=2)turned++;
  }
  assert.ok(forcedDetours>=30, 'at least 30 soldiers must avoid barrier with nontrivial A* detours');
  assert.ok(turned>=300, 'hundreds of soldiers must visibly change direction');
  const segments=x.__nativeThreeDebugSegments();
  assert.ok(ArrayBuffer.isView(segments),'cross-realm Float32Array should remain a typed array');
  assert.equal(segments.length%5,0);
  assert.ok(segments.length>5000,'draw enough segments for visible paths');
  assert.equal(x.__nativeThreeDiagnostics().debugSegments,segments.length/5);
  let reds=0,blues=0;
  for(let n=0;n<segments.length;n+=5){
    if(segments[n]===0)reds++;
    if(segments[n]===1)blues++;
  }
  assert.ok(reds>50 && blues>50,'both armies need route visuals');
});
