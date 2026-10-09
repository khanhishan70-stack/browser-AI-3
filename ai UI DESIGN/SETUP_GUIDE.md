# AI VOICE ASSISTANT - SETUP GUIDE

## Quick Start

### Step 1: Backend Setup
1. Open Command Prompt/PowerShell
2. Navigate to the `backend` folder:
   ```
   cd backend
   ```

3. Run the startup script (Windows):
   ```
   start.bat
   ```
   
   Or Linux/Mac:
   ```
   bash start.sh
   ```

### Step 2: Get Groq API Key
1. Visit https://console.groq.com
2. Sign up/Login
3. Create new API key
4. Copy the key

### Step 3: Configure .env
1. Open `backend/.env` file
2. Replace `GROQ_API_KEY` with your key:
   ```
   GROQ_API_KEY=your_actual_key_here
   ```

### Step 4: Install Dependencies
The startup script installs them automatically, or manually:
```
pip install -r requirements.txt
```

### Step 5: Run Backend
```
python app.py
```
You should see:
```
🔥 AI Voice Assistant Backend Starting...
🎤 Listening on http://localhost:5000
```

### Step 6: Open Frontend
1. Open `index.html` in your browser
2. You should see "Connected to AI Assistant" message

## Supported Commands

### Voice Commands
- "Calculate 2 plus 2" → Returns: The answer is 4
- "What's the time?" → Returns: Current time
- "What's the date?" → Returns: Today's date
- "Open Chrome" → Opens Chrome browser
- "Lock my PC" → Locks the computer
- "Open Google" → Opens Google in browser
- "Save my browser" → Saves running browsers
- "Restore browsers" → Opens saved browsers

### Search Mode Commands
- Toggle search mode for AI Q&A
- Ask any general question

## Features

✅ Voice Input (Microphone)
✅ Voice Output (Text-to-Speech)
✅ AI Chat (Groq LLM)
✅ System Control (Lock, Shutdown)
✅ Browser Management
✅ App Launcher
✅ Calculator
✅ Time/Date Info
✅ WhatsApp Integration

## Troubleshooting

### "Connection failed" message
- Make sure Python backend is running (on port 5000)
- Check firewall settings
- Try: http://localhost:5000/api/health

### Microphone not working
- Check Windows microphone permissions
- Test microphone in Settings → Sound
- Ensure microphone is not muted

### API Key errors
- Verify key is in .env file (no quotes needed)
- Check key is valid at https://console.groq.com
- Ensure .env file is in the `backend` folder

### Speech Recognition Errors
- Need active internet connection (Google Speech API)
- May need to install portaudio for microphone

## File Structure

```
ai UI DESIGN/
├── index.html              # Main frontend
├── script.js              # Frontend logic (UPDATED)
├── styles.css             # Styling
└── backend/
    ├── app.py             # Flask backend (NEW)
    ├── requirements.txt   # Dependencies (NEW)
    ├── .env.example       # Config template (NEW)
    ├── .env               # Config (create from .env.example)
    ├── start.bat          # Windows startup (NEW)
    ├── start.sh           # Linux/Mac startup (NEW)
    ├── README.md          # Backend docs (NEW)
    └── setup_guide.md     # This file
```

## API Endpoints Reference

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | /api/chat | Send message to AI |
| POST | /api/voice/listen | Transcribe speech |
| POST | /api/voice/speak | Convert text to speech |
| POST | /api/system/lock | Lock PC |
| POST | /api/system/shutdown | Shutdown PC |
| POST | /api/browser/save | Save browser state |
| POST | /api/browser/restore | Restore browsers |
| GET | /api/health | Check connection |

## Next Steps

1. ✅ Backend running
2. ✅ API keys configured
3. ✅ Frontend connected
4. 🎤 Test voice input
5. 🔊 Test voice output
6. 💬 Try commands and AI search

Enjoy your AI Voice Assistant! 🚀
