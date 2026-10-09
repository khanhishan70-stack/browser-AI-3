## ✅ AI Voice Assistant - Getting Started Checklist

Complete these steps to get your voice assistant running:

### 📋 Pre-Setup
- [ ] Python 3.8+ installed ([download](https://www.python.org/downloads/))
- [ ] Microphone working and enabled
- [ ] Speaker/Headphones working
- [ ] Internet connection active

### 🔑 API Setup
- [ ] Visit https://console.groq.com
- [ ] Create free account
- [ ] Generate API key
- [ ] Copy the key (starts with `gsk_`)

### 📦 Backend Setup
- [ ] Open Command Prompt/PowerShell
- [ ] Navigate to project folder: `cd "ai UI DESIGN\backend"`
- [ ] Run: `start.bat` (Windows) or `bash start.sh` (Linux/Mac)
- [ ] Wait for: "📦 Creating virtual environment..." ✓
- [ ] Wait for: "📥 Installing dependencies..." ✓
- [ ] See: "⚙️  Creating .env file..." ✓

### ⚙️ Configuration
- [ ] Edit `backend/.env` file
- [ ] Find line: `GROQ_API_KEY=`
- [ ] Paste your API key after `=` (no quotes needed)
- [ ] Save the file
- [ ] Press Enter in startup script to continue

### 🚀 Start Server
- [ ] Backend script runs automatically
- [ ] Look for: `✅ Starting Flask server on http://localhost:5000`
- [ ] See: `* Running on http://127.0.0.1:5000`
- [ ] Leave terminal running

### 🌐 Open Frontend
- [ ] Keep backend running in terminal
- [ ] Open `index.html` in browser OR
- [ ] Run: `python -m http.server 8000` in project root
- [ ] Visit: `http://localhost:8000` (or `http://localhost:8080`)

### ✨ First Test
- [ ] See: "✅ Connected to AI Assistant"
- [ ] Try: "What's the time?" in chat
- [ ] Should get: Current time response
- [ ] Try: Mic button 🎤
- [ ] Say: "Open Google"
- [ ] Should open: Google in browser

### 🎤 Voice Tests
- [ ] Enable Voice Mode (🎤 button)
- [ ] Enable Voice Output (🔊 button)
- [ ] Click Mic button
- [ ] Say: "Calculate 5 plus 3"
- [ ] Should hear: "The answer is 8"

### 🎯 Command Tests
- [ ] "What's the date?" → Should show today's date
- [ ] "Calculate 10 minus 2" → Should show: The answer is 8
- [ ] "Open Chrome" → Should open Chrome
- [ ] "Lock my PC" → Should lock computer

### 🔍 Search Mode
- [ ] Click anywhere to unfocus input
- [ ] Say: "Switch to search mode"
- [ ] Ask: "What is machine learning?"
- [ ] Should get: AI answer to your question

### 🎊 You're All Set!
- [ ] Backend running ✓
- [ ] Frontend working ✓
- [ ] Voice input working ✓
- [ ] Voice output working ✓
- [ ] AI responding ✓

### 📚 Next Steps
1. Read [COMMAND_REFERENCE.md](../COMMAND_REFERENCE.md) for all commands
2. Customize voice and settings in `backend/.env`
3. Add more apps to APP_COMMANDS in `backend/app.py`
4. Try advanced features (browser save/restore)

### 🐛 If Something Doesn't Work

**No "Connected to AI Assistant" message:**
- Check: Is backend running? (Terminal should show Flask running)
- Check: Backend port is 5000
- Check: Firewall is allowing connections

**Microphone not working:**
- Check: Windows Sound settings → Microphone enabled
- Check: App has microphone permission
- Check: Microphone is not muted

**API Key error:**
- Check: Key is in `.env` file correctly
- Check: No extra spaces or quotes
- Check: Key starts with `gsk_`

**Speech not recognized:**
- Check: Speaking clearly
- Check: Microphone is working
- Check: Internet connection active

### 🆘 Still Having Issues?
1. See [SETUP_GUIDE.md](../SETUP_GUIDE.md) → Troubleshooting
2. Check backend terminal for error messages
3. Open browser Console (F12) for frontend errors
4. Verify all files are in correct folders

---

**Congratulations! 🎉 Your AI Voice Assistant is ready!**

Start by saying: "Calculate 2 plus 2" 🎤
