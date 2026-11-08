NativeThreeBridge - WebApp Battle (DX12 native test)
================================================

1. Extract the complete ZIP to a NEW folder, separate from your main NativeThreeBridge install.
2. Double-click NativeThree-WebApp-Battle.exe (64-bit Windows with DirectX 12).
3. F12 starts the close-up battle; F1/F2/F3 cameras; F4 routes; F5 shadows;
   F6 VSync; F7 day/night; F8 walking; F9 restart; F10 audio test; F11 mute.
   Drag the mouse to rotate, mouse wheel zooms, Space pauses, Escape exits.

This EXE executes webapp/native-scene.js, generated from webapp/index.html
and webapp/battle-scene.js. It does NOT read game/scene.js.
The DX12 engine runs the webapp's game simulation in QuickJS WITHOUT WebGL,
Chromium or an HTML browser. HTML buttons are NOT rendered: native controls
and keyboard shortcuts are used instead.

The WebApp ZIP contains NO updater. It cannot replace the main engine/game.
GitHub CI compiles Windows binaries and verifies the QuickJS battle simulation.
Actual GPU rendering and FPS still need a physical Windows DX12 test.

An older unsigned test EXE was flagged by Windows Defender. If Windows
quarantines this one, do not bypass security; inspect the alert and request
a review of the build.
