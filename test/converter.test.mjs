import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {convertThreeScene,MANIFEST_VERSION} from '../js/native-three-converter.mjs';

test('converts arbitrary scene hierarchy, instancing, cameras and independent lights',()=>{
  const scene=new THREE.Scene();
  const town=new THREE.Group();town.name='town';town.position.set(10,0,2);scene.add(town);
  const geo=new THREE.BoxGeometry(1,2,3);
  const material=new THREE.MeshStandardMaterial({color:0x225588,roughness:0.7});
  const houses=new THREE.InstancedMesh(geo,material,3);
  houses.name='houses';
  const transform=new THREE.Matrix4();
  for(let i=0;i<3;i++)houses.setMatrixAt(i,transform.makeTranslation(i*4,0,0));
  town.add(houses);
  const light=new THREE.PointLight(0xffaa11,3,50);light.position.set(2,8,3);scene.add(light);
  const camera=new THREE.PerspectiveCamera(62,16/9,0.3,2000);scene.add(camera);
  const m=convertThreeScene(scene);
  assert.equal(m.version,MANIFEST_VERSION);
  assert.equal(m.counts.InstancedMesh,1);
  assert.equal(m.counts.PointLight,1);
  assert.equal(m.counts.PerspectiveCamera,1);
  assert.equal(m.geometries.length,1);
  assert.equal(m.materials.length,1);
  assert.ok(m.geometries[0].vertexCount>0);
  assert.equal(m.objects.find(o=>o.name==='houses').instances,3);
  assert.equal(m.objects.find(o=>o.name==='houses').instanceMatrices.length,48);
  assert.equal(m.objects.find(o=>o.name==='houses').worldMatrix[12],10);
  assert.equal(m.objects.find(o=>o.type==='PointLight').light.intensity,3);
  assert.equal(m.issues.length,0);
});
test('reports unsupported shader/material issues rather than inventing compatibility',()=>{
  const scene=new THREE.Scene();
  const custom=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.ShaderMaterial({
    vertexShader:'void main(){gl_Position=vec4(position,1.);}',
    fragmentShader:'void main(){gl_FragColor=vec4(1.);}'
  }));
  scene.add(custom);
  const m=convertThreeScene(scene);
  assert.ok(m.issues.some(issue=>issue.code==='UNSUPPORTED_MATERIAL'));
});
test('large instanced scene exports no duplicated geometry',()=>{
  const scene=new THREE.Scene(),g=new THREE.BoxGeometry();
  const mat=new THREE.MeshBasicMaterial();
  scene.add(new THREE.InstancedMesh(g,mat,200));
  scene.add(new THREE.Mesh(g,mat));
  const m=convertThreeScene(scene,{includeGeometry:false});
  assert.equal(m.geometries.length,1);
  assert.equal(m.materials.length,1);
  assert.equal(m.objects.find(o=>o.type==='InstancedMesh').instanceMatrices.length,3200);
});
