@echo off
cd /d "%~dp0"
echo Building a clean release ZIP of NEXORA Browser...
echo (Keeps the browser + backend sources, drops node_modules / venv / caches.
echo  First run on a new PC auto-recreates the backend venv via launch.bat.)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make_release_zip.ps1"
echo.
pause