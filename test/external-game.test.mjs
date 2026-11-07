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
  assert.equal(xs.length,32);assert.equal(zs.length,32);
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
