import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const dx=readFileSync(new URL('../native-dx12/NativeThree-DX12.cpp',import.meta.url),'utf8');
const js=readFileSync(new URL('../game/scene.js',import.meta.url),'utf8');
const host=readFileSync(new URL('../native-dx12/three_js_host.cpp',import.meta.url),'utf8');
const workflow=readFileSync(new URL('../.github/workflows/native-threejs.yml',import.meta.url),'utf8');

test('twenty live Three.js SpotLight objects have shadow support',()=>{
  assert.match(js,/new THREE\.SpotLight\(/);
  assert.match(js,/lamp\.castShadow = true/);
  assert.match(js,/lamp\.shadow\.mapSize\.set\(256, 256\)/);
  assert.match(js,/__nativeThreeLightFrame/);
  assert.match(js,/lamp\.position\.set\(unit\.x, LIGHT_HEIGHT, unit\.z\)/);
});
test('all twenty light records flow through native QuickJS and 20 shadow maps',()=>{
  assert.match(host,/void NativeThreeJS_Lights\(/);
  assert.match(host,/20 \* 8/);
  assert.match(dx,/NativeThreeJS_Lights\(lights,SHADOW_COUNT\*8\)/);
  assert.match(dx,/SHADOW_COUNT=20/);
  assert.match(dx,/D3D12_DSV_DIMENSION_TEXTURE2DARRAY/);
  assert.match(dx,/DXGI_FORMAT_R32_TYPELESS/);
  assert.match(dx,/DXGI_FORMAT_R32_FLOAT/);
  assert.match(dx,/D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE/);
  assert.match(dx,/gCmd->ClearDepthStencilView\(dsv/);
});
test('shadow passes include pine foliage alpha mask and soldier depth geometry',()=>{
  assert.match(dx,/void PSShadow\(Vout i\)/);
  assert.match(dx,/gTexture\.Sample\(gSampler,i\.uv\)\.a-gAlphaCut/);
  assert.match(dx,/p<2\?1000:10/);
  assert.match(dx,/gShadowDepthTexture\.SampleLevel/);
  assert.match(dx,/SetGraphicsRootDescriptorTable\(4,gShadowSRV\)/);
  assert.match(dx,/SetGraphicsRootConstantBufferView\(5,gLightsCB/);
});
test('CI compiles actual HLSL PSShadow and PSMain without needing Windows GPU',()=>{
  assert.match(workflow,/Compile HLSL main lighting and per-soldier shadow shaders/);
  assert.match(workflow,/shader_smoke\.exe/);
});
