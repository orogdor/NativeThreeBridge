import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {sceneToNativeBytes} from '../js/three-adapter.mjs';
import {decodeMetadata} from '../js/bridge.mjs';
test('exports Three.js instanced meshes',()=>{
  const scene=new THREE.Scene();
  const mesh=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial({color:0x118833}),7);
  const temp=new THREE.Object3D();
  for(let i=0;i<7;i++){temp.position.x=i;temp.updateMatrix();mesh.setMatrixAt(i,temp.matrix);}
  scene.add(mesh);
  const info=decodeMetadata(sceneToNativeBytes(THREE,scene));
  assert.equal(info.totalInstances,7);
  assert.ok(info.totalTriangles>0);
});
