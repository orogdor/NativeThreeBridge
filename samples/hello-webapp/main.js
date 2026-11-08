// Ordinary Three.js webapp: runs unchanged in Chrome and in NativeThreeBridge.
// Uses only standard browser APIs (DOM, canvas, rAF via setAnimationLoop,
// pointer/wheel/keyboard events, resize) and the official 'three' module.
import * as THREE from 'three';
import { makeGround, makeInstancedBlocks } from './world.js';

const canvas = document.getElementById('view');
const status = document.getElementById('status');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x10141a);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1d2633);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);

// --- World -----------------------------------------------------------------
scene.add(makeGround(THREE));
const blocks = makeInstancedBlocks(THREE, 10, 10);
scene.add(blocks);

const knot = new THREE.Mesh(
  new THREE.TorusKnotGeometry(1.6, 0.5, 160, 24),
  new THREE.MeshPhongMaterial({ color: 0xf2a541, shininess: 80 })
);
knot.position.set(0, 4, 0);
scene.add(knot);

const sphere = new THREE.Mesh(
  new THREE.SphereGeometry(1.2, 48, 24),
  new THREE.MeshStandardMaterial({ color: 0x8fb8de, roughness: 0.25, metalness: 0.6 })
);
sphere.position.set(-6, 1.2, 4);
scene.add(sphere);

const glass = new THREE.Mesh(
  new THREE.BoxGeometry(3, 3, 3),
  new THREE.MeshStandardMaterial({ color: 0x66e0c2, transparent: true, opacity: 0.35, roughness: 0.1 })
);
glass.position.set(6, 1.5, 4);
scene.add(glass);

// Group hierarchy: a pivot spins and carries the point light and its marker.
const pivot = new THREE.Group();
pivot.position.set(0, 3, 0);
scene.add(pivot);
const lamp = new THREE.PointLight(0xff5533, 40, 30, 2);
lamp.position.set(7, 0, 0);
pivot.add(lamp);
const lampMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.25, 16, 8),
  new THREE.MeshBasicMaterial({ color: 0xff7755 })
);
lamp.add(lampMarker);

// --- Lights ----------------------------------------------------------------
scene.add(new THREE.HemisphereLight(0xbcd7ff, 0x3a2f24, 0.9));
const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
sun.position.set(12, 20, 8);
scene.add(sun);
const spot = new THREE.SpotLight(0x88aaff, 60, 40, Math.PI / 7, 0.4, 2);
spot.position.set(-8, 12, -6);
spot.target.position.set(-6, 0, 4);
scene.add(spot, spot.target);

// --- Orbit camera driven by pointer + wheel events ------------------------
const orbit = { yaw: 0.7, pitch: 0.45, distance: 22, target: new THREE.Vector3(0, 2, 0) };
const home = { ...orbit };
function placeCamera() {
  const cp = Math.cos(orbit.pitch);
  camera.position.set(
    orbit.target.x + orbit.distance * cp * Math.sin(orbit.yaw),
    orbit.target.y + orbit.distance * Math.sin(orbit.pitch),
    orbit.target.z + orbit.distance * cp * Math.cos(orbit.yaw)
  );
  camera.lookAt(orbit.target);
}
placeCamera();

let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  orbit.yaw -= (e.clientX - lastX) * 0.006;
  orbit.pitch = Math.min(1.45, Math.max(0.05, orbit.pitch + (e.clientY - lastY) * 0.006));
  lastX = e.clientX; lastY = e.clientY;
  placeCamera();
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbit.distance = Math.min(80, Math.max(5, orbit.distance * (e.deltaY > 0 ? 1.1 : 0.9)));
  placeCamera();
}, { passive: false });

let paused = false;
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') paused = !paused;
  if (e.key === 'r' || e.key === 'R') { Object.assign(orbit, home, { target: home.target.clone() }); placeCamera(); }
  if (e.key === 'l' || e.key === 'L') lamp.visible = !lamp.visible;
});

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// --- Loop --------------------------------------------------------------------
const clock = new THREE.Clock();
let elapsed = 0, frames = 0, fpsTime = 0;
const stats = { frames: 0, fps: 0 };
window.__helloWebapp = stats; // read by the headless engine smoke test

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!paused) {
    elapsed += dt;
    knot.rotation.set(elapsed * 0.4, elapsed * 0.7, 0);
    sphere.position.y = 1.2 + Math.abs(Math.sin(elapsed * 2)) * 2;
    pivot.rotation.y = elapsed * 0.9;
    blocks.rotation.y = Math.sin(elapsed * 0.2) * 0.1;
  }
  renderer.render(scene, camera);
  frames++; fpsTime += dt; stats.frames++;
  if (fpsTime >= 0.5) {
    stats.fps = Math.round(frames / fpsTime);
    status.textContent = `${stats.fps} FPS · ${renderer.info.render.calls} draw calls${paused ? ' · paus' : ''}`;
    document.title = `Hello webapp – ${stats.fps} FPS`;
    frames = 0; fpsTime = 0;
  }
});
