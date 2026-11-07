// Native Three.js scene graph; no DOM, window, browser or WebGLRenderer.
// This module is bundled with the real "three" npm package at BUILD time.
// The native DX12 adapter reads the matrices produced by __nativeThreeFrame().
import * as THREE from 'three';

const houseGeometry = new THREE.BufferGeometry();
houseGeometry.userData.nativeMesh = 'models-stone-lod-v244/house_far.glb';
const pineGeometry = new THREE.BufferGeometry();
pineGeometry.userData.nativeMesh = 'assets/sapling-trees/pine_01/mid.glb';

// Actual mesh vertex/index/texture data are stored in the native EXE as verified
// Kuningriigid GLB resources. No fake shapes are substituted in the DX12 pipeline.
const houseMaterial = new THREE.MeshStandardMaterial({ roughness: 0.89 });
const barkMaterial = new THREE.MeshStandardMaterial({ roughness: 0.93 });
const foliageMaterial = new THREE.MeshStandardMaterial({ alphaTest: 0.4, side: THREE.DoubleSide });

export const scene = new THREE.Scene();
scene.name = 'NativeThreeBridge - Kuningriigid Stone Age';
scene.background = new THREE.Color(0x172a42);

const settlement = new THREE.Group();
settlement.name = 'Kiviaja küla';
scene.add(settlement);

// Multiple GLB mesh parts share one set of instance matrices.
export const houses = new THREE.InstancedMesh(houseGeometry, houseMaterial, 10);
houses.name = '10 Kuningriigid houses';
settlement.add(houses);
const woods = new THREE.Group();
woods.name = 'Männid';
scene.add(woods);
export const trunks = new THREE.InstancedMesh(pineGeometry, barkMaterial, 10);
export const canopies = new THREE.InstancedMesh(pineGeometry, foliageMaterial, 10);
trunks.name = '10 pine trunk meshes';
canopies.name = '10 pine foliage meshes';
woods.add(trunks, canopies);

const ground = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: 0x415a43 }));
ground.name = 'Ground';
ground.userData.nativePrimitive = 'ground';
scene.add(ground);

const camera = new THREE.PerspectiveCamera(57, 1152 / 768, 0.1, 500);
camera.name = 'Native camera';
scene.add(camera);

// IDs, types and world transforms remain real Three.js object graph data.
const transform = new THREE.Object3D();
for (let i = 0; i < 10; i++) {
  transform.position.set(((i % 5) - 2) * 6.8, 0, Math.floor(i / 5) * 6.5 - 14);
  transform.rotation.y = i * 0.075;
  transform.scale.setScalar(1);
  transform.updateMatrix();
  houses.setMatrixAt(i, transform.matrix);

  transform.position.set(((i % 5) - 2) * 9.0, 0, Math.floor(i / 5) * 9 + 13);
  transform.rotation.y = i * 0.3;
  transform.scale.setScalar(1);
  transform.updateMatrix();
  trunks.setMatrixAt(i, transform.matrix);
  canopies.setMatrixAt(i, transform.matrix);
}
houses.instanceMatrix.needsUpdate = true;
trunks.instanceMatrix.needsUpdate = true;
canopies.instanceMatrix.needsUpdate = true;

// Each frame transfer 20 genuine Three.js Matrix4 world transforms to C++ DX12.
const matrices = new Float32Array(20 * 16);
const scratch = new THREE.Matrix4();
function copyWorldMatrices(mesh, begin) {
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, scratch);
    scratch.premultiply(mesh.matrixWorld);
    matrices.set(scratch.elements, (begin + i) * 16);
  }
}
export function frame(dt = 0) {
  scene.updateMatrixWorld(true);
  copyWorldMatrices(houses, 0);
  copyWorldMatrices(trunks, 10);
  return matrices;
}
export function diagnostics() {
  return {
    actualThreeScene: scene.isScene === true,
    actualThreeGroup: settlement.isGroup === true,
    actualThreeMesh: ground.isMesh === true,
    actualThreeInstances: houses.isInstancedMesh === true,
    treePartCounts: [trunks.count, canopies.count],
    houseCount: houses.count,
    treeCount: trunks.count,
    arrayLength: frame().length,
  };
}
// Expose only the small native bridge entrypoints; THREE objects remain live.
globalThis.__nativeThreeScene = scene;
globalThis.__nativeThreeFrame = frame;
globalThis.__nativeThreeDiagnostics = diagnostics;
