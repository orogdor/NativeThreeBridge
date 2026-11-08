@echo off
setlocal
cd /d "%~dp0"
if not exist "v8-runtime\node.exe" (
  echo Missing bundled V8 runtime: v8-runtime\node.exe
  echo Extract the whole ZIP, not just NativeThree-V8.exe.
  pause
  exit /b 1
)
echo NativeThreeBridge experimental V8 backend (Node V8, no Chromium).
echo Current game folder: %CD%\game
echo.
"NativeThree-V8.exe" %*
set "exitCode=%ERRORLEVEL%"
if not "%exitCode%"=="0" (
  echo V8 test exited with code %exitCode%.
  if exist "NativeThreeBridge-webapp-log.txt" (
    echo See NativeThreeBridge-webapp-log.txt for details.
  )
  pause
)
exit /b %exitCode%
