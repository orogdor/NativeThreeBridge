NativeThreeBridge v0.7 – independent Windows EXE and updater
==========================================================
NativeThree-Game.exe      : run game directly without checking GitHub
NativeThree-Updater.exe   : update Game EXE + game/scene.js and start game
game\scene.js            : editable official THREE.Scene / THREE.InstancedMesh script

Extract the whole ZIP keeping game/scene.js in its subfolder.
Open NativeThree-Updater.exe for GitHub updates or NativeThree-Game.exe directly.
Command NativeThree-Updater.exe --check-only checks/updates without launching.
Create NO-UPDATE.txt alongside updater to disable updates.
Create PRESERVE-SCENE.txt alongside updater to protect your locally edited scene.js.
Use updater.log to investigate failures. Running EXE files cannot be replaced.

v0.6 and older launchers cannot migrate automatically: extract v0.7 ZIP once.
Updater EXE itself currently needs manual replacement via ZIP.
Game supports a limited genuine Three.js scene graph, not all WebGLRenderer APIs.
No Chromium, browser, Electron, WebView, Deno or Node at runtime.
