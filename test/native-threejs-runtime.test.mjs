import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const host=readFileSync(new URL('../native-dx12/three_js_host.cpp',import.meta.url),'utf8');
const dx12=readFileSync(new URL('../native-dx12/NativeThree-DX12.cpp',import.meta.url),'utf8');
const cmake=readFileSync(new URL('../CMakeLists.txt',import.meta.url),'utf8');
test('official Three.js bundle evaluated in embedded QuickJS not browser',()=>{
  assert.match(host,/JS_Eval\(/);
  assert.match(host,/__nativeThreeFrame/);
  assert.match(host,/JS_GetTypedArrayBuffer/);
  assert.match(host,/memcpy\(outMatrices/);
  assert.match(cmake,/target_link_libraries\(NativeThreeJS PRIVATE qjs d3d12/);
});
test('DX12 reads native JS instance matrices per frame',()=>{
  assert.match(dx12,/NativeThreeJS_Frame\(/);
  assert.match(dx12,/SetGraphicsRootConstantBufferView\(3,gInstancesCB/);
  assert.match(dx12,/float4x4 gInstances\[20\]/);
  assert.match(dx12,/gInstances\[instance \+ offset\]/);
});
