NativeThreeBridge v0.27.1-kuningriigid.1 - SEPARATE GAME TEST
==========================================================

This package is built from the experiment/kuningriigid-game branch. The main
NativeThreeBridge release remains the forest battle engine test. Extract
this complete ZIP to a separate writable folder. It contains exactly
three EXE files:

  Game-Updater.exe       Downloads changed files from orogdor/Kuningriigid
                         main into game/, showing download percentage.
  Engine-Updater.exe     Checks the latest stable forest-battle engine release
                         and updates only NativeThree-Game.exe, showing %.
  NativeThree-Game.exe   Starts the local engine without checking the network.

Run Game-Updater.exe first. It installs the repository source in game/ and
keeps the previous game directory as game.previous. The updater refuses to
overwrite locally edited tracked files. Engine updates keep the previous
NativeThree-Game.exe as NativeThree-Game.exe.previous. Do not combine this
test ZIP with the forest-battle installation; extract to a separate folder.

IMPORTANT COMPATIBILITY RESULT
Kuningriigid is the first compatibility experiment, not the engine's main
development scenario. This native DX12 host does not implement its
HTML/DOM, CSS, module loading, WebGLRenderer, or full asset pipeline. When
NativeThree-Game.exe sees the downloaded source, it writes
compatibility-report.txt and exits with a clear warning before executing
any downloaded JavaScript. There is no claim that Kuningriigid currently
runs on native DirectX 12. The latest stable main-branch ZIP is the working
forest battle development release.

Game-Updater.exe uses a pinned Git commit for each update, verifies every
download against its Git blob SHA-1 and records SHA-256 checksums in
game/.native-three-game-manifest.json. It downloads only files whose Git
blob changed or whose local copy is missing, but the update needs temporary
disk space to copy the full game directory before a directory swap. It does
not run scripts from the repository. Git LFS pointers, symbolic links,
truncated GitHub trees and oversized downloads are rejected. GitHub/TLS is
the trust source; these checksums do not provide independent code signing.

Game-Updater.log and Engine-Updater.log contain errors. Network access is
required only when running an updater. The game EXE never updates itself.
