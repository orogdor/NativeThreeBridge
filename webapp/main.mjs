import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const canvas=document.querySelector('#view');
const status=document.querySelector('#status');
const score=document.querySelector('#score');
const battleButton=document.querySelector('#battle');
const pauseButton=document.querySelector('#pause');
const resetButton=document.querySelector('#reset');

let renderer,scene,camera,controls,paused=false,last=0,frames=0,seconds=0;
function installBrowserGeometry(world){
  const treeGeometry=new THREE.ConeGeometry(2.2,12,6);
  treeGeometry.translate(0,6,0);
  const trunkGeometry=new THREE.CylinderGeometry(.36,.54,3,6);
  trunkGeometry.translate(0,1.5,0);
  const soldierGeometry=new THREE.CapsuleGeometry(.45,1.25,4,6);
  soldierGeometry.translate(0,1.1,0);
  world.traverse(object=>{
    if(!object.isMesh)return;
    if(object.userData.nativePrimitive==='ground'){
      object.geometry=new THREE.PlaneGeometry(1080,1080);
      object.rotation.x=-Math.PI/2;
      object.material=new THREE.MeshStandardMaterial({color:0x405742,roughness:1});
    } else if(object.geometry?.userData?.nativeMesh?.includes('pine_01')){
      object.geometry=object.material.alphaTest?treeGeometry:trunkGeometry;
      object.material=new THREE.MeshStandardMaterial({color:object.material.alphaTest?0x315a38:0x57442c,roughness:1});
    } else if(object.geometry?.userData?.nativeMesh?.includes('odamees')){
      object.geometry=soldierGeometry;
      object.material=new THREE.MeshStandardMaterial({color:object.name.startsWith('Red')?0xd4635c:0x6396d8,roughness:.8});
    }
    if(object.isInstancedMesh)object.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  });
  // The native stress fixture creates 1000 spotlights. A browser shader with
  // all of them would not be a useful compatibility test, so keep lighting
  // separate from its simulation and instance transforms.
  const spots=[];world.traverse(object=>{if(object.isSpotLight)spots.push(object);});
  for(const light of spots)light.parent?.remove(light);
  world.add(new THREE.AmbientLight(0xffffff,1.5));
  const sun=new THREE.DirectionalLight(0xffedcf,2);
  sun.position.set(120,220,100);world.add(sun);
  world.background=new THREE.Color(0x66899a);
}
function resize(){
  const width=canvas.clientWidth,height=canvas.clientHeight;
  renderer.setSize(width,height,false);
  camera.aspect=width/height;camera.updateProjectionMatrix();
}
function updateScore(){
  const b=window.__nativeThreeBattleStatus();
  score.textContent=`Punased ${b.aliveRed} · Sinised ${b.aliveBlue} · Tabamused ${b.hits} · Langenud ${b.deaths}`;
  if(b.finished)status.textContent=`Võitja: ${b.winner===0?'punased':'sinised'}`;
}
function frame(now){
  requestAnimationFrame(frame);
  const dt=Math.min(.05,(now-last)/1000||0);last=now;
  if(!paused)window.__nativeThreeFrame(dt);
  controls.update();renderer.render(scene,camera);
  frames++;seconds+=dt;
  if(seconds>=.5){if(!window.__nativeThreeBattleStatus().finished)status.textContent=`Veebirenderdus ${Math.round(frames/seconds)} FPS`;updateScore();frames=0;seconds=0;}
}
async function start(){
  try{
    const response=await fetch('./battle-scene.js');
    if(!response.ok)throw new Error(`Lahingustseen puudub: HTTP ${response.status}`);
    const source=await response.text();
    // This is bundled, trusted project source. User-provided game code is not
    // fetched or evaluated by the web test.
    new Function('THREE',source)(THREE);
    scene=window.__nativeThreeScene;
    if(!scene?.isScene||typeof window.__nativeThreeFrame!=='function')throw new Error('Lahingustseeni liides puudub');
    installBrowserGeometry(scene);
    camera=scene.children.find(object=>object.isPerspectiveCamera)??new THREE.PerspectiveCamera(57,1,.1,2000);
    renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});
    renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    controls=new OrbitControls(camera,canvas);
    controls.target.set(0,0,0);controls.enableDamping=true;controls.update();
    addEventListener('resize',resize);resize();
    battleButton.onclick=()=>{window.__nativeThreeQuickBattle();updateScore();};
    pauseButton.onclick=()=>{paused=!paused;pauseButton.textContent=paused?'Jätka':'Peata';};
    resetButton.onclick=()=>location.reload();
    status.textContent='Stseen valmis';updateScore();requestAnimationFrame(frame);
  }catch(error){status.textContent=`Käivitamine ebaõnnestus: ${error.message}`;console.error(error);}
}
start();
