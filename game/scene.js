// NativeThreeBridge Windows DX12 stress test: 1000 pines in a ~32x32 forest + 500 units/lights.
// Real Three.js / QuickJS-NG; independent file, editable without recompiling EXE.
(() => {
  'use strict';
  const GRID=160, CELL=3, FOREST_SIDE=32, TREES=1000, PER_ARMY=250;
  const SOLDIERS=2*PER_ARMY, TOTAL=TREES+SOLDIERS, LIGHT_HEIGHT=9.5, LIGHT_RADIUS=18;
  const scene=new THREE.Scene();
  scene.name='1000-tree expanded forest + 500 moving soldiers with spotlights';
  scene.background=new THREE.Color(0x1c2a3c);
  const forest=new THREE.Group(), armies=new THREE.Group();
  forest.name='1000 pine forest (~32x32 grid)'; armies.name='Two armies of 250';
  scene.add(forest,armies);
  const pineGeo=new THREE.BufferGeometry();
  pineGeo.userData.nativeMesh='assets/sapling-trees/pine_01/mid.glb';
  const spearmanGeo=new THREE.BufferGeometry();
  spearmanGeo.userData.nativeMesh='models-trellis-v262/odamees.glb';
  const treeBark=new THREE.InstancedMesh(pineGeo,new THREE.MeshStandardMaterial({roughness:0.9}),TREES);
  const treeNeedles=new THREE.InstancedMesh(pineGeo,new THREE.MeshStandardMaterial({alphaTest:0.4,side:THREE.DoubleSide}),TREES);
  forest.add(treeBark,treeNeedles);
  const red=new THREE.InstancedMesh(spearmanGeo,new THREE.MeshStandardMaterial({color:0xf4a9a9}),PER_ARMY);
  const blue=new THREE.InstancedMesh(spearmanGeo,new THREE.MeshStandardMaterial({color:0x9acaff}),PER_ARMY);
  red.name='Red army 250';blue.name='Blue army 250';
  armies.add(red,blue);
  const ground=new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshStandardMaterial({color:0x405742}));
  ground.userData.nativePrimitive='ground';scene.add(ground);
  const camera=new THREE.PerspectiveCamera(57,1152/768,0.1,2000);
  camera.position.set(250,380,-500);camera.lookAt(0,0,0);scene.add(camera);

  const blocked=new Uint8Array(GRID*GRID);
  const gridIndex=(x,z)=>z*GRID+x;
  const toWorld=x=>(x-(GRID-1)/2)*CELL;
  const fromIndex=n=>[n%GRID,Math.floor(n/GRID)];
  const transform=new THREE.Object3D();
  function put(mesh,index,x,z,yaw=0,scale=1){
    transform.position.set(x,0,z);transform.rotation.set(0,yaw,0);
    transform.scale.setScalar(scale);transform.updateMatrix();
    mesh.setMatrixAt(index,transform.matrix);
  }
  let seed=173019;
  function rand(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;}
  const treeCells=[];
  // 32x32 positions cover 10.24x the original forest footprint.
  // Omit every 43rd grid position: 1024 - 24 = exactly 1000 trees.
  // Preserve 3 nav cells spacing so soldiers can find routes between trunks.
  for(let z=0;z<FOREST_SIDE;z++)for(let x=0;x<FOREST_SIDE;x++){
    if((z*FOREST_SIDE+x)%43===0)continue;
    const gx=32+x*3, gz=32+z*3, n=treeCells.length;
    treeCells.push([gx,gz]);blocked[gridIndex(gx,gz)]=1;
    const tx=toWorld(gx)+(rand()-0.5)*0.55;
    const tz=toWorld(gz)+(rand()-0.5)*0.55;
    const yaw=rand()*Math.PI*2,scale=0.83+rand()*0.34;
    put(treeBark,n,tx,tz,yaw,scale);
    put(treeNeedles,n,tx,tz,yaw,scale);
  }
  if(treeCells.length!==TREES) throw new Error('Forest tree count must be exactly 1000');
  treeBark.instanceMatrix.needsUpdate=true;
  treeNeedles.instanceMatrix.needsUpdate=true;

  // Binary-heap A*: every one of the 500 soldiers independently plans around trees.
  // Paths are computed at initialization, not inside the render loop.
  function findPath(sx,sz,tx,tz){
    const start=gridIndex(sx,sz),goal=gridIndex(tx,tz),size=GRID*GRID;
    if(blocked[start]||blocked[goal])return [];
    const cost=new Float32Array(size),prev=new Int32Array(size),closed=new Uint8Array(size);
    cost.fill(Infinity);prev.fill(-1);cost[start]=0;
    const queue=[];
    const heuristic=n=>Math.abs(n%GRID-tx)+Math.abs(Math.floor(n/GRID)-tz);
    function push(n,p){
      const entry={n,p};let k=queue.length;queue.push(entry);
      while(k>0){const j=(k-1)>>1;if(queue[j].p<=entry.p)break;queue[k]=queue[j];k=j;}
      queue[k]=entry;
    }
    function pop(){
      const result=queue[0].n,tail=queue.pop();
      if(queue.length){
        let k=0;
        while((k*2+1)<queue.length){
          let j=k*2+1;
          if(j+1<queue.length&&queue[j+1].p<queue[j].p)j++;
          if(queue[j].p>=tail.p)break;
          queue[k]=queue[j];k=j;
        }
        queue[k]=tail;
      }
      return result;
    }
    push(start,heuristic(start));
    while(queue.length){
      const n=pop();if(closed[n])continue;
      if(n===goal){
        const path=[];
        for(let v=n;v!==-1;v=prev[v]){path.push(v);if(v===start)break;}
        return path.reverse();
      }
      closed[n]=1;
      const x=n%GRID,z=(n/GRID)|0;
      const adj=[x>0?n-1:-1,x<GRID-1?n+1:-1,z>0?n-GRID:-1,z<GRID-1?n+GRID:-1];
      for(const next of adj){
        if(next<0||closed[next]||blocked[next])continue;
        const d=cost[n]+1;
        if(d<cost[next]){cost[next]=d;prev[next]=n;push(next,d+heuristic(next)*1.0001);}
      }
    }
    return [];
  }

  const units=[],soldierLights=[];
  const matrices=new Float32Array(TOTAL*16);
  const lightData=new Float32Array(SOLDIERS*8);
  const lightColors=[new THREE.Color(0xffbc88),new THREE.Color(0x94c5ff)];
  let pathFailures=0,totalPathCells=0,arrivals=0;
  for(let team=0;team<2;team++)for(let i=0;i<PER_ARMY;i++){
    // 10 columns by 25 rows on each side (250 separate starting tiles).
    const column=i%10,row=(i/10)|0;
    const sx=team===0?4+column:155-column;
    const sz=68+row;
    const tx=team===0?155-column:4+column;
    const tz=92-row;
    const path=findPath(sx,sz,tx,tz);
    if(path.length===0)pathFailures++;
    totalPathCells+=path.length;
    const unit={team,index:i,path,at:0,x:toWorld(sx),z:toWorld(sz),
      startX:toWorld(sx),startZ:toWorld(sz),yaw:team===0?1.57:-1.57,
      speed:6.2+(i%5)*0.22,arrived:false};
    units.push(unit);
    const lamp=new THREE.SpotLight(lightColors[team],2.0,LIGHT_RADIUS,Math.PI/3,0.25,1.5);
    lamp.name=(team===0?'Red':'Blue')+' spotlight '+i;
    lamp.castShadow=true; // DX12 selectively budgets 16 shadow-map updates/frame.
    lamp.shadow.mapSize.set(256,256);lamp.shadow.bias=-0.0008;
    lamp.position.set(unit.x,LIGHT_HEIGHT,unit.z);
    lamp.target.position.set(unit.x,0,unit.z);
    scene.add(lamp,lamp.target);
    soldierLights.push(lamp);
    const base=(team*PER_ARMY+i)*8;
    lightData[base+1]=LIGHT_HEIGHT;
    lightData[base+3]=LIGHT_RADIUS;
    lightData[base+4]=lamp.color.r;
    lightData[base+5]=lamp.color.g;
    lightData[base+6]=lamp.color.b;
    lightData[base+7]=lamp.intensity;
    put(team===0?red:blue,i,unit.x,unit.z,unit.yaw);
  }

  function updateSoldiers(dt){
    dt=Math.min(0.06,Math.max(0,Number(dt)||0));
    for(const unit of units){
      let advance=unit.speed*dt;
      while(advance>0.00001 && unit.at+1<unit.path.length){
        const [gx,gz]=fromIndex(unit.path[unit.at+1]);
        const vx=toWorld(gx)-unit.x,vz=toWorld(gz)-unit.z;
        const len=Math.hypot(vx,vz),step=Math.min(len,advance);
        if(len>0.000001){
          unit.x+=vx/len*step;unit.z+=vz/len*step;
          unit.yaw=Math.atan2(vx,vz);advance-=step;
        }else advance=0;
        if(len<=step+0.00001)unit.at++;
      }
      if(unit.path.length && unit.at===unit.path.length-1 && !unit.arrived){
        unit.arrived=true;arrivals++;
      }
      put(unit.team===0?red:blue,unit.index,unit.x,unit.z,unit.yaw);
      const li=unit.team*PER_ARMY+unit.index,base=li*8;
      const lamp=soldierLights[li];
      lamp.position.x=unit.x;lamp.position.z=unit.z;
      lamp.target.position.x=unit.x;lamp.target.position.z=unit.z;
      lightData[base]=unit.x;lightData[base+2]=unit.z;
    }
    red.instanceMatrix.needsUpdate=true;blue.instanceMatrix.needsUpdate=true;
  }
  updateSoldiers(0);

  const scratch=new THREE.Matrix4();
  function writeMatrices(mesh,offset){
    for(let i=0;i<mesh.count;i++){
      mesh.getMatrixAt(i,scratch);
      scratch.premultiply(mesh.matrixWorld);
      matrices.set(scratch.elements,(offset+i)*16);
    }
  }
  scene.updateMatrixWorld(true);
  writeMatrices(treeBark,0); // static trees: once, no per-frame recalculation
  function frame(dt=1/60){
    updateSoldiers(dt);
    scene.updateMatrixWorld(true);
    writeMatrices(red,TREES);
    writeMatrices(blue,TREES+PER_ARMY);
    return matrices;
  }
  function diagnostics(){
    return {treeCount:TREES,forestSide:FOREST_SIDE,armyCount:2,unitCount:SOLDIERS,
      soldierCounts:[red.count,blue.count],lights:soldierLights.length,
      shadowLights:soldierLights.filter(l=>l.castShadow).length,
      lightsAreSpotLights:soldierLights.every(l=>l.isSpotLight),
      floats:matrices.length,lightFloatCount:lightData.length,
      routes:units.length,routeFailures:pathFailures,totalRouteCells:totalPathCells,
      moved:units.filter(u=>Math.hypot(u.x-u.startX,u.z-u.startZ)>0.2).length,
      arrived:arrivals,treeCells:treeCells.length,
      scene:scene.isScene,group:forest.isGroup,mesh:ground.isMesh,
      instances:red.isInstancedMesh};
  }
  globalThis.__nativeThreeScene=scene;
  globalThis.__nativeThreeFrame=frame;
  globalThis.__nativeThreeLightFrame=()=>lightData;
  globalThis.__nativeThreeDiagnostics=diagnostics;
  globalThis.__nativeNavTest=()=>({
    size:GRID,blocked:Array.from(blocked),trees:treeCells.map(t=>t.slice()),
    paths:units.map(u=>u.path.slice()),
    positions:units.map(u=>[u.x,u.z]),
    lights:soldierLights.map(l=>[l.position.x,l.position.y,l.position.z])
  });
})();