import * as THREE from 'three';

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-16, 16, 9, -9, .1, 100);
camera.position.z = 20;
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('world') });
renderer.setSize(innerWidth, innerHeight);
scene.background = new THREE.Color('#273331');

const geometry = new THREE.BoxGeometry(.55, .55, .55);
const material = new THREE.MeshBasicMaterial({ color: '#84bd62' });
for (let i = 0; i < 24; ++i) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.x = i - 12;
  scene.add(mesh);
}
const ordered = new THREE.Mesh(geometry, material);
ordered.position.y = 2;
ordered.renderOrder = 1;
scene.add(ordered);

const translucent = new THREE.MeshBasicMaterial({ color: '#f5a331', transparent: true, opacity: .5 });
for (const x of [-2, 2]) {
  const mesh = new THREE.Mesh(geometry, translucent);
  mesh.position.set(x, 3, 1);
  scene.add(mesh);
}

const staticInstances = new THREE.InstancedMesh(geometry, material, 256);
staticInstances.position.z = -1;
const transform = new THREE.Matrix4();
function fillVisibleChunk(chunk) {
  for (let i = 0; i < 256; ++i) {
    const x = Math.floor(i / 64) === chunk ? (i % 8) - 4 : 200 + (i % 8);
    staticInstances.setMatrixAt(i, transform.makeTranslation(x, -1 - (Math.floor(i / 8) % 8) * .5, 0));
  }
  staticInstances.instanceMatrix.needsUpdate = true;
  staticInstances.computeBoundingSphere();
}
fillVisibleChunk(1);
scene.add(staticInstances);
window.moveVisibleChunk = () => fillVisibleChunk(2);

const dynamic = new THREE.InstancedMesh(geometry, material, 256);
dynamic.position.z = -2;
dynamic.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
for (let i = 0; i < 256; ++i)
  dynamic.setMatrixAt(i, transform.makeTranslation((i % 32) * .55 - 9, -5 - Math.floor(i / 32) * .35, 0));
scene.add(dynamic);

let updates = 0;
setInterval(() => {
  document.getElementById('counter').textContent = `Counter ${++updates}`;
  dynamic.setMatrixAt(127, transform.makeTranslation(8 + (updates % 2) * .2, -6, 0));
  dynamic.instanceMatrix.needsUpdate = true;
}, 250);
renderer.setAnimationLoop(() => renderer.render(scene, camera));
