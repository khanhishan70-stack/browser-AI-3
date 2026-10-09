@echo off
title NEO-AI-Backend
cd /d "%~dp0ai UI DESIGN\backend"
"%~dp0ai UI DESIGN\backend\venv\Scripts\python.exe" app.py
echo.
echo.
echo ==== AI Backend exited. Press any key to close this window. ====
pause >nul