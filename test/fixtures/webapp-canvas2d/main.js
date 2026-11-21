// Canvas 2D shadows (shadowBlur, shadowOffsetX/Y, shadowColor) on shapes,
// text and images, and createPattern fills from another canvas and from an
// image. The same canvas is the texture of the 3D box on the right.
import * as THREE from 'three';
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

const checker = document.createElement('canvas');
checker.width = checker.height = 16;
const cc = checker.getContext('2d');
cc.fillStyle = '#ffffff'; cc.fillRect(0, 0, 16, 16);
cc.fillStyle = '#3070d0'; cc.fillRect(0, 0, 8, 8); cc.fillRect(8, 8, 8, 8);

const tile = new Image();
tile.src = './tile.png';
await tile.decode();

function draw() {
  ctx.fillStyle = '#e8e4da';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetX = 8; ctx.shadowOffsetY = 8;
  ctx.fillStyle = '#d04040';
  ctx.fillRect(30, 30, 140, 100);                  // blurred drop shadow
  ctx.beginPath();
  ctx.arc(300, 80, 50, 0, Math.PI * 2);
  ctx.fillStyle = '#40a060';
  ctx.fill();
  ctx.shadowBlur = 0;                              // hard shadow
  ctx.shadowColor = '#2050a0';
  ctx.fillStyle = '#f0c040';
  ctx.fillRect(400, 30, 120, 100);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
  ctx.shadowBlur = 6; ctx.shadowOffsetX = 3; ctx.shadowOffsetY = 3;
  ctx.font = 'bold 36px sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('Shadows', 30, 200);
  ctx.restore();

  ctx.fillStyle = ctx.createPattern(checker, 'repeat');
  ctx.fillRect(30, 240, 220, 150);                 // canvas pattern
  ctx.save();
  ctx.translate(290, 240);
  ctx.rotate(0.15);
  ctx.fillStyle = ctx.createPattern(tile, 'repeat');
  ctx.beginPath();
  ctx.arc(110, 80, 75, 0, Math.PI * 2);
  ctx.fill();                                      // image pattern in a rotated space
  ctx.restore();
  ctx.strokeStyle = '#303030';
  ctx.lineWidth = 3;
  ctx.strokeRect(30, 240, 220, 150);
}
draw();

const renderer = new THREE.WebGLRenderer();
renderer.setSize(innerWidth, innerHeight);
renderer.domElement.style.position = 'absolute';
renderer.domElement.style.left = '0'; renderer.domElement.style.top = '0';
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#1d2229');
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 50);
camera.position.set(0, 0, 8);
const texture = new THREE.CanvasTexture(canvas);
texture.colorSpace = THREE.SRGBColorSpace;
const box = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.65, 0.2), new THREE.MeshBasicMaterial({ map: texture }));
box.position.set(3.2, -0.6, 0);
scene.add(box);
let t = 0;
renderer.setAnimationLoop(() => {
  t += 0.01;
  box.rotation.y = -0.4 + Math.sin(t) * 0.2;
  renderer.render(scene, camera);
});
window.ready = true;
