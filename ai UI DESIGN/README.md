# 🎤 ESTA - AI Voice Assistant

**ESTA** (Enhanced Smart Talking Assistant) is a modern AI-powered voice assistant with a beautiful web UI, Python backend, and Groq AI integration. Activate with **"HELLO ESTA"** and give voice commands, execute system tasks, or search the web.

![AI Assistant UI](https://img.shields.io/badge/Status-Production%20Ready-brightgreen)
![Python](https://img.shields.io/badge/Python-3.8+-blue)
![Flask](https://img.shields.io/badge/Flask-2.3+-lightblue)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-yellow)

## 🌟 Features

- 🎤 **Wake Word Detection** - Activate ESTA by saying "HELLO ESTA"
- 🔊 **Real-time Speech Recognition** - Convert voice to text using Google Speech API
- 📢 **Text-to-Speech** - AI responses spoken aloud with female voice
- 🤖 **Groq AI Integration** - Fast, intelligent responses using Llama 3.3 LLM
- 💻 **System Commands** - Lock, shutdown, refresh PC via voice
- 🌐 **Web Search Engine** - Search Google and get AI summaries
- 🌐 **Browser Management** - Save and restore browser sessions
- 🎯 **Command Mode** - Execute specific commands (open apps, calculate, etc.)
- 🔍 **Search Mode** - Ask AI any question and search the web
- 📱 **WhatsApp Integration** - Send messages via WhatsApp Web
- 🎨 **Modern UI** - Beautiful dark-themed interface with animations
- ⚡ **Low Latency** - Real-time processing and responses

## 📋 Quick Start

### Prerequisites
- Windows 10/11 or Linux/Mac
- Python 3.8 or higher
- Microphone and Speaker
- Internet connection
- Groq API key (free at https://console.groq.com)

### 1️⃣ Clone/Download Project
```bash
# Download the entire project folder
cd "ai UI DESIGN"
```

### 2️⃣ Setup Backend
```bash
cd backend

# Windows - Run startup script
start.bat

# Linux/Mac - Run startup script
bash start.sh
```

### 3️⃣ Configure API Key
1. Go to https://console.groq.com
2. Create account and generate API key
3. Edit `backend/.env` file
4. Replace `GROQ_API_KEY=` with your actual key

### 4️⃣ Start Backend
The startup script will:
- ✅ Create Python virtual environment
- ✅ Install dependencies
- ✅ Start Flask server on port 5000

You should see:
```
🔥 ESTA Backend Starting...
🎤 Listening on http://localhost:5000
```

### 5️⃣ Open Frontend
Simply open `index.html` in your browser or run a local server:
```bash
# Python 3
python -m http.server 8000

# Then visit http://localhost:8000
```

## 🎯 Usage

### Activating ESTA

**Voice Activation:**
```
You: "HELLO ESTA" (or "HI ESTA" / "HEY ESTA")
ESTA: "Hello! I am ESTA. How can I help you?"
You: [Give your command or ask a question]
```

**Text Activation:**
- Type "HELLO ESTA" in the chat box
- Press Enter or click Send
- ESTA activates and awaits your command/query

### Example Commands

**System Info:**
- "HELLO ESTA" → "What's the time?" → Current time
- "HELLO ESTA" → "What's the date?" → Today's date

**Calculations:**
- "HELLO ESTA" → "Calculate 2 plus 2" → Returns: The answer is 4
- "HELLO ESTA" → "Calculate 10 minus 5" → Returns: The answer is 5

**Applications:**
- "HELLO ESTA" → "Open Chrome" / "Open Firefox" / "Open Edge"
- "HELLO ESTA" → "Open Notepad" / "Open Calculator"

**Websites:**
- "HELLO ESTA" → "Open YouTube"
- "HELLO ESTA" → "Open Google"
- "HELLO ESTA" → "Open WhatsApp"

**System Control:**
- "HELLO ESTA" → "Lock my PC" → Locks computer
- "HELLO ESTA" → "Shut down my PC" → Shutdown (10 sec delay)
- "HELLO ESTA" → "Refresh my desktop" → Refresh desktop

**Browser Management:**
- "HELLO ESTA" → "Save my browser" → Save running browsers
- "HELLO ESTA" → "Restore browsers" → Open saved browsers

**Communication:**
- "HELLO ESTA" → "Message mom Hello!" → Send WhatsApp message

**Web Search & AI Queries:**
- "HELLO ESTA" → "Search for Python tutorials" → Opens Google search + AI summary
- "HELLO ESTA" → "What is artificial intelligence?" → Gets AI answer + opens search
- "HELLO ESTA" → "Find information about machine learning" → Web search + AI response
- "HELLO ESTA" → "Look up quantum computing" → Search + detailed answer

## 📁 Project Structure

```
ai UI DESIGN/
├── index.html                 # Main UI
├── script.js                 # Frontend (Flask API integration)
├── styles.css               # Styling & animations
├── SETUP_GUIDE.md          # Detailed setup instructions
├── COMMAND_REFERENCE.md    # All supported commands
├── README.md               # This file
│
└── backend/
    ├── app.py              # Flask backend (Core application)
    ├── requirements.txt    # Python dependencies
    ├── .env               # Configuration (create from .env.example)
    ├── .env.example       # Config template
    ├── start.bat          # Windows startup script
    ├── start.sh           # Linux/Mac startup script
    └── README.md          # Backend documentation
```

## 🔌 API Endpoints

### Chat & Commands
- **POST** `/api/chat` - Send message/command to AI
  ```json
  {"message": "Calculate 5 plus 3", "mode": "command"}
  ```

### Voice
- **POST** `/api/voice/listen` - Transcribe microphone input
- **POST** `/api/voice/speak` - Convert text to speech
  ```json
  {"text": "Hello, how can I help?"}
  ```

### System
- **POST** `/api/system/lock` - Lock PC
- **POST** `/api/system/shutdown` - Shutdown PC

### Browser
- **POST** `/api/browser/save` - Save browser state
- **POST** `/api/browser/restore` - Restore browsers

### Health
- **GET** `/api/health` - Check server status

## 🛠️ Technology Stack

### Frontend
- HTML5
- CSS3 (Dark theme, animations)
- Vanilla JavaScript (ES6+)
- Fetch API

### Backend
- Python 3.8+
- Flask (Web framework)
- Groq AI API (LLM)
- pyttsx3 (Text-to-speech)
- SpeechRecognition (Voice input)
- PyAutoGUI (System control)

### APIs & Services
- Groq Llama 3.3 70B (AI)
- Google Speech Recognition (Voice input)
- Windows API (System control)

## ⚙️ Configuration

Edit `backend/.env`:
```env
# Required: Your Groq API key
GROQ_API_KEY=gsk_xxxxxxxxxxxxx

# Optional: Customize settings
ASSISTANT_NAME=sunday
PASSWORD=77296
MOM_NUMBER=+919921718519

# Server settings
FLASK_ENV=development
FLASK_DEBUG=True
```

## 🐛 Troubleshooting

### Backend Connection Failed
```
❌ Error: Cannot connect to http://localhost:5000
```
**Solution:**
- Ensure Python backend is running
- Check port 5000 is not in use: `netstat -ano | findstr :5000`
- Restart backend server

### Microphone Not Working
```
❌ OSError: No default microphone
```
**Solution:**
- Check Windows Sound settings
- Allow app microphone permission
- Test microphone: `Settings → Sound → Input`

### API Key Invalid
```
❌ groq.RateLimitError: Invalid API key
```
**Solution:**
- Generate new key at https://console.groq.com
- Ensure key is in `.env` file (no quotes)
- Verify `.env` is in `backend` folder

### Speech Recognition Timeout
```
❌ sr.WaitTimeoutError: Listening timed out
```
**Solution:**
- Speak louder and clearer
- Move closer to microphone
- Check microphone is not muted
- Ensure internet connection

### Port Already in Use
```
❌ OSError: [Errno 10048] Only one usage of each socket address
```
**Solution:**
- Kill process on port 5000:
  ```bash
  netstat -ano | findstr :5000
  taskkill /PID <PID> /F
  ```
- Or run on different port: Edit `app.py` last line

## 📝 Commands by Category

| Category | Examples |
|----------|----------|
| **Info** | time, date, calculate |
| **Apps** | open chrome, open notepad, open vlc |
| **Web** | open youtube, open google, open whatsapp |
| **System** | lock my pc, shut down, refresh |
| **Browser** | save browser, restore browsers |
| **AI** | calculate, search, questions |

## 🚀 Advanced Features

### Custom Commands
Add more apps in `backend/app.py` → `APP_COMMANDS` dict

### Change Voice
Modify `backend/app.py` → `set_female_voice()` function

### Adjust Microphone Sensitivity
Edit `backend/app.py` → `recognizer.energy_threshold` (default: 120)

### Change AI Model
Update `backend/app.py` → model parameter (current: "llama-3.3-70b-versatile")

## 📚 Documentation

- **[SETUP_GUIDE.md](SETUP_GUIDE.md)** - Detailed setup instructions
- **[COMMAND_REFERENCE.md](COMMAND_REFERENCE.md)** - All commands & examples
- **[backend/README.md](backend/README.md)** - Backend API documentation

## 🎓 Learning Resources

- [Groq API Docs](https://console.groq.com/docs)
- [Flask Documentation](https://flask.palletsprojects.com/)
- [SpeechRecognition Docs](https://github.com/Uberi/speech_recognition)
- [pyttsx3 Documentation](https://pyttsx3.readthedocs.io/)

## 🔒 Security Notes

⚠️ **For Production:**
- Use environment variables for all secrets
- Enable HTTPS/SSL for API endpoints
- Add authentication (JWT tokens)
- Rate limit API endpoints
- Validate all user inputs
- Store API keys securely (not in .env)

## 💝 Contributing

Found a bug? Have ideas? 
1. Document the issue
2. Test your changes
3. Submit improvements

## 📄 License

MIT License - Feel free to use and modify

## 🙏 Acknowledgments

Built with:
- [Groq](https://groq.com/) - Fast AI inference
- [Flask](https://flask.palletsprojects.com/) - Web framework
- [Google Speech API](https://cloud.google.com/speech-to-text) - Voice recognition

## 📞 Support

**Having issues?**
1. Check [SETUP_GUIDE.md](SETUP_GUIDE.md) Troubleshooting
2. Review console logs (F12 in browser)
3. Check backend terminal output
4. Verify all dependencies are installed

---

**Made with ❤️ for AI enthusiasts**

🎤 Start using now: `backend/start.bat` (Windows) or `bash backend/start.sh` (Linux/Mac)
