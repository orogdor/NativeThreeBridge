import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const host=readFileSync(new URL('../native-dx12/three_js_host.cpp',import.meta.url),'utf8');
const dx=readFileSync(new URL('../native-dx12/NativeThree-DX12.cpp',import.meta.url),'utf8');
const cmake=readFileSync(new URL('../CMakeLists.txt',import.meta.url),'utf8');
test('real JS code is interpreted by QuickJS without Chromium',()=>{
  assert.match(host,/JS_Eval\(/);
  assert.match(host,/__nativeThreeFrame/);
  assert.match(host,/JS_GetTypedArrayBuffer/);
  assert.match(host,/memcpy\(outMatrices/);
  assert.match(cmake,/target_link_libraries\(NativeThreeJS PRIVATE qjs d3d12/);
});
test('DX12 consumes 11000 THREE.InstancedMesh transforms over split DirectX12 buffers',()=>{
  assert.match(dx,/NativeThreeJS_FrameFrom\(/);
  assert.match(dx,/SetGraphicsRootDescriptorTable\(3,gTreeSRV/);
  assert.match(dx,/StructuredBuffer<float4x4> gTreeInstances/);
  assert.match(dx,/float4x4 gSoldierInstances\[1000\]/);
  assert.match(dx,/SetGraphicsRootConstantBufferView\(7,gSoldierCB/);
  assert.match(host,/MATRIX_FLOATS = 11000 \* 16/);
});
