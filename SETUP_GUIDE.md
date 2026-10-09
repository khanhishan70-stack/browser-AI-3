# NEXORA Browser - Setup Guide

A Chromium-based AI browser with ESTA AI assistant, offline AI (Ollama), YouTube downloader, and more.

---

## Quick Start (new PC)

### 1. First run — one time only

Double-click **`setup.bat`**. It automatically installs and configures everything:

1. **Python 3.13** (if not installed)
2. **Ollama** (offline AI engine)
3. **qwen3:1.7b** offline AI model (~1.4 GB download)
4. Backend environment (`venv` + all Python packages)

> Requires an internet connection. Takes about 5–10 minutes. Downloads are saved to the `setup_downloads` folder.

### 2. Every day

Double-click **`launch.bat`**. It starts everything for you:

- **[1/4]** Checks/fixes the backend `venv` (auto-rebuilds if copied from another PC)
- **[2/4]** Starts Ollama (offline AI on port 11434)
- **[3/4]** Starts the AI backend (writes to `backend.log`)
- **[4/4]** Opens the NEXORA Browser window

That's it — no Node.js, no Git, no commands needed.

---

## What you need to hand a new user

Give them the whole project folder (zipped). Make sure it contains:

- `setup.bat` and `launch.bat`
- `ai UI DESIGN/` (backend)
- `electron/` (browser)
- `node_modules/` (pre-installed Electron — no Node.js needed)

### Delete before sharing (machine-specific or personal)

- `offline_chat_start.bat` — hardcoded paths to another PC
- `electron/dist_v2_COPY/NEO.exe` — stale packaged build, not current
- `backend.log`, `error_log.txt`, `output_log.txt`, `temp_errors.txt`, `NEO_TEST_LOG.txt`
- `ai UI DESIGN/backend/.env` — delete if it contains your personal API keys (new user makes their own)
- Any private images/videos in the root folder

---

## How it works

- **Offline AI** uses Ollama (`http://localhost:11434`, model `qwen3:1.7b`). No Ollama = browser still runs, only offline chat is disabled. The root `start.bat` (llamafile on port 8080) is legacy and unused.
- **AI backend** runs from `ai UI DESIGN/backend/app.py`, served on `http://127.0.0.1:5000`.
- **Browser** runs from `electron/main.js` via the local `node_modules/electron` binary.
- The `venv` inside `ai UI DESIGN/backend` is tied to the PC that created it — `launch.bat` rebuilds it automatically on a new PC.

---

## Troubleshooting

**Browser won't start:**
- Make sure `setup.bat` completed without errors first.
- From the root, try `node_modules\electron\dist\electron.exe electron\main.js --no-sandbox`.

**AI not responding:**
- Check the `backend.log` file for errors.
- Make sure Ollama is running: `http://localhost:11434` should answer `/api/show`.
- Backend health: `curl http://127.0.0.1:5000/api/health` should return `offline_chat.available: true`.

**YouTube downloads failing:**
- `yt-dlp` is installed with the backend. Merging high-quality video needs `ffmpeg` (add it to PATH if missing).

**No sound:**
- Check system volume and the browser's audio settings.

---

## Important: the backend venv is machine-bound

`ai UI DESIGN/backend/venv/pyvenv.cfg` points to the Python installation that created it. If `launch.bat` can't run it on a new PC it **recreates the venv and reinstalls everything automatically** — this is expected and normal on the first start after copying the folder.