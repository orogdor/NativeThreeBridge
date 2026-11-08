NativeThreeBridge v0.23.0 - CSS RESTART BUTTON TO NATIVE C++
================================================================
CSS test: game/ui.html declares <button id=restart-button>; game/ui.css
sets right/top/size/background/text/border/radius/font. Engine parses these
on startup and creates a real owner-drawn Win32 BUTTON, no browser or WebView.
Press Restart to reset 1000 soldiers, A* routes, lights and gait to initial
conditions without reloading the static 10000-tree GPU assets.
You can edit game/ui.css and relaunch to test supported native styles.
F9 is a keyboard shortcut to invoke the same C++ restart command.
Full web CSS layout, animations, flexbox and scripts are NOT implemented.

New: all radius-overlapping lights contribute to each 16x16 spatial tile.
The former nearest-16 light list created hard moving square boundaries.
Light indices are now compact per-frame SRVs; 16 real shadow maps remain.
Compare v0.19.0 and v0.20.0 on the same Windows DX12 camera and settings.
A physical GPU is needed to check lighting pixels and FPS. FPS is not guaranteed.

NEW: Red army 500 spearmen use an actual 8-bone skin generated from the original
Odamees GLB, with JOINTS_0, WEIGHTS_0, hierarchy and inverse bind matrices.
Knees, hips, spine and arms are procedurally moved using skeletal influences.
Blue army 500 retains the v0.21 unrigged procedural gait for comparison.
The same skinning runs in the real shadow depth pass. F8 toggles animation.
game/odamees-rigged.glb contains the exported rig for inspection and reuse.
Rigging is automatic/experimental; it needs a close visual assessment.

10,000 pines / two 500-unit armies / 1,000 lights / 16 shadow maps.
C++ scene registry, spatial index, async A*, native fixed 60Hz simulation
with render interpolation, GPU timing and offline texture mipmaps.

Extract ZIP with NativeThree-Game.exe and game/scene.js together.
Run NativeThree-Game.exe directly to bypass updater checks.
Run NativeThree-Updater.exe separately to check GitHub for deltas.

Controls: F1 overview, F2/F3 army follow, F4 routes, F5 shadow toggle,
F6 VSync, F7 day/night, F8 walking, F9 restart scene.
Mouse drag orbit, wheel zoom; F2/F3 follow army to see legs close up.
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
