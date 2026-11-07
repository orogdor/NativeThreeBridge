# NativeThreeBridge v0.10.0 — 10×10 forest + 500 soldiers/lights

Windows-only native DirectX 12 prototype with official Three.js r181 inside embedded QuickJS-NG, no Chromium, Electron, WebView, browser, Node or Deno at runtime.

## Stress-test scene

- 10×10 forest: 100 original Kuningriigid Sapling pine GLBs on 100 distinct navigation tiles.
- Two opposing armies with 250 spearmen each: 500 real Kuningriigid odamees GLB instances.
- 500 real THREE.SpotLight objects, one moving above each soldier, with warm/red or cool/blue color.
- 500 individually calculated A* paths on a 64×64 navigation grid. Paths avoid tree obstacles; no combat or unit collision avoidance.
- 600 actual Three.js Matrix4 instance transforms go to DirectX 12 per frame. The static 100 tree transforms are cached.
- DX12 keeps all 500 dynamic lights but evaluates at most 16 nearest lights per 16×16 world-space illumination tile, preventing a 500-iteration pixel-shader loop.
- 16 active 256×256 shadow-map slices (eight selected lights per army), rather than 500 full depth passes per frame. All 500 lights are present in the JS scene but only the 16 selected lights cast real-time depth-map shadows that frame.
- Trees and armies use GPU instancing; pine foliage shadows retain the alpha cutout.

## Download and update

[Windows release ZIP](https://github.com/orogdor/NativeThreeBridge/releases/latest). Extract the entire ZIP keeping the game subdirectory:

    NativeThree-Updater.exe    independent SHA-256 GitHub updater
    NativeThree-Game.exe       separate native Three.js / QuickJS-NG / DX12 executable
    game/scene.js              editable 10×10 forest and 500-unit JS code
    installed-version.txt

Launch NativeThree-Game.exe without checking GitHub, or NativeThree-Updater.exe for independent per-file updates. NO-UPDATE.txt disables checking; PRESERVE-SCENE.txt protects locally modified scene.js. Close the game before updating. v0.7+ updater is compatible with this two-file layout.

Mouse drag rotates the camera; wheel zooms; Space pauses; Escape closes. FPS is in the title.

## Testing and limitations

GitHub Actions verifies JavaScript Three.js structure, 100 distinct tree tiles, 500 A* routes, 500 moving SpotLights, native QuickJS matrices, the MSVC Windows EXE build and the three HLSL shader entries.

Real GPU shadow appearance and FPS still require a Windows test. General Three.js WebGLRenderer, GLTFLoader, generic geometry uploads, all materials, full animations, HTML/DOM and UI remain unsupported.

Original pinned GLBs in the unchanged [Kuningriigid repository](https://github.com/orogdor/Kuningriigid): models-trellis-v262/odamees.glb and assets/sapling-trees/pine_01/mid.glb.
