@echo off
setlocal
where cl.exe >nul 2>&1
if errorlevel 1 (echo Missing Visual Studio x64 C++ build tools & pause & exit /b 1)
where cmake.exe >nul 2>&1
if errorlevel 1 (echo Missing CMake & pause & exit /b 1)
where python.exe >nul 2>&1
if errorlevel 1 (echo Missing Python for BUILD TIME only & pause & exit /b 1)
where npm.cmd >nul 2>&1
if errorlevel 1 (echo Missing npm for BUILD TIME only & pause & exit /b 1)
if not exist generated mkdir generated
if not exist third_party mkdir third_party
if not exist third_party\quickjs\CMakeLists.txt (
  git clone --depth 1 --branch v0.13.0 https://github.com/quickjs-ng/quickjs.git third_party\quickjs
  if errorlevel 1 (echo QuickJS download failed & pause & exit /b 1)
)
call npm install --no-audit --no-fund
if errorlevel 1 (echo npm install failed & pause & exit /b 1)
call npm install --no-save --no-package-lock --no-audit --no-fund esbuild@0.25.12
if errorlevel 1 (echo esbuild install failed & pause & exit /b 1)
call npx esbuild threejs-native\three-runtime-entry.mjs --bundle --platform=neutral --format=iife --target=es2020 --outfile=generated\three-runtime.bundle.js
if errorlevel 1 (echo ThreeJS bundle failed & pause & exit /b 1)
python -m pip install Pillow
if errorlevel 1 (echo Pillow failed & pause & exit /b 1)
python tools\pack_kuningriigid.py
if errorlevel 1 (echo Original GLB packing failed & pause & exit /b 1)
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
if errorlevel 1 (echo CMake config failed & pause & exit /b 1)
cmake --build build --config Release --target ThreeSceneSmoke NativeThreeJS --parallel 4
if errorlevel 1 (echo DX12/QuickJS compilation failed & pause & exit /b 1)
set CI=1
build\Release\ThreeSceneSmoke.exe
if errorlevel 1 (echo JavaScript runtime smoke test failed & pause & exit /b 1)
echo NativeThreeBridge ThreeJS DX12 build succeeded.
if not exist dist\game mkdir dist\game
copy /Y build\Release\NativeThree-Diagnostics.exe dist\NativeThree-Game.exe >nul
copy /Y game\scene.js dist\game\scene.js >nul
cl /nologo /O2 /W3 /TC launcher\NativeThree-Updater.c /Fe:dist\NativeThree-Updater.exe /link /SUBSYSTEM:WINDOWS kernel32.lib shell32.lib user32.lib winhttp.lib advapi32.lib
if errorlevel 1 (echo Independent updater compile failed & pause & exit /b 1)
echo Standalone game: dist\NativeThree-Game.exe
echo Independent GitHub updater: dist\NativeThree-Updater.exe
echo Editable game code: dist\game\scene.js
pause
