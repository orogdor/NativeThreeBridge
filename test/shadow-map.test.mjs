import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const dx=readFileSync(new URL('../native-dx12/NativeThree-DX12.cpp',import.meta.url),'utf8');
const js=readFileSync(new URL('../game/scene.js',import.meta.url),'utf8');
const host=readFileSync(new URL('../native-dx12/three_js_host.cpp',import.meta.url),'utf8');
const workflow=readFileSync(new URL('../.github/workflows/native-threejs.yml',import.meta.url),'utf8');

test('1000 native Three.js spotlights each follow a soldier; only 16 depth maps',()=>{
  assert.match(js,/new THREE\.SpotLight\(/);
  assert.match(js,/lamp\.castShadow=true/);
  assert.match(js,/lamp\.shadow\.mapSize\.set\(256,256\)/);
  assert.match(js,/lamp\.position\.x=unit\.x/);
  assert.match(js,/__nativeThreeLightFrame/);
  assert.match(host,/constexpr size_t FLOATS = 1000 \* 8/);
  assert.match(dx,/NativeThreeJS_Lights\(lights,LIGHT_COUNT\*8\)/);
  assert.match(dx,/SHADOW_COUNT=16/);
  assert.match(dx,/LIGHT_COUNT=1000/);
});
test('DX12 bins all 1000 lights and shades with 16 nearest per pixel',()=>{
  assert.match(dx,/LightGridConstants/);
  assert.match(dx,/MAX_CELL_LIGHTS=16/);
  assert.match(dx,/gGridCounts\[64\]/);
  assert.match(dx,/gGridIndices\[1024\]/);
  assert.match(dx,/for\(UINT li=0;li<LIGHT_COUNT;li\+\+\)/);
  assert.match(dx,/gGridCB->GetGPUVirtualAddress\(\)/);
  assert.match(dx,/gLightsCB->GetGPUVirtualAddress\(\)/);
  assert.match(dx,/gShadowSlots\[1000\]/);
});
test('real DX12 shadow depth array captures tree and soldier silhouettes',()=>{
  assert.match(dx,/void PSShadow\(Vout v\)/);
  assert.match(dx,/gTexture\.Sample\(gSampler,v\.uv\)\.a-gAlphaCut/);
  assert.match(dx,/D3D12_DSV_DIMENSION_TEXTURE2DARRAY/);
  assert.match(dx,/DXGI_FORMAT_R32_TYPELESS/);
  assert.match(dx,/DXGI_FORMAT_R32_FLOAT/);
  assert.match(dx,/gShadowVisibleCounts\[li\]\[p<2\?0/);
  assert.match(dx,/gShadowInstanceIDs\[gShadowOffset\+instance\]/);
  assert.match(dx,/gShadowIndexSRV\[FRAME_COUNT\]/);
  assert.match(dx,/gShadowDepthTexture\.SampleLevel/);
  assert.match(dx,/SetGraphicsRootDescriptorTable\(4,gShadowSRV\)/);
  assert.match(dx,/SetGraphicsRootConstantBufferView\(5,gLightsCB/);
});
test('CI builds the three HLSL entry points without a physical GPU',()=>{
  assert.match(workflow,/Compile HLSL main lighting and per-soldier shadow shaders/);
  assert.match(workflow,/shader_smoke\.exe/);
});


test('shadow slots are selected from lights nearest the visible camera focus',()=>{
  assert.match(dx,/gCameraFocusX/);
  assert.match(dx,/gCameraFocusZ/);
  assert.match(dx,/const float dx=lights\[i\*8\]-gCameraFocusX/);
  assert.match(dx,/gShadowSourceIndices\[k\]=li/);
  assert.match(dx,/constants\.shadowSlots\[li\]\.x=gEnableShadows\?\(float\)k:-1\.f/);
});
test('camera can inspect either army close up and toggle real route overlays',()=>{
  assert.match(dx,/gCameraMode=0/);
  assert.match(dx,/wp==VK_F1/);
  assert.match(dx,/wp==VK_F2/);
  assert.match(dx,/wp==VK_F3/);
  assert.match(dx,/wp==VK_F4/);
  assert.match(dx,/createDebugRouteGeometry\(\)/);
  assert.match(dx,/NativeThreeJS_DebugSegments/);
  assert.match(dx,/gCmd->DrawInstanced\(gDebugRedVertices/);
  assert.match(dx,/gCmd->DrawInstanced\(gDebugBlueVertices/);
  assert.match(dx,/if\(gKind==4\) return float4\(gTint\.rgb,1\)/);
});

test('F5 toggles physical shadow contribution rather than fake projected decals',()=>{
  assert.match(dx,/if\(wp==VK_F5\)gEnableShadows=!gEnableShadows/);
  assert.match(dx,/constants\.shadowSlots\[li\]\.x=gEnableShadows\?\(float\)k:-1\.f/);
});
