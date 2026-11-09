// Second module: checks that relative imports between game files work.
export function makeGround(THREE) {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x3c4a3e, roughness: 0.95 })
  );
  ground.rotation.x = -Math.PI / 2;
  return ground;
}

export function makeInstancedBlocks(THREE, columns, rows) {
  const geometry = new THREE.BoxGeometry(0.9, 1, 0.9);
  geometry.translate(0, 0.5, 0);
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const blocks = new THREE.InstancedMesh(geometry, material, columns * rows);
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  let i = 0;
  for (let x = 0; x < columns; x++) {
    for (let z = 0; z < rows; z++) {
      const height = 0.4 + ((x * 7 + z * 13) % 10) / 6;
      matrix.makeScale(1, height, 1).setPosition((x - columns / 2) * 1.6, 0, (z - rows / 2) * 1.6 - 9);
      blocks.setMatrixAt(i, matrix);
      blocks.setColorAt(i, color.setHSL((x + z) / (columns + rows), 0.6, 0.55));
      i++;
    }
  }
  blocks.instanceMatrix.needsUpdate = true;
  blocks.instanceColor.needsUpdate = true;
  return blocks;
}
