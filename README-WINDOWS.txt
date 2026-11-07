NativeThreeBridge v0.8 - 1000 trees + TWO A* pathfinding armies
===============================================================
NativeThree-Game.exe       DirectX12 renderer + embedded official Three.js
NativeThree-Updater.exe    independent GitHub update checker
game\scene.js             editable forest generation + A* pathfinding

Test contents:
 - 1000 original Kuningriigid Sapling pine trees
 - Red army: 10 original spearmen; blue army: 10 original spearmen
 - Every soldier calculates an A* path around tree obstacles on a 64x64 grid
 - Both armies move continuously; GPU instancing and FPS title enabled

Unpack the complete ZIP preserving game\scene.js.
Run NativeThree-Game.exe for direct offline gameplay; updater is optional.
Run NativeThree-Updater.exe to download EXE and JS independently if changed.
NO-UPDATE.txt disables updates; PRESERVE-SCENE.txt preserves edited JS.
Mouse drag to orbit; mouse wheel zoom; Space pauses; Esc quits.

This is NOT a general drop-in WebGLRenderer/GLTFLoader compatibility layer.
Models are embedded during the Windows build. Soldiers have no skeletal walk cycle.
GitHub validates Windows compilation and JS pathfinding, but real DX12 output
must still be verified on the user's GPU.
