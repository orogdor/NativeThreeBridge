// EffectComposer with the stock three.js passes (files in ./jsm are copied
// unchanged from three.js r181): RenderPass -> UnrealBloomPass -> OutputPass.
// Bright emissive rings should glow; the dim boxes should not.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const renderer = new THREE.WebGLRenderer();
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#05070c');
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 2.5, 9);
camera.lookAt(0, 0.5, 0);
scene.add(new THREE.HemisphereLight('#b0c0d0', '#303030', 2));

const colors = ['#ff4040', '#40ff80', '#4080ff'];
colors.forEach((c, i) => {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.12, 16, 64),
    new THREE.MeshStandardMaterial({ color: '#000000', emissive: c, emissiveIntensity: 2.5 }));
  ring.position.set((i - 1) * 2.6, 1.2, 0);
  ring.name = 'ring' + i;
  scene.add(ring);
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: '#606870' }));
  box.position.set((i - 1) * 2.6, -0.6, 0);
  scene.add(box);
});

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.8, 0.3, 0.85);
composer.addPass(bloom);
composer.addPass(new OutputPass());
window.composer = composer;

let t = 0;
renderer.setAnimationLoop(() => {
  t += 0.01;
  scene.children.forEach((o) => { if (o.name.startsWith('ring')) o.rotation.y = t; });
  composer.render();
});
window.ready = true;
