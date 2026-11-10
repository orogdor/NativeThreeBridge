# K73 / generic WebGL2 compatibility — implementation plan

## Verified baseline (10 Nov 2026)
- K73 v86: `orogdor/game`, commit `bdb6d6ad1dbdd78ecd0d2838b59955847aabda31`.
- Chrome / RTX 2080 Super / 1280×720 / High: title 105.74 FPS, base builder 112.74 FPS, first-person 88.90 FPS. This is a separate Chromium/ANGLE WebGL2 backend, not NativeThreeBridge.
- Pre-change V8 engine: K73 data/index.json and all JSON/BIN models loaded; 41 connected classic scripts were appended but neither evaluated nor sent load events; GFX/Game never initialized; native draws 0.
- Experimental generic dynamic-script loader now handles this first blocker. A real K73 headless CI smoke tests that it reaches (but **cannot yet pass**) the next blocker.
- Next blocker: `js/02_gfx.js` calls `canvas.getContext('webgl2')`, which the existing renderer intentionally returns `null`. **Do not fabricate a WebGL2 context**: a nonfunctional stub would allow startup but produce false rendering/FPS results.
- The static K73 code has about 563 `gl.method(...)` call sites and 76 distinct syntactic method names; some are false positives for local objects. K73 uses GLSL ES 3.00, VAOs, instanced draws, texture arrays, shadow-map framebuffers, multiple render targets and multisample resolves.
- The repository's old WebGL2 demos execute in a separate **browser**; they are not the engine's raw WebGL2 backend.

## Architecture and development checkpoints

### Checkpoint 1 — ordinary DOM script bootloader (implemented, pending full native validation)
Implement connected script insertion via `Node.insertBefore/appendChild`, load offline paths, guarantee ordered classic script execution for `async=false`, emit `load/error`, support inline classic and module scripts, protect initial parser-inserted scripts against duplicate execution. Keep a generic fixture for K73's `Promise.all(idx.code.map(loadScript))` pattern. Verify in Node, V8 and QuickJS, and confirm original Kuningriigid tests pass.

### Checkpoint 2 — real ANGLE / EGL OpenGL ES 3 backend (not implemented yet)
Use a pinned, licensed build of **ANGLE** (`libEGL.dll`, `libGLESv2.dll`, D3D11 backend) to create a real ES3 context. Avoid replacing the current Three.js → DX12 path: select the alternate backend only when a webapp asks for raw `webgl2`. Validate: an off-screen GLES3 triangle with compiled GLSL ES 3.00, pixel readback, texture upload, shader errors and resource teardown. Detect unsupported hardware and return a readable error. No WebView, Chrome subprocess, SwiftShader or silent CPU renderer.

### Checkpoint 3 — JS WebGL2 binding (not implemented yet)
Expose the full `WebGL2RenderingContext` surface required by K73 through V8, using native function calls into the ANGLE GL context. WebGL constants as numeric enums; opaque lifetime-tracked WebGLProgram, WebGLShader, WebGLBuffer, WebGLVertexArrayObject, WebGLFramebuffer, WebGLTexture, WebGLRenderbuffer and WebGLUniformLocation handles; typed array overloads, `null` and exception semantics. Initial priority:
1. createShader/shaderSource/compileShader/getShaderParameter/getShaderInfoLog; linkProgram/useProgram.
2. VAO/VBO/index buffers, vertexAttribPointer/IPointer, drawElements/Arrays and instancing.
3. GLSL uniforms, matrix uploads and standard GL state.
4. 2D texture images, array textures, mipmaps, sampler formats.
5. Framebuffer textures/renderbuffers, depth/shadow sampler and MSAA blit.
6. resize, getParameter/getExtension/getError, readPixels, destruction/recreation.

Never execute WebGL calls across a different thread without context ownership and ordering.

### Checkpoint 4 — native frame presentation (not implemented yet)
Expose ANGLE's rendered colour texture to the DX12 compositor with **supported cross-device or interop sharing**, not repeated readPixels every frame. Test pixel format, alpha, colour space and resize. Share/transfer GPU resources with proper fences. Continue to composite HTML/CSS through the independent Direct2D UI overlay at its own cadence. Preserve responsive pointer events and pointer lock.

### Checkpoint 5 — real K73 and Kuningriigid acceptance (not implemented yet)
All must pass before release:
- K73 loads 41 scripts and finishes boot without errors; real WebGL2 context is non-null.
- K73 title, base building and first-person views show **visible geometry**, textures, depth, shadows, and HUD; K73 play/pointer lock/keyboard/inventory work.
- 3 runs × 20 s each at same resolution, quality, camera and seed; log native and browser FPS, frame times p50/p95, JS CPU, GPU draw calls, present stalls and GPU time. Do **not** report engine FPS when there are zero GPU draws.
- Original Three.js Kuningriigid stone-age battle with a fixed seed, 192+192 troops, finishes unchanged and FPS does not regress >5% without justification.
- 5 retained backup versions; no overwrite of an installed EXE until explicit successful test and rollback.

## Implementation risks
- ANGLE generates shader bytecode/HLSL through its own drivers; compiling only HLSL or returning fake GL objects is insufficient.
- DX12↔D3D11 texture sharing, context/thread ownership, alpha, sRGB and stencil/depth are substantial integration tasks.
- K73's reliance on 2D canvas overlays and IndexedDB also requires targeted acceptance tests, but they are not the first boot blocker.
- A Chromium WebView fallback is deliberately excluded: it would make this a wrapper, not a native WebGL2-compatible engine.

## Sources
- ANGLE official Windows build and runtime documentation: https://github.com/google/angle/blob/main/doc/DevSetup.md
- ANGLE project: https://github.com/google/angle
- K73 source: https://github.com/orogdor/game
- Safe development PR: https://github.com/orogdor/NativeThreeBridge/pull/25
