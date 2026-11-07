from pathlib import Path
source=Path('benchmarks/NativeThreeBridge-v017-ALL-SOLDIER-LIGHTS.html')
target=Path('benchmarks/NativeThreeBridge-v018-REAL-SHADOWS.html')
html=source.read_text(encoding='utf-8')
assert len(html)>3000000

# The old HemisphereLight only provides ambient shading and does not cast shadows.
old="scene.add(new THREE.HemisphereLight(0xaecaf6,0x364b34,.75));"
assert html.count(old)==1
html=html.replace(old,'''scene.add(new THREE.HemisphereLight(0xaecaf6,0x364b34,.48));
   // Real directional depth shadow map: unlike a glow decal, this darkens
   // terrain behind trees and soldiers and respects their actual silhouettes.
   const sunlight=new THREE.DirectionalLight(0xffeed4,2.25);
   sunlight.name='Actual tree and soldier shadows';
   sunlight.castShadow=true;
   sunlight.shadow.mapSize.set(1024,1024);
   sunlight.shadow.camera.left=-100;sunlight.shadow.camera.right=100;
   sunlight.shadow.camera.top=100;sunlight.shadow.camera.bottom=-100;
   sunlight.shadow.camera.near=1;sunlight.shadow.camera.far=250;
   sunlight.shadow.bias=-0.00035;
   sunlight.shadow.normalBias=0.035;
   sunlight.shadow.radius=2;
   scene.add(sunlight,sunlight.target);
   window.__BENCH_SUNLIGHT=sunlight;''',1)

old="function selectLights(){\n refreshSoldierGlows();"
assert html.count(old)==1
html=html.replace(old,'''function selectLights(){
 refreshSoldierGlows();
 // Follow the camera focus, so the sole 1024px sun shadow map covers
 // the battlefield rather than wasting depth resolution in distant woods.
 const sun=window.__BENCH_SUNLIGHT;
 if(sun){
  const focus=controls.target;
  sun.position.set(focus.x+55,90,focus.z+36);
  sun.target.position.set(focus.x,0,focus.z);
  sun.target.updateMatrixWorld();
  sun.castShadow=shadows;
 }
''',1)
# Reduce screen-space glow overlays that previously hid depth-map shadows.
old='map:tex,transparent:true,opacity:.45,depthWrite:false,'
assert html.count(old)==1
html=html.replace(old,'map:tex,transparent:true,opacity:.22,depthWrite:false,',1)

# Explicit DOM diagnostics for test automation (do not just assume a visible scene).
old="running=true;tick(performance.now());"
assert html.count(old)==1
html=html.replace(old,'''document.body.dataset.sunlightShadow=String(!!window.__BENCH_SUNLIGHT?.castShadow);
   document.body.dataset.shadowReceivingGround=String(ground.receiveShadow);
   document.body.dataset.shadowCastingMeshes=String(scene.children.filter(o=>o.isInstancedMesh&&o.castShadow&&o.visible).length);
   running=true;tick(performance.now());''',1)
html=html.replace('ALL-SOLDIER-LIGHTS','REAL-SHADOWS')
target.write_text(html,encoding='utf-8')
print('Built real-shadow HTML:',target, target.stat().st_size)
