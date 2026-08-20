@echo off
REM ===== DEPENDENCY CHECKER =====
echo.
echo 🔍 AI Voice Assistant - Dependency Checker
echo.

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Python NOT installed
    echo.
    echo Install Python from: https://www.python.org/downloads/
    echo Make sure to check "Add Python to PATH" during installation
    echo.
    pause
    exit /b 1
) else (
    echo ✅ Python installed
    python --version
)

echo.

REM Check pip
pip --version >nul 2>&1
if errorlevel 1 (
    echo ❌ pip NOT installed
    echo.
    echo Run: python -m pip install --upgrade pip
    echo.
    pause
    exit /b 1
) else (
    echo ✅ pip installed
    pip --version
)

echo.

REM Create venv if needed
if not exist "venv" (
    echo 📦 Creating virtual environment...
    python -m venv venv
    call venv\Scripts\activate.bat
    echo ✅ Virtual environment created
) else (
    echo ✅ Virtual environment exists
    call venv\Scripts\activate.bat
)

echo.

REM Install requirements
echo 📥 Installing/Checking dependencies...
pip install -q -r requirements.txt

if errorlevel 1 (
    echo ❌ Failed to install dependencies
    echo.
    echo Try running manually:
    echo   pip install -r requirements.txt
    echo.
    pause
    exit /b 1
) else (
    echo ✅ All dependencies installed
)

echo.
echo ✅ All checks passed! You can now run: python app.py
echo.
pause
