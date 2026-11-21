// Shadow maps: a directional sun casting from boxes, an instanced row of
// posts, an alpha-tested leaf card and a tower that stands outside the
// camera view but throws its shadow into it.
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#9cc4e4');
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 200);
camera.position.set(0, 9, 14);
camera.lookAt(0, 0, 0);

scene.add(new THREE.HemisphereLight('#ffffff', '#556644', 0.8));
const sun = new THREE.DirectionalLight('#fff4e0', 3);
sun.position.set(-10, 30, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 100 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: '#d8d2c0', roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
ground.name = 'ground';
scene.add(ground);

const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial({ color: '#c0492f' }));
box.position.set(-1, 1, 0);
box.castShadow = true;
box.receiveShadow = true;
box.name = 'box';
scene.add(box);

const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.2, 0.2, 3), new THREE.MeshStandardMaterial({ color: '#3b6fb0' }), 5);
for (let i = 0; i < 5; i++) posts.setMatrixAt(i, new THREE.Matrix4().makeTranslation(-4 + i * 2, 1.5, 4));
posts.castShadow = true;
posts.name = 'posts';
scene.add(posts);

// Leaf card: the alpha-tested holes must show in its shadow.
const leaf = new Uint8Array(16 * 16 * 4);
for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
  const o = (y * 16 + x) * 4;
  leaf.set([60, 140, 50, ((x >> 2) + (y >> 2)) % 2 ? 255 : 0], o);
}
const leafTexture = new THREE.DataTexture(leaf, 16, 16);
leafTexture.needsUpdate = true;
const card = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshStandardMaterial({ map: leafTexture, alphaTest: 0.5, side: THREE.DoubleSide }));
card.position.set(3, 2.5, -1);
card.castShadow = true;
card.name = 'leaf';
scene.add(card);

// Behind the camera (outside the view); its shadow falls forward onto the ground in view.
const tower = new THREE.Mesh(new THREE.BoxGeometry(1, 12, 1), new THREE.MeshStandardMaterial({ color: '#777777' }));
tower.position.set(-4, 6, 22);
tower.castShadow = true;
tower.name = 'tower';
scene.add(tower);

renderer.setAnimationLoop(() => renderer.render(scene, camera));
window.ready = true;
