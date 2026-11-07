NativeThreeBridge v0.13.0 — VISIBLE A* ROUTES + CAMERA-NEAR SHADOWS
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
