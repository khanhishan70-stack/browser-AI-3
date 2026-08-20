#!/bin/bash

# ===== AI VOICE ASSISTANT STARTUP SCRIPT (Linux/Mac) =====
echo ""
echo "🚀 AI Voice Assistant - Starting Backend"
echo ""

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is not installed! Please install Python 3.8 or higher."
    exit 1
fi

# Check if venv exists
if [ ! -d "venv" ]; then
    echo "📦 Creating virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
source venv/bin/activate

# Check if requirements are installed
if ! python3 -c "import flask" 2>/dev/null; then
    echo "📥 Installing dependencies..."
    pip install -r requirements.txt
fi

# Check if .env exists
if [ ! -f ".env" ]; then
    echo "⚙️  Creating .env file from .env.example..."
    cp .env.example .env
    echo ""
    echo "📝 Please edit .env and add your GROQ_API_KEY"
    echo "Get it from: https://console.groq.com"
    echo ""
    read -p "Press enter to continue..."
fi

# Run the app
echo ""
echo "✅ Starting Flask server on http://localhost:5000"
echo ""
python3 app.py
