# NativeThreeBridge — 1000 trees, A* armies, and per-soldier spotlights

Native Windows DirectX 12 renderer using **real official Three.js in embedded QuickJS-NG**. No Chromium, Electron, WebView, browser, Node or Deno on the player's computer. This is a separate benchmark project; [Kuningriigid](https://github.com/orogdor/Kuningriigid) itself is unchanged.

## The new performance test

- **1000 original Kuningriigid Sapling pines**, positioned deterministically across a 64×64 forest grid.
- **Two opposing armies, 10 spearmen per side**, rendered using the original Kuningriigid `models-trellis-v262/odamees.glb` textured model (static mesh, no skeletal animation yet).
- **20 independently computed A* routes** using 4-direction navigation around occupied tree cells. No paths through tree obstacles. The units follow waypoints over time, turning to face their movement direction.
- Trees use two GPU-instanced draw batches (trunks and foliage). Both armies share their source mesh but are tinted red/blue and drawn in separate GPU batches.
- **1020 genuine Three.js instance Matrix4 transforms** are passed to the native DX12 renderer, using a 64 KiB GPU constant buffer. The 1000 static tree transforms are cached; only the 20 moving unit transforms are updated in JS per frame.
- JavaScript tests check 1000 distinct blocked cells, all A* routes, collision-free planned paths and movement over 180 frames. The Windows native smoke test verifies motion in embedded QuickJS as well.

## Shadow-casting soldier lights (new in v0.9)

Each of the 20 moving spearmen carries a **real Three.js `THREE.SpotLight`**, positioned 9.5 world units above the soldier and aimed straight down. The red army gets warm amber illumination; the blue army gets cool blue illumination. Spotlights and their targets follow each soldier's A* movement on every JavaScript frame.

The native QuickJS bridge exports **20 light records** in addition to the 1020 Three.js instance matrices. The DX12 renderer now allocates a **20-layer 256×256 D32 shadow-map texture array** (one depth slice per light). For each light, it renders depth silhouettes of the 1000 trees and 20 soldiers, using the pine foliage texture's alpha mask so the foliage does not become a solid rectangular shadow. Its forward pixel shader accumulates up to 20 localized spotlights and tests the corresponding shadow depth layer.

The implementation is deliberately a real shadow-map pipeline, **not painted dark blobs**. The 20 additional depth passes can lower performance, especially on low-end GPUs. The prototype still waits on a fence every frame and is not yet optimized to production quality. The shadow map HLSL compilation is verified separately in Windows CI; actual GPU shadow appearance and FPS on the user's computer require a manual test.

## Download / launch / customize

[Download Windows x64 Releases](https://github.com/orogdor/NativeThreeBridge/releases/latest). Extract the complete ZIP to a writable folder.

```text
NativeThree-Updater.exe    checks GitHub Releases for updated game EXE + scene.js
NativeThree-Game.exe       standalone native DX12 + QuickJS-NG + Three.js runtime
game/scene.js              editable 1000-tree / two-army A* pathfinding test
```

Start `NativeThree-Game.exe` directly to skip the update check. Or start `NativeThree-Updater.exe` to download only changed game/scene files (independent SHA-256 hashes) and launch the game. `NO-UPDATE.txt` disables checking; `PRESERVE-SCENE.txt` protects local edits to `game/scene.js` from updates.

Left mouse drag: orbit. Mouse wheel: zoom. Space: pause. Esc: close. FPS is displayed in the window title.

**Limitations:** this is a native renderer prototype using true Three.js scene objects and matrix transforms, but it does **not** implement a generic Three.js `WebGLRenderer`, `GLTFLoader`, all materials/shaders, arbitrary dynamic geometry or animated skeletons. These model vertices and textures are bundled into the EXE during the GitHub Actions build. The A* paths are planned per soldier; dynamic unit-vs-unit avoidance, combat AI, and skeletal animations are not implemented. GitHub CI cannot verify visual GPU output on your PC.

Source GLBs: `assets/sapling-trees/pine_01/mid.glb` and `models-trellis-v262/odamees.glb` from the pinned Kuningriigid repo commit.
