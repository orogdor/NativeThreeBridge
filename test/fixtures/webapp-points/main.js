// THREE.Points: a coloured spiral galaxy (sizeAttenuation), round sparks
// from a texture with alphaTest, and fixed-size star dots.
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#05070d');
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 200);
camera.position.set(0, 4, 12);
camera.lookAt(0, 0, 0);

const n = 4000, positions = new Float32Array(n * 3), colors = new Float32Array(n * 3);
const inner = new THREE.Color('#ffd27a'), outer = new THREE.Color('#5a7dff'), c = new THREE.Color();
for (let i = 0; i < n; i++) {
  const r = Math.pow(i / n, 0.7) * 6, arm = (i % 3) * (Math.PI * 2 / 3), a = r * 1.1 + arm + Math.sin(i * 12.9898) * 0.3;
  positions.set([Math.cos(a) * r, Math.sin(i * 78.233) * 0.25, Math.sin(a) * r], i * 3);
  c.copy(inner).lerp(outer, r / 6);
  colors.set([c.r, c.g, c.b], i * 3);
}
const galaxyGeometry = new THREE.BufferGeometry();
galaxyGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
galaxyGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
const galaxy = new THREE.Points(galaxyGeometry, new THREE.PointsMaterial({ size: 0.12, vertexColors: true }));
galaxy.name = 'galaxy';
scene.add(galaxy);

const dot = new Uint8Array(32 * 32 * 4);
for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
  const d = Math.hypot(x - 15.5, y - 15.5) / 15.5;
  dot.set([255, 140, 60, d < 1 ? 255 * (1 - d * d) : 0], (y * 32 + x) * 4);
}
const dotTexture = new THREE.DataTexture(dot, 32, 32);
dotTexture.needsUpdate = true;
const sparkGeometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(
  Array.from({ length: 60 * 3 }, (_, i) => (i % 3 === 1 ? 2 + Math.sin(i) : Math.cos(i * 1.7) * 3)), 3));
const sparks = new THREE.Points(sparkGeometry, new THREE.PointsMaterial({ size: 0.6, map: dotTexture, alphaTest: 0.3, transparent: true }));
sparks.name = 'sparks';
scene.add(sparks);

const starGeometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(
  Array.from({ length: 300 * 3 }, (_, i) => Math.sin(i * 91.7) * 80), 3));
const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, color: '#ffffff' }));
stars.name = 'stars';
scene.add(stars);

renderer.setAnimationLoop(() => {
  galaxy.rotation.y += 0.002;
  renderer.render(scene, camera);
});
window.ready = true;
