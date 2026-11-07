import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const code=readFileSync(new URL('../game/scene.js',import.meta.url),'utf8');
function start(){const ctx={THREE};vm.runInNewContext(code,ctx,{filename:'scene.js'});return ctx;}
test('official Three.js scene contains exactly 1000 pines and two 10-unit armies',()=>{
 const x=start(), d=x.__nativeThreeDiagnostics();
 assert.equal(x.__nativeThreeScene.isScene,true);
 assert.equal(d.treeCount,1000);
 assert.equal(d.armyCount,2);
 assert.equal(d.unitCount,20);
 assert.equal(d.routes,20);
 assert.equal(d.routeFailures,0);
 assert.equal(d.floats,1020*16);
 assert.equal(d.treeCells,1000);
});
test('1000 tree cells are distinct and never occupy a path tile',()=>{
 const x=start(), data=x.__nativeNavTest();
 const set=new Set(data.trees.map(c=>c[1]*64+c[0]));
 assert.equal(set.size,1000);
 for(const path of data.paths) {
   assert.ok(path.length>1,'A* returned a route');
   for(let i=0;i<path.length;i++){
     assert.equal(data.blocked[path[i]],0, 'path traverses a tree');
     if(i){
       let diff=Math.abs(path[i]-path[i-1]);
       assert.ok(diff===1||diff===64,'path movement must be between adjacent grid cells');
       if(diff===1)assert.equal(Math.floor(path[i]/64),Math.floor(path[i-1]/64));
     }
   }
 }
});
test('both armies move continuously while Three.js instance matrices update',()=>{
 const x=start(), original=x.__nativeNavTest().positions;
 for(let i=0;i<180;i++)x.__nativeThreeFrame(1/60);
 const d=x.__nativeThreeDiagnostics(),after=x.__nativeNavTest().positions;
 assert.equal(d.moved,20);
 for(let i=0;i<20;i++){
   const dx=after[i][0]-original[i][0],dz=after[i][1]-original[i][1];
   assert.ok(Math.hypot(dx,dz)>3, 'soldier advances at least one grid cell');
 }
 const m=x.__nativeThreeFrame(1/60);
 assert.equal(m.length,1020*16);
 for(let i=0;i<20;i++){
   let k=(1000+i)*16;
   assert.ok(Number.isFinite(m[k+12]) && Number.isFinite(m[k+14]));
   assert.ok(m[k+15]===1);
 }
});

test('every soldier owns a real shadow-casting overhead THREE.SpotLight',()=>{
 const x=start();
 const d=x.__nativeThreeDiagnostics();
 assert.equal(d.lights,20);
 assert.equal(d.shadowLights,20);
 assert.equal(d.lightsAreSpotLights,true);
 assert.equal(d.lightFloatCount,160);
 const lamps=[];
 x.__nativeThreeScene.traverse(o=>{if(o.isSpotLight)lamps.push(o);});
 assert.equal(lamps.length,20);
 for(const l of lamps){assert.equal(l.castShadow,true);assert.equal(l.shadow.mapSize.x,256);assert.ok(l.position.y>3);}
});
test('lights follow moving soldiers and preserve separate warm/cool colors',()=>{
 const x=start();
 const before=Array.from(x.__nativeThreeLightFrame());
 for(let i=0;i<180;i++)x.__nativeThreeFrame(1/60);
 const after=Array.from(x.__nativeThreeLightFrame());
 assert.equal(after.length,20*8);
 assert.ok(Math.hypot(after[0]-before[0],after[2]-before[2])>3);
 assert.ok(Math.hypot(after[10*8]-before[10*8],after[10*8+2]-before[10*8+2])>3);
 for(let i=0;i<20;i++){
   const p=i*8;
   assert.equal(after[p+1],9.5);
   assert.ok(after[p+3]>9 && after[p+7]>0);
 }
 assert.ok(after[4]>after[6], 'red army warm light');
 assert.ok(after[10*8+6]>after[10*8+4], 'blue army cool light');
});
