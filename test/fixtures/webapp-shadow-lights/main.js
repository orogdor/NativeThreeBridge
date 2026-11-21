// Several shadow-casting lights in one render(): a dim directional sun, a
// point light (lamp, six cube faces) and a spot light. A row of instanced
// ramps where every other instance is mirrored (scale.x = -1) must look the
// same as the others, not inside out.
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#10141a');
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 7, 12);
camera.lookAt(0, 0.5, 0);
scene.add(new THREE.AmbientLight('#ffffff', 0.15));

const sun = new THREE.DirectionalLight('#ffffff', 0.6);
sun.position.set(-6, 10, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -10; sun.shadow.camera.right = 10;
sun.shadow.camera.top = 10; sun.shadow.camera.bottom = -10;
sun.shadow.bias = -0.0005;
scene.add(sun);

const lamp = new THREE.PointLight('#ffb050', 40, 0, 2);
lamp.position.set(0, 2.2, 0);
lamp.castShadow = true;
lamp.shadow.mapSize.set(512, 512);
lamp.shadow.bias = -0.002;
lamp.name = 'lamp';
scene.add(lamp);
const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.15), new THREE.MeshBasicMaterial({ color: '#ffd090' }));
bulb.position.copy(lamp.position);
scene.add(bulb);

const spot = new THREE.SpotLight('#60a0ff', 60, 0, Math.PI / 7, 0.3, 2);
spot.position.set(5, 6, -2);
spot.target.position.set(4, 0, 2);
spot.castShadow = true;
spot.shadow.bias = -0.0005;
scene.add(spot, spot.target);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: '#8c8c84' }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Pillars around the lamp: their shadows point away from it in every direction.
const pillar = new THREE.BoxGeometry(0.4, 1.6, 0.4);
const stone = new THREE.MeshStandardMaterial({ color: '#c8c0b0' });
for (let i = 0; i < 6; i++) {
  const a = (i / 6) * Math.PI * 2;
  const m = new THREE.Mesh(pillar, stone);
  m.position.set(Math.cos(a) * 2.2, 0.8, Math.sin(a) * 2.2);
  m.castShadow = true; m.receiveShadow = true;
  scene.add(m);
}
const post = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 2.5), stone);
post.position.set(4, 1.25, 2);
post.castShadow = true;
scene.add(post);

// Ramps: a right-triangle wedge; mirrored instances use scale.x = -1.
const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(1.2, 0), new THREE.Vector2(0, 1)]);
const wedge = new THREE.ExtrudeGeometry(shape, { depth: 0.6, bevelEnabled: false });
const ramps = new THREE.InstancedMesh(wedge, new THREE.MeshStandardMaterial({ color: '#d05050' }), 6);
ramps.name = 'ramps';
const m = new THREE.Matrix4();
for (let i = 0; i < 6; i++) {
  const mirrored = i % 2 === 1;
  m.makeScale(mirrored ? -1 : 1, 1, 1).setPosition(-5 + i * 1.6 + (mirrored ? 1 : 0), 0, 4);
  ramps.setMatrixAt(i, m);
}
ramps.castShadow = true;
scene.add(ramps);

renderer.setAnimationLoop(() => renderer.render(scene, camera));
window.ready = true;
