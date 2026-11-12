import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('world') });
renderer.setSize(640, 480);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 640 / 480, 0.1, 200);
camera.position.set(0, 3, 12); camera.lookAt(0, 1, 0);
scene.add(new THREE.AmbientLight(0xffffff, 1));
const root = new THREE.LOD();
root.name = 'Sapling test LOD'; scene.add(root);
const fallback = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicMaterial({ color: '#795548' }));
fallback.name = 'fallback tree'; root.add(fallback);
let batch = null; globalThis.treeLodUpdates = 0;
root.update = function (incomingCamera) {
  if (incomingCamera !== camera) throw new Error('LOD received wrong camera');
  globalThis.treeLodUpdates++;
  if (!batch) {
    batch = new THREE.InstancedMesh(new THREE.ConeGeometry(0.65, 3, 6), new THREE.MeshStandardMaterial({ color: '#438449', side: THREE.DoubleSide }), 4);
    batch.name = 'Sapling resource pine far'; batch.frustumCulled = false;
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < 4; i++) batch.setMatrixAt(i, matrix.makeTranslation((i - 1.5) * 2.0, 1.5, 0));
    batch.instanceMatrix.needsUpdate = true; scene.add(batch);
  }
  fallback.visible = false;
};
function animate() { renderer.render(scene, camera); requestAnimationFrame(animate); }
animate();
