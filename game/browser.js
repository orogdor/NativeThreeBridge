// Browser-only visualization wrapper for the unchanged v0.26.0 scene.js.
// This file is NEVER evaluated by NativeThreeBridge's QuickJS/DX12 engine.
// Native continues to use the original GLB GPU models, custom HLSL,
// texture memory, shadows, lighting, navigation workers and combat poses.
import * as THREE from 'three';
globalThis.THREE = THREE;
await import('./scene.js');

const scene = globalThis.__nativeThreeScene;
const step = globalThis.__nativeThreeFrame;
if (!scene?.isScene || typeof step !== 'function')
  throw new Error('game/scene.js did not initialize the original battle');

const camera = scene.children.find(x => x.isPerspectiveCamera);
const canvas = document.getElementById('screen');
const renderer = new THREE.WebGLRenderer({canvas,antialias:false,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(1.5,window.devicePixelRatio || 1));
renderer.shadowMap.enabled = false; // Browser preview only. Native shadows are unchanged.
renderer.setSize(window.innerWidth,window.innerHeight,false);

// v0.26.0 references native-only GLB assets via userData.nativeMesh and
// deliberately leaves browser-side geometry empty. Supply simple visible
// placeholders only in this browser viewer; NEVER rewrite scene.js.
const trees = scene.getObjectByName('10000 randomly scattered pines');
if (!trees || trees.children.length < 2) throw Error('Missing original pine instances');
const trunk = new THREE.CylinderGeometry(0.23,0.36,4.2,5);
trunk.translate(0,2.1,0);
const crown = new THREE.ConeGeometry(2.2,8,6);
crown.translate(0,6.8,0);
trees.children[0].geometry = trunk;
trees.children[1].geometry = crown;
trees.children[0].material = new THREE.MeshLambertMaterial({color:0x69472e});
trees.children[1].material = new THREE.MeshLambertMaterial({color:0x1c4937,side:THREE.DoubleSide});
const armyGeo = new THREE.CapsuleGeometry(0.42,1.5,3,5);
armyGeo.translate(0,1.1,0);
const red = scene.getObjectByName('Red army 500');
const blue = scene.getObjectByName('Blue army 500');
red.geometry = armyGeo;
blue.geometry = armyGeo;
const ground = scene.children.find(x => x.userData?.nativePrimitive === 'ground');
ground.geometry = new THREE.PlaneGeometry(1100,1100,1,1);
ground.rotation.x = -Math.PI / 2;
ground.material = new THREE.MeshLambertMaterial({color:0x405742});

// 1000 real-time shadowed spotlights in a browser can exceed WebGL limits.
// They are retained in the *simulation* for positioning and gameplay, but
// browser preview skips their draw; the v0.26.0 native DX12 light+shadow
// path and memory layout remain absolutely unchanged.
scene.traverse(obj => {if (obj.isSpotLight) obj.visible = false;});
scene.add(new THREE.AmbientLight(0x9db3cf,0.85));
const sun = new THREE.DirectionalLight(0xffffff,2.0);
sun.position.set(200,450,-150);
scene.add(sun);

let yaw=0,pitch=0.65,distance=850,dragging=false,px=0,py=0;
const target=new THREE.Vector3(0,0,0);
function positionCamera(){
  const cp=Math.cos(pitch);
  camera.position.set(target.x+Math.sin(yaw)*distance*cp,
                      target.y+Math.sin(pitch)*distance,
                      target.z+Math.cos(yaw)*distance*cp);
  camera.lookAt(target);
}
positionCamera();
canvas.addEventListener('pointerdown',event=>{dragging=true;px=event.clientX;py=event.clientY;canvas.setPointerCapture(event.pointerId);});
canvas.addEventListener('pointermove',event=>{
  if(!dragging)return;
  yaw-=(event.clientX-px)*0.005;pitch=Math.min(1.45,Math.max(0.06,pitch+(event.clientY-py)*0.005));
  px=event.clientX;py=event.clientY;positionCamera();
});
canvas.addEventListener('pointerup',()=>dragging=false);
canvas.addEventListener('wheel',event=>{
  event.preventDefault();distance=Math.min(1600,Math.max(20,distance*(event.deltaY>0?1.1:0.9)));positionCamera();
},{passive:false});
let paused=false;
window.addEventListener('keydown',event=>{
  if(event.code==='Space'){paused=!paused;event.preventDefault();}
  else if(event.code==='F12'){globalThis.__nativeThreeQuickBattle();event.preventDefault();}
});
window.addEventListener('resize',()=>{
  const w=Math.max(1,window.innerWidth),h=Math.max(1,window.innerHeight);
  renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();
});
const status=document.getElementById('status');
let last=performance.now(),fpsStart=last,frames=0;
function frame(now){
  const dt=Math.min(0.05,(now-last)/1000);last=now;
  if(!paused)step(dt);
  renderer.render(scene,camera);
  if(++frames>=30) {
    const fps=frames*1000/Math.max(1,now-fpsStart);
    const battle=globalThis.__nativeThreeBattleStatus();
    status.textContent=`${fps.toFixed(0)} FPS · punased ${battle.aliveRed} · sinised ${battle.aliveBlue} · ${paused?'paus':'käib'}`;
    fpsStart=now;frames=0;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
