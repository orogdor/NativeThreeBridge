import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const dx=readFileSync(new URL('../native-dx12/NativeThree-DX12.cpp',import.meta.url),'utf8');
test('DX12 uses in-flight backbuffer resources instead of waiting after Present',()=>{
  assert.match(dx,/gFrameAllocators\[FRAME_COUNT\]/);
  assert.match(dx,/gFrameFenceValues\[FRAME_COUNT\]/);
  assert.match(dx,/const UINT64 reuseFence=gFrameFenceValues\[back\]/);
  assert.match(dx,/gFrameFenceValues\[back\]=submitted/);
  assert.doesNotMatch(dx,/check\(gSwap->Present\([^;]+;\s*waitGPU\(\)/);
});
test('static geometry is uploaded to GPU-local default memory',()=>{
  assert.match(dx,/staticGpuBuffer\(/);
  assert.match(dx,/D3D12_HEAP_TYPE_DEFAULT/);
  assert.match(dx,/gCmd->CopyBufferRegion\(/);
  assert.match(dx,/m\.vertices=staticGpuBuffer\(/);
  assert.match(dx,/m\.indices=staticGpuBuffer\(/);
});
test('shadow rendering culls per light, and shadow-off actually skips the pass',()=>{
  assert.match(dx,/gShadowVisibleCounts\[SHADOW_COUNT\]\[3\]/);
  assert.match(dx,/Buffer<uint> gShadowInstanceIDs : register\(t2\)/);
  assert.match(dx,/const UINT visible=gShadowVisibleCounts/);
  assert.match(dx,/if\(gEnableShadows\)drawShadowMaps\(\)/);
  assert.match(dx,/gShadowIndexCB->Map/);
});
test('GPU selection, VSync toggle, diagnostics are visible',()=>{
  assert.match(dx,/DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE/);
  assert.match(dx,/wp==VK_F6/);
  assert.match(dx,/shadows %u/);
});
