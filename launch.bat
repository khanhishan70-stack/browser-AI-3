@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM  NEXORA BROWSER - ONE-CLICK LAUNCHER
REM  Starts:  1) Offline AI (Ollama)   2) AI backend   3) Browser
REM ============================================================

REM ---- [1/4] Fix backend venv if it was copied from another PC ----
echo [1/4] Checking Python venv...
"ai UI DESIGN\backend\venv\Scripts\python.exe" -c "import pydantic_core, PIL" >nul 2>&1
if %ERRORLEVEL% EQU 0 goto venv_ok
echo    Venv missing or broken (corrupted packages). Recreating...
where python >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto no_python
if exist "ai UI DESIGN\backend\venv" rmdir /s /q "ai UI DESIGN\backend\venv"
python -m venv "ai UI DESIGN\backend\venv"
if %ERRORLEVEL% EQU 0 goto venv_install
:no_python
echo.
echo    WARNING: Python not found. AI backend will be skipped.
echo    (Browser still opens - page translator works without it.
echo    Install Python 3.13 from https://www.python.org/downloads/
echo    and re-run for the full AI chat experience.)
set SKIP_BACKEND=1
goto venv_done
:venv_install
echo    Installing dependencies, one-time only...
"ai UI DESIGN\backend\venv\Scripts\python.exe" -m pip install -r "ai UI DESIGN\backend\requirements.txt" >nul 2>&1
:venv_ok
echo    OK.
:venv_done

REM ---- First-run backend config (never overwrite an existing .env) ----
if not exist "ai UI DESIGN\backend\.env" (
  if exist "ai UI DESIGN\backend\.env.example" copy /y "ai UI DESIGN\backend\.env.example" "ai UI DESIGN\backend\.env" >nul
  echo.
  echo    First run: created ai UI DESIGN\backend\.env from the template.
  echo    For AI cloud chat, paste a free Groq key as GROQ_API_KEY=... in it:
  echo    https://console.groq.com  (then re-run launch.bat)
  echo    Browser, history, downloads and offline tools work without it.
)

REM ---- [2/4] Start Offline AI (Ollama on port 11434) ----
echo [2/4] Starting offline AI, Ollama...
netstat -an | findstr /c:":11434" | findstr /c:"LISTENING" >nul
if %ERRORLEVEL% EQU 0 goto ollama_ready
if not exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" goto ollama_missing
echo    Launching Ollama...
start /min "Ollama server" "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve
set tries=0
:wait_ollama
timeout /t 1 /nobreak >nul
set /a tries+=1
netstat -an | findstr /c:":11434" | findstr /c:"LISTENING" >nul
if %ERRORLEVEL% EQU 0 goto ollama_ready
if %tries% LSS 30 goto wait_ollama
echo    WARNING: Ollama did not start within 30s.
goto ollama_done
:ollama_missing
echo    Ollama not found - installing it automatically (one time, free)...
where winget >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto ollama_manual
winget install -e --id Ollama.Ollama --silent --accept-package-agreements --accept-source-agreements
if not exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" goto ollama_manual
echo    Launching Ollama...
start /min "Ollama server" "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve
set tries=0
goto wait_ollama
:ollama_manual
echo    WARNING: automatic install failed. Offline AI unavailable.
echo    Install from https://ollama.com then run: ollama pull qwen3:1.7b
goto ollama_done
:ollama_ready
echo    Ollama ready on :11434
REM Free offline model, present forever after the first download (~1.2 GB, one time).
set OLLAMA_BIN=%LOCALAPPDATA%\Programs\Ollama\ollama.exe
if not exist "%OLLAMA_BIN%" set OLLAMA_BIN=ollama
"%OLLAMA_BIN%" list 2>nul | findstr /c:"qwen3:1.7b" >nul
if %ERRORLEVEL% EQU 0 goto ollama_done
echo    First run: downloading the free offline AI model (one time)...
"%OLLAMA_BIN%" pull qwen3:1.7b
:ollama_done

REM ---- [3/4] Start AI backend ----
if defined SKIP_BACKEND (
echo    Skipped, Python not installed.
goto backend_done
)
echo [3/4] Starting AI backend...
start "" /min "%ComSpec%" /c ""ai UI DESIGN\backend\venv\Scripts\python.exe" "ai UI DESIGN\backend\app.py" >> "backend.log" 2>&1"

REM Wait for backend to be reachable
set btries=0
:wait_backend
set /a btries+=1
timeout /t 1 /nobreak >nul
curl -s http://127.0.0.1:5000/api/health >nul 2>&1
if %ERRORLEVEL% EQU 0 goto backend_ready
if %btries% LSS 20 goto wait_backend
echo.
echo    Backend FAILED to start. Last messages from backend.log:
powershell -NoProfile -Command "if (Test-Path 'backend.log') { Get-Content 'backend.log' -Tail 15 } else { Write-Output 'no log yet' }"
goto backend_done
:backend_ready
echo    Backend ready on :5000
:backend_done

REM ---- [4/4] Launch NEXORA Browser (full packaged build) ----
echo [4/4] Launching NEXORA Browser...
if exist "dist\NEXORA-win32-x64\NEXORA.exe" (
  start "" "dist\NEXORA-win32-x64\NEXORA.exe"
) else (
  start "" "node_modules\electron\dist\electron.exe" "electron\main.js" --no-sandbox
)

echo.
echo    NEXORA Browser is starting. You may close this window.
endlocal