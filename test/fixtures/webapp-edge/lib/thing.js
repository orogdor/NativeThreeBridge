import { helperColor } from './colors.js';
export function makeThing(THREE) {
  const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshNormalMaterial());
  mesh.userData.tint = helperColor; // proves the nested relative import ran
  return mesh;
}
