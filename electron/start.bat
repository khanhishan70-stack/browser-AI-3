@echo off
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
echo Starting NeoBrowser...
npx electron .
pause
