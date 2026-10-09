@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM  NEO BROWSER - SILENT STARTUP LAUNCHER
REM  Drop this file (or a shortcut to it) in the Startup folder:
REM    Win+R -> shell:startup
REM  Starts:  1) AI backend   2) Ollama (offline AI)   3) Browser
REM  All components run hidden. Logs go to start.log.
REM ============================================================

REM ---- [1/4] Fix backend venv if it was copied from another PC ----
"ai UI DESIGN\backend\venv\Scripts\python.exe" -c "import pydantic_core, PIL" >nul 2>&1
if %ERRORLEVEL% EQU 0 goto venv_ok
echo [%date% %time%] Venv missing or broken, recreating... >> "start.log" 2>&1
if exist "python.exe" goto :eof
where python >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto no_python
if exist "ai UI DESIGN\backend\venv" rmdir /s /q "ai UI DESIGN\backend\venv"
python -m venv "ai UI DESIGN\backend\venv" >> "start.log" 2>&1
if %ERRORLEVEL% EQU 0 (
  "ai UI DESIGN\backend\venv\Scripts\python.exe" -m pip install -r "ai UI DESIGN\backend\requirements.txt" >> "start.log" 2>&1
  goto venv_ok
)
:no_python
echo [%date% %time%] Python not found, backend will be unavailable. >> "start.log" 2>&1
goto backend_done
:venv_ok

REM ---- [2/4] AI backend ----
netstat -an | findstr /c:":5000" | findstr /c:"LISTENING" >nul
if %ERRORLEVEL% EQU 0 goto backend_ready
start "" /min "%ComSpec%" /c ""ai UI DESIGN\backend\venv\Scripts\python.exe" "ai UI DESIGN\backend\app.py" >> "start.log" 2>&1"
set btries=0
:wait_backend
set /a btries+=1
timeout /t 1 /nobreak >nul
curl -s http://127.0.0.1:5000/api/health >nul 2>&1
if %ERRORLEVEL% EQU 0 goto backend_ready
if %btries% LSS 20 goto wait_backend
echo [%date% %time%] Backend FAILED to start. >> "start.log" 2>&1
goto backend_done
:backend_ready
echo [%date% %time%] Backend ready on :5000 >> "start.log" 2>&1
:backend_done

REM ---- [3/4] Ollama (offline AI) ----
netstat -an | findstr /c:":11434" | findstr /c:"LISTENING" >nul
if %ERRORLEVEL% EQU 0 goto ollama_ready
if not exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" goto ollama_missing
start /min "Ollama server" "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve
set tries=0
:wait_ollama
timeout /t 1 /nobreak >nul
set /a tries+=1
netstat -an | findstr /c:":11434" | findstr /c:"LISTENING" >nul
if %ERRORLEVEL% EQU 0 goto ollama_ready
if %tries% LSS 20 goto wait_ollama
echo [%date% %time%] Ollama failed to start. >> "start.log" 2>&1
goto ollama_done
:ollama_missing
echo [%date% %time%] Ollama not installed - offline AI unavailable. >> "start.log" 2>&1
goto ollama_done
:ollama_ready
echo [%date% %time%] Ollama ready on :11434 >> "start.log" 2>&1
:ollama_done

REM ---- [4/4] Launch NEXORA Browser (skip if already open) ----
tasklist /FI "IMAGENAME eq electron.exe" 2>nul | findstr /i "electron.exe" >nul
if %ERRORLEVEL% EQU 0 goto browser_running
start "" "node_modules\electron\dist\electron.exe" "electron\main.js" --no-sandbox >> "start.log" 2>&1
echo [%date% %time%] NEXORA Browser launched. >> "start.log" 2>&1
goto :eof
:browser_running
echo [%date% %time%] NEXORA Browser already running. >> "start.log" 2>&1

endlocal