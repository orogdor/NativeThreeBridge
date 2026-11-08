import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const dx=readFileSync(new URL('../native-dx12/NativeThree-DX12.cpp',import.meta.url),'utf8');
const js=readFileSync(new URL('../game/scene.js',import.meta.url),'utf8');
test('night DX12 benchmark is dark by default, with angled real shadow casting lights',()=>{
  assert.match(dx,/static bool gNightMode=true/);
  assert.match(dx,/float day=lerp\(0\.20\+0\.34\*diffuseSky,0\.018\+0\.026\*diffuseSky,gNight\)/);
  assert.match(dx,/const XMVECTOR target=XMVectorSet\(l\[0\]-6\.f,0\.f,l\[2\]-4\.f,1\.f\)/);
  assert.match(dx,/float cone=dot\(direction,normalize\(float3\(6\.0,12\.5,4\.0\)\)\)/);
  assert.match(dx,/gNightMode\?0\.002f:0\.075f/);
  assert.match(dx,/wp==VK_F7/);
  assert.match(js,/LIGHT_HEIGHT=12\.5, LIGHT_RADIUS=32, LIGHT_OFFSET_X=6, LIGHT_OFFSET_Z=4/);
  assert.match(js,/lamp\.castShadow=true/);
});
test('A* uses bounded reusable arrays rather than allocating heap objects per node',()=>{
  assert.match(js,/const heapNodes=new Int32Array\(HEAP_CAPACITY\)/);
  assert.match(js,/const heapPriority=new Float64Array\(HEAP_CAPACITY\)/);
  assert.match(js,/const MAX_PLANS_PER_FRAME=12/);
  assert.doesNotMatch(js,/const entry=\{node,p\}/);
  assert.doesNotMatch(js,/const adj=\[/);
});
test('scene transforms are copied from Three.js instance arrays, not re-evaluated each frame',()=>{
  assert.match(js,/matrices\.set\(treeBark\.instanceMatrix\.array,0\)/);
  assert.match(js,/matrices\.set\(red\.instanceMatrix\.array,TREES\*16\)/);
  assert.match(js,/matrices\.set\(blue\.instanceMatrix\.array,\(TREES\+PER_ARMY\)\*16\)/);
  assert.equal(js.split('scene.updateMatrixWorld(true)').length-1,1);
});
test('CPU diagnostics separate simulation, lighting, render command recording and present',()=>{
  assert.match(dx,/QueryPerformanceCounter/);
  assert.match(dx,/CPU JS %\.2f LIGHT %\.2f DRAW %\.2f PRESENT %\.2f ms/);
  assert.match(dx,/gJsCpuMsTotal/);
  assert.match(dx,/gLightCpuMsTotal/);
});
