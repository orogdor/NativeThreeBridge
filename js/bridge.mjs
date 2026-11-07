// NativeThreeBridge N3B1 binary format; no DOM APIs.
export const MAGIC = 0x3142334e;
export function encodeBatches(batches) {
  let len = 8;
  for (const b of batches) {
    if (b.vertices.length % 18 || b.matrices.length % 16) throw Error('invalid batch');
    if (b.vertices.length && b.matrices.length) len += 8 + 4 * (b.vertices.length + b.matrices.length);
  }
  const out = new Uint8Array(len), dv = new DataView(out.buffer);
  dv.setUint32(0,MAGIC,true);
  let at=8, count=0;
  for (const b of batches) {
    if (!b.vertices.length || !b.matrices.length) continue;
    dv.setUint32(at,b.vertices.length/6,true); at+=4;
    dv.setUint32(at,b.matrices.length/16,true); at+=4;
    for (const v of [b.vertices,b.matrices]) {
      out.set(new Uint8Array(v.buffer,v.byteOffset,v.byteLength),at);
      at+=v.byteLength;
    }
    count++;
  }
  dv.setUint32(4,count,true);
  return out;
}
export function decodeMetadata(bytes) {
  const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(dv.byteLength<8||dv.getUint32(0,true)!==MAGIC) throw Error('bad N3B1');
  const batches=dv.getUint32(4,true);
  let off=8, instances=0, triangles=0;
  if(batches>10000)throw Error('invalid batch count');
  for(let i=0;i<batches;i++) {
    if(off+8>dv.byteLength)throw Error('truncated');
    const nv=dv.getUint32(off,true),ni=dv.getUint32(off+4,true);off+=8;
    if(nv===0||nv%3||ni===0||nv>2e6||ni>1e6)throw Error('invalid count');
    const size=nv*24+ni*64;
    if(off+size>dv.byteLength)throw Error('truncated');
    off+=size;instances+=ni;triangles+=(nv/3)*ni;
  }
  if(off!==dv.byteLength)throw Error('trailing bytes');
  return {batchCount:batches,totalInstances:instances,totalTriangles:triangles,byteLength:off};
}
