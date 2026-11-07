# NativeThreeBridge v0.6.0

Native Windows DirectX 12 prototype with a real **Three.js scene graph running in an embedded JavaScript engine**. This is a separate project from Kuningriigid; the original game repository is unchanged.

## What is real in v0.6

- Three.js r181 is bundled into the executable and executed by embedded QuickJS-NG.
- JavaScript builds actual THREE.Scene, THREE.Group, THREE.Mesh, THREE.InstancedMesh, THREE.Object3D, THREE.Matrix4 and THREE.PerspectiveCamera objects.
- The C++ DX12 renderer reads twenty genuine world matrices from the Three.js objects **every frame**, not hardcoded native placement.
- The test renders 10 original Stone Age houses and 10 original Sapling pines from the Kuningriigid GLBs, with a GPU depth buffer, texturing, simple shading, and GPU instancing.
- The meshes and textures are converted and embedded at **build time**. No browser, WebGL, Chromium, WebView, Electron, Node.js or Deno is required on Windows to run the EXE.
- The Windows GitHub Actions build compiles MSVC + QuickJS-NG and runs a real embedded-JavaScript smoke test that validates world matrices before publishing.

## Download and run

Download NativeThreeBridge-Windows-x64.zip from [Releases](https://github.com/orogdor/NativeThreeBridge/releases/latest), extract it, open NativeThree-Launcher.exe for an update check, or NativeThree-DX12.exe directly.

Left mouse drag rotates the camera, mouse wheel zooms, Space pauses, Escape closes. FPS is displayed in the window title.

## How it is structured

Game JavaScript -> official Three.js scene graph -> embedded QuickJS-NG -> native C++ scene adapter -> Direct3D 12 GPU rendering.

- threejs-native/scene.mjs — source Three.js scene graph
- native-dx12/three_js_host.cpp — embedded JavaScript runtime and typed-array bridge
- native-dx12/NativeThree-DX12.cpp — Direct3D 12 renderer
- native-dx12/three_scene_smoke.cpp — runtime verification without the GPU
- tools/pack_kuningriigid.py — original GLB asset verification and resource packaging
- .github/workflows/native-threejs.yml — Windows build and release with smoke test

## Current limitations

**Not yet a drop-in engine for arbitrary Three.js games.** Scene graph transforms are genuine Three.js, but the BufferGeometry objects carry native IDs while vertex data/textures come from the pre-packed models in DX12. Dynamic user-provided BufferGeometry uploads, arbitrary materials/shaders, WebGLRenderer, WebGPURenderer, GLTFLoader, TextureLoader, browser DOM, advanced lights/shadows, skeletal animation, and UI event bridges are **not** supported yet.

Windows native JavaScript execution is verified by CI. The actual DX12 graphics output/FPS on your GPU is **not yet verified**.

To build locally, run BUILD-WINDOWS.bat from a Visual Studio x64 Native Tools Command Prompt with Python and Node/npm available for development only. The Windows game EXE needs neither.
