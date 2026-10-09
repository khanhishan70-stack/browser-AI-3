@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  NEXORA Browser - OFFLINE CHAT launcher
echo  (qwen3-4b local AI, zero network needed)
echo ============================================

REM --- 1. Make sure Ollama server is running on port 11434 ---
netstat -an | findstr /c:":11434" | findstr /c:"LISTENING" >nul
if %errorlevel%==0 (
    echo [1/3] Ollama already running on :11434
) else (
    echo [1/3] Starting Ollama server...
    start /min "Ollama server" "C:\Users\Admin\AppData\Local\Programs\Ollama\ollama.exe" serve
    REM wait for Ollama to listen (up to 30s)
    set /a tries=0
    :wait_ollama
    set /a tries+=1
    if %tries% GTR 30 (
        echo WARNING: Ollama did not start on :11434 within 30s.
        echo Verify the local model is installed: ollama list
    ) else (
        timeout /t 1 /nobreak >nul
        netstat -an | findstr /c:":11434" | findstr /c:"LISTENING" >nul
        if not errorlevel 1 (
            echo        Ollama now listening on :11434
        ) else (
            goto wait_ollama
        )
    )
)

REM --- 2. Start the ESTA AI backend (console-free pythonw, logs to temp) ---
echo [2/3] Starting backend (port 5000)...
start /min "ESTA backend" cmd /c ""C:\Users\Admin\AppData\Local\Temp\opencode\start_backend.cmd""

REM --- 3. Launch NEXORA Browser Electron ---
echo [3/3] Launching NEXORA Browser...
start "" "node_modules\electron\dist\electron.exe" "electron\main.js" --no-sandbox

echo.
echo Done. Offline chat uses the local qwen3-4b model.
endlocal