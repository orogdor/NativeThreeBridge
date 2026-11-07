// NativeThreeBridge Windows DX12 stress test: 1000 pines in a ~32x32 forest + 500 units/lights.
// Real Three.js / QuickJS-NG; independent file, editable without recompiling EXE.
(() => {
  'use strict';
  const GRID=160, CELL=3, FOREST_SIDE=32, TREES=1000, PER_ARMY=250;
  const SOLDIERS=2*PER_ARMY, TOTAL=TREES+SOLDIERS, LIGHT_HEIGHT=9.5, LIGHT_RADIUS=32;
  const scene=new THREE.Scene();
  scene.name='1000 randomly placed pines + 500 moving soldiers';
  scene.background=new THREE.Color(0x1c2a3c);
  const forest=new THREE.Group(), armies=new THREE.Group();
  forest.name='1000 randomly scattered pines'; armies.name='Two armies of 250';
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
  const FOREST_SEED=173019; // change this number to generate a different forest
  let seed=FOREST_SEED;
  function rand(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;}
  const treeCells=[];
  const treePositions=[]; // sub-cell coordinates; prevents visible grid rows
  // Seeded pseudo-random blue-noise placement. Keep approximately the same
  // forest footprint but discard the rigid 32x32 planting lattice.
  // Each accepted tree occupies a navigation cell so A* routes avoid trunks.
  const FOREST_MIN=32, FOREST_MAX=127, MIN_TREE_SPACING=2.05;
  const MIN_TREE_SPACING_SQ=MIN_TREE_SPACING*MIN_TREE_SPACING;
  const treeCellOwner=new Int32Array(GRID*GRID);
  treeCellOwner.fill(-1);
  let attempts=0;
  while(treeCells.length<TREES && attempts<250000){
    attempts++;
    const gxFloat=FOREST_MIN+rand()*(FOREST_MAX-FOREST_MIN);
    const gzFloat=FOREST_MIN+rand()*(FOREST_MAX-FOREST_MIN);
    // Vary local density to create denser pockets and natural clearings.
    const density=0.62+0.23*Math.sin(gxFloat*0.17+1.4)*
                           Math.cos(gzFloat*0.13-0.8);
    if(rand()>density)continue;
    const gx=Math.round(gxFloat),gz=Math.round(gzFloat);
    const index=gridIndex(gx,gz);
    if(blocked[index])continue;
    // Check only neighbouring cells: O(1) instead of testing all 1000 trees.
    // Trunks are kept apart, while their canopies may naturally overlap.
    let collision=false;
    for(let z=Math.max(0,gz-3);z<=Math.min(GRID-1,gz+3)&&!collision;z++){
      for(let x=Math.max(0,gx-3);x<=Math.min(GRID-1,gx+3);x++){
        const previous=treeCellOwner[gridIndex(x,z)];
        if(previous<0)continue;
        const [px,pz]=treePositions[previous];
        const dx=px-gxFloat,dz=pz-gzFloat;
        if(dx*dx+dz*dz<MIN_TREE_SPACING_SQ){collision=true;break;}
      }
    }
    if(collision)continue;
    const n=treeCells.length;
    treeCells.push([gx,gz]);
    treePositions.push([gxFloat,gzFloat]);
    blocked[index]=1;
    treeCellOwner[index]=n;
    const worldX=toWorld(gxFloat),worldZ=toWorld(gzFloat);
    const yaw=rand()*Math.PI*2,scale=0.75+rand()*0.55;
    put(treeBark,n,worldX,worldZ,yaw,scale);
    put(treeNeedles,n,worldX,worldZ,yaw,scale);
  }
  if(treeCells.length!==TREES)
    throw new Error('Random forest placed '+treeCells.length+' of '+TREES+' trees');
  treeBark.instanceMatrix.needsUpdate=true;
  treeNeedles.instanceMatrix.needsUpdate=true;

  // Each unit plans on demand while the simulation is running.
  // Live cell occupancy AND in-transit reservations are A* obstacles.
  // No 500-route upfront computation or overlapping/swap moves.
  const occupants=new Int16Array(GRID*GRID), reservations=new Int16Array(GRID*GRID);
  occupants.fill(-1); reservations.fill(-1);
  const pathCosts=new Float32Array(GRID*GRID);
  const pathParents=new Int32Array(GRID*GRID);
  const seen=new Uint32Array(GRID*GRID), closed=new Uint32Array(GRID*GRID);
  let searchId=0,searches=0,replans=0,blockedMoves=0,routeFailures=0;
  const MAX_PLANS_PER_FRAME=12; // budget planning to avoid JS frame spikes
  const pathHeap=[];
  function findPath(unit) {
    const start=unit.cell,goal=unit.goal;
    if(blocked[start] || blocked[goal])return [];
    searchId++;
    if(searchId>=0xfffffffe){seen.fill(0);closed.fill(0);searchId=1;}
    const epoch=searchId;
    pathHeap.length=0;
    const tx=goal%GRID,tz=(goal/GRID)|0;
    const heuristic=n=>Math.abs(n%GRID-tx)+Math.abs(((n/GRID)|0)-tz);
    function push(node,p) {
      const entry={node,p};let i=pathHeap.length;
      pathHeap.push(entry);
      while(i>0){const parent=(i-1)>>1;
        if(pathHeap[parent].p<=entry.p)break;
        pathHeap[i]=pathHeap[parent];i=parent;
      }
      pathHeap[i]=entry;
    }
    function pop() {
      const top=pathHeap[0].node,last=pathHeap.pop();
      if(pathHeap.length){
        let i=0;
        while(i*2+1<pathHeap.length){
          let child=i*2+1;
          if(child+1<pathHeap.length && pathHeap[child+1].p<pathHeap[child].p)child++;
          if(pathHeap[child].p>=last.p)break;
          pathHeap[i]=pathHeap[child];i=child;
        }
        pathHeap[i]=last;
      }
      return top;
    }
    function canVisit(cell) {
      return !blocked[cell] &&
          (occupants[cell]===-1 || occupants[cell]===unit.id) &&
          (reservations[cell]===-1 || reservations[cell]===unit.id);
    }
    seen[start]=epoch;pathCosts[start]=0;pathParents[start]=-1;
    push(start,heuristic(start));
    while(pathHeap.length){
      const n=pop();
      if(closed[n]===epoch)continue;
      if(n===goal){
        const path=[];
        for(let p=n;p!==-1;p=pathParents[p]){
          path.push(p);
          if(p===start)break;
        }
        path.reverse();return path;
      }
      closed[n]=epoch;
      const x=n%GRID,z=(n/GRID)|0;
      const adj=[x>0?n-1:-1,x<GRID-1?n+1:-1,z>0?n-GRID:-1,z<GRID-1?n+GRID:-1];
      for(const next of adj){
        if(next<0 || closed[next]===epoch || !canVisit(next))continue;
        const candidate=pathCosts[n]+1;
        if(seen[next]!==epoch || candidate<pathCosts[next]){
          seen[next]=epoch;pathCosts[next]=candidate;
          pathParents[next]=n;
          push(next,candidate+heuristic(next)*1.0001);
        }
      }
    }
    return [];
  }
  function planFor(unit) {
    if(unit.next!==-1 || unit.arrived)return false;
    const oldPlans=unit.plans;
    const path=findPath(unit);
    searches++; if(oldPlans>0)replans++;
    unit.plans++;unit.wait=0;unit.path=path;unit.at=0;
    if(path.length<2){
      unit.path=[];unit.retry=0.30+(unit.id%9)*0.045;
      if(unit.cell===unit.goal)unit.arrived=true;
      return false;
    }
    unit.retry=0;
    return true;
  }
  const units=[],soldierLights=[];
  const matrices=new Float32Array(TOTAL*16);
  const lightData=new Float32Array(SOLDIERS*8);
  const lightColors=[new THREE.Color(0xffbc88),new THREE.Color(0x94c5ff)];
  let arrivals=0,planningCursor=0,simFrames=0;
  for(let team=0;team<2;team++)for(let i=0;i<PER_ARMY;i++){
    // Two-spaced formations leave a free cell between soldiers: physically
    // viable queues that can get around one another without spawning overlaps.
    const column=i%10,row=(i/10)|0;
    const sx=team===0?10+column*2:149-column*2;
    const sz=50+row*2;
    // Destinations are distinct and not initially occupied by enemy spawns.
    const tx=team===0?150+column:9-column, tz=sz;
    const id=team*PER_ARMY+i,cell=gridIndex(sx,sz),goal=gridIndex(tx,tz);
    if(blocked[cell]||occupants[cell]!==-1||blocked[goal])
      throw new Error('Invalid soldier start/goal '+id);
    occupants[cell]=id;
    const unit={id,team,index:i,cell,goal,next:-1,progress:0,
      path:[],at:0,plans:0,wait:0,retry:0,arrived:false,
      x:toWorld(sx),z:toWorld(sz),startX:toWorld(sx),startZ:toWorld(sz),
      yaw:team===0?1.57:-1.57,speed:10.5+(i%5)*0.35};
    units.push(unit);
    const lamp=new THREE.SpotLight(lightColors[team],4.0,LIGHT_RADIUS,Math.PI/3,0.25,1.5);
    lamp.name=(team===0?'Red':'Blue')+' spotlight '+i;
    lamp.castShadow=true;
    lamp.shadow.mapSize.set(256,256);lamp.shadow.bias=-0.0008;
    lamp.position.set(unit.x,LIGHT_HEIGHT,unit.z);
    lamp.target.position.set(unit.x,0,unit.z);
    scene.add(lamp,lamp.target);
    soldierLights.push(lamp);
    const base=id*8;
    lightData[base+1]=LIGHT_HEIGHT;
    lightData[base+3]=LIGHT_RADIUS;
    lightData[base+4]=lamp.color.r;
    lightData[base+5]=lamp.color.g;
    lightData[base+6]=lamp.color.b;
    lightData[base+7]=lamp.intensity;
    put(team===0?red:blue,i,unit.x,unit.z,unit.yaw);
  }

  function planPending(dt) {
    // Fair round-robin, max 12 independent A* searches per frame. Solders
    // request a route only when needed; a stuck unit can request a new one.
    let budget=MAX_PLANS_PER_FRAME;
    for(let checked=0;checked<SOLDIERS && budget>0;checked++){
      const unit=units[planningCursor];
      planningCursor=(planningCursor+1)%SOLDIERS;
      if(unit.arrived||unit.next!==-1||unit.path.length>1||unit.retry>0)continue;
      planFor(unit);budget--;
    }
  }
  function updateSoldiers(dt){
    dt=Math.min(0.5,Math.max(0,Number(dt)||0));
    simFrames++;
    // Retry clocks progress even for soldiers who cannot currently find a route.
    for(const unit of units)if(unit.retry>0)unit.retry=Math.max(0,unit.retry-dt);
    if(dt>0)planPending(dt);
    // Rotate priority every frame to avoid permanent starvation.
    const first=simFrames%SOLDIERS;
    for(let j=0;j<SOLDIERS;j++){
      const unit=units[(j+first)%SOLDIERS];
      let distance=unit.speed*dt,segments=0;
      while(distance>0.000001 && segments<8 && !unit.arrived){
        if(unit.next===-1){
          if(unit.cell===unit.goal){unit.arrived=true;arrivals++;break;}
          if(unit.path.length<2 || unit.at+1>=unit.path.length)break;
          const next=unit.path[unit.at+1];
          // Source remains occupied until the whole edge is traversed,
          // while destination is separately reserved. Prevents overlap,
          // head-on swaps and walking through stationary/moving soldiers.
          if(blocked[next] || occupants[next]!==-1 || reservations[next]!==-1){
            unit.wait+=dt;blockedMoves++;
            if(unit.wait>0.28+(unit.id%5)*0.05){
              unit.path=[];unit.at=0;unit.wait=0;
              unit.retry=0.08+(unit.id%7)*0.025; // re-plan on demand
            }
            break;
          }
          reservations[next]=unit.id;
          unit.next=next;unit.progress=0;unit.wait=0;
        }
        const remaining=CELL-unit.progress;
        const step=Math.min(distance,remaining);
        unit.progress+=step;distance-=step;
        const [sx,sz]=fromIndex(unit.cell),[tx,tz]=fromIndex(unit.next);
        const t=unit.progress/CELL;
        unit.x=toWorld(sx)+(toWorld(tx)-toWorld(sx))*t;
        unit.z=toWorld(sz)+(toWorld(tz)-toWorld(sz))*t;
        unit.yaw=Math.atan2(tx-sx,tz-sz);
        if(unit.progress>=CELL-0.00001){
          // The occupied and reserved tiles are updated atomically.
          if(occupants[unit.cell]!==unit.id ||
             reservations[unit.next]!==unit.id ||
             occupants[unit.next]!==-1)
            throw new Error('Soldier occupancy conflict '+unit.id);
          occupants[unit.cell]=-1;
          occupants[unit.next]=unit.id;
          reservations[unit.next]=-1;
          unit.cell=unit.next;unit.next=-1;unit.progress=0;
          unit.at++;segments++;
          if(unit.cell===unit.goal){unit.arrived=true;arrivals++;break;}
        }
      }
      put(unit.team===0?red:blue,unit.index,unit.x,unit.z,unit.yaw);
      const base=unit.id*8,lamp=soldierLights[unit.id];
      lamp.position.x=unit.x;lamp.position.z=unit.z;
      lamp.target.position.x=unit.x;lamp.target.position.z=unit.z;
      lightData[base]=unit.x;lightData[base+2]=unit.z;
    }
    red.instanceMatrix.needsUpdate=true;
    blue.instanceMatrix.needsUpdate=true;
  }
  updateSoldiers(0); // Creates no paths: planning only starts on actual frames.

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
      routes:units.filter(u=>u.plans>0).length,routeFailures,
      searches,replans,blockedMoves,unplanned:units.filter(u=>!u.plans).length,
      moved:units.filter(u=>Math.hypot(u.x-u.startX,u.z-u.startZ)>0.2).length,
      arrived:arrivals,treeCells:treeCells.length,
      placementMode:'seeded-random',forestAttempts:attempts,
      debugSegments:0, // generated on demand for the native F4 overlay
      active:units.filter(u=>!u.arrived).length,
      routeSteps:units.reduce((n,u)=>n+u.at,0),
      scene:scene.isScene,group:forest.isGroup,mesh:ground.isMesh,
      instances:red.isInstancedMesh};
  }
  globalThis.__nativeThreeNavStats=()=>({
    routeFailures,
    moved:units.filter(u=>Math.hypot(u.x-u.startX,u.z-u.startZ)>0.2).length,
    active:units.filter(u=>!u.arrived).length,
    arrived:arrivals,
    routeSteps:units.reduce((n,u)=>n+u.at,0),
    searches,replans,blockedMoves,
    planned:units.filter(u=>u.plans>0).length
  });
  // Only F4 diagnostic sampling requests these twelve individual paths.
  // All remaining 488 soldiers still start with no precomputed route.
  const sampleUnits=[0,29,79,129,179,229];
  function debugSegments() {
    const output=[];
    for(let team=0;team<2;team++)for(const index of sampleUnits){
      const unit=units[team*PER_ARMY+index];
      if(!unit.plans)planFor(unit); // on-demand render inspection, not a bulk preload
      const path=unit.path;
      for(let j=unit.at+1;j<path.length;j++){
        const [ax,az]=fromIndex(path[j-1]);
        const [bx,bz]=fromIndex(path[j]);
        output.push(team,toWorld(ax),toWorld(az),toWorld(bx),toWorld(bz));
      }
    }
    return new Float32Array(output);
  }
  globalThis.__nativeThreeDebugSegments=debugSegments;
  // Live movement orders: each soldier chooses/replans their own path.
  // A new destination never bypasses a unit's in-progress cell reservation.
  globalThis.__nativeThreeSetDestination=(id,gx,gz)=>{
    if(!Number.isInteger(id)||id<0||id>=SOLDIERS ||
       !Number.isInteger(gx)||!Number.isInteger(gz)||
       gx<0||gx>=GRID||gz<0||gz>=GRID)return false;
    const target=gridIndex(gx,gz);
    if(blocked[target])return false;
    const unit=units[id];
    unit.goal=target;unit.arrived=false;unit.path=[];unit.at=0;
    unit.wait=0;unit.retry=0;
    return true;
  };
  globalThis.__nativeThreeScene=scene;
  globalThis.__nativeThreeFrame=frame;
  globalThis.__nativeThreeLightFrame=()=>lightData;
  globalThis.__nativeThreeDiagnostics=diagnostics;
  globalThis.__nativeNavTest=()=>({
    size:GRID,blocked:Array.from(blocked),trees:treeCells.map(t=>t.slice()),
    worldTreePositions:treePositions.map(([x,z])=>[toWorld(x),toWorld(z)]),
    forestAttempts:attempts,
    paths:units.map(u=>u.path.slice()),
    occupancy:Array.from(occupants),reservations:Array.from(reservations),
    cells:units.map(u=>u.cell),nextCells:units.map(u=>u.next),
    goals:units.map(u=>u.goal),planCounts:units.map(u=>u.plans),
    movementProgress:units.map(u=>u.progress),
    positions:units.map(u=>[u.x,u.z]),
    lights:soldierLights.map(l=>[l.position.x,l.position.y,l.position.z])
  });
})();