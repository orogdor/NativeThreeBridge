# NativeThreeBridge

A separate **native Windows** game-engine experiment, independent from [Kuningriigid](https://github.com/orogdor/Kuningriigid).

**Status v0.4.1:** the Win32 GDI diagnostic EXE and WinHTTP updater are real native Windows executables. **This is not yet a working DirectX 12 + embedded JavaScript runtime.** Three.js is currently used only in the scene exporter (Node.js at build time), not inside the Windows EXE.

## v0.4.1 diagnostic rendering fix

The native GDI diagnostic now uses a persistent offscreen bitmap and copies each completed frame to the window with one `BitBlt`. It suppresses `WM_ERASEBKGND` and painter-sorts trees and houses by camera depth. This addresses flicker and inconsistent house overlap; it is **not** yet DirectX 12 or a fully compatible Three.js engine.

## Download / auto update

Download **NativeThreeBridge-Windows-x64.zip** from [Releases](https://github.com/orogdor/NativeThreeBridge/releases/latest). Extract it into a writeable directory and launch **NativeThree-Launcher.exe**.

The launcher checks the latest public Release, downloads `NativeThree-Diagnostics.exe` if a newer version exists, validates SHA-256 against `update.txt`, retains a backup and opens the diagnostic app. Offline launches continue using the installed version. Create `NO-UPDATE.txt` beside the launcher to disable updates. No Chromium, WebView, Electron, Node or Deno is needed on players' PCs.

## Automated build and release

Pushing to `main` builds and uploads the Windows x64 artifact using GitHub Actions. The workflow creates the GitHub Release for the version in `version.txt` **only if it does not already exist**. For subsequent releases: increment `version.txt` and `package.json` version, then push to `main`. The Windows builder creates the ZIP, hashes the game executable and publishes the update manifest.

These are unsigned EXEs; Windows SmartScreen may warn. Use a writable directory, not `Program Files`.

## Sources / development

- `launcher/NativeThree-Launcher.c` - WinHTTP updater, SHA-256 and game EXE launch.
- `diagnostic/NativeThree-Diagnostics.c` - native Win32 GDI benchmark/diagnostic.
- `js/three-adapter.mjs`, `js/bridge.mjs` - experimental Three.js to N3B1 batch conversion.
- `BUILD-WINDOWS.bat` - manual local MSVC build.
- `.github/workflows/windows.yml` - automatic Windows builder/release.

Run `npm ci && npm test && npm run export` to test scene export **only on a development machine**.

**Limitations:** no embedded JS game loop, no complete Three.js render API, and no working DX12 integration in the downloaded executable yet. The current updater replaces only the diagnostic EXE, not other game assets; an asset manifest will be needed later.
