import * as THREE from 'three';

const canvas = document.getElementById('world');
const renderer = new THREE.WebGLRenderer({ canvas });
renderer.setSize(innerWidth, innerHeight);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x335577);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 2, 6);
scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0xcc8844 })));
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2));

window.clicks = [];
window.canvasDowns = 0;
for (const id of ['start', 'pause', 'build', 'off']) {
  document.getElementById(id).addEventListener('click', () => window.clicks.push(id));
}
canvas.addEventListener('pointerdown', () => { window.canvasDowns++; });
document.getElementById('sound').addEventListener('change', (e) => { window.sound = e.target.checked; });

const scroller = document.getElementById('scroller');
for (let i = 1; i <= 12; i++) {
  const p = document.createElement('p');
  p.textContent = `Rida ${i}`;
  scroller.appendChild(p);
}

let gold = 120;
window.addGold = (n) => { gold += n; document.querySelector('#gold b').textContent = String(gold); };
// A HUD value that changes every few seconds (measures steady-state UI redraws).
const clock = document.getElementById('clock');
setInterval(() => { clock.setAttribute('value', String((Number(clock.getAttribute('value')) + 5) % 60)); }, 2000);

renderer.setAnimationLoop(() => renderer.render(scene, camera));
