// WebGLRenderTarget: a "security camera" scene rendered into a texture
// every frame and shown on a screen in the main scene.
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const inner = new THREE.Scene();
inner.background = new THREE.Color('#ffcc55');
const innerCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 50);
innerCamera.position.set(0, 0, 4);
inner.add(new THREE.HemisphereLight('#ffffff', '#333333', 2));
const cube = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), new THREE.MeshStandardMaterial({ color: '#2255cc' }));
inner.add(cube);
const target = new THREE.WebGLRenderTarget(256, 256);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#1b1f24');
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, 6);
const screen = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshBasicMaterial({ map: target.texture }));
screen.name = 'screen';
scene.add(screen);
const frame = new THREE.Mesh(new THREE.PlaneGeometry(3.3, 3.3), new THREE.MeshBasicMaterial({ color: '#444444' }));
frame.position.z = -0.01;
scene.add(frame);

renderer.setAnimationLoop(() => {
  cube.rotation.x += 0.01;
  cube.rotation.y += 0.015;
  renderer.setRenderTarget(target);
  renderer.render(inner, innerCamera);
  renderer.setRenderTarget(null);
  renderer.render(scene, camera);
});
window.ready = true;
