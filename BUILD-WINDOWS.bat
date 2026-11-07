@echo off
setlocal
where cl.exe >nul 2>&1
if errorlevel 1 (
  echo Microsoft C++ compiler not found. Use "x64 Native Tools Command Prompt for VS".
  pause
  exit /b 1
)
if not exist dist mkdir dist
cl /nologo /O2 /W3 /TC diagnostic\NativeThree-Diagnostics.c /Fe:dist\NativeThree-Diagnostics.exe /link /SUBSYSTEM:WINDOWS user32.lib gdi32.lib
if errorlevel 1 ( echo Diagnostic build FAILED & pause & exit /b 1 )
cl /nologo /O2 /W3 /TC launcher\NativeThree-Launcher.c /Fe:dist\NativeThree-Launcher.exe /link /SUBSYSTEM:WINDOWS kernel32.lib shell32.lib user32.lib winhttp.lib advapi32.lib
if errorlevel 1 ( echo Launcher build FAILED & pause & exit /b 1 )
copy /Y version.txt dist\installed-version.txt >nul
echo Build succeeded; run dist\NativeThree-Launcher.exe
pause
