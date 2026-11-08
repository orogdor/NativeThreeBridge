NativeThreeBridge v0.15.0 — VISIBLE A* ROUTES + CAMERA-NEAR SHADOWS
============================================
1000 original pine trees on a ~32x32 square forest placement grid.
Two 250-soldier armies (500 moving real GLB models).
500 moving real Three.js SpotLights; 16 selected depth shadow maps.
160x160 cell A* navigation grid; trees block occupied nav cells.
DX12 now splits 1500 world matrices into tree and soldier GPU buffers.

Unpack ZIP keeping these separate files:
  NativeThree-Updater.exe   GitHub SHA-256 updater
  NativeThree-Game.exe      Native DirectX12 game EXE
  game\scene.js            Editable Three.js forest and A* game script

To update: close game, run NativeThree-Updater.exe. If PRESERVE-SCENE.txt
exists, remove it to allow the updated 1000-tree scene.js.
Run NativeThree-Game.exe directly to bypass network checks.
NO-UPDATE.txt disables update checks.

Mouse left-drag = orbit, wheel = zoom, Space = pause, Esc = quit.
Test limits: Only 16 of 500 lights have dynamic depth shadows per frame.
Windows GPU visual correctness and FPS still require a manual test.

v0.12 fixes v0.11's 0.06-second frame cap, which made soldiers
move slowly when GPU FPS was low. The app title shows FPS, moved
soldiers, waypoint progress and failed routes. 1000 trees, 500
soldiers, 500 lights and the 16-shadow budget remain in place.

TEST VISUALS IN v0.13:
F1 = whole forest; F2 = near RED army; F3 = near BLUE army;
F4 = toggle the REAL A* route lines (yellow/cyan);
F5 = toggle depth-map shadows ON/OFF for a visual comparison.
Newly placed trees form a navigable barrier; 500 soldiers must detour.
Only 16 of the 500 SpotLights cast depth-map shadows per frame.
The app title displays FPS and A* route progress.
To be CERTAIN of the installed version, extract a fresh v0.13 ZIP
and run NativeThree-Game.exe directly. Avoid mixing old scene.js files.

v0.14 FOREST: 1000 pines randomly placed (not in a 32x32 grid).
Minimum tree-trunk spacing ~6.15 world units, varied yaw and scale.
Seeded random locations create the same forest on each start.
Edit FOREST_SEED in game\scene.js to regenerate a new layout.
Each tree still marks the corresponding A* obstacle cell.

v0.15 DYNAMIC SOLDIER PATHFINDING AND COLLISION AVOIDANCE:
- All 500 soldiers start WITHOUT precomputed routes.
- Each soldier independently searches A* during the simulation.
- Other soldiers' current and reserved next nav cells are BLOCKED.
- A soldier claims the next cell before moving and only releases
  the previous cell after reaching the destination.
- Congested soldiers wait and recompute their path as needed.
- Planning is spread across frames (12 A* searches per frame).
- Window title shows planned paths, replans and blocked waits.


v0.16.0 PERFORMANCE TEST (DX12):
- GPU-local DEFAULT memory for static vertex/index data instead of UPLOAD heap.
- Two independent in-flight per-frame allocators and dynamic GPU buffers.
- Only waits for the frame buffer being reused, not after each Present.
- Per-spotlight visible-instance compaction for 1000 trees and 500 soldiers.
- F5 OFF fully skips shadow rendering. F6 toggles VSync (OFF by default).
- Window title displays GPU adapter, FPS and visible shadow instance count.
- Run v0.15.0 vs v0.16.0 on the same GPU, camera and resolution.
- Windows CI validates compilation, not GPU fps or visual shadow correctness.


v0.17.0 NIGHT LIGHTING + SMOOTHER CPU:
- Starts in NIGHT mode: near-black sky, faint ambient fill, warm/red and cool/blue angled soldier spotlights.
- All 500 lights move with soldiers and 16 selected lights cast real DX12 shadow depth maps.
- F7 toggles day/night for comparison; F5 toggles shadows; F6 toggles VSync.
- F4 path lines are OFF initially so they don't brighten the night test.
- A* uses typed-array heap and avoids per-node object/adjacency allocations.
- 12 dynamic A* searches/frame retained to preserve 500 soldier routing responsiveness.
- Three.js instanced matrices copied directly without full scene update per frame.
- 1000 static tree transforms uploaded once to GPU-local DEFAULT memory.
- CPU timing in title: JS, light binning, draw recording, Present (ms).
- Win CI tests compilation and navigation, not real GPU image or FPS.
