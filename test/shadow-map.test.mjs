import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const dx=readFileSync(new URL('../native-dx12/NativeThree-DX12.cpp',import.meta.url),'utf8');
const js=readFileSync(new URL('../game/scene.js',import.meta.url),'utf8');
const host=readFileSync(new URL('../native-dx12/three_js_host.cpp',import.meta.url),'utf8');
const workflow=readFileSync(new URL('../.github/workflows/native-threejs.yml',import.meta.url),'utf8');

test('500 native Three.js spotlights each follow a soldier; only 16 depth maps',()=>{
  assert.match(js,/new THREE\.SpotLight\(/);
  assert.match(js,/lamp\.castShadow=true/);
  assert.match(js,/lamp\.shadow\.mapSize\.set\(256,256\)/);
  assert.match(js,/lamp\.position\.x=unit\.x/);
  assert.match(js,/__nativeThreeLightFrame/);
  assert.match(host,/constexpr size_t FLOATS = 500 \* 8/);
  assert.match(dx,/NativeThreeJS_Lights\(lights,LIGHT_COUNT\*8\)/);
  assert.match(dx,/SHADOW_COUNT=16/);
  assert.match(dx,/LIGHT_COUNT=500/);
});
test('DX12 bins all 500 lights and shades with 16 nearest per pixel',()=>{
  assert.match(dx,/LightGridConstants/);
  assert.match(dx,/MAX_CELL_LIGHTS=16/);
  assert.match(dx,/gGridCounts\[64\]/);
  assert.match(dx,/gGridIndices\[1024\]/);
  assert.match(dx,/for\(UINT li=0;li<LIGHT_COUNT;li\+\+\)/);
  assert.match(dx,/gGridCB->GetGPUVirtualAddress\(\)/);
  assert.match(dx,/gLightsCB->GetGPUVirtualAddress\(\)/);
  assert.match(dx,/gShadowSlots\[500\]/);
});
test('real DX12 shadow depth array captures tree and soldier silhouettes',()=>{
  assert.match(dx,/void PSShadow\(Vout v\)/);
  assert.match(dx,/gTexture\.Sample\(gSampler,v\.uv\)\.a-gAlphaCut/);
  assert.match(dx,/D3D12_DSV_DIMENSION_TEXTURE2DARRAY/);
  assert.match(dx,/DXGI_FORMAT_R32_TYPELESS/);
  assert.match(dx,/DXGI_FORMAT_R32_FLOAT/);
  assert.match(dx,/p<2\?TREE_COUNT:PER_ARMY/);
  assert.match(dx,/gShadowDepthTexture\.SampleLevel/);
  assert.match(dx,/SetGraphicsRootDescriptorTable\(4,gShadowSRV\)/);
  assert.match(dx,/SetGraphicsRootConstantBufferView\(5,gLightsCB/);
});
test('CI builds the three HLSL entry points without a physical GPU',()=>{
  assert.match(workflow,/Compile HLSL main lighting and per-soldier shadow shaders/);
  assert.match(workflow,/shader_smoke\.exe/);
});
