// NativeThreeBridge Windows DX12 stress test: 10000 randomized pines + 1000 individually navigating soldiers and 1000 moving lights.
// Real Three.js / QuickJS-NG; independent file, editable without recompiling EXE.
(() => {
  'use strict';
  const GRID=360, CELL=3, FOREST_SIDE=100, TREES=10000, PER_ARMY=500;
  const SOLDIERS=2*PER_ARMY, TOTAL=TREES+SOLDIERS, LIGHT_HEIGHT=12.5, LIGHT_RADIUS=32, LIGHT_OFFSET_X=6, LIGHT_OFFSET_Z=4;
  const scene=new THREE.Scene();
  scene.name='10000 randomly placed pines + 1000 moving soldiers';
  scene.background=new THREE.Color(0x030611); // night benchmark by default
  const forest=new THREE.Group(), armies=new THREE.Group();
  forest.name='10000 randomly scattered pines'; armies.name='Two armies of 500';
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
  red.name='Red army 500';blue.name='Blue army 500';
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
  const FOREST_MIN=30, FOREST_MAX=329, MIN_TREE_SPACING=2.05;
// Keep formation origins and destinations clear; otherwise a stress test may
// fail during initialization simply because a random tree was planted there.
function protectedFormationCell(x,z) {
  const row=(z-90)/3;
  if(!Number.isInteger(row)||row<0||row>=25)return false;
  return (x>=10&&x<=48&&(x-10)%2===0) ||
         (x>=311&&x<=349&&(349-x)%2===0) ||
         (x>=285&&x<=304) || (x>=55&&x<=74);
}
  const MIN_TREE_SPACING_SQ=MIN_TREE_SPACING*MIN_TREE_SPACING;
  const treeCellOwner=new Int32Array(GRID*GRID);
  treeCellOwner.fill(-1);
  let attempts=0;
  while(treeCells.length<TREES && attempts<3000000){
    attempts++;
    const gxFloat=FOREST_MIN+rand()*(FOREST_MAX-FOREST_MIN);
    const gzFloat=FOREST_MIN+rand()*(FOREST_MAX-FOREST_MIN);
    // Vary local density to create denser pockets and natural clearings.
    const density=0.62+0.23*Math.sin(gxFloat*0.17+1.4)*
                           Math.cos(gzFloat*0.13-0.8);
    if(rand()>density)continue;
    const gx=Math.round(gxFloat),gz=Math.round(gzFloat);
    const index=gridIndex(gx,gz);
    if(blocked[index]||protectedFormationCell(gx,gz))continue;
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
  // Generic native asynchronous navigation is preferred in Windows.
  // Browser/Node Three.js tests keep the identical synchronous JS fallback.
  const nativeNavigation=globalThis.NativeThreeNavigation??null;
  // Optional portable audio command layer. In Windows it is forwarded to
  // native XAudio2; in a browser it may be supplied by another backend.
  const nativeAudio=globalThis.NativeThreeAudio??null;
  let footstepClock=0;
  // Independent combat pose stream: [swing, impact, death, stance] for each instance.
  const combatData=new Float32Array(SOLDIERS*4);
  if(nativeNavigation)nativeNavigation.configure(GRID,GRID,blocked);
  const nativeTickets=new Map();
  const nativeOccupied=new Int32Array(SOLDIERS);
  const nativeReserved=new Int32Array(SOLDIERS);
  let occupancyRevision=1,lastNativeOccupancyRevision=-1;

  // Each unit plans on demand while the simulation is running.
  // Live cell occupancy AND in-transit reservations are A* obstacles.
  // No 1000-route upfront computation or overlapping/swap moves.
  const occupants=new Int16Array(GRID*GRID), reservations=new Int16Array(GRID*GRID);
  occupants.fill(-1); reservations.fill(-1);
  const pathCosts=new Float32Array(GRID*GRID);
  const pathParents=new Int32Array(GRID*GRID);
  const seen=new Uint32Array(GRID*GRID), closed=new Uint32Array(GRID*GRID);
  let searchId=0,searches=0,replans=0,blockedMoves=0,routeFailures=0;
  const MAX_PLANS_PER_FRAME=4; // bound heavy 360x360-grid searches to limit frame spikes
  // Preallocated A* heap eliminates transient JS allocations per expanded node.
  const HEAP_CAPACITY=GRID*GRID*4;
  const heapNodes=new Int32Array(HEAP_CAPACITY);
  const heapPriority=new Float64Array(HEAP_CAPACITY);
  let heapSize=0;
  function findPath(unit) {
    const start=unit.cell,goal=unit.goal;
    if(blocked[start] || blocked[goal])return [];
    searchId++;
    if(searchId>=0xfffffffe){seen.fill(0);closed.fill(0);searchId=1;}
    const epoch=searchId;
    heapSize=0;
    const tx=goal%GRID,tz=(goal/GRID)|0;
    const heuristic=n=>Math.abs(n%GRID-tx)+Math.abs(((n/GRID)|0)-tz);
    function push(node,p) {
      if(heapSize>=HEAP_CAPACITY)throw new Error('A* heap capacity exceeded');
      let i=heapSize++;
      while(i>0){
        const parent=(i-1)>>1;
        if(heapPriority[parent]<=p)break;
        heapNodes[i]=heapNodes[parent];
        heapPriority[i]=heapPriority[parent];
        i=parent;
      }
      heapNodes[i]=node;heapPriority[i]=p;
    }
    function pop() {
      const top=heapNodes[0];
      const lastNode=heapNodes[--heapSize],lastPriority=heapPriority[heapSize];
      if(heapSize){
        let i=0;
        while(i*2+1<heapSize){
          let child=i*2+1;
          if(child+1<heapSize && heapPriority[child+1]<heapPriority[child])child++;
          if(heapPriority[child]>=lastPriority)break;
          heapNodes[i]=heapNodes[child];heapPriority[i]=heapPriority[child];i=child;
        }
        heapNodes[i]=lastNode;heapPriority[i]=lastPriority;
      }
      return top;
    }
    function canVisit(cell) {
      return !blocked[cell] &&
          (occupants[cell]===-1 || occupants[cell]===unit.id) &&
          (reservations[cell]===-1 || reservations[cell]===unit.id);
    }
    // Visit helper is allocated once per search rather than per expanded cell.
    function visit(next,from) {
      if(closed[next]===epoch || !canVisit(next))return;
      const candidate=pathCosts[from]+1;
      if(seen[next]!==epoch || candidate<pathCosts[next]){
        seen[next]=epoch;pathCosts[next]=candidate;
        pathParents[next]=from;
        push(next,candidate+heuristic(next)*1.0001);
      }
    }
    seen[start]=epoch;pathCosts[start]=0;pathParents[start]=-1;
    push(start,heuristic(start));
    while(heapSize){
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
      if(x>0)visit(n-1,n);
      if(x<GRID-1)visit(n+1,n);
      if(z>0)visit(n-GRID,n);
      if(z<GRID-1)visit(n+GRID,n);
    }
    return [];
  }
  function acceptPath(unit,path) {
    const oldPlans=unit.plans;
    searches++; if(oldPlans>0)replans++;
    else initialRoutesRemaining--;
    unit.plans++;unit.wait=0;unit.path=path;unit.at=0;
    if(path.length<2){
      unit.path=[];unit.retry=0.30+(unit.id%9)*0.045;
      if(unit.cell===unit.goal)unit.arrived=true;
      return false;
    }
    unit.retry=0;
    return true;
  }
  function planForImmediate(unit) {
    if(unit.next!==-1 || unit.arrived || unit.dead || unit.hold)return false;
    return acceptPath(unit,findPath(unit));
  }
  function planFor(unit) {
    if(!nativeNavigation)return planForImmediate(unit);
    if(unit.next!==-1 || unit.arrived || unit.navTicket || unit.dead || unit.hold)return false;
    // Worker captures an immutable navigation snapshot; route application
    // checks that the unit is still at the request's start and target.
    const token=nativeNavigation.request(unit.cell,unit.goal,unit.plans>0);
    unit.navTicket=token;
    nativeTickets.set(token,{id:unit.id,start:unit.cell,goal:unit.goal});
    return true;
  }
  const units=[],soldierLights=[];
  const matrices=new Float32Array(TOTAL*16);
  const lightData=new Float32Array(SOLDIERS*8);
  const lightColors=[new THREE.Color(0xffbc88),new THREE.Color(0x94c5ff)];
  let arrivals=0,planningCursor=0,simFrames=0,initialRoutesRemaining=SOLDIERS;
  const urgentPlans=[],queuedUrgent=new Uint8Array(SOLDIERS);
  function requestUrgentPlan(unit) {
    if(!queuedUrgent[unit.id]){
      queuedUrgent[unit.id]=1;
      urgentPlans.push(unit.id);
    }
  }
  for(let team=0;team<2;team++)for(let i=0;i<PER_ARMY;i++){
    // Two-spaced formations leave a free cell between soldiers: physically
    // viable queues that can get around one another without spawning overlaps.
    const column=i%20,row=(i/20)|0;
    const sx=team===0?10+column*2:349-column*2;
    const sz=90+row*3;
    // Destinations are distinct and not initially occupied by enemy spawns.
    const tx=team===0?285+column:74-column, tz=sz;
    const id=team*PER_ARMY+i,cell=gridIndex(sx,sz),goal=gridIndex(tx,tz);
    if(blocked[cell]||occupants[cell]!==-1||blocked[goal])
      throw new Error('Invalid soldier start/goal '+id);
    occupants[cell]=id;
    const unit={id,team,index:i,cell,goal,next:-1,progress:0,
      path:[],at:0,plans:0,wait:0,retry:0,arrived:false,navTicket:0,
      x:toWorld(sx),z:toWorld(sz),startX:toWorld(sx),startZ:toWorld(sz),
      startCell:cell,initialGoal:goal,
      yaw:team===0?1.57:-1.57,speed:10.5+(i%5)*0.35,
      armor:15,dead:false,deathTime:0,targetId:-1,hold:false,
      returning:false,attackTime:0,hitTime:0,attackCooldown:0.18+(i%13)*0.055,
      chaseTime:0,attacks:0,kills:0};
    units.push(unit);
    const lamp=new THREE.SpotLight(lightColors[team],4.0,LIGHT_RADIUS,Math.PI/3,0.25,1.5);
    lamp.name=(team===0?'Red':'Blue')+' spotlight '+i;
    lamp.castShadow=true;
    lamp.shadow.mapSize.set(256,256);lamp.shadow.bias=-0.0008;
    lamp.position.set(unit.x+LIGHT_OFFSET_X,LIGHT_HEIGHT,unit.z+LIGHT_OFFSET_Z);
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


  // ══════ Reusable stress-test melee AI (no separate JS object per strike) ══════
  // Health: 15 armor points, front hit = 3 (5 strikes), side = 5 (3),
  // rear = 15 (instant kill). Mixed-angle damage adds up on one health pool.
  const MELEE_RANGE=5.25, ACQUIRE_RANGE=105, MELEE_RANGE_SQ=MELEE_RANGE*MELEE_RANGE;
  const living=[PER_ARMY,PER_ARMY],hitAngles=[0,0,0];
  let battleStarted=false,battleFinished=false,winner=-1,battleSeconds=0;
  let attackCount=0,deathCount=0,engagedCount=0,combatScanCursor=0;
  let combatSoundBudget=0;
  function battleSound(name,unit,volume=0.55){
    if(!nativeAudio || combatSoundBudget<1)return;
    combatSoundBudget-=1;
    nativeAudio.play(name,unit.x,0,unit.z,volume,true,false);
  }
  function cancelRoute(unit){
    if(nativeNavigation && unit.navTicket){
      nativeNavigation.cancel(unit.navTicket);
      nativeTickets.delete(unit.navTicket);unit.navTicket=0;
    }
    unit.path=[];unit.at=0;unit.wait=0;unit.retry=0;
    queuedUrgent[unit.id]=0;
  }
  function setCombatGoal(unit,goal){
    if(unit.dead || unit.cell===goal || goal<0 || unit.goal===goal)return false;
    cancelRoute(unit);
    unit.goal=goal;unit.arrived=false;unit.hold=false;
    // If already moving along an edge, finish that reservation before
    // requesting a new path. Unit and tile ownership remain unchanged.
    if(unit.next===-1)requestUrgentPlan(unit);
    return true;
  }
  function faceToward(unit,target,dt){
    const desired=Math.atan2(target.x-unit.x,target.z-unit.z);
    let delta=((desired-unit.yaw+Math.PI*3)%(Math.PI*2))-Math.PI;
    const turn=Math.min(Math.abs(delta),dt*3.8);
    unit.yaw+=Math.sign(delta)*turn;
  }
  function strikeDamage(defender,attacker){
    const dx=attacker.x-defender.x,dz=attacker.z-defender.z;
    const distance=Math.hypot(dx,dz)||1;
    const dot=(Math.sin(defender.yaw)*dx+Math.cos(defender.yaw)*dz)/distance;
    if(dot>=0.5){hitAngles[0]++;return 3;} // FRONT: five hits
    if(dot<=-0.5){hitAngles[2]++;return 15;} // REAR: one hit
    hitAngles[1]++;return 5;               // SIDE: three hits
  }
  function killSoldier(defender,attacker){
    if(defender.dead)return;
    defender.dead=true;defender.deathTime=0;defender.armor=0;
    defender.hold=true;defender.arrived=true;defender.targetId=-1;
    cancelRoute(defender);
    // Release reservations/occupancy; corpses remain visible but have no
    // collision and do not prevent other agents returning to spawn.
    if(defender.next!==-1){
      if(reservations[defender.next]===defender.id)
        reservations[defender.next]=-1;
      defender.next=-1;defender.progress=0;
      defender.x=toWorld(defender.cell%GRID);
      defender.z=toWorld((defender.cell/GRID)|0);
    }
    if(occupants[defender.cell]===defender.id)
      occupants[defender.cell]=-1;
    occupancyRevision++;
    const lamp=soldierLights[defender.id];
    lamp.intensity=0;
    lightData[defender.id*8+7]=0;
    living[defender.team]--;deathCount++;
    attacker.kills++;
    battleSound('death',defender,0.9);
  }
  // Incremental fixed-grid spatial hash. We search only neighbouring
  // buckets, not all 500 enemies: the old full scan cost ~7ms CPU and
  // halved RTX 2080 SUPER FPS from 160 to 82 even without combat.
  const FIGHT_BUCKET_CELLS=12,FIGHT_BUCKETS=Math.ceil(GRID/FIGHT_BUCKET_CELLS);
  const bucketHead=new Int32Array(FIGHT_BUCKETS*FIGHT_BUCKETS);
  const bucketNext=new Int16Array(SOLDIERS);
  let bucketTimer=0;
  let redFront=-1e9,blueFront=1e9;
  function rebuildOpponentIndex() {
    bucketHead.fill(-1);
    redFront=-1e9;blueFront=1e9;
    for(const u of units){
      if(u.dead)continue;
      if(u.team===0)redFront=Math.max(redFront,u.x);
      else blueFront=Math.min(blueFront,u.x);
      const gx=u.cell%GRID,gz=(u.cell/GRID)|0;
      const index=((gz/FIGHT_BUCKET_CELLS)|0)*FIGHT_BUCKETS+
                    ((gx/FIGHT_BUCKET_CELLS)|0);
      bucketNext[u.id]=bucketHead[index];
      bucketHead[index]=u.id;
    }
    bucketTimer=0;
  }
  function nearestEnemy(unit){
    let best=-1,bestD=ACQUIRE_RANGE*ACQUIRE_RANGE;
    const gx=unit.cell%GRID,gz=(unit.cell/GRID)|0;
    const bx=(gx/FIGHT_BUCKET_CELLS)|0;
    const bz=(gz/FIGHT_BUCKET_CELLS)|0;
    // Radius 4 buckets conservatively covers the 105-world-unit radius
    // even when a soldier is crossing a cell boundary.
    for(let z=Math.max(0,bz-4);z<=Math.min(FIGHT_BUCKETS-1,bz+4);z++){
      for(let x=Math.max(0,bx-4);x<=Math.min(FIGHT_BUCKETS-1,bx+4);x++){
        for(let id=bucketHead[z*FIGHT_BUCKETS+x];id!==-1;id=bucketNext[id]){
          const other=units[id];
          if(other.team===unit.team||other.dead)continue;
          const dx=other.x-unit.x,dz=other.z-unit.z;
          const d=dx*dx+dz*dz;
          if(d<bestD){bestD=d;best=id;}
        }
      }
    }
    return best;
  }
  rebuildOpponentIndex();
  function freeAdjacentGoal(unit,enemy){
    const ex=enemy.cell%GRID,ez=(enemy.cell/GRID)|0;
    const ux=unit.cell%GRID,uz=(unit.cell/GRID)|0;
    let best=-1,bestDist=1e12;
    // Prefer an unobstructed neighbor, never the tile occupied by a unit.
    for(let dz=-3;dz<=3;dz++)for(let dx=-3;dx<=3;dx++){
      if(Math.abs(dx)+Math.abs(dz)<1 || Math.abs(dx)+Math.abs(dz)>4)continue;
      const gx=ex+dx,gz=ez+dz;
      if(gx<1||gz<1||gx>=GRID-1||gz>=GRID-1)continue;
      const tile=gridIndex(gx,gz);
      if(blocked[tile] || (occupants[tile]!==-1&&occupants[tile]!==unit.id) ||
         (reservations[tile]!==-1&&reservations[tile]!==unit.id))continue;
      const cost=(gx-ux)**2+(gz-uz)**2+((dx*dx+dz*dz)*0.4);
      if(cost<bestDist){bestDist=cost;best=tile;}
    }
    return best;
  }
  function startReturnToSpawn(){
    if(battleFinished)return;
    battleFinished=true;winner=living[0]>0?0:(living[1]>0?1:-1);
    for(const unit of units){
      if(unit.dead)continue;
      unit.targetId=-1;unit.hold=false;unit.returning=true;
      unit.attackTime=0;unit.attackCooldown=0;
      if(unit.cell===unit.startCell) {
        cancelRoute(unit);unit.goal=unit.startCell;unit.arrived=true;
      } else setCombatGoal(unit,unit.startCell);
    }
  }
  function updateBattle(dt) {
    if(dt<=0)return;
    battleSeconds+=dt;
    bucketTimer+=dt;
    if(bucketTimer>=0.22)rebuildOpponentIndex();
    // When the opposing army fronts are farther apart than acquisition
    // range, there cannot be a strike or target in this frame. No reason to
    // scan 1000 fighters or write the same zero animation data 60x/second.
    // F12 staging updates the bounds immediately, so combat still starts.
    if(!battleStarted && !battleFinished &&
       living[0]===PER_ARMY && living[1]===PER_ARMY &&
       blueFront-redFront>ACQUIRE_RANGE)return;
    combatSoundBudget=Math.min(3,combatSoundBudget+dt*6);
    // Offset work across frames; one search/candidate update per soldier
    // roughly every 16 frames, even with 1000 agents.
    for(let j=0;j<64;j++){
      const unit=units[combatScanCursor];
      combatScanCursor=(combatScanCursor+1)%SOLDIERS;
      if(unit.dead||unit.returning||battleFinished)continue;
      const previous=unit.targetId>=0?units[unit.targetId]:null;
      if(previous?.dead)unit.targetId=-1;
      const best=nearestEnemy(unit);
      if(best>=0){
        if(unit.targetId<0)unit.targetId=best;
        else {
          const current=units[unit.targetId],other=units[best];
          const oldSq=(current.x-unit.x)**2+(current.z-unit.z)**2;
          const newSq=(other.x-unit.x)**2+(other.z-unit.z)**2;
          if(newSq<oldSq*0.62)unit.targetId=best;
        }
      }
    }
    engagedCount=0;
    for(const unit of units){
      if(unit.dead){
        unit.deathTime=Math.min(1,unit.deathTime+dt/0.7);
      }else{
        unit.hitTime=Math.max(0,unit.hitTime-dt/0.28);
        unit.attackTime=Math.max(0,unit.attackTime-dt/0.36);
        unit.attackCooldown-=dt;
        if(!unit.returning && !battleFinished){
          const target=unit.targetId<0?null:units[unit.targetId];
          if(target && !target.dead){
            const dx=target.x-unit.x,dz=target.z-unit.z;
            const distSq=dx*dx+dz*dz;
            unit.chaseTime=Math.max(0,unit.chaseTime-dt);
            // Hold after the existing reserved cell edge completes. Never
            // interrupt a half-traversed edge or ignore collision tiles.
            if(distSq<=MELEE_RANGE_SQ){
              if(unit.next===-1){
                if(!unit.hold){cancelRoute(unit);unit.hold=true;}
                engagedCount++;
                faceToward(unit,target,dt);
                if(unit.attackCooldown<=0){
                  battleStarted=true;
                  unit.attackTime=1;
                  unit.attacks++;attackCount++;
                  unit.attackCooldown=0.76+((unit.id*7)%13)*0.033;
                  battleSound('swing',unit,0.35);
                  target.armor-=strikeDamage(target,unit);
                  target.hitTime=1;
                  battleSound('hit',target,0.55);
                  if(target.armor<=0)killSoldier(target,unit);
                }
              }
            }else if(unit.next===-1){
              if(unit.hold){
                unit.hold=false;
                unit.chaseTime=0;
              }
              if(unit.chaseTime<=0){
                const goal=freeAdjacentGoal(unit,target);
                if(goal>=0 && goal!==unit.cell &&
                   (unit.goal!==goal || unit.arrived))
                  setCombatGoal(unit,goal);
                unit.chaseTime=0.75+(unit.id%9)*0.055;
              }
            }
          }else if(unit.targetId>=0){
            unit.targetId=-1;unit.hold=false;
            if(!unit.returning)setCombatGoal(unit,unit.initialGoal);
          }
        }
      }
      const c=unit.id*4;
      combatData[c]=unit.attackTime>0?Math.sin((1-unit.attackTime)*Math.PI):0;
      combatData[c+1]=unit.hitTime;
      combatData[c+2]=unit.deathTime;
      combatData[c+3]=unit.hold?1:0;
    }
    if(!battleFinished && (living[0]===0 || living[1]===0))
      startReturnToSpawn();
  }
  // F12 fast battle fixture. Move 48 per side into a clear mid-map arena;
  // all other soldiers continue their original A* battle and remain untouched.
  function quickBattle(){
    if(battleStarted||battleFinished)return false;
    const selected=[];
    function relocate(unit,centerX,centerZ){
      cancelRoute(unit);
      if(unit.next!==-1){
        if(reservations[unit.next]===unit.id)reservations[unit.next]=-1;
        unit.next=-1;unit.progress=0;
      }
      if(occupants[unit.cell]===unit.id)occupants[unit.cell]=-1;
      for(let radius=0;radius<=20;radius++)
        for(let dz=-radius;dz<=radius;dz++)
          for(let dx=-radius;dx<=radius;dx++){
            if(Math.max(Math.abs(dx),Math.abs(dz))!==radius)continue;
            const gx=centerX+dx,gz=centerZ+dz;
            if(gx<2||gz<2||gx>=GRID-2||gz>=GRID-2)continue;
            const pos=gridIndex(gx,gz);
            if(blocked[pos]||occupants[pos]!==-1||reservations[pos]!==-1)continue;
            unit.cell=pos;unit.x=toWorld(gx);unit.z=toWorld(gz);
            occupants[pos]=unit.id;unit.goal=unit.initialGoal;
            unit.arrived=false;unit.hold=false;unit.targetId=-1;
            unit.chaseTime=0;occupancyRevision++;
            selected.push(unit.id);
            return true;
          }
      throw new Error('No clear battle staging cell');
    }
    for(let i=0;i<48;i++){
      relocate(units[i],176,177);
      relocate(units[PER_ARMY+i],181,177);
    }
    rebuildOpponentIndex(); // refresh hash after the immediate teleport
    for(const id of selected){
      const unit=units[id];
      unit.targetId=nearestEnemy(unit);
      if(unit.targetId<0)throw new Error('Fast battle lacks a nearby enemy');
      requestUrgentPlan(unit);
    }
    return true;
  }
  globalThis.__nativeThreeQuickBattle=quickBattle;
  globalThis.__nativeThreeCombatFrame=()=>combatData;
  globalThis.__nativeThreeBattleStatus=()=>({
    aliveRed:living[0],aliveBlue:living[1],deaths:deathCount,
    hits:hitAngles[0]+hitAngles[1]+hitAngles[2],
    frontHits:hitAngles[0],sideHits:hitAngles[1],rearHits:hitAngles[2],
    attacks:attackCount,engaged:engagedCount,started:battleStarted,
    finished:battleFinished,winner,
    returning:units.filter(u=>!u.dead&&u.returning&&!u.arrived).length,
    returned:units.filter(u=>!u.dead&&u.returning&&u.arrived).length
  });
  globalThis.__nativeThreeBattleInspect=(id)=>{
    const u=units[id];
    return u?{armor:u.armor,dead:u.dead,position:[u.x,u.z],
      targetId:u.targetId,kills:u.kills,returning:u.returning,
      returned:u.returning&&u.arrived,deathTime:u.deathTime,
      attacks:u.attacks,yaw:u.yaw,cell:u.cell}:null;
  };
  globalThis.__nativeThreeBattleFace=(id,yaw)=>{
    const u=units[id];
    if(!u||!Number.isFinite(yaw)||u.dead)return false;
    u.yaw=yaw;return true;
  };
  globalThis.__nativeThreeTestStrike=(attackerId,defenderId)=>{
    const attacker=units[attackerId],defender=units[defenderId];
    if(!attacker||!defender||attacker.dead||defender.dead||attacker.team===defender.team)return false;
    defender.armor-=strikeDamage(defender,attacker);
    defender.hitTime=1;
    if(defender.armor<=0)killSoldier(defender,attacker);
    return true;
  };

  function pollNativeNavigation() {
    if(!nativeNavigation)return;
    if(occupancyRevision!==lastNativeOccupancyRevision){
      for(const unit of units){
        nativeOccupied[unit.id]=unit.dead?-1:unit.cell;
        nativeReserved[unit.id]=unit.dead?-1:unit.next;
      }
      nativeNavigation.updateAgents(nativeOccupied,nativeReserved);
      lastNativeOccupancyRevision=occupancyRevision;
    }
    for(const response of nativeNavigation.poll(32)){
      const request=nativeTickets.get(response.token);
      if(!request)continue;
      nativeTickets.delete(response.token);
      const unit=units[request.id];
      if(unit.navTicket!==response.token)continue;
      unit.navTicket=0;
      if(unit.cell!==request.start || unit.goal!==request.goal ||
         unit.next!==-1 || unit.arrived || unit.dead || unit.hold){
        requestUrgentPlan(unit);
        continue;
      }
      const path=response.status===0 ? response.cells : [];
      acceptPath(unit,path);
    }
  }
  function planPending(dt) {
    pollNativeNavigation();
    // New movement orders and released collisions cannot wait behind 1000
    // first-time route requests. Defer busy units without losing their ticket.
    let budget=MAX_PLANS_PER_FRAME;
    // Reserve at least 3 of 4 slots for never-planned soldiers until the
    // full 1000-agent formation has a first route. Prevents replan starvation.
    const urgentQuota=initialRoutesRemaining>0?1:MAX_PLANS_PER_FRAME;
    let urgentUsed=0;
    for(let attempts=urgentPlans.length;attempts>0 &&
        budget>0 && urgentUsed<urgentQuota;attempts--){
      const id=urgentPlans.shift(),unit=units[id];
      if(unit.next!==-1||unit.retry>0||unit.navTicket){
        urgentPlans.push(id);
        continue;
      }
      queuedUrgent[id]=0;
      if(unit.arrived||unit.dead||unit.hold||unit.path.length>1)continue;
      planFor(unit);budget--;urgentUsed++;
    }
    // The remaining slots are fair round-robin requests from all soldiers.
    for(let checked=0;checked<SOLDIERS && budget>0;checked++){
      const unit=units[planningCursor];
      planningCursor=(planningCursor+1)%SOLDIERS;
      if(unit.arrived||unit.dead||unit.hold||unit.next!==-1||unit.path.length>1||unit.retry>0||
         unit.navTicket||queuedUrgent[unit.id])continue;
      planFor(unit);budget--;
    }
  }
  function updateSoldiers(dt){
    dt=Math.min(0.5,Math.max(0,Number(dt)||0));
    simFrames++;
    // Retry clocks progress even for soldiers who cannot currently find a route.
    for(const unit of units)if(unit.retry>0){
      unit.retry=Math.max(0,unit.retry-dt);
      if(unit.retry===0 && unit.path.length<2 && !unit.arrived)
        requestUrgentPlan(unit);
    }
    if(dt>0)planPending(dt);
    // Rotate priority every frame to avoid permanent starvation.
    const first=simFrames%SOLDIERS;
    for(let j=0;j<SOLDIERS;j++){
      const unit=units[(j+first)%SOLDIERS];
      let distance=unit.dead||unit.hold?0:unit.speed*dt,segments=0;
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
          ++occupancyRevision;
          unit.next=next;unit.progress=0;unit.wait=0;
        }
        const remaining=CELL-unit.progress;
        const step=Math.min(distance,remaining);
        unit.progress+=step;distance-=step;
        // Extract integer coordinates without allocating two JS arrays per unit.
        const sx=unit.cell%GRID,sz=(unit.cell/GRID)|0;
        const tx=unit.next%GRID,tz=(unit.next/GRID)|0;
        const t=unit.progress/CELL;
        unit.x=toWorld(sx)+(toWorld(tx)-toWorld(sx))*t;
        unit.z=toWorld(sz)+(toWorld(tz)-toWorld(sz))*t;
        // A* grid waypoints may turn 90 degrees instantly. The collision
        // path still follows exact cells, but the visual facing rotates at
        // a bounded angular rate so the nearby model doesn't twitch at each
        // waypoint. The native renderer additionally interpolates this pose.
        const desiredYaw=Math.atan2(tx-sx,tz-sz);
        const yawDelta=Math.atan2(Math.sin(desiredYaw-unit.yaw),
                                  Math.cos(desiredYaw-unit.yaw));
        const maxTurn=dt*9.0; // ~0.17 s for a 90 degree walking turn
        unit.yaw+=Math.max(-maxTurn,Math.min(maxTurn,yawDelta));
        if(unit.progress>=CELL-0.00001){
          // The occupied and reserved tiles are updated atomically.
          if(occupants[unit.cell]!==unit.id ||
             reservations[unit.next]!==unit.id ||
             occupants[unit.next]!==-1)
            throw new Error('Soldier occupancy conflict '+unit.id);
          occupants[unit.cell]=-1;
          occupants[unit.next]=unit.id;
          reservations[unit.next]=-1;
          ++occupancyRevision;
          unit.cell=unit.next;unit.next=-1;unit.progress=0;
          unit.at++;segments++;
          if(unit.cell===unit.goal){unit.arrived=true;arrivals++;break;}
        }
      }
      put(unit.team===0?red:blue,unit.index,unit.x,unit.z,unit.yaw);
      const base=unit.id*8,lamp=soldierLights[unit.id];
      lamp.position.x=unit.x+LIGHT_OFFSET_X;lamp.position.z=unit.z+LIGHT_OFFSET_Z;
      lamp.target.position.x=unit.x;lamp.target.position.z=unit.z;
      lightData[base]=lamp.position.x;lightData[base+2]=lamp.position.z;
      lightData[base+7]=unit.dead?0:lamp.intensity;
    }
    red.instanceMatrix.needsUpdate=true;
    blue.instanceMatrix.needsUpdate=true;
  }
  updateSoldiers(0); // Creates no paths: planning only starts on actual frames.

  // All instanced meshes and parent Groups have identity world transforms.
  // Read the official Three.js instanceMatrix arrays directly, without 500
  // getMatrixAt + premultiply operations or a forced full Scene traversal.
  scene.updateMatrixWorld(true); // initialization only
  matrices.set(treeBark.instanceMatrix.array,0); // static trees once
  function frame(dt=1/60){
    updateBattle(dt);
    updateSoldiers(dt);
    // Demonstrate spatial JS->native one-shots without 1000 overlapping
    // sources: two separate soldiers, at most ~3 footsteps per second.
    if(nativeAudio && dt>0) {
      footstepClock+=Math.min(0.2,dt);
      if(footstepClock>=0.65){
        footstepClock-=0.65;
        for(const id of [0,PER_ARMY]) {
          const u=units[id];
          if(!u.dead && (u.next!==-1 || u.progress>0))
            nativeAudio.play('step',u.x,0,u.z,0.65,true,false);
        }
      }
    }
    matrices.set(red.instanceMatrix.array,TREES*16);
    matrices.set(blue.instanceMatrix.array,(TREES+PER_ARMY)*16);
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
      instances:red.isInstancedMesh,
      battle:globalThis.__nativeThreeBattleStatus()};
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
  // All remaining 988 soldiers still start with no precomputed route.
  const sampleUnits=[0,59,159,259,359,459];
  function debugSegments() {
    const output=[];
    for(let team=0;team<2;team++)for(const index of sampleUnits){
      const unit=units[team*PER_ARMY+index];
      if(!unit.plans){
        if(nativeNavigation && unit.navTicket){
          nativeNavigation.cancel(unit.navTicket);
          nativeTickets.delete(unit.navTicket);
          unit.navTicket=0;
        }
        planForImmediate(unit); // F4 route preview is a synchronous diagnostic only
      }
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
    if(!Number.isInteger(id)||id<0||id>=SOLDIERS || units[id].dead ||
       !Number.isInteger(gx)||!Number.isInteger(gz)||
       gx<0||gx>=GRID||gz<0||gz>=GRID)return false;
    const target=gridIndex(gx,gz);
    if(blocked[target])return false;
    const unit=units[id];
    if(nativeNavigation && unit.navTicket){
      nativeNavigation.cancel(unit.navTicket);
      nativeTickets.delete(unit.navTicket);unit.navTicket=0;
    }
    unit.goal=target;unit.arrived=false;unit.path=[];unit.at=0;
    unit.wait=0;unit.retry=0;
    requestUrgentPlan(unit);
    return true;
  };
  // Explicit functional audio-bridge test triggered by F10 in native DX12.
  // Audible UI sound is intentionally non-spatial even in an overview camera.
  globalThis.__nativeThreeAudioTest=()=>nativeAudio
    ?nativeAudio.play('signal',0,0,0,0.75,false,false):false;
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