import * as THREE from 'three';
import {mkdirSync,writeFileSync} from 'node:fs';
import {sceneToNativeBytes} from './three-adapter.mjs';
import {decodeMetadata} from './bridge.mjs';
const scene=new THREE.Scene(),dummy=new THREE.Object3D();
scene.add(new THREE.Mesh(new THREE.BoxGeometry(130,.5,130),new THREE.MeshBasicMaterial({color:0x567644})));
const trees=new THREE.InstancedMesh(new THREE.ConeGeometry(1,3,6),new THREE.MeshBasicMaterial({color:0x386a49}),1500);
for(let i=0;i<1500;i++){dummy.position.set((i%50)*2.5-62,2,Math.floor(i/50)*3-44);dummy.updateMatrix();trees.setMatrixAt(i,dummy.matrix);}
scene.add(trees);
const bytes=sceneToNativeBytes(THREE,scene);
mkdirSync('build',{recursive:true});writeFileSync('build/scene.n3b',bytes);
console.log(decodeMetadata(bytes));
