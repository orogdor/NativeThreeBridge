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

test('random forest has irregular positions, safe spacing and accurate A* obstacle cells',()=>{
  const x=create(),nav=x.__nativeNavTest();
  const positions=nav.worldTreePositions;
  assert.equal(positions.length,1000);
  assert.ok(nav.forestAttempts>=1000);
  const navigable=new Set(nav.trees.map(([gx,gz])=>gz*160+gx));
  assert.equal(navigable.size,1000);
  let offsetFromCellCentre=0;
  const uniqueX=new Set(),uniqueZ=new Set();
  for(let i=0;i<positions.length;i++){
    const [worldX,worldZ]=positions[i];
    const gxFloat=worldX/3+(160-1)/2;
    const gzFloat=worldZ/3+(160-1)/2;
    const [gx,gz]=nav.trees[i];
    assert.equal(nav.blocked[gz*160+gx],1,'tree cell not marked blocked');
    assert.ok(Math.abs(gxFloat-gx)<0.501 && Math.abs(gzFloat-gz)<0.501);
    if(Math.abs(gxFloat-gx)>0.08 || Math.abs(gzFloat-gz)>0.08)
      offsetFromCellCentre++;
    uniqueX.add(Math.round(worldX*1000));
    uniqueZ.add(Math.round(worldZ*1000));
  }
  assert.ok(offsetFromCellCentre>900,'forest should not be planted at grid cell centres');
  assert.ok(uniqueX.size>950 && uniqueZ.size>950,'trees must not align in regular rows');
  // Poisson-style minimum distance keeps trunks from sitting on top of each other.
  for(let i=0;i<positions.length;i++)for(let j=i+1;j<positions.length;j++){
    const dx=positions[i][0]-positions[j][0];
    const dz=positions[i][1]-positions[j][1];
    assert.ok(dx*dx+dz*dz>6.1*6.1,'overlapping or too-close tree trunks');
  }
});
test('500 genuine A* routes still avoid randomly placed tree obstacles and turn',()=>{
  const x=create(),nav=x.__nativeNavTest();
  const routes=nav.paths;
  let detours=0,turning=0;
  for(const path of routes){
    assert.ok(path.length>1);
    const start=path[0],goal=path[path.length-1];
    const sx=start%160,sz=Math.floor(start/160);
    const tx=goal%160,tz=Math.floor(goal/160);
    if(path.length-1>Math.abs(tx-sx)+Math.abs(tz-sz))detours++;
    let lastDelta=0,turnCount=0;
    for(let i=0;i<path.length;i++){
      assert.equal(nav.blocked[path[i]],0,'A* crosses a tree');
      if(i>0){
        const delta=path[i]-path[i-1];
        assert.ok(Math.abs(delta)===1||Math.abs(delta)===160,'A* teleported');
        if(lastDelta!==0&&delta!==lastDelta)turnCount++;
        lastDelta=delta;
      }
    }
    if(turnCount>=2)turning++;
  }
  assert.ok(detours>=30,'randomized forest should produce visible obstacle detours');
  assert.ok(turning>=300,'most soldiers should have multi-turn A* paths');
  const segments=x.__nativeThreeDebugSegments();
  assert.ok(ArrayBuffer.isView(segments));
  assert.equal(segments.length%5,0);
  assert.ok(segments.length>5000,'visible path debug data missing');
  assert.equal(x.__nativeThreeDiagnostics().debugSegments,segments.length/5);
  let redSegments=0,blueSegments=0;
  for(let i=0;i<segments.length;i+=5){
    if(segments[i]===0)redSegments++;
    if(segments[i]===1)blueSegments++;
  }
  assert.ok(redSegments>50&&blueSegments>50);
});
