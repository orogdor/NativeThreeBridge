NativeThreeBridge v0.11.0 — FOREST 10x LARGER
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
