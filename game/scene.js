// NativeThreeBridge: directly editable Three.js scene (no recompile needed).
// The official Three.js library is available as globalThis.THREE inside QuickJS.
// This is a supported subset of Three.js: Scene/Group/Mesh/InstancedMesh transforms.
// Asset geometry/texture are currently loaded by the DX12 renderer from the EXE.
(() => {
  'use strict';
  const scene = new THREE.Scene();
  scene.name = 'Kuningriigid kiviaeg – editable scene.js';
  scene.background = new THREE.Color(0x182538);

  const village = new THREE.Group();
  village.name = 'Kiviaja küla';
  scene.add(village);
  const woods = new THREE.Group();
  woods.name = 'Männid';
  scene.add(woods);

  const houseGeometry = new THREE.BufferGeometry();
  houseGeometry.userData.nativeMesh = 'house';
  const pineTrunkGeometry = new THREE.BufferGeometry();
  pineTrunkGeometry.userData.nativeMesh = 'pine-bark';
  const pineFoliageGeometry = new THREE.BufferGeometry();
  pineFoliageGeometry.userData.nativeMesh = 'pine-foliage';

  const houses = new THREE.InstancedMesh(
    houseGeometry, new THREE.MeshStandardMaterial({ roughness: 0.89 }), 10
  );
  houses.name = '10 Stone Age houses';
  village.add(houses);

  const trunks = new THREE.InstancedMesh(
    pineTrunkGeometry, new THREE.MeshStandardMaterial({ roughness: 0.93 }), 10
  );
  const crowns = new THREE.InstancedMesh(
    pineFoliageGeometry,
    new THREE.MeshStandardMaterial({ roughness: 0.93, alphaTest: 0.4, side: THREE.DoubleSide }),
    10
  );
  trunks.name = '10 Sapling pine trunks';
  crowns.name = '10 Sapling pine crowns';
  woods.add(trunks, crowns);

  const ground = new THREE.Mesh(
    new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: 0x405841 })
  );
  ground.userData.nativePrimitive = 'ground';
  scene.add(ground);

  const camera = new THREE.PerspectiveCamera(57, 1152 / 768, 0.1, 500);
  camera.position.set(40, 75, -65);
  camera.lookAt(0, 2, 0);
  scene.add(camera);

  const placement = new THREE.Object3D();
  for (let i = 0; i < 10; i++) {
    placement.position.set(((i % 5) - 2) * 6.8, 0, Math.floor(i / 5) * 6.5 - 14);
    placement.rotation.set(0, i * 0.075, 0);
    placement.scale.setScalar(1);
    placement.updateMatrix();
    houses.setMatrixAt(i, placement.matrix);

    placement.position.set(((i % 5) - 2) * 9, 0, Math.floor(i / 5) * 9 + 13);
    placement.rotation.set(0, i * 0.3, 0);
    placement.scale.setScalar(1);
    placement.updateMatrix();
    trunks.setMatrixAt(i, placement.matrix);
    crowns.setMatrixAt(i, placement.matrix);
  }
  houses.instanceMatrix.needsUpdate = true;
  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;

  const positions = new Float32Array(20 * 16);
  const local = new THREE.Matrix4();
  function writeWorldMatrices(mesh, start) {
    for (let i = 0; i < mesh.count; ++i) {
      mesh.getMatrixAt(i, local);
      local.premultiply(mesh.matrixWorld);
      positions.set(local.elements, (start + i) * 16);
    }
  }
  function frame(dt = 0) {
    // Any user-authored game logic changing Mesh/Group/InstancedMesh matrices
    // can run here. The native DX12 adapter consumes their real Matrix4 values.
    scene.updateMatrixWorld(true);
    writeWorldMatrices(houses, 0);
    writeWorldMatrices(trunks, 10);
    return positions;
  }
  globalThis.__nativeThreeFrame = frame;
  globalThis.__nativeThreeScene = scene;
  globalThis.__nativeThreeDiagnostics = () => ({
    scene: scene.isScene === true,
    group: village.isGroup === true,
    mesh: ground.isMesh === true,
    instances: houses.isInstancedMesh === true,
    houseCount: houses.count,
    treeCount: trunks.count,
    pineParts: [trunks.count, crowns.count],
    floats: frame().length,
  });
})();
