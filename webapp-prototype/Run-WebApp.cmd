@echo off
setlocal
cd /d "%~dp0"
echo NativeThreeBridge Three.js WebApp - DirectX 12 test
echo.
if not exist "webapp\index.html" (
  echo ERROR: webapp\index.html is missing.
  echo Extract all files from the ZIP first. Do not run the EXE inside ZIP.
  pause
  exit /b 2
)
if not exist "webapp\app.js" (
  echo ERROR: webapp\app.js is missing.
  pause
  exit /b 3
)
"NativeThree-WebApp.exe"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
  echo.
  echo NativeThree-WebApp.exe exited with error code %RESULT%.
  if exist "webapp-startup.log" (
    echo.
    echo ========= webapp-startup.log =========
    type "webapp-startup.log"
    echo ======================================
  ) else (
    echo Startup log was not written. Check Windows Defender or missing DLL message.
  )
  pause
)
exit /b %RESULT%
