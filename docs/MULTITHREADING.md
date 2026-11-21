# Multithreading in webapps (v0.33.0)

Applies to every webapp the engine runs; no game-specific code. JavaScript
is single-threaded as a language, so the engine cannot split one function
across cores. Two things make games wait less:

1. The engine moves its own work off the game's JavaScript thread.
2. Games get standard Web Workers, which run on other cores.

## What runs where

| Thread | Work |
| --- | --- |
| Page JavaScript (V8) | game logic, Three.js scene, DOM/CSS, `render()` packets |
| Web Worker × N (V8, one isolate each) | the scripts the game starts with `new Worker(...)` |
| File reads (2) | `fetch` of files ≥ 256 KB in the game folder |
| Image decode (up to 4) | PNG/JPEG/WebP → RGBA8 + mipmaps (WIC) |
| DX12 render worker | command recording, submit, Present (`NTB_ASYNC_RENDER`) |
| UI raster worker | Direct2D HTML/CSS raster (`NTB_ASYNC_UI`) |
| V8 platform pool | concurrent GC marking/sweeping, background compilation |

## Web Workers

Standard API, the same code runs in Chrome:

- `new Worker(url, { type: 'module' | 'classic', name })` with a game-folder
  path, `new URL('./w.js', import.meta.url)`, a `blob:` URL
  (`URL.createObjectURL(new Blob([code]))`, used by DRACOLoader and many
  libraries) or a `data:` URL.
- `postMessage(value, [transfer])`: structured clone. Transferred
  `ArrayBuffer`s move without copying (the sender's becomes detached).
  `SharedArrayBuffer` is shared memory; `Atomics.wait/notify` work in
  workers. Compiled `WebAssembly.Module`s can be posted.
- `worker.onmessage`, `onerror` (uncaught worker errors; `preventDefault()`
  stops the page log entry), `onmessageerror`, `terminate()`.
- Worker global scope: `self`, `postMessage`, `onmessage`/`addEventListener`,
  `close()`, `importScripts()` (classic workers), static and dynamic
  `import` (module workers, same import map and `three` as the page),
  `setTimeout/setInterval`, `fetch` inside the game folder, `console`
  (worker log lines go to the webapp log as `[worker name] ...`),
  `performance.now()`, `URL`, `TextEncoder/TextDecoder`, `atob/btoa`,
  `structuredClone`, `crypto.getRandomValues/randomUUID` (not secure),
  `navigator.hardwareConcurrency`, `WebAssembly`.
- `crossOriginIsolated` is `true`, as on a page served with COOP/COEP.

Not in workers: DOM, `OffscreenCanvas`/WebGL, `MessageChannel`, nested
workers. Messages and worker errors reach the page at the start of the next
frame, like browser tasks between frames.

Only the V8 build (the shipped engine started by Launcher.exe) has workers; the QuickJS
test build keeps `Worker` undefined, so feature detection still works.

## Measuring

- Webapp log: `[gc] N collections, X ms in 30 s, longest Y ms; K workers`,
  `[async-textures] ...`, `JavaScript engine: V8 ..., N CPU threads ...`.
- `[js-perf]` lines (frames over 90 ms) split timers / rAF / canvas / UI.

Compare the same save and camera path with and without a setting:

| Variable | Effect |
| --- | --- |
| `NTB_ASYNC_TEXTURES=0` | decode images on the JavaScript thread (old way) |
| `NTB_V8_FLAGS="--max-semi-space-size=16"` | V8 flags, e.g. the old young-generation size |
| `NTB_ASYNC_RENDER`, `NTB_ASYNC_UI` | see ASYNC-RENDER-EXPERIMENT.md |

No FPS gain is claimed until it has been measured on real hardware.

## Not done yet

Moving Three.js's per-frame scene work (matrix updates, culling, draw
packets in `js/native-renderer.mjs`) into parallel C++ would speed up every
game without changes, but it needs a native mirror of the scene graph. That
is a larger rewrite planned as a separate step.
