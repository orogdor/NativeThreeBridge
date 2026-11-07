from pathlib import Path
src=Path('benchmarks/NativeThreeBridge-v018-REAL-SHADOWS.html')
dst=Path('benchmarks/NativeThreeBridge-v019-SOLDIER-SHADOWS.html')
s=src.read_text('utf8')
assert len(s)>3_000_000
# Soldier shadow maps must be physically separate from the 500 cosmetic ground glows.
old="dst.position.copy(src.position);dst.target.position.copy(src.target.position);"
assert s.count(old)==1
s=s.replace(old,'''// Offset each true spotlight from its moving soldier: angled lighting casts
   // visible tree and soldier silhouettes instead of an almost invisible
   // shadow directly beneath the unit.
   dst.position.set(src.position.x+6,src.position.y+3,src.position.z+4);
   dst.target.position.set(src.position.x,0,src.position.z);
   dst.target.updateMatrixWorld();
   dst.updateMatrixWorld();
   dst.shadow.camera.updateProjectionMatrix();
   dst.shadow.needsUpdate=true;''',1)
old="dst.angle=src.angle;dst.penumbra=src.penumbra;dst.decay=src.decay;dst.castShadow=shadows&&i<shadowBudget;"
assert s.count(old)==1
s=s.replace(old,'''dst.angle=Math.PI/3;dst.penumbra=0.14;dst.decay=1.2;
   dst.intensity=src.intensity*2.6;
   dst.castShadow=shadows&&i<shadowBudget;
   dst.shadow.needsUpdate=dst.castShadow;''',1)
old="light.shadow.mapSize.set(256,256);light.shadow.bias=-.0008;"
assert s.count(old)==1
s=s.replace(old,'''light.shadow.mapSize.set(256,256);
    light.shadow.bias=-0.00028;light.shadow.normalBias=0.025;
    light.shadow.radius=1.2;''',1)
# Real spotlight shadow contrast requires its light to dominate ambient + sun.
old="scene.add(new THREE.HemisphereLight(0xaecaf6,0x364b34,.48));"
assert s.count(old)==1
s=s.replace(old,"scene.add(new THREE.HemisphereLight(0xaecaf6,0x364b34,.18));",1)
old="const sunlight=new THREE.DirectionalLight(0xffeed4,2.25);"
assert s.count(old)==1
s=s.replace(old,"const sunlight=new THREE.DirectionalLight(0xffeed4,0.65);",1)
# The artificial additive glow decal may cover exactly the shadowed floor.
old="map:tex,transparent:true,opacity:.22,depthWrite:false,"
assert s.count(old)==1
s=s.replace(old,"map:tex,transparent:true,opacity:.075,depthWrite:false,",1)
# Explicit diagnostic of actual spotlight shadow instances, not merely JS lights.
old="renderer.shadowMap.enabled=shadows;"
assert s.count(old)==1
s=s.replace(old,'''renderer.shadowMap.enabled=shadows;
  document.body.dataset.soldierShadowLights=String(pool.filter(l=>l.visible&&l.castShadow).length);
  document.body.dataset.spotlightShadowsActive=String(shadows&&pool.some(l=>l.visible&&l.castShadow));''',1)
# Make shadowCount default 8 as previous. Add toggle status info without changing user input layout.
old="const activeLights=16;"
assert s.count(old)==1
# Display shadow pool's actual status in UI so the 500 cosmetic lights aren't confused with 8/16 shadow casters.
old="const shadowControl=document.getElementById('shadows');"
assert s.count(old)==1
s=s.replace(old,'''const shadowControl=document.getElementById('shadows');
   shadowControl.title='Varjud tekivad lähima 8 või 16 sõduri päris prožektorist. 500 nõrka valguslaiku ei tekita eraldi varjukaarte.';
''',1)
s=s.replace('REAL-SHADOWS','SOLDIER-SHADOWS')
dst.write_text(s,'utf8')
print(dst, dst.stat().st_size)
