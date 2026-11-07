import { encodeBatches } from './bridge.mjs';
export function sceneToNativeBytes(THREE,scene) {
  scene.updateMatrixWorld(true);
  const batches=[], scratch=new THREE.Matrix4(),world=new THREE.Matrix4();
  scene.traverse(obj=>{
    if(!obj.isMesh||!obj.geometry)return;
    const pos=obj.geometry.getAttribute('position'),indices=obj.geometry.index;
    if(!pos)return;
    const n=indices?indices.count:pos.count;
    if(n%3)throw Error('triangles required');
    const tint=(Array.isArray(obj.material)?obj.material[0]:obj.material)?.color||new THREE.Color(0xffffff);
    const verts=new Float32Array(n*6);
    for(let i=0;i<n;i++) {
      const ix=indices?indices.getX(i):i,k=6*i;
      verts[k]=pos.getX(ix);verts[k+1]=pos.getY(ix);verts[k+2]=pos.getZ(ix);
      verts[k+3]=tint.r;verts[k+4]=tint.g;verts[k+5]=tint.b;
    }
    const nInstances=obj.isInstancedMesh?obj.count:1, matrices=new Float32Array(nInstances*16);
    for(let i=0;i<nInstances;i++){
      if(obj.isInstancedMesh){obj.getMatrixAt(i,scratch);world.multiplyMatrices(obj.matrixWorld,scratch);}
      else world.copy(obj.matrixWorld);
      matrices.set(world.elements,i*16);
    }
    batches.push({vertices:verts,matrices});
  });
  return encodeBatches(batches);
}
