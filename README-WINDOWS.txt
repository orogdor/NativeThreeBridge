NativeThreeBridge v0.18.0 — 10,000 TREES + 1,000 SOLDIERS AT NIGHT
==================================================================
10,000 random pine instances (trunks and foliage), with camera frustum culling.
1,000 individual pathfinding soldiers, two armies of 500.
1,000 moving SpotLights; the nearest 16 get real shadow maps per frame.
360x360 navigation cells; max four independent A* full searches per frame.
Windows EXE / DX12 / real Three.js through QuickJS.

Unpack ZIP keeping:
  NativeThree-Updater.exe     Separate signed-hash update checker
  NativeThree-Game.exe        Native DX12 game (no browser)
  game\scene.js              Editable Three.js test scene
  installed-version.txt       Installed version metadata

Run NativeThree-Game.exe directly to bypass network checks.
Run NativeThree-Updater.exe (with the game closed) to fetch newer versions.
NO-UPDATE.txt disables updater checks. PRESERVE-SCENE.txt keeps custom JS.

F1 overview; F2 red army; F3 blue army; F4 debug A* routes.
F5 real shadows ON/OFF; F6 VSync; F7 night/day. Night is default.
Left mouse drag orbit, wheel zoom, Space pause, Esc exit.

Window title: FPS, MAX worst frame ms, FENCE avg wait ms, CPU JS/LIGHT/DRAW/
PRESENT average ms, camera-visible trees / 10000 and A* route counts.
F1 overview is a much heavier scene than the prior close camera test.

WARNING: Windows CI verifies builds and code, not physical GPU FPS or
real visual shadows. Individual A* searches remain synchronous QuickJS
operations (max 4 per frame), not a C++ worker system yet.
