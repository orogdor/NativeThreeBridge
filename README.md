# NativeThreeBridge v0.11.0 — 10× larger forest

Native Windows DirectX 12 prototype using official Three.js within QuickJS-NG, without a browser, Chromium or WebView.

## New forest benchmark

- **1000 original Sapling pines**, ten times the 100-tree population in v0.10. The forest expands to an approximately 32×32 tree-placement lattice (1024 candidate locations, 24 omitted to leave exactly 1000), retaining the previous 3-cell tree spacing. The visible forest footprint is roughly ten times larger.
- **Two armies of 250 Kuningriigid spearmen**, for 500 moving units. All 500 still have independent A* paths through the forest.
- **500 real moving Three.js spotlights**, one per soldier, with warm/cool army colors.
- **16 real-time shadow maps** chosen from the 500 lights each frame; other nearby lights illuminate without a depth shadow.
- Navigation expanded from **64×64 to 160×160 cells**. Tree-occupied cells are blocked; soldiers move on passable routes.
- GPU instancing still draws pine bark, pine foliage, red soldiers, and blue soldiers in four draw batches plus the ground.
- DX12 world, camera and 16×16 tiled-light coverage enlarged to match the forest.

### Windows/DX12 memory change

1000 trees + 500 soldiers require **1500 Matrix4 transforms** (96,000 bytes). This is larger than one DirectX12 constant-buffer-view limit of 64 KiB, so the engine uses **two GPU CBVs**: 1000 static tree transforms (64,000 bytes) and 500 dynamic soldier transforms (32,000 bytes). Tree transforms are uploaded once; soldier matrices are updated per frame. This preserves real Three.js Scene/InstancedMesh transforms, rather than replacing them with hardcoded C++ positions.

## Download and update

Use the latest [NativeThreeBridge Windows GitHub Release](https://github.com/orogdor/NativeThreeBridge/releases/latest). Keep the ZIP layout:

    NativeThree-Updater.exe  – separate SHA-256 verified updater
    NativeThree-Game.exe     – standalone native DX12 + QuickJS-NG + Three.js
    game/scene.js            – independently editable forest/army pathfinding

Close the game and open the updater to check for changed EXE and scene.js files, or run the game EXE directly. If PRESERVE-SCENE.txt exists, it protects local game script changes; remove it to install the new forest scene. NO-UPDATE.txt disables update checks.

Mouse drag rotates the camera, mouse wheel zooms, Space pauses, Esc closes. FPS appears in the window title.

## Verification boundary

GitHub Actions checks actual Three.js instancing, 1000 tree placements, 500 A* routes, native QuickJS matrix export, C++/DX12 compilation and HLSL shader compilation. Graphical rendering, GPU FPS and shadow appearance still need testing on Windows hardware. This remains a limited Three.js-to-DX12 adapter, not a complete WebGLRenderer/GLTFLoader replacement.

Original unchanged source assets: Kuningriigid `models-trellis-v262/odamees.glb`, `assets/sapling-trees/pine_01/mid.glb`.
