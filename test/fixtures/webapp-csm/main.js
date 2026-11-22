// three.js CSM (addons/csm, copied unchanged from r181): three cascades
// over a long field of posts. Near posts get sharp shadows, far ones still
// have shadows, and the ground is lit once (not three times).
import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';

const renderer = new THREE.WebGLRenderer();
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#9cc4e4');
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 400);
camera.position.set(0, 4, 10);
camera.lookAt(0, 1, -30);
scene.add(new THREE.HemisphereLight('#c8dcf0', '#4a4030', 0.6));

const csm = new CSM({ maxFar: 200, cascades: 3, mode: 'practical', parent: scene, shadowMapSize: 1024,
  lightDirection: new THREE.Vector3(1, -1.2, -0.6).normalize(), camera, lightIntensity: 2.2 });
window.csm = csm;

const groundMaterial = new THREE.MeshStandardMaterial({ color: '#9a9a88' });
csm.setupMaterial(groundMaterial);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), groundMaterial);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
ground.name = 'ground';
scene.add(ground);

const postMaterial = new THREE.MeshStandardMaterial({ color: '#b04030' });
csm.setupMaterial(postMaterial);
const post = new THREE.BoxGeometry(0.6, 3, 0.6);
for (let z = 0; z < 24; z++) {
  for (const x of [-4, 4]) {
    const m = new THREE.Mesh(post, postMaterial);
    m.position.set(x, 1.5, 2 - z * 6);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  }
}

renderer.setAnimationLoop(() => {
  camera.updateMatrixWorld();
  csm.update();
  renderer.render(scene, camera);
});
window.ready = true;
