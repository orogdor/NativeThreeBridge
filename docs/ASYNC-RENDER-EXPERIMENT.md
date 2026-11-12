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

## v0.32.19: independent native UI raster experiment

Added to the **same** experimental render-thread PR. The existing shared V8
DOM/game simulation is unchanged. Native Direct2D raster runs on its own thread
and publishes immutable BGRA snapshots. DX12 composites the most recent
completed UI snapshot over each 3D frame and never waits for Direct2D raster
to finish. UI redraws only when a display list arrives or the window resizes.

The UI worker coalesces pending display lists. When it skips an intermediate
partial update, it forces full redraw to avoid losing changed regions. Native
Canvas and text measurement calls still acquire the shared UI lock to ensure
correctness; therefore V8 may briefly wait for UI raster if a game uses those
APIs heavily. This does **not** yet separate JavaScript DOM/CSS computation
into another V8 isolate or make all HTML/Three.js code independently scheduled.

Modes on the **same test executable**:

| NTB_ASYNC_RENDER | NTB_ASYNC_UI | Meaning |
| --- | --- | --- |
| 0 | 0 | synchronous old pipeline (baseline) |
| 1 | 0 | DX12 render worker only (v0.32.18 comparison) |
| 0 | 1 | native UI raster worker only |
| 1 | 1 | DX12 + UI workers (two native workers, one V8 thread) |

Unset NTB_ASYNC_UI defaults to worker mode on CPUs with 4+ logical threads.
Log marker: `[async-ui] independent Direct2D raster worker enabled`.
In asynchronous UI mode `ui_raster_ms_avg` is completed worker CPU time
amortized over produced 3D frames, not blocking JS time. It is **not**
additive with total frame time, because worker rendering overlaps DX12/V8.

Run the same save and camera path twice with `NTB_ASYNC_UI=0` and `=1`,
keeping NTB_ASYNC_RENDER fixed. Compare FPS, p95/p99 frame times, UI
responsiveness and screenshots. No FPS improvement has been established yet.
