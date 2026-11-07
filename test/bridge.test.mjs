import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeBatches,decodeMetadata,MAGIC} from '../js/bridge.mjs';
test('N3B1 metadata and counts',()=>{
  const bytes=encodeBatches([{vertices:new Float32Array(18),matrices:new Float32Array(32)}]);
  assert.deepEqual(decodeMetadata(bytes),{batchCount:1,totalInstances:2,totalTriangles:2,byteLength:8+8+18*4+32*4});
  assert.equal(new DataView(bytes.buffer).getUint32(0,true),MAGIC);
});
test('N3B1 rejects truncated data',()=>{
  const bytes=encodeBatches([{vertices:new Float32Array(18),matrices:new Float32Array(16)}]);
  assert.throws(()=>decodeMetadata(bytes.subarray(0,-3)));
});
