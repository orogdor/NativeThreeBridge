@echo off
setlocal
where cl.exe >nul 2>&1
if errorlevel 1 ( echo Need MSVC x64 Native Tools Command Prompt & pause & exit /b 1 )
where rc.exe >nul 2>&1
if errorlevel 1 ( echo Need Windows SDK rc.exe & pause & exit /b 1 )
python -m pip install Pillow
if errorlevel 1 ( echo Pillow installation failed & pause & exit /b 1 )
python tools\pack_kuningriigid.py
if errorlevel 1 ( echo Original GLB asset pack failed & pause & exit /b 1 )
if not exist dist mkdir dist
rc /nologo /fo generated\model_assets.res generated\model_assets.rc
if errorlevel 1 ( echo Resource compile failed & pause & exit /b 1 )
cl /nologo /O2 /W3 /EHsc /std:c++17 /DUNICODE /D_UNICODE native-dx12\NativeThree-DX12.cpp generated\model_assets.res /Fe:dist\NativeThree-Diagnostics.exe /link /SUBSYSTEM:WINDOWS user32.lib d3d12.lib dxgi.lib d3dcompiler.lib
if errorlevel 1 ( echo DX12 compile failed & pause & exit /b 1 )
copy /Y dist\NativeThree-Diagnostics.exe dist\NativeThree-DX12.exe >nul
cl /nologo /O2 /W3 /TC launcher\NativeThree-Launcher.c /Fe:dist\NativeThree-Launcher.exe /link /SUBSYSTEM:WINDOWS kernel32.lib shell32.lib user32.lib winhttp.lib advapi32.lib
if errorlevel 1 ( echo Launcher compile failed & pause & exit /b 1 )
copy /Y version.txt dist\installed-version.txt >nul
echo Build succeeded: run dist\NativeThree-Launcher.exe
pause
