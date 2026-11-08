// One ordinary Three.js application. The browser uses WebGLRenderer.
// NativeThreeBridge substitutes only the renderer surface and renders the
// resulting scene through DirectX 12; the scene creation code is identical.
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(960, 640);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1426);
const camera = new THREE.PerspectiveCamera(60, 960 / 640, 0.1, 100);
camera.position.set(0, 0, 6);
camera.lookAt(0, 0, 0);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(2, 2, 2),
  new THREE.MeshStandardMaterial({ color: 0x26b6dd, metalness: 0.12, roughness: 0.65 })
);
cube.name = 'demo-cube';
scene.add(cube);
scene.add(new THREE.AmbientLight(0xffffff, 0.48));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(3, 6, 5);
scene.add(sun);

function animate(timeMs) {
  cube.rotation.x = timeMs * 0.00065;
  cube.rotation.y = timeMs * 0.0011;
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
