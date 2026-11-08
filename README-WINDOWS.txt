NativeThreeBridge v0.19.0 - ENGINE CORE + SMOOTH 10K/1K NIGHT TEST
================================================================
10,000 pines / two 500-unit armies / 1,000 lights / 16 shadow maps.
C++ scene registry, spatial index, async A*, native fixed 60Hz simulation
with render interpolation, GPU timing and offline texture mipmaps.

Extract ZIP with NativeThree-Game.exe and game/scene.js together.
Run NativeThree-Game.exe directly to bypass updater checks.
Run NativeThree-Updater.exe separately to check GitHub for deltas.

Controls: F1 overview, F2/F3 army follow, F4 routes, F5 shadow toggle,
F6 VSync, F7 day/night (night default). Mouse drag orbit, wheel zoom.
Space pause; Esc exit.

Window title metrics: FPS, MAX longest frame ms, GPU FENCE wait ms, CPU
JS/LIGHT/DRAW/PRESENT ms, GPU shadow/main ms, visible trees and dirty objects.
NativeThreeBridge-frames.csv is created in the CURRENT WORKING DIRECTORY,
with one-second summaries and frames longer than 40 ms. File I/O is async.
GPU times are only available if DirectX 12 timestamp queries are supported.

The bundled demo now uses the async native path service; the browser/Node
fallback remains synchronous. Workers find paths on immutable map snapshots.
The test still uses local occupancy/reservation avoidance.
NativeThreeNavigation JS API (Windows only): configure(width,height,blocked
Uint8Array); updateAgents(occupiedInt32Array,reservedInt32Array);
request(startCell,goalCell,urgent); poll(32); cancel(token).

Reusing engine components in new games: generic C++ spatial_index.h,
scene_registry.h, navigation_service.h, fixed_stepper.h, lod_policy.h.
For trusted local Three.js ESM scene modules, run on a developer PC:
  npm install
  npm run convert -- ./my-scene.mjs ./manifest.json
This currently EXPORTS a JSON manifest with compatibility diagnostics;
the DX12 game cannot yet directly run arbitrary imported manifest games.
Full mesh LOD, universal DX12 scene imports and GPU ExecuteIndirect still
need implementing. Windows CI cannot measure your actual GPU FPS.
