@echo off
REM ===== AI VOICE ASSISTANT STARTUP SCRIPT =====
echo.
echo 🚀 AI Voice Assistant - Starting Backend
echo.

REM Check if Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Python is not installed! Please install Python 3.8 or higher.
    pause
    exit /b 1
)

REM Check if venv exists
if not exist "venv" (
    echo 📦 Creating virtual environment...
    python -m venv venv
)

REM Activate virtual environment
call venv\Scripts\activate.bat

REM Check if requirements are installed
python -c "import flask" >nul 2>&1
if errorlevel 1 (
    echo 📥 Installing dependencies...
    pip install -r requirements.txt
)

REM Check if .env exists
if not exist ".env" (
    echo ⚙️  Creating .env file from .env.example...
    copy .env.example .env
    echo.
    echo 📝 Please edit .env and add your GROQ_API_KEY
    echo Get it from: https://console.groq.com
    echo.
    pause
)

REM Run the app
echo.
echo ✅ Starting Flask server on http://localhost:5000
echo.
python app.py

pause
