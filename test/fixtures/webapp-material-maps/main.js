// MeshStandardMaterial maps besides `map`: normal (bumpy tiles), roughness,
// metalness, emissive, ambient occlusion and alpha, on generated textures.
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#202833');
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, 9);
scene.add(new THREE.AmbientLight('#ffffff', 0.6));
const key = new THREE.DirectionalLight('#ffffff', 3);
key.position.set(-3, 4, 5);
scene.add(key);

const N = 64;
function texture(fill, srgb = false) {
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) data.set(fill(x / N, y / N), (y * N + x) * 4);
  const t = new THREE.DataTexture(data, N, N);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
// Rounded tiles: tangent-space normals pointing away from each tile centre.
const normalMap = texture((u, v) => {
  const dx = (u * 4 % 1) - 0.5, dy = (v * 4 % 1) - 0.5;
  const nx = Math.abs(dx) > 0.42 || Math.abs(dy) > 0.42 ? 0 : dx * 1.2, ny = Math.abs(dx) > 0.42 || Math.abs(dy) > 0.42 ? 0 : -dy * 1.2;
  const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
  return [(nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (nz * 0.5 + 0.5) * 255, 255];
});
const roughnessMap = texture((u) => [0, u < 0.5 ? 40 : 255, 0, 255]);
const metalnessMap = texture((u, v) => [0, 0, v < 0.5 ? 255 : 0, 255]);
const emissiveMap = texture((u, v) => ((u * 8 | 0) + (v * 8 | 0)) % 7 === 0 ? [255, 200, 80, 255] : [0, 0, 0, 255], true);
const aoMap = texture((u, v) => { const d = Math.hypot((u * 4 % 1) - 0.5, (v * 4 % 1) - 0.5); return [255 - d * 300, 0, 0, 255]; });
const alphaMap = texture((u, v) => [0, ((u * 6 | 0) + (v * 6 | 0)) % 2 ? 255 : 30, 0, 255]);

const material = new THREE.MeshStandardMaterial({
  color: '#b9c4d0', roughness: 1, metalness: 1, normalMap, roughnessMap, metalnessMap,
  emissive: '#ffffff', emissiveMap, aoMap, aoMapIntensity: 0.8,
});
material.normalScale.set(1.5, 1.5);
const ball = new THREE.Mesh(new THREE.SphereGeometry(1.6, 64, 32), material);
ball.position.x = -2.2;
ball.name = 'maps';
scene.add(ball);
const card = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshStandardMaterial({ color: '#58a65c', alphaMap, alphaTest: 0.5, side: THREE.DoubleSide }));
card.position.x = 2.2;
card.name = 'alpha';
scene.add(card);
renderer.setAnimationLoop(() => {
  ball.rotation.y += 0.004;
  renderer.render(scene, camera);
});
window.ready = true;
