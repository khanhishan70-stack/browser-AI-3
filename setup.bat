@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM  NEO BROWSER - FIRST-TIME SETUP (run ONCE on a new PC)
REM  Installs:  Python 3.13  +  Ollama  +  qwen model
REM  Then use launch.bat every day.
REM ============================================================

echo ============================================
echo   NEO BROWSER SETUP
echo   This installs everything automatically.
echo ============================================
echo.

REM ---- [1/4] Python 3.13 ----
echo [1/4] Checking Python...
python --version >nul 2>&1
if %ERRORLEVEL% EQU 0 goto python_ok
echo    Python not found. Downloading installer...
if not exist "setup_downloads" mkdir setup_downloads
curl -L -o "setup_downloads\python-3.13.6-amd64.exe" "https://www.python.org/ftp/python/3.13.6/python-3.13.6-amd64.exe"
echo    Installing Python silently...
"setup_downloads\python-3.13.6-amd64.exe" /quiet InstallAllUsers=1 PrependPath=1
echo    Python installed. Please close ANY open Command Prompts after this.
:python_ok
echo    OK.

REM ---- [2/4] Ollama ----
echo [2/4] Checking Ollama...
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" goto ollama_ok
where ollama >nul 2>&1
if %ERRORLEVEL% EQU 0 goto ollama_ok
echo    Ollama not found. Downloading installer...
if not exist "setup_downloads" mkdir setup_downloads
curl -L -o "setup_downloads\OllamaSetup.exe" "https://ollama.com/download/OllamaSetup.exe"
echo    Installing Ollama silently...
"setup_downloads\OllamaSetup.exe" /VERYSILENT /NORESTART
if not exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" goto ollama_manual
:ollama_ok
echo    OK.
goto ollama_model

:ollama_manual
echo.
echo    ERROR: Ollama could not install automatically.
echo    Please run this file manually and then come back here:
echo        setup_downloads\OllamaSetup.exe
pause
exit /b 1

:ollama_model
REM ---- [3/4] Offline AI model (qwen3:1.7b) ----
echo [3/4] Downloading offline AI model ~1.4GB, one time only...
set OLL="%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
if not exist %OLL% set OLL=ollama
%OLL% pull qwen3:1.7b
echo    Model ready.

REM ---- [4/4] Rebuild backend environment ----
echo [4/4] Building backend environment...
python -m venv "ai UI DESIGN\backend\venv"
"ai UI DESIGN\backend\venv\Scripts\pip.exe" install -r "ai UI DESIGN\backend\requirements.txt"
echo.
echo ============================================
echo   SETUP COMPLETE!
echo   Now double-click:  launch.bat
echo ============================================
pause