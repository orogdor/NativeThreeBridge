# Three.js-native scene structure

This is a **real Three.js scene graph**, running without DOM APIs.

`threejs-native/scene.mjs` uses the official `three` package with:
- `THREE.Scene`, `THREE.Group`, `THREE.Object3D`, `THREE.Mesh`
- `THREE.InstancedMesh`, `THREE.Matrix4`
- `THREE.PerspectiveCamera`, `THREE.MeshStandardMaterial`

The native adapter reads world matrices from 20 real Three.js instances. Actual model vertex data and textures are from the Kuningriigid GLBs built into the native EXE; the JS geometry objects currently carry native asset IDs. Loading GLTF geometry into JS BufferGeometry, general-purpose shader/material support, animations and dynamic tree population are not implemented yet.

**Critical:** the existing v0.5 EXE does **not** execute this JS module yet. The next milestone is linking a self-contained JavaScript engine (QuickJS-NG) into the DX12 executable and calling `__nativeThreeFrame` on every frame. Until that milestone is built and tested on Windows, this module is a separately verified component, not a complete browser-free Three.js runtime.

Run `npm install && npm test` on the development/build machine to verify the class instances and transformation data. No HTML or browser required.
