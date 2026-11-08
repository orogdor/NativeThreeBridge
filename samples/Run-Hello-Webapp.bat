@echo off
rem Opens the bundled Three.js sample webapp in NativeThreeBridge (no browser).
start "" "%~dp0NativeThree-Game.exe" --webapp "%~dp0webapps\hello-webapp"
