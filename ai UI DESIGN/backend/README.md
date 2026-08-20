# AI Voice Assistant Backend

A Python Flask backend for the AI Voice Assistant application with Groq AI integration.

## Features

- 🎤 Speech Recognition (Google Speech API)
- 🔊 Text-to-Speech (pyttsx3)
- 🤖 AI Chat with Groq LLM
- 💻 System Control (Lock, Shutdown, etc.)
- 🌐 Browser Management
- 📱 WhatsApp Integration
- 🧮 Calculator
- ⏰ Time/Date Info

## Installation

### 1. Create Virtual Environment
```bash
python -m venv venv
venv\Scripts\activate
```

### 2. Install Dependencies
```bash
pip install -r requirements.txt
```

### 3. Setup Environment Variables
```bash
cp .env.example .env
# Edit .env and add your Groq API key from https://console.groq.com
```

### 4. Run the Server
```bash
python app.py
```

Server will start at `http://localhost:5000`

## API Endpoints

### Chat
- **POST** `/api/chat`
  - Body: `{"message": "your message", "mode": "command|search"}`
  - Response: `{"response": "assistant response"}`

### Voice
- **POST** `/api/voice/listen` - Transcribe speech to text
- **POST** `/api/voice/speak` - Convert text to speech
  - Body: `{"text": "text to speak"}`

### System
- **POST** `/api/system/lock` - Lock the PC
- **POST** `/api/system/shutdown` - Shutdown PC (10 sec delay)

### Browser
- **POST** `/api/browser/save` - Save running browsers
- **POST** `/api/browser/restore` - Restore saved browsers

### Health
- **GET** `/api/health` - Check server status

## Frontend Integration

Update your `script.js` to call these endpoints:

```javascript
// Send message
async function sendMessage(message, mode = 'command') {
  const response = await fetch('http://localhost:5000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, mode })
  });
  return await response.json();
}

// Listen to voice
async function listenVoice() {
  const response = await fetch('http://localhost:5000/api/voice/listen', {
    method: 'POST'
  });
  return await response.json();
}

// Speak response
async function speakResponse(text) {
  await fetch('http://localhost:5000/api/voice/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
}
```

## Supported Commands

### General
- `time` - Current time
- `date` - Today's date
- `calculate [expression]` - Math calculation
- `search [query]` - AI search
- `switch to search mode` - Enable AI search
- `switch to command mode` - Enable command mode

### Applications
- `open [app]` - Open application (chrome, firefox, notepad, calculator, etc.)
- `open youtube` - Open YouTube
- `open google` - Open Google
- `open whatsapp` - Open WhatsApp Web

### System Control
- `lock my pc` - Lock the computer
- `shut down my pc` - Shutdown PC (10 second delay)
- `refresh my desktop` - Refresh desktop

### Browser Management
- `save my browser` - Save running browsers
- `open my browsers` - Restore saved browsers

### Communication
- `message mom [message]` - Send WhatsApp message to mom

## Requirements

- Python 3.8+
- Microphone (for speech recognition)
- Speaker (for text-to-speech)
- Internet connection (for AI, speech recognition, browser)
- Groq API key

## Troubleshooting

### Microphone not working
- Check microphone permissions
- Test with: `python -c "import speech_recognition as sr; sr.Microphone().list_microphone_indexes()"`

### Speech recognition errors
- Ensure internet connection
- Google API may rate limit - add delays between requests

### Text-to-speech issues
- Check Windows narrator settings
- Try: `python -c "import pyttsx3; pyttsx3.init().say('test'); pyttsx3.init().runAndWait()"`

## License

MIT
