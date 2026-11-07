NativeThreeBridge v0.4.0 - Windows x64
====================================
1. Extract the ZIP into a user-writable folder, e.g. C:\Games\NativeThreeBridge
2. Double-click NativeThree-Launcher.exe (requires Internet only for updates).
3. Launcher checks the newest public GitHub Release, verifies SHA-256,
   and replaces NativeThree-Diagnostics.exe if the version is newer.
4. If offline, the installed diagnostic EXE opens normally.
5. To disable updates: create NO-UPDATE.txt next to the launcher.
6. For troubleshooting: read launcher.log in the same folder.

This is a native GDI diagnostic test, NOT YET a DX12 Three.js engine.
No Chromium, Electron, WebView, Node, or Deno needed to run the EXEs.
Windows SmartScreen may warn because binaries are not code-signed.
