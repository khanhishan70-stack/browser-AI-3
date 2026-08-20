@echo off
cd /d "%~dp0"
echo Starting ESTA AI backend...
start /min "" "ai UI DESIGN\backend\venv\Scripts\python.exe" "ai UI DESIGN\backend\app.py"
timeout /t 3 /nobreak >nul
echo Starting NeoBrowser...
start "" "node_modules\electron\dist\electron.exe" "electron\main.js" --no-sandbox
