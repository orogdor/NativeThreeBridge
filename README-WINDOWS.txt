NativeThreeBridge v0.10.0 — 10x10 FOREST + 500 SOLDIERS/LIGHTS
===============================================================
100 original pine trees arranged 10 by 10.
Two 250-unit spearman armies; 500 A* obstacle-avoiding routes.
500 live moving Three.js SpotLights (one per soldier).
DX12 uses a 16x16 spatial light grid, 16 nearest lights per tile.
Only 16 active real-time depth shadow maps per frame (8 per army).

Extract complete ZIP; preserve game/scene.js next to the two EXEs:
  NativeThree-Updater.exe — independent GitHub update checker
  NativeThree-Game.exe    — native DX12 + embedded official Three.js
  game\scene.js           — editable Three.js pathfinding and scene

v0.7+ updater should update game EXE and scene.js independently.
Close old game first; remove PRESERVE-SCENE.txt if you want new JS.
NO-UPDATE.txt disables checking. PRESERVE-SCENE.txt keeps custom JS.
Left mouse drag = orbit. Wheel = zoom. Space = pause. Esc = exit.

Current limitation: 500 moving lights but only 16 selected lights
have live depth-shadow maps at a given time. Other lights are
distance-culled and unshadowed to protect FPS.
Actual Windows GPU appearance/FPS still needs checking.
