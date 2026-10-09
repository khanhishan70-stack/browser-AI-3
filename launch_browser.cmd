@echo off
cd /d "%~dp0"
taskkill /f /im electron.exe >nul 2>&1
timeout /t 1 /nobreak >nul
del /q "%APPDATA%\Electron\Singleton*" 2>nul
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0electron\main.js" --no-sandbox