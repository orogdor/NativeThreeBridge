import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('standalone, directly editable game/scene.js uses real Three.js structures', () => {
  const script=readFileSync(new URL('../game/scene.js',import.meta.url),'utf8');
  const sandbox={THREE};
  vm.runInNewContext(script,sandbox,{filename:'scene.js'});
  assert.equal(sandbox.__nativeThreeScene.isScene,true);
  assert.equal(sandbox.__nativeThreeScene.children.some(obj=>obj.isGroup),true);
  const stats=sandbox.__nativeThreeDiagnostics();
  assert.equal(stats.scene,true);
  assert.equal(stats.group,true);
  assert.equal(stats.mesh,true);
  assert.equal(stats.instances,true);
  assert.equal(stats.houseCount,10);
  assert.equal(stats.treeCount,10);
  assert.equal(stats.floats,320);
  const matrices=sandbox.__nativeThreeFrame(0.016);
  assert.equal(matrices.length,320);
  const round=(i)=>Number(matrices[i].toFixed(3));
  assert.deepEqual([round(12),round(14)],[-13.6,-14]);
  assert.deepEqual([round(19*16+12),round(19*16+14)],[18,22]);
});
