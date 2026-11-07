from pathlib import Path
import re

source=Path('benchmarks/NativeThreeBridge-v016-WebGL2-RENDER-FIX.html')
target=Path('benchmarks/NativeThreeBridge-v017-ALL-SOLDIER-LIGHTS.html')
html=source.read_text(encoding='utf-8')

old='function selectLights(){'
assert html.count(old)==1,'Light-selection function changed'

# 500 cheap radial light footprints rendered in a single instanced draw call.
# Actual Three.js spotlights are still reserved for the camera-near soldiers.
replacement='''let soldierGlow=null;
let glowEnabled=true;
const glowPivot=new THREE.Object3D();
const glowColors=[new THREE.Color(0xff694a),new THREE.Color(0x649dff)];
function prepareSoldierGlows(){
 if(soldierGlow)return;
 const canvas=document.createElement('canvas');canvas.width=canvas.height=64;
 const ctx=canvas.getContext('2d');
 const grad=ctx.createRadialGradient(32,32,2,32,32,32);
 grad.addColorStop(0,'rgba(255,255,255,0.9)');
 grad.addColorStop(.28,'rgba(255,255,255,0.42)');
 grad.addColorStop(.65,'rgba(255,255,255,0.10)');
 grad.addColorStop(1,'rgba(255,255,255,0)');
 ctx.fillStyle=grad;ctx.fillRect(0,0,64,64);
 const tex=new THREE.CanvasTexture(canvas);
 const material=new THREE.MeshBasicMaterial({
  map:tex,transparent:true,opacity:.45,depthWrite:false,
  depthTest:true,blending:THREE.AdditiveBlending,
  toneMapped:false,side:THREE.DoubleSide
 });
 soldierGlow=new THREE.InstancedMesh(new THREE.PlaneGeometry(18,18),material,lamps.length);
 soldierGlow.name='500 moving soldier light footprints (one GPU draw)';
 soldierGlow.frustumCulled=false; soldierGlow.renderOrder=1;
 for(let i=0;i<lamps.length;i++) soldierGlow.setColorAt(i,glowColors[i<250?0:1]);
 soldierGlow.instanceColor.needsUpdate=true;
 scene.add(soldierGlow);
}
function refreshSoldierGlows(){
 if(!soldierGlow)return;
 soldierGlow.visible=glowEnabled;
 if(!glowEnabled)return;
 for(let i=0;i<lamps.length;i++){
  const p=lamps[i].position;
  glowPivot.position.set(p.x,0.035,p.z);
  glowPivot.rotation.set(-Math.PI/2,0,0);
  glowPivot.scale.set(1,1,1);
  glowPivot.updateMatrix();
  soldierGlow.setMatrixAt(i,glowPivot.matrix);
 }
 soldierGlow.instanceMatrix.needsUpdate=true;
}
function selectLights(){
 refreshSoldierGlows();'''
html=html.replace(old,replacement,1)
# The shader lights stay near the camera; the 500 visible light footprints are independent.
html=html.replace('const activeLights=shadowBudget===16?16:8;',
                  'const activeLights=16;',1)
# Initialize after all original GLB meshes and pool of 16 actual spotlights exist.
anchor='setView(1);selectLights();refreshPaths();'
assert html.count(anchor)==1,'Initial light setup changed'
html=html.replace(anchor,'''prepareSoldierGlows();refreshSoldierGlows();
   setView(1);selectLights();refreshPaths();''',1)
# Ensure moving instanced light footprints follow each soldier on every frame.
# selectLights is called in the animation loop, so update all footprints at its start.

# Keep the test's original UI and add a separate toggle for all glow footprints.

# add UI control using existing shadow-button parent to avoid altering bundled libraries.
anchor="setView(1);selectLights();refreshPaths();"
assert html.count(anchor)==1
html=html.replace(anchor,'''   const glowToggle=document.createElement('button');
   glowToggle.textContent='500 sõduri valgused: SEES';
   glowToggle.className='active';
   glowToggle.title='Lülitab kõigi sõdurite optimeeritud valguslaigud sisse või välja';
   glowToggle.addEventListener('click',()=>{
    glowEnabled=!glowEnabled;
    glowToggle.textContent='500 sõduri valgused: '+(glowEnabled?'SEES':'VÄLJAS');
    glowToggle.classList.toggle('active',glowEnabled);
    refreshSoldierGlows();
   });
   const shadowControl=document.getElementById('shadows');
   shadowControl.parentElement.appendChild(glowToggle);
   setView(1);selectLights();refreshPaths();''',1)
html=html.replace('WebGL2-RENDER-FIX','ALL-SOLDIER-LIGHTS')
assert 'prepareSoldierGlows();refreshSoldierGlows()' in html
assert 'function selectLights(){\n refreshSoldierGlows();' in html
assert len(html)>3000000
target.write_text(html,encoding='utf-8')
print('Wrote',target,'bytes',target.stat().st_size)
