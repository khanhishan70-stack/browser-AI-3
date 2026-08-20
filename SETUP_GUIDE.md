# Neo Browser - Setup Guide

A Chromium-based AI browser with ESTA AI assistant, YouTube downloader, and more.

---

## Prerequisites

Install these first:

1. **Node.js** (v18+) — https://nodejs.org
2. **Python** (3.9+) — https://python.org
3. **Git** — https://git-scm.com
4. **yt-dlp** — https://github.com/yt-dlp/yt-dlp (for YouTube downloads)
5. **ffmpeg** — https://ffmpeg.org (for merging high-quality video)

---

## Step 1 — Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/browser-AI.git
cd browser-AI
```

---

## Step 2 — Install Node dependencies

```bash
npm install
```

This downloads Electron and its dev tools (~180 MB).

---

## Step 3 — Set up the Python backend (AI assistant)

```bash
cd "ai UI DESIGN/backend"

# Create a virtual environment
python -m venv venv

# Activate it
# Windows:
venv\Scripts\activate
# Mac/Linux:
source venv/bin/activate

# Install Python packages
pip install -r requirements.txt

# Create your .env file from the example
copy .env.example .env
```

---

## Step 4 — Get a Groq API Key (free)

The AI assistant uses Groq for fast inference.

1. Go to https://console.groq.com
2. Sign up / log in
3. Create an API key
4. Open `ai UI DESIGN/backend/.env` and replace the `GROQ_API_KEY` line:

```
GROQ_API_KEY=your_key_here
```

---

## Step 5 — Launch the browser

Go back to the project root folder:

```bash
cd ../..

# Windows:
launch.bat

# Mac/Linux:
# Start the backend:
cd "ai UI DESIGN/backend"
source venv/bin/activate
python app.py &

# Start the browser:
npx electron electron/main.js --no-sandbox
```

The browser opens automatically. The AI assistant connects to the backend.

---

## What you get

- **ESTA AI** — Chat with AI, control browser, search the web
- **Tab system** — Vertical tabs with persistence (tabs survive restart)
- **YouTube downloader** — Download any quality with yt-dlp
- **Home shortcuts** — Quick-access website icons, customizable layout
- **Playlist manager** — Organize downloaded music/videos
- **NEO Editor** — Built-in code/text editor
- **Dark cyberpunk UI** — Customizable themes, live wallpaper support
- **Security assistant** — Browse safely with AI-powered checks
- **Performance modes** — Save/ultra modes for low-RAM systems

---

## Troubleshooting

**Browser won't start:**
- Make sure `npm install` completed without errors
- Try: `npx electron electron/main.js --no-sandbox`

**AI not responding:**
- Check that `app.py` is running in the backend folder
- Verify your Groq API key is valid in `.env`
- Backend runs on http://localhost:5000

**YouTube downloads failing:**
- Install yt-dlp: `pip install yt-dlp` or download from GitHub
- Install ffmpeg and add it to your system PATH

**No sound:**
- Check system volume and browser audio settings
