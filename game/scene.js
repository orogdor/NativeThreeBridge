// NativeThreeBridge native Windows Three.js benchmark:
// 1000 genuine Sapling pine instances and TWO pathfinding armies of 10 spearmen.
// Edit this file and launch NativeThree-Game.exe again; no browser or recompile.
(() => {
  'use strict';
  const GRID = 64, CELL = 3.0, TREES = 1000, PER_ARMY = 10, SOLDIERS = 20;
  const TOTAL = TREES + SOLDIERS; // 1020 Matrix4 values = 65,280B (< 64 KiB CBV limit).
  const scene = new THREE.Scene();
  scene.name = 'Kuningriigid: 1000 pines and two A* armies';
  scene.background = new THREE.Color(0x1c2a3c);
  const forest = new THREE.Group();
  forest.name = '1000 tree forest';
  const armies = new THREE.Group();
  armies.name = 'Two moving armies';
  scene.add(forest, armies);

  const treeGeometry = new THREE.BufferGeometry();
  treeGeometry.userData.nativeMesh = 'pine';
  const soldierGeometry = new THREE.BufferGeometry();
  soldierGeometry.userData.nativeMesh = 'models-trellis-v262/odamees.glb';
  const treeBark = new THREE.InstancedMesh(treeGeometry,
    new THREE.MeshStandardMaterial({ roughness: 0.9 }), TREES);
  const treeNeedles = new THREE.InstancedMesh(treeGeometry,
    new THREE.MeshStandardMaterial({ alphaTest: 0.4, side: THREE.DoubleSide }), TREES);
  treeBark.name = '1000 pine trunks';
  treeNeedles.name = '1000 pine crowns';
  forest.add(treeBark, treeNeedles);

  const red = new THREE.InstancedMesh(soldierGeometry,
    new THREE.MeshStandardMaterial({ color: 0xf4a9a9 }), PER_ARMY);
  const blue = new THREE.InstancedMesh(soldierGeometry,
    new THREE.MeshStandardMaterial({ color: 0x9acaff }), PER_ARMY);
  red.name = 'Red army: 10 spearmen';
  blue.name = 'Blue army: 10 spearmen';
  armies.add(red, blue);

  const ground = new THREE.Mesh(new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({ color: 0x405742 }));
  ground.name = 'Ground'; ground.userData.nativePrimitive = 'ground';
  scene.add(ground);
  const camera = new THREE.PerspectiveCamera(57, 1152 / 768, 0.1, 1000);
  camera.position.set(100, 160, -200);
  camera.lookAt(0, 0, 0);
  scene.add(camera);

  let rngState = 0x5f3759df;
  function random() {
    rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
    return rngState / 4294967296;
  }
  const blocked = new Uint8Array(GRID * GRID);
  const toIndex = (x, z) => z * GRID + x;
  const inGrid = (x, z) => x >= 0 && x < GRID && z >= 0 && z < GRID;
  const wx = x => (x - (GRID - 1) / 2) * CELL;
  const wz = z => (z - (GRID - 1) / 2) * CELL;
  const transform = new THREE.Object3D();
  function matrixAt(mesh, n, x, z, yaw = 0, scale = 1) {
    transform.position.set(x, 0, z);
    transform.rotation.set(0, yaw, 0);
    transform.scale.setScalar(scale);
    transform.updateMatrix();
    mesh.setMatrixAt(n, transform.matrix);
  }

  // Keep both staging areas clear. The forest is deterministic across runs,
  // but otherwise distributed over the WHOLE map, not clustered in its centre.
  function staging(x, z) {
    return (x <= 10 && Math.abs(z - 19) < 7)
      || (x >= 53 && Math.abs(z - 44) < 7);
  }
  const treeCells = [];
  while (treeCells.length < TREES) {
    const x = Math.floor(random() * GRID), z = Math.floor(random() * GRID);
    const k = toIndex(x, z);
    if (blocked[k] || staging(x, z)) continue;
    blocked[k] = 1;
    treeCells.push([x, z]);
  }
  for (let i = 0; i < treeCells.length; i++) {
    const [x, z] = treeCells[i];
    // Small non-grid placement jitter, constrained to the occupied nav cell.
    const dx = (random() - 0.5) * CELL * 0.22;
    const dz = (random() - 0.5) * CELL * 0.22;
    const yaw = random() * Math.PI * 2;
    const scale = 0.81 + random() * 0.36;
    matrixAt(treeBark, i, wx(x) + dx, wz(z) + dz, yaw, scale);
    matrixAt(treeNeedles, i, wx(x) + dx, wz(z) + dz, yaw, scale);
  }
  treeBark.instanceMatrix.needsUpdate = true;
  treeNeedles.instanceMatrix.needsUpdate = true;

  // Real A* pathfinding on a 64x64 navigation grid, 4-neighbour connections.
  // A binary heap avoids sorting the entire open set for each expansion.
  function findPath(sx, sz, tx, tz) {
    const start = toIndex(sx, sz), goal = toIndex(tx, tz);
    if (!inGrid(sx, sz) || !inGrid(tx, tz) || blocked[start] || blocked[goal])
      return [];
    const costs = new Float32Array(GRID * GRID);
    const previous = new Int32Array(GRID * GRID);
    const closed = new Uint8Array(GRID * GRID);
    costs.fill(Infinity);
    previous.fill(-1);
    costs[start] = 0;
    const heap = [];
    function push(node, priority) {
      let i = heap.length;
      heap.push({ node, priority });
      while (i) {
        const parent = (i - 1) >> 1;
        if (heap[parent].priority <= priority) break;
        heap[i] = heap[parent]; i = parent;
      }
      heap[i] = { node, priority };
    }
    function pop() {
      const top = heap[0], tail = heap.pop();
      if (heap.length) {
        let i = 0;
        while (i * 2 + 1 < heap.length) {
          let child = i * 2 + 1;
          if (child + 1 < heap.length && heap[child + 1].priority < heap[child].priority) child++;
          if (heap[child].priority >= tail.priority) break;
          heap[i] = heap[child]; i = child;
        }
        heap[i] = tail;
      }
      return top.node;
    }
    const heuristic = n => Math.abs(n % GRID - tx) + Math.abs(Math.floor(n / GRID) - tz);
    push(start, heuristic(start));
    while (heap.length) {
      const node = pop();
      if (closed[node]) continue;
      if (node === goal) {
        const path = [];
        let cur = node;
        while (cur !== -1) {
          path.push(cur);
          if (cur === start) break;
          cur = previous[cur];
        }
        path.reverse();
        return path;
      }
      closed[node] = 1;
      const x = node % GRID, z = Math.floor(node / GRID);
      const neighbours = [x > 0 ? node - 1 : -1, x < GRID - 1 ? node + 1 : -1,
                          z > 0 ? node - GRID : -1, z < GRID - 1 ? node + GRID : -1];
      for (const next of neighbours) {
        if (next < 0 || closed[next] || blocked[next]) continue;
        const candidate = costs[node] + 1;
        if (candidate < costs[next]) {
          costs[next] = candidate;
          previous[next] = node;
          push(next, candidate + heuristic(next));
        }
      }
    }
    return [];
  }

  const units = [];
  const startsRed = [], startsBlue = [], goalsRed = [], goalsBlue = [];
  for (let i = 0; i < PER_ARMY; i++) {
    const col = i % 2, row = Math.floor(i / 2);
    startsRed.push([5 + col, 15 + row * 2]);
    startsBlue.push([58 - col, 40 + row * 2]);
    goalsRed.push([56 - col, 40 + row * 2]);
    goalsBlue.push([7 + col, 15 + row * 2]);
  }
  let searchCount = 0, searchFailures = 0, routeSum = 0, arrivals = 0;
  for (let army = 0; army < 2; army++) {
    for (let i = 0; i < PER_ARMY; i++) {
      const [x,z] = (army === 0 ? startsRed : startsBlue)[i];
      const [gx,gz] = (army === 0 ? goalsRed : goalsBlue)[i];
      const path = findPath(x,z,gx,gz);
      searchCount++;
      if (!path.length) searchFailures++;
      routeSum += path.length;
      const unit = {
        army, i, x:wx(x), z:wz(z), path, pathAt:0, speed:6.6 + (i % 3) * 0.35,
        initialX:wx(x), initialZ:wz(z), arrived:false, yaw:0, destination:[gx,gz],
      };
      units.push(unit);
    }
  }

  function updateSoldiers(dt) {
    dt = Math.max(0, Math.min(0.06, Number(dt) || 0));
    for (const unit of units) {
      let distance = unit.speed * dt; // cell units per second
      // Follow each A* waypoint; never step diagonally through a blocked tile.
      while (distance > 0.0001 && unit.pathAt + 1 < unit.path.length) {
        const n = unit.path[unit.pathAt + 1];
        const tx = wx(n % GRID), tz = wz(Math.floor(n / GRID));
        const dx = tx - unit.x, dz = tz - unit.z;
        const remaining = Math.sqrt(dx * dx + dz * dz);
        const step = Math.min(remaining, distance);
        if (remaining > 0.00001) {
          unit.x += (dx / remaining) * step;
          unit.z += (dz / remaining) * step;
          unit.yaw = Math.atan2(dx, dz);
          distance -= step;
        } else distance = 0;
        if (remaining <= step + 0.00001) unit.pathAt++;
      }
      if (unit.path.length && unit.pathAt === unit.path.length - 1 && !unit.arrived) {
        unit.arrived = true;
        arrivals++;
      }
      matrixAt(unit.army === 0 ? red : blue, unit.i,
        unit.x, unit.z, unit.yaw, 1);
    }
    red.instanceMatrix.needsUpdate = true;
    blue.instanceMatrix.needsUpdate = true;
  }
  updateSoldiers(0);

  const matrices = new Float32Array(TOTAL * 16);
  const current = new THREE.Matrix4();
  function writeMatrices(mesh, offset) {
    for (let i=0; i<mesh.count; i++) {
      mesh.getMatrixAt(i, current);
      current.premultiply(mesh.matrixWorld);
      matrices.set(current.elements, (offset+i)*16);
    }
  }
  // Pine bark and foliage are static: read 1000 world transforms ONCE.
  // Each frame only the 20 moving soldiers need new world matrix copies.
  scene.updateMatrixWorld(true);
  writeMatrices(treeBark, 0);
  function frame(dt = 1/60) {
    updateSoldiers(dt);
    scene.updateMatrixWorld(true);
    writeMatrices(red, TREES);
    writeMatrices(blue, TREES + PER_ARMY);
    return matrices;
  }
  function diagnostics() {
    return {
      scene:scene.isScene, group:forest.isGroup, mesh:ground.isMesh,
      instances:treeBark.isInstancedMesh,
      treeCount:treeBark.count, houseCount:0, armyCount:2,
      soldierCounts:[red.count,blue.count], unitCount:units.length,
      routes:searchCount, routeFailures:searchFailures, totalRouteCells:routeSum,
      arrived:arrivals, floats:matrices.length,
      moved:units.filter(u=>Math.abs(u.x-u.initialX)+Math.abs(u.z-u.initialZ)>0.2).length,
      treeCells:treeCells.length,
    };
  }
  globalThis.__nativeThreeScene = scene;
  globalThis.__nativeThreeFrame = frame;
  globalThis.__nativeThreeDiagnostics = diagnostics;
  globalThis.__nativeNavTest = () => ({
    size:GRID, trees:treeCells.map(c=>c.slice()),
    paths:units.map(u=>u.path.slice()),
    positions:units.map(u=>[u.x,u.z]),
    goals:units.map(u=>u.destination.slice()),
    blocked:Array.from(blocked),
    cellSize:CELL,
  });
})();