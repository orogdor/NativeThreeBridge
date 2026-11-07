# NativeThreeBridge — native Windows / DirectX 12 / Three.js

v0.7 introduces TWO independent executables plus an editable scene file:

```text
NativeThree-Updater.exe    # checks GitHub Releases and starts the game
NativeThree-Game.exe       # standalone native DX12 + QuickJS-NG + official Three.js
game/scene.js              # real editable THREE.Scene / THREE.InstancedMesh code
installed-version.txt
```

**NativeThree-Game.exe** runs directly without GitHub. **NativeThree-Updater.exe** checks `update-v2.txt`, compares SHA-256 for the game EXE and scene.js individually, downloads only changed files to staging, attempts transactional replacement with rollback, then launches the game. `--check-only` checks/updates without launching. `NO-UPDATE.txt` disables checks. `PRESERVE-SCENE.txt` protects your customized local scene.js from replacement.

v0.6 and older launchers cannot migrate automatically to this two-file layout; download and extract the v0.7 ZIP once. Updating the Updater EXE itself is currently manual via new ZIP.

## Actual Three.js classes

The Windows EXE embeds official Three.js r181 and QuickJS-NG. At runtime it reads **game/scene.js** from disk and creates real `THREE.Scene`, `THREE.Group`, `THREE.Mesh`, `THREE.InstancedMesh`, `THREE.Object3D`, `THREE.Matrix4` and `THREE.PerspectiveCamera` objects. Edit this script and restart the Game EXE to change instance transforms without recompiling C++. The native DX12 backend consumes the Three.js world matrices on every frame.

**This remains a limited renderer adapter, not a drop-in port of any Three.js game.** It currently renders only the pre-registered original 10 Kuningriigid Stone Age houses and 10 Sapling pines, with the GLB vertex data/textures built into the EXE. It does not yet implement arbitrary `BufferGeometry` GPU upload, `GLTFLoader`, general materials/shaders, animations, WebGLRenderer, WebGPURenderer, HTML or DOM. The script uses a global official `THREE` object (not runtime ES imports).

## Controls and build

Left-drag orbits the camera, wheel zooms, Space pauses, Escape quits. The DirectX projection multiplication has been corrected following the v0.6 near-horizon screenshot; this still requires visual testing on Windows hardware.

GitHub Actions builds both native binaries with MSVC, bundles Three.js at build time, verifies pinned GLBs from the Kuningriigid repository, and tests the QuickJS runtime's 20 instance matrices. The player's Windows computer requires neither Chromium, Electron, WebView, Deno, Node.js nor Python.

Source models in [orogdor/Kuningriigid](https://github.com/orogdor/Kuningriigid): `models-stone-lod-v244/house_far.glb` and `assets/sapling-trees/pine_01/mid.glb`. That repository remains unchanged.

[Windows downloads](https://github.com/orogdor/NativeThreeBridge/releases/latest)
