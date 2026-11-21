// SkinnedMesh: a three-bone arm that bends every frame, and a box with two
// morph targets (relative, as glTF exports them) that breathes.
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#283038');
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 3, 12);
camera.lookAt(0, 3, 0);
scene.add(new THREE.HemisphereLight('#ffffff', '#445566', 1.2));
const sun = new THREE.DirectionalLight('#ffffff', 2);
sun.position.set(3, 6, 5);
scene.add(sun);

const height = 6, segments = 24, segmentHeight = height / 3;
const geometry = new THREE.CylinderGeometry(0.5, 0.5, height, 16, segments, false);
geometry.translate(0, height / 2, 0);
const position = geometry.attributes.position, skinIndex = [], skinWeight = [];
for (let i = 0; i < position.count; i++) {
  const y = position.getY(i);
  const bone = Math.min(2, Math.floor(y / segmentHeight));
  const w = (y % segmentHeight) / segmentHeight;
  skinIndex.push(bone, Math.min(2, bone + 1), 0, 0);
  skinWeight.push(1 - w, w, 0, 0);
}
geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
const bones = [];
let parent = null;
for (let i = 0; i < 3; i++) {
  const bone = new THREE.Bone();
  bone.position.y = i === 0 ? 0 : segmentHeight;
  if (parent) parent.add(bone);
  bones.push(bone);
  parent = bone;
}
const arm = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ color: '#d9874a' }));
arm.add(bones[0]);
arm.bind(new THREE.Skeleton(bones));
arm.position.x = -2;
arm.name = 'arm';
scene.add(arm);
window.bend = (angle) => { bones[1].rotation.z = angle; bones[2].rotation.z = angle; };
window.bend(0.5);

const box = new THREE.BoxGeometry(2, 2, 2, 4, 4, 4);
const tall = [], wide = [];
for (let i = 0; i < box.attributes.position.count; i++) {
  const y = box.attributes.position.getY(i), x = box.attributes.position.getX(i);
  tall.push(0, y * 0.8, 0);
  wide.push(x * 0.5, 0, 0);
}
box.morphAttributes.position = [new THREE.Float32BufferAttribute(tall, 3), new THREE.Float32BufferAttribute(wide, 3)];
box.morphTargetsRelative = true;
const blob = new THREE.Mesh(box, new THREE.MeshStandardMaterial({ color: '#5aa0d8' }));
blob.position.set(3, 2, 0);
blob.morphTargetInfluences = [1, 0.5];
blob.name = 'blob';
scene.add(blob);

let t = 0;
renderer.setAnimationLoop(() => {
  t += 0.03;
  window.bend(0.5 + Math.sin(t) * 0.4);
  blob.morphTargetInfluences[0] = 0.5 + 0.5 * Math.sin(t);
  renderer.render(scene, camera);
});
window.ready = true;
