# NativeThreeBridge V8 backend (experimental)

This is a **real V8 JavaScript runtime**, hosted by bundled **Node.js 22**.
Node is a child process (not Chromium, not WebView, not an embedded V8 DLL).
No change to `game/index.html`, its JavaScript, or the original DX12 shader /
rendering and memory backends is needed.

`NativeThree-V8.exe` launches `v8-runtime/node.exe --experimental-vm-modules`
running `v8-runtime/worker.mjs`. The JavaScript-side browser shim is the same
`js/webapp-shim.js` and the same official Three.js r181 / NativeRenderer used
by the original QuickJS host. Binary IPC carries geometry uploads, instances,
render passes, input and resize events between V8 and the C++ DX12 renderer.

The QuickJS build remains `NativeThree-Game.exe`; the original forest battle
remains `NativeThree-Game.exe --battle`.

**Limitations:** Node's extra process and CPU copies introduce some overhead;
this is a compatibility and JavaScript-JIT experiment, not proven to be faster
for rendering. The original renderer's known unsupported textures, custom
shaders, HTML overlays, GLTF rendering, and other WebGL features stay unsupported.
Kuningriigid's complete boot with identical unmodified files still needs a
direct hardware test; passing the separate scene smoke does not prove that.

The test executable `WebappV8Smoke.exe` verifies that WebGLRenderer calls in
V8 produce geometries, instance uploads, and render passes via the C++ bridge.
