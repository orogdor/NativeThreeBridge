# Adaptive threaded DX12: experimental Windows build

No game code changes. The native Three.js bridge runs game logic, DOM,
JavaScript callbacks and LOD on V8's original single JS thread, but overlaps
DX12 command recording, GPU submission and Present with the next JS frame.
GPU resource uploads and releases are guarded while a native worker is
recording. Window resizing, reload and shutdown drain the worker.

**Modes:** Default auto-enables at frame 20+ when hardware has 4+ logical
cores, the scene has 128+ draw calls and one JS frame takes >=8 ms.
Set `NTB_ASYNC_RENDER=0` for original synchronous rendering.
Set `NTB_ASYNC_RENDER=1` to force async rendering for any supported webapp.
Check the webapp log for `[async-render]` when active.

This first prototype **does not** parallelize arbitrary JS game logic,
Three.js traversal, or CSS parsing. It is one safe experimental stage of the
adaptive scheduler. The existing Windows FPS CSV is retained; in threaded
mode render worker time and frame wall time overlap and must not be added.

For A/B FPS comparison, copy this test engine into a separate directory,
launch it with the same `--webapp <game-folder>` and camera/save settings,
and alternate the two NTB_ASYNC_RENDER modes. Compare mean FPS, p95 frame
times, crashes and graphical screenshots. Do not overwrite your stable engine.
