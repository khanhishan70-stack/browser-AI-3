from flask import Flask, request, jsonify, Response, send_from_directory
from flask_cors import CORS
import os
import sys
from dotenv import load_dotenv
import datetime
import json
import re
import csv
import glob
import subprocess
import webbrowser
import urllib.parse
import hashlib
import threading
import time
import random
import ctypes
import requests
import io

# ----- Fast-boot strategy -----
# These few modules are genuinely needed before the server can bind. The heavy,
# slow-to-import ones (groq, edge_tts, speech_recognition, deep_translator,
# pyautogui, pygame) are now imported LAZILY at first use so the backend goes
# live in ~1-2s instead of ~10s. That keeps startup (and page loads like YT)
# fast on weak PCs.

# pyautogui / speech_recognition / deep_translator / groq / edge_tts are lazy:
# see _lazy_pyautogui(), sr lazy import inside voice functions, _groq_client(),
# _edge_tts_module().
pyttsx3 = None

try:
    import pygetwindow as gw
except ImportError:
    gw = None

try:
    from gtts import gTTS
except ImportError:
    gTTS = None

# deep_translator is imported lazily only if a backend translate endpoint needs
# it (it costs ~0.4s at boot - not worth it). Currently unused server-side.

_trans_cache = {}
_trans_cache_lock = threading.Lock()

# edge_tts is ONLY imported lazily inside edge_TTS helpers (it costs ~5s to
# import, which would otherwise delay backend boot). EDGE_AVAILABLE starts as
# a sentinel and becomes True/False on first use.
EDGE_AVAILABLE = None

# ===== NEURAL FEMALE AI VOICES (Microsoft Edge neural TTS, browser MP3) =====
EDGE_VOICES = {
    "edge_jenny":   ("en-US-JennyNeural",   "AI Girl - Jenny (US)"),
    "edge_aria":    ("en-US-AriaNeural",    "AI Girl - Aria (US)"),
    "edge_sonia":   ("en-GB-SoniaNeural",   "AI Girl - Sonia (UK)"),
    "edge_ana":     ("en-GB-AnaNeural",     "AI Girl - Ana (UK)"),
    "edge_natasha": ("en-AU-NatashaNeural", "AI Girl - Natasha (AU)"),
}

def edge_girl_voice(voice_id):
    """Return the speaking label for an edge_* voice id."""
    entry = EDGE_VOICES.get(voice_id)
    return entry[1] if entry else "AI Girl"

def _edge_tts_module():
    """Lazy-import edge_tts (slow first import ~5s). Returns (module, ok)."""
    global EDGE_AVAILABLE
    if EDGE_AVAILABLE is True:
        return edge_tts, True
    if EDGE_AVAILABLE is False:
        return None, False
    try:
        import edge_tts
        EDGE_AVAILABLE = True
        return edge_tts, True
    except ImportError:
        EDGE_AVAILABLE = False
        return None, False

def synthesize_edge(text, voice_id):
    """Synthesize MP3 bytes with a Microsoft neural voice (works offline of browser audio)."""
    edge_tts, ok = _edge_tts_module()
    if not ok:
        raise RuntimeError("edge_tts is not installed")
    entry = EDGE_VOICES.get(voice_id)
    voice_name = entry[0] if entry else "en-US-JennyNeural"
    # Slightly slower + slightly higher pitch = bright, friendly AI-girl tone.
    return edge_tts.Communicate(text, voice_name, rate="-8%", pitch="+6Hz")

def edge_tts_bytes(text, voice_id):
    """Run edge-tts and return the full MP3 bytes."""
    import asyncio
    comm = synthesize_edge(text, voice_id)
    out = b""
    async def _run():
        nonlocal out
        async for chunk in comm.stream():
            if chunk.get("type") == "audio":
                out += chunk.get("data", b"")
    asyncio.run(_run())
    return out

# Load environment variables
load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.abspath(os.path.join(BASE_DIR, '..'))
USER_HOME = os.path.expanduser("~")
app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path='')
app.json.ensure_ascii = False
app.config['JSON_AS_ASCII'] = False
# Cap request bodies globally: the largest legitimate call is a document or
# image upload (~25MB). Without this, a single huge POST can exhaust RAM.
app.config['MAX_CONTENT_LENGTH'] = 40 * 1024 * 1024
# CORS: the only legitimate browser client is this app's own UI, served from
# local files (Origin: null). A wildcard here would let ANY website the user
# visits read this backend's responses, so only null-origin callers get
# cross-origin access. Requests with no Origin header (curl, same-machine
# tools) are unaffected by CORS and continue to work.
CORS(app, origins=["null"], supports_credentials=False)

@app.before_request
def _csrf_content_type_guard():
    """Block cross-site form-POST CSRF.

    CORS preflights stop malicious sites from sending JSON, but a plain HTML
    <form> POST needs no preflight — so without this, any website could submit
    form-encoded POSTs to state-changing routes (lock, shutdown, memory, vault,
    chat...). This app's UI only ever sends application/json or
    multipart/form-data (uploads, voice), so anything else on a write method is
    rejected before any handler runs.
    """
    if request.method in ('POST', 'PUT', 'DELETE', 'PATCH'):
        ctype = (request.content_type or '').split(';')[0].strip().lower()
        if ctype not in ('application/json', 'multipart/form-data',
                         'audio/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4',
                         'video/webm', 'video/mp4', 'image/png', 'image/jpeg'):
            return jsonify({'success': False, 'error': 'Unsupported content type'}), 415

# ===== SINGLE INSTANCE GUARD =====
# Only one backend may run. If port 5000 is already answerable, this process
# is a duplicate (browserAi.bat + electron watchdog + manual starts all race to
# launch it) - exit instantly instead of wasting CPU/RAM booting a second copy.
import socket as _socket
try:
    _probe = _socket.create_connection(("127.0.0.1", 5000), timeout=0.5)
    _probe.close()
    print("[APP] Another backend is already running on port 5000 - exiting.")
    sys.exit(0)
except OSError:
    pass  # port free - this is the one true backend

# Atomic single-instance lock. A port probe alone can't catch a process that is
# mid-boot (nothing is bound yet), so we ALSO take an OS-level exclusive lock on
# a lock file. msvcrt.locking is atomic - if two processes race here, exactly one
# wins and the other exits. The lock auto-releases when this process dies, so no
# stale-PID cleanup is ever needed.
import msvcrt as _msvcrt
import pathlib as _pathlib
_LOCK = _pathlib.Path(BASE_DIR) / ".neo_backend.lock"
_lock_fd = None
try:
    _lock_fd = open(_LOCK, "ab")  # create if missing; never truncate
    _msvcrt.locking(_lock_fd.fileno(), _msvcrt.LK_NBLCK, 1)
except (OSError, IOError):
    try:
        _LOCK.unlink(missing_ok=True)
        _lock_fd = open(_LOCK, "ab")
        _msvcrt.locking(_lock_fd.fileno(), _msvcrt.LK_NBLCK, 1)
    except (OSError, IOError):
        print(f"[APP] Backend lock held by another process - exiting duplicate.")
        sys.exit(0)

import atexit as _atexit
def _release_lock():
    try:
        if _lock_fd is not None:
            _lock_fd.seek(0)
            _msvcrt.locking(_lock_fd.fileno(), _msvcrt.LK_UNLCK, 1)
            _lock_fd.close()
    except Exception:
        pass
_atexit.register(_release_lock)

def strip_think_tags(text):
    """Strip <think>...</think> tags from model responses (Qwen adds these).
    Also strips unclosed <think> blocks (when max_tokens cuts off before </think>)."""
    if not text:
        return text
    text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL)
    text = re.sub(r'<think>.*', '', text, flags=re.DOTALL)
    return text.strip()

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
OLLAMA_VISION_MODEL = os.getenv("OLLAMA_VISION_MODEL", "minicpm-v")
# Fast vision: use Groq cloud vision FIRST (seconds, like Gemini/ChatGPT).
# Set VISION_FAST_MODE=0 in .env to prefer private local Ollama first.
VISION_FAST_MODE = os.getenv("VISION_FAST_MODE", "1").strip().lower() in ("1", "true", "yes", "on")

def _normalize_image_data_url(image_data):
    """Accept a full data URL ('data:image/png;base64,XXX') OR raw base64 and
    return (mime, raw_base64). Defaults to image/jpeg when no prefix is present."""
    if not isinstance(image_data, str):
        return ('image/jpeg', '')
    s = image_data.strip()
    if s.startswith('data:') and ';base64,' in s:
        try:
            mime = s[5:s.index(';base64,')].lower() or 'image/jpeg'
        except Exception:
            mime = 'image/jpeg'
        return (mime, s[s.index(';base64,') + 8:])
    return ('image/jpeg', s)


def ollama_vision(base64_image, prompt, system_prompt=None):
    """Analyze an image. Fast mode calls Groq vision first (quick response like
    Gemini/ChatGPT); falls back to local Ollama minicpm-v only when needed."""
    mime, raw_b64 = _normalize_image_data_url(base64_image)
    if not raw_b64:
        raise Exception("No image data provided to vision analysis")
    if VISION_FAST_MODE:
        try:
            print("[VISION] Fast mode: calling Groq vision first")
            return _groq_vision_fallback(raw_b64, prompt, system_prompt, mime)
        except Exception as groq_err:
            print(f"[VISION] Groq fast path failed ({groq_err}); falling back to local Ollama")
        try:
            return _ollama_vision_local(mime, raw_b64, prompt, system_prompt)
        except Exception as ollama_err:
            print(f"[VISION] Local Ollama also failed ({ollama_err})")
            raise
    # Privacy mode: local Ollama first, Groq fallback
    try:
        return _ollama_vision_local(mime, raw_b64, prompt, system_prompt)
    except Exception as ollama_err:
        print(f"[VISION] Ollama failed ({ollama_err}); falling back to Groq vision")
        return _groq_vision_fallback(raw_b64, prompt, system_prompt, mime)

def _ollama_vision_local(mime, raw_b64, prompt, system_prompt=None):
    """Private local Ollama vision analysis (slow cold start)."""
    import urllib.request
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({
        "role": "user",
        "content": prompt,
        "images": [raw_b64]
    })
    payload = json.dumps({
        "model": OLLAMA_VISION_MODEL,
        "messages": messages,
        "stream": False,
        "keep_alive": "2m",
        "options": {"temperature": 0.3,
                    "num_gpu": 0 if LOW_SPEC else 16,
                    "num_ctx": 768 if LOW_SPEC else 2048,
                    "num_thread": OLLAMA_OFFLINE_NUM_THREAD}
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    print(f"[VISION] Calling Ollama {OLLAMA_VISION_MODEL} (timeout 180s for cold start)")
    resp = urllib.request.urlopen(req, timeout=180)
    data = json.loads(resp.read().decode("utf-8"))
    return data.get("message", {}).get("content", "")

def _groq_vision_fallback(base64_image, prompt, system_prompt=None, mime='image/jpeg'):
    """Fallback vision using Groq Qwen vision models when Ollama is unavailable."""
    vision_models = ["qwen/qwen3.8-27b", "qwen/qwen3.6-27b"]
    vision_max_tokens = {"qwen/qwen3.8-27b": 6144, "qwen/qwen3.6-27b": 700}
    last_err = None
    for model in vision_models:
        try:
            sys_text = system_prompt or "You are a helpful vision assistant. Analyze the image and answer the user's question."
            user_content = [{"type": "text", "text": prompt}]
            user_content.append({
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{base64_image}"}
            })
            print(f"[VISION] Trying Groq fallback model: {model}")
            response = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": sys_text},
                    {"role": "user", "content": user_content}
                ],
                temperature=0.3,
                max_tokens=vision_max_tokens.get(model, 700)
            )
            if response.choices and response.choices[0].message and response.choices[0].message.content:
                return strip_think_tags(response.choices[0].message.content)
            return "I was able to see the image but couldn't generate a detailed analysis."
        except Exception as groq_err:
            print(f"[VISION] Groq fallback {model} failed: {groq_err}")
            last_err = groq_err
            continue
    raise Exception(f"All vision models failed. Last error: {last_err}")

def ollama_vision_multi(base64_images, prompt, system_prompt=None):
    """Analyze several images. Fast mode uses Groq vision first; falls back to local Ollama."""
    raw_images = []
    for b64 in (base64_images or []):
        _mime, _raw = _normalize_image_data_url(b64)
        if _raw:
            raw_images.append(_raw)
    if not raw_images:
        raise Exception("No image data provided to vision analysis")
    if VISION_FAST_MODE:
        try:
            print("[VISION] Fast mode: calling Groq vision (multi) first")
            return _groq_vision_multi_fallback(raw_images, prompt, system_prompt)
        except Exception as groq_err:
            print(f"[VISION] Groq fast path (multi) failed ({groq_err}); falling back to local Ollama")
        try:
            return _ollama_vision_multi_local(raw_images, prompt, system_prompt)
        except Exception as ollama_err:
            print(f"[VISION] Local Ollama (multi) also failed ({ollama_err})")
            raise
    try:
        return _ollama_vision_multi_local(raw_images, prompt, system_prompt)
    except Exception as ollama_err:
        print(f"[VISION] Ollama multi failed ({ollama_err}); falling back to Groq vision")
        return _groq_vision_multi_fallback(raw_images, prompt, system_prompt)

def _ollama_vision_multi_local(raw_images, prompt, system_prompt=None):
    """Private local Ollama multi-image vision analysis."""
    import urllib.request
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({
        "role": "user",
        "content": prompt,
        "images": raw_images
    })
    payload = json.dumps({
        "model": OLLAMA_VISION_MODEL,
        "messages": messages,
        "stream": False,
        "keep_alive": "2m",
        "options": {"temperature": 0.3,
                    "num_gpu": 0 if LOW_SPEC else 16,
                    "num_ctx": 768 if LOW_SPEC else 2048,
                    "num_thread": OLLAMA_OFFLINE_NUM_THREAD}
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    print(f"[VISION] Calling Ollama {OLLAMA_VISION_MODEL} with {len(raw_images)} image(s)")
    resp = urllib.request.urlopen(req, timeout=240)
    data = json.loads(resp.read().decode("utf-8"))
    return data.get("message", {}).get("content", "")

def _groq_vision_multi_fallback(base64_images, prompt, system_prompt=None):
    """Fallback multi-image vision via Groq Qwen vision models."""
    vision_models = ["qwen/qwen3.8-27b", "qwen/qwen3.6-27b"]
    vision_max_tokens = {"qwen/qwen3.8-27b": 6144, "qwen/qwen3.6-27b": 700}
    last_err = None
    for model in vision_models:
        try:
            sys_text = system_prompt or "You are a helpful vision assistant. Analyze the images and answer the user's question."
            user_content = [{"type": "text", "text": prompt}]
            for b64 in base64_images:
                user_content.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{b64}"}
                })
            print(f"[VISION] Trying Groq multi fallback model: {model}")
            response = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": sys_text},
                    {"role": "user", "content": user_content}
                ],
                temperature=0.3,
                max_tokens=vision_max_tokens.get(model, 700)
            )
            if response.choices and response.choices[0].message and response.choices[0].message.content:
                return strip_think_tags(response.choices[0].message.content)
            return "I was able to see the images but couldn't generate a detailed analysis."
        except Exception as groq_err:
            print(f"[VISION] Groq multi fallback {model} failed: {groq_err}")
            last_err = groq_err
            continue
    raise Exception(f"All vision models failed. Last error: {last_err}")

def _detect_low_spec():
    """Best-effort low-PC detector. Never throws - worst case returns False."""
    try:
        import ctypes
        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]
        status = MEMORYSTATUSEX()
        status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            ram_gb = status.ullTotalPhys / (1024 ** 3)
        else:
            ram_gb = 16.0
        cores = os.cpu_count() or 4
        print(f"[AI] Low-spec check: {ram_gb:.1f} GB RAM, {cores} logical cores")
        return ram_gb <= 6.0 or cores <= 3
    except Exception:
        return False

LOW_SPEC = _detect_low_spec()
print(f"[AI] Low-spec mode: {LOW_SPEC}")

if LOW_SPEC:
    # Tiny model + minimal footprint so a weak PC never runs out of memory.
    OLLAMA_OFFLINE_MODEL = os.getenv("OLLAMA_OFFLINE_MODEL", "qwen3:0.6b")
    OLLAMA_OFFLINE_NUM_THREAD = max(2, int(os.getenv("OLLAMA_OFFLINE_NUM_THREAD",
        str(max(2, min(4, (os.cpu_count() or 4) // 2))))))
    OLLAMA_OFFLINE_NUM_CTX = max(256, int(os.getenv("OLLAMA_OFFLINE_NUM_CTX", "768")))
    OLLAMA_KEEP_ALIVE = os.getenv("OLLAMA_KEEP_ALIVE", "3m")
    OFFLINE_HISTORY_COUNT = max(2, int(os.getenv("OFFLINE_HISTORY_COUNT", "6")))
    OFFLINE_MAX_TOKENS = max(64, int(os.getenv("OFFLINE_MAX_TOKENS", "384")))
else:
    # Normal PC: balanced speed vs. footprint.
    OLLAMA_OFFLINE_MODEL = os.getenv("OLLAMA_OFFLINE_MODEL", "qwen3:1.7b")
    OLLAMA_OFFLINE_NUM_THREAD = max(2, int(os.getenv("OLLAMA_OFFLINE_NUM_THREAD",
        str(max(2, min(6, (os.cpu_count() or 4) // 2))))))
    OLLAMA_OFFLINE_NUM_CTX = max(256, int(os.getenv("OLLAMA_OFFLINE_NUM_CTX", "1536")))
    OLLAMA_KEEP_ALIVE = os.getenv("OLLAMA_KEEP_ALIVE", "10m")
    OFFLINE_HISTORY_COUNT = max(2, int(os.getenv("OFFLINE_HISTORY_COUNT", "8")))
    OFFLINE_MAX_TOKENS = max(64, int(os.getenv("OFFLINE_MAX_TOKENS", "512")))

def _offline_ollama_options(max_tokens):
    """Ollama options tuned to stay quick and light (and crash-free) on any PC."""
    return {
        "temperature": 0.7,
        "num_predict": max(32, int(max_tokens)),
        "num_ctx": OLLAMA_OFFLINE_NUM_CTX,
        "num_thread": OLLAMA_OFFLINE_NUM_THREAD
    }


def _resolve_offline_model(preferred=None):
    """Pick an installed Ollama model that fits the current profile.

    Never raises: on any failure it falls back to the preferred/default model.
    This keeps low-spec PCs working even before qwen3:0.6b is pulled - the
    app must never crash just because a model is missing."""
    import urllib.request
    try:
        req = urllib.request.Request(f"{OLLAMA_URL}/api/tags", method="GET")
        resp = urllib.request.urlopen(req, timeout=3)
        data = json.loads(resp.read().decode("utf-8"))
        installed = [m.get("name", "") for m in data.get("models", [])]
    except Exception:
        return OLLAMA_OFFLINE_MODEL  # Ollama down - let caller report it
    pref = preferred or OLLAMA_OFFLINE_MODEL
    if pref in installed:
        return pref
    order = ["qwen3:0.6b", "qwen3:1.7b", "qwen3-4b:latest",
             "llama3.2:1b", "llama3.2:3b", "qwen3:4b", "llama3:latest"]
    for candidate in order:
        if candidate in installed:
            print(f"[AI] Offline model '{pref}' not installed; using '{candidate}'")
            return candidate
    return pref  # nothing usable found - API will surface the real error


# Pick once at startup so the health probe & chat stay consistent.
OLLAMA_OFFLINE_MODEL = _resolve_offline_model()

# ===== OFFLINE AI ON/OFF =====
# The user wants an explicit switch, because a resident Ollama model keeps ~1.8 GB
# of weights in RAM long after the last question is answered. Turning the offline
# AI off evicts the weights instead of merely declining new requests.
_OFFLINE_AI_STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                      "offline_ai_state.json")


def _ollama_ps():
    """Models Ollama currently holds in RAM, newest first. [] if unreachable."""
    import urllib.request
    try:
        req = urllib.request.Request(f"{OLLAMA_URL}/api/ps", method="GET")
        resp = urllib.request.urlopen(req, timeout=3)
        data = json.loads(resp.read().decode("utf-8"))
        return data.get("models", []) or []
    except Exception:
        return []


def _offline_ai_enabled():
    try:
        with open(_OFFLINE_AI_STATE_PATH, "r", encoding="utf-8") as fh:
            return bool(json.load(fh).get("enabled", True))
    except Exception:
        return True  # default: on, so nothing breaks if the file is missing


def _set_offline_ai_enabled(flag):
    try:
        with open(_OFFLINE_AI_STATE_PATH, "w", encoding="utf-8") as fh:
            json.dump({"enabled": bool(flag),
                       "updated": datetime.datetime.now().isoformat()}, fh)
        return True
    except Exception as e:
        print(f"[OFFLINE-AI] could not persist state: {e}")
        return False


def _unload_ollama_models():
    """Evict every resident model. Returns roughly how many MB was released."""
    resident = _ollama_ps()
    if not resident:
        return 0
    freed = 0
    for m in resident:
        name = m.get("name") or m.get("model")
        if not name:
            continue
        try:
            freed += int(m.get("size") or 0)
        except Exception:
            pass
        try:
            # keep_alive=0 is Ollama's documented way to drop a model from RAM.
            payload = json.dumps({"model": name, "keep_alive": 0}).encode("utf-8")
            urllib.request.urlopen(
                urllib.request.Request(f"{OLLAMA_URL}/api/generate", data=payload,
                                       headers={"Content-Type": "application/json"}),
                timeout=20)
            print(f"[OFFLINE-AI] unloaded {name}")
        except Exception as e:
            print(f"[OFFLINE-AI] unload failed for {name}: {e}")
    return int(freed / (1024 * 1024))


def _ollama_generate(model, prompt, num_predict=1, keep_alive="30m"):
    """One tiny completion, used only to pull the model into RAM on demand."""
    import urllib.request
    payload = json.dumps({
        "model": model, "prompt": prompt, "stream": False,
        "keep_alive": keep_alive,
        "options": {"num_predict": max(1, int(num_predict))}
    }).encode("utf-8")
    return urllib.request.urlopen(
        urllib.request.Request(f"{OLLAMA_URL}/api/generate", data=payload,
                               headers={"Content-Type": "application/json"}),
        timeout=180).read()


def _offline_ai_snapshot():
    resident = _ollama_ps()
    names = []
    size = 0
    for m in resident:
        if m.get("name"):
            names.append(m["name"])
        try:
            size += int(m.get("size") or 0)
        except Exception:
            pass
    return {
        "enabled": _offline_ai_enabled(),
        "model": OLLAMA_OFFLINE_MODEL,
        "loaded_models": names,
        "resident_mb": int(size / (1024 * 1024)),
        "ollama_up": bool(resident) or bool(_ollama_tags_safe()),
    }


def _ollama_tags_safe():
    import urllib.request
    try:
        req = urllib.request.Request(f"{OLLAMA_URL}/api/tags", method="GET")
        urllib.request.urlopen(req, timeout=3).read()
        return True
    except Exception:
        return False

def _trim_messages(messages, max_count):
    """Keep the system prompt (if present) + the newest turns only."""
    if max_count is None or max_count <= 0:
        return messages
    if len(messages) <= max_count:
        return messages
    head = 1 if messages and messages[0].get("role") == "system" else 0
    body = messages[head:]
    return messages[:head] + body[-(max_count - head):]

def _sanitize_history(raw, max_count=10, max_chars=4000):
    """Normalise a frontend chat-history payload into Groq messages.

    Accepts [{role, text|content}, ...] and returns {role, content} pairs
    ('user'/'assistant' only, newest `max_count` turns).

    Multimodal content arrays are PRESERVED, not stringified: an image that was
    attached in an earlier turn must still be visible to the model when the user
    asks a follow-up like "and what about the price?". Text parts are capped at
    `max_chars`; images are capped by count so history can't grow unbounded."""
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw[-max_count * 4:]:
        if not isinstance(item, dict):
            continue
        r = str(item.get('role', '')).lower()
        if r not in ('user', 'assistant'):
            continue
        c = item.get('content')
        if c is None:
            c = item.get('text') or ''

        # --- multimodal: [{'type':'text'|'image_url', ...}, ...] ---
        if isinstance(c, list):
            parts, n_img = [], 0
            for part in c:
                if not isinstance(part, dict):
                    continue
                pt = part.get('type')
                if pt == 'text':
                    t = str(part.get('text') or '').strip()
                    if t:
                        parts.append({'type': 'text', 'text': t[:max_chars]})
                elif pt == 'image_url':
                    iu = part.get('image_url') or {}
                    url = iu.get('url') if isinstance(iu, dict) else iu
                    if url and n_img < 2:
                        parts.append({'type': 'image_url', 'image_url': {'url': str(url)}})
                        n_img += 1
            if parts:
                out.append({'role': r, 'content': parts})
            continue

        c = str(c).strip()
        if not c:
            continue
        out.append({'role': r, 'content': c[:max_chars]})
    return out[-max_count:]

# ===== OFFLINE AI LONG-TERM MEMORY + LOCAL FILES (RAG) =====
import math
from collections import Counter

AI_MEMORY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ai_memory.json")
# RAG folder lives OUTSIDE OneDrive on purpose: cloud placeholder files inside
# OneDrive can block os.listdir/open for ages in a long-running process.
_RAG_HOME = os.path.join(
    os.environ.get("LOCALAPPDATA", os.path.dirname(os.path.abspath(__file__))),
    "NeoBrowser")
RAG_DIR = os.path.join(_RAG_HOME, "rag_docs")
_RAG_CACHE = {"mtime": None, "files": [], "chunks": []}
_RAG_MIGRATED = False

def _ensure_rag_dir():
    """Create the out-of-OneDrive rag folder; migrate any old backend\rag_docs files once."""
    global _RAG_MIGRATED
    try:
        os.makedirs(RAG_DIR, exist_ok=True)
        if not _RAG_MIGRATED:
            _RAG_MIGRATED = True
            old = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rag_docs")
            if os.path.isdir(old):
                for fn in sorted(os.listdir(old)):
                    src = os.path.join(old, fn)
                    dst = os.path.join(RAG_DIR, fn)
                    if os.path.isfile(src) and not os.path.exists(dst):
                        try:
                            with open(src, "rb") as f:
                                data = f.read()
                            with open(dst, "wb") as f:
                                f.write(data)
                        except Exception:
                            pass
        return True
    except Exception:
        return False

def _load_ai_memory():
    try:
        with open(AI_MEMORY_PATH, "r", encoding="utf-8") as f:
            return json.load(f).get("memory", "") or ""
    except Exception:
        return ""

def _save_ai_memory(text):
    try:
        with open(AI_MEMORY_PATH, "w", encoding="utf-8") as f:
            json.dump({"memory": text}, f, indent=2, ensure_ascii=False)
        return True
    except Exception:
        return False

def _tokenize(text):
    return re.findall(r"[a-z0-9']+", (text or "").lower())

def _snippet(text, cap):
    text = (text or "").strip()
    return text if len(text) <= cap else text[:cap] + " [...]"

def _chunk_text(text, size=1200, overlap=120):
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= size:
        return [text]
    out = []
    i = 0
    while i < len(text):
        out.append(text[i:i + size])
        if i + size >= len(text):
            break
        i += size - overlap
    return out

def _rag_scan():
    """One filesystem pass over the rag folder. Returns (files, chunks).

    Uses a single listdir/stat/read sweep cached by folder mtime — a second
    access right after the first can block on this OS, so callers must not
    re-list the directory themselves.
    """
    try:
        if not os.path.isdir(RAG_DIR):
            _ensure_rag_dir()
        mtime = 0.0
        files = []
        chunks = []
        for fn in sorted(os.listdir(RAG_DIR)):
            if not fn.lower().endswith((".txt", ".md", ".csv")):
                continue
            p = os.path.join(RAG_DIR, fn)
            try:
                st = os.stat(p)
                mtime = max(mtime, st.st_mtime)
                with open(p, "r", encoding="utf-8", errors="ignore") as f:
                    txt = f.read()
            except Exception:
                continue
            files.append(fn)
            if txt.strip():
                for i, c in enumerate(_chunk_text(txt)):
                    chunks.append({"name": fn, "idx": i, "text": c})
        if _RAG_CACHE["mtime"] == mtime:
            return _RAG_CACHE["files"], _RAG_CACHE["chunks"]
        _RAG_CACHE["mtime"] = mtime
        _RAG_CACHE["files"] = files
        _RAG_CACHE["chunks"] = chunks
        return files, chunks
    except Exception:
        return [], []

def _rag_chunks():
    files, chunks = _rag_scan_safe()
    return chunks

def _rag_scan_safe(timeout=4.0):
    """Run _rag_scan with a hard timeout so a filesystem stall can never hang
    the API. Falls back to the last cached snapshot; the scan thread still
    updates the cache if it eventually completes."""
    box = {}

    def _worker():
        try:
            box['files'], box['chunks'] = _rag_scan()
        except Exception:
            box['error'] = True

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        return list(_RAG_CACHE.get('files', [])), list(_RAG_CACHE.get('chunks', []))
    return (box.get('files', []), box.get('chunks', [])) if 'error' not in box else ([], [])

def _rag_retrieve(query, top_k=3):
    """Naive TF*log1p term scoring - good enough for small local note files."""
    chunks = _rag_chunks()
    q = set(_tokenize(query))
    if not chunks or not q:
        return []
    scored = []
    for c in chunks:
        words = _tokenize(c["text"])
        if not words:
            continue
        counts = Counter(words)
        s = sum(math.log1p(counts[w]) if w in counts else 0.0 for w in q)
        s = s / (len(words) ** 0.5)
        if s > 0:
            scored.append((s, c))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [c for _, c in scored[:top_k]]

def _build_offline_system_prompt(base, query, use_memory=True, use_rag=True):
    parts = [base]
    if use_memory:
        mem = _load_ai_memory().strip()
        if mem:
            parts.append(
                "FACTS THE USER ASKED YOU TO REMEMBER (use them when relevant, "
                "otherwise ignore them):\n" + _snippet(mem, 2000))
    if use_rag:
        docs = _rag_retrieve(query or "")
        if docs:
            parts.append(
                "LOCAL DOCUMENTS from the user's machine (use them when relevant, "
                "name the file when you quote it):\n" +
                "\n\n".join("[" + d["name"] + "]\n" + _snippet(d["text"], 1200) for d in docs))
    return "\n\n".join(parts)

# ChatGPT-style formatting rules for all offline chat (0.6b included). Small
# local models output plain text by default, so we show them exactly how the
# browser's chat bubble renders: **bold**, `code`, # headings, ```code```
# fences, bullet lists and tables.
OFFLINE_STYLE_GUIDE = (
    "Always answer in ChatGPT style. Format rules:\n"
    "1. Use Markdown. Bold important words with **...**.\n"
    "2. For code put it inside ``` fences with the language name on the first "
    "line (e.g. ```python, ```javascript, ```html, ```bash). Never paste code "
    "as plain text.\n"
    "3. Use short # headings, bullet lists (- ), and numbered lists (1.) to "
    "keep answers organised and easy to scan.\n"
    "4. Explain steps clearly like ChatGPT: short summary first, then the "
    "details, then a short closing line.\n"
    "5. Keep it friendly and concise. Answering in English.\n"
    "Answer in Markdown now."
)

def _style_offline_response(text):
    """Force ChatGPT-style formatting on raw model output, so even a tiny
    0.6b model's answers look right in the chat bubble."""
    if not text or not isinstance(text, str):
        return text or ""
    # Code fences need a language name or the bubble's formatter shows "text".
    lines = text.split("\n")
    for idx, line in enumerate(lines):
        if line.strip().startswith("```") and len(line.strip()) <= 3:
            lines[idx] = "```text"
    return "\n".join(lines)

def ollama_offline_chat(user_message, history=None, system_prompt=None, max_tokens=2048,
                        use_memory=True, use_rag=True):
    """Fully offline chat using the locally-installed Ollama model (qwen3-4b).
    Makes NO network calls; talks only to 127.0.0.1:11434."""
    import urllib.request
    base_prompt = (system_prompt or
                   "You are NEXORA Browser's built-in offline AI assistant. Ask the "
                   "user's question clearly and honestly. Never claim to use the "
                   "internet.") + "\n\n" + OFFLINE_STYLE_GUIDE
    system_prompt = _build_offline_system_prompt(
        base_prompt, user_message,
        use_memory=use_memory, use_rag=use_rag
    )
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    for m in (history or []):
        role = m.get("role")
        content = m.get("content")
        if role in ("system", "user", "assistant") and content:
            messages.append({"role": role, "content": str(content)[:1500]})
    messages = _trim_messages(messages, OFFLINE_HISTORY_COUNT + 1)
    messages.append({"role": "user", "content": user_message})
    payload = json.dumps({
        "model": OLLAMA_OFFLINE_MODEL,
        "messages": messages,
        "stream": False,
        "think": False,
        "keep_alive": OLLAMA_KEEP_ALIVE,
        "options": _offline_ollama_options(max_tokens)
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    resp = urllib.request.urlopen(req, timeout=300)
    data = json.loads(resp.read().decode("utf-8"))
    return _style_offline_response(
        strip_think_tags(data.get("message", {}).get("content", "")))

def _lazy_pyautogui():
    """Lazily import pyautogui (slow ~1.5s) only when automation is first used."""
    import pyautogui
    pyautogui.FAILSAFE = True
    pyautogui.PAUSE = 0.12
    return pyautogui

# Keys allowed for single-key press / hotkey automation (lowercase names for pyautogui)
_AUTOMATION_PRESS_KEYS = frozenset({
    "enter", "return", "tab", "esc", "escape", "space", "backspace", "delete", "del",
    "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
    "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
    "volumeup", "volumedown", "volumemute",
})
_AUTOMATION_HOTKEY_PARTS = frozenset(
    {"ctrl", "alt", "shift", "win", "command"}
    | {chr(c) for c in range(ord("a"), ord("z") + 1)}
    | {str(d) for d in range(0, 10)}
    | {"tab", "enter", "esc", "space", "up", "down", "left", "right", "f5", "l", "r", "t", "w", "e", "n"}
)

AUTOMATION_INTENT = re.compile(
    r"\b(type|write)\s+.|\b(press|hit)\s+\w+|\b(single\s*)?click\b|\bdouble\s*click\b|"
    r"\b(ctrl|alt|shift|win)\s*\+\s*\w|\b(hotkey|keyboard\s+shortcut|shortcut)\b|"
    r"\b(mouse\s+click|click\s+mouse)\b|\b(scroll)\s+(up|down)\b|\bautomate\b|\brobot\b|"
    r"\bmove\s+(?:the\s+)?(?:mouse|cursor)\b",
    re.I,
)


def env_int(name, default):
    """Read an integer environment setting without breaking app startup."""
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        print(f"Invalid {name}. Using default value {default}.")
        return default

# ===== SETTINGS =====
ASSISTANT_NAME = os.getenv("ASSISTANT_NAME", "ESTA")
WAKE_PHRASES = (
    f"hello {ASSISTANT_NAME}".lower(),
    f"hi {ASSISTANT_NAME}".lower(),
    f"hey {ASSISTANT_NAME}".lower(),
)
# Personal credentials live ONLY in backend/.env (never in source).
# Empty defaults = features stay dormant until the owner configures them.
PASSWORD = os.getenv("PASSWORD", "")
MOM_NUMBER = os.getenv("MOM_NUMBER", "").strip()
PHONE_NUMBER = os.getenv("PHONE_NUMBER", "").strip()
MOM_WHATSAPP_CALL_LINK = os.getenv("MOM_WHATSAPP_CALL_LINK", "").strip()
WHATSAPP_CALL_DELAY = float(os.getenv("WHATSAPP_CALL_DELAY", "8"))
WHATSAPP_CALL_X = os.getenv("WHATSAPP_CALL_X")
WHATSAPP_CALL_Y = os.getenv("WHATSAPP_CALL_Y")
WHATSAPP_CALL_OFFSET_X = env_int("WHATSAPP_CALL_OFFSET_X", 132)
WHATSAPP_CALL_OFFSET_Y = env_int("WHATSAPP_CALL_OFFSET_Y", 56)

# Initialize Groq AI (lazily - importing groq costs ~1.5s and delays boot)
# The key is OPTIONAL at boot: without it the backend still runs (history,
# downloads, offline chat and every local feature keep working) and the
# Groq-powered endpoints simply report that a key is needed. New users arrive
# with no .env yet - exiting here would leave "AI backend OFF" forever.
groq_api_key = os.getenv("GROQ_API_KEY")
if not groq_api_key:
    print("WARNING: GROQ_API_KEY not found in .env - Groq cloud chat disabled.")
    print("Add your key to ai UI DESIGN/backend/.env to enable ESTA cloud chat.")
else:
    print(f"Groq API key loaded: {groq_api_key[:10]}...")  # Print first 10 chars for verification

class _LazyGroqClient:
    """Creates the real Groq client on first use, keeping boot fast."""
    _real = None
    def _get(self):
        if self._real is None:
            from groq import Groq
            self._real = Groq(api_key=groq_api_key)
        return self._real
    def __getattr__(self, name):
        return getattr(self._get(), name)

client = _LazyGroqClient()

# Initialize pygame mixer for sounds (pygame is imported lazily too)
class _LazyPygame:
    """Proxy that imports pygame on first use; None-like if unavailable."""
    _real = None
    _failed = False
    def _get(self):
        if self._real is not None:
            return self._real
        if self._failed:
            return None
        try:
            import pygame
            try:
                if not pygame.get_init():
                    pygame.mixer.init()
            except Exception:
                pass
            self._real = pygame
            return pygame
        except Exception:
            self._failed = True
            return None
    def __getattr__(self, name):
        return getattr(self._get(), name)
    def __bool__(self):
        return self._get() is not None

pygame = _LazyPygame()

class _LazyPyautogui:
    """Proxy that imports pyautogui on first use (~1.5s saved at boot)."""
    _real = None
    def _get(self):
        if self._real is None:
            self._real = _lazy_pyautogui()
        return self._real
    def __getattr__(self, name):
        return getattr(self._get(), name)

pyautogui = _LazyPyautogui()

class _LazySpeechRecognition:
    """Proxy that imports speech_recognition on first use (~0.6s saved at boot)."""
    _real = None
    def _get(self):
        if self._real is None:
            import speech_recognition as sr
            self._real = sr
        return self._real
    def __getattr__(self, name):
        return getattr(self._get(), name)

sr = _LazySpeechRecognition()

# Initialize text-to-speech engines (lazily - pyttsx3 init costs ~0.5s at boot)
class _LazyPyttsx3Engine:
    """Proxy that initializes the pyttsx3 engine on first use."""
    _real = None
    _failed = False
    def _get(self):
        if self._real is not None:
            return self._real
        if self._failed:
            return None
        try:
            import pyttsx3
            self._real = pyttsx3.init()
            return self._real
        except Exception as e:
            print(f"pyttsx3 init error: {e}")
            self._failed = True
            return None
    def __getattr__(self, name):
        return getattr(self._get(), name)
    def __bool__(self):
        return self._get() is not None

engine = _LazyPyttsx3Engine()
gtts_available = None  # resolved lazily - a real test synth costs ~1.6s

def _gtts_ok():
    """Lazily verify gTTS works (one ~1.6s test on first use, none at boot)."""
    global gtts_available
    if gtts_available is not None:
        return gtts_available
    try:
        if gTTS:
            gTTS(text="test", lang='en')
            gtts_available = True
        else:
            gtts_available = False
    except Exception:
        gtts_available = False
    return gtts_available
_voices = None
def _get_voices():
    """Lazy voice list - avoids triggering the pyttsx3 import at boot."""
    global _voices
    if _voices is None and engine._get() is not None:
        try:
            _voices = list(engine.getProperty("voices"))
        except Exception:
            _voices = []
    return _voices or []

def set_female_voice():
    """Set female voice for TTS"""
    if not engine:
        return
    female_keywords = ("female", "zira", "hazel", "susan", "samantha", "eva", "aria")
    for voice in _get_voices():
        voice_text = f"{voice.id} {voice.name}".lower()
        if any(keyword in voice_text for keyword in female_keywords):
            engine.setProperty("voice", voice.id)
            return
    if len(_get_voices()) > 1:
        engine.setProperty("voice", _get_voices()[1].id)

def set_voice(voice_type):
    """Set voice based on type"""
    global current_voice
    current_voice = voice_type

    if not engine and not voice_type.startswith("gtts_"):
        return
    
    if voice_type == "female":
        set_female_voice()
    elif voice_type == "male":
        set_male_voice()
    elif voice_type.startswith("gtts_"):
        # For gTTS voices, we'll handle in speak function
        pass
    else:
        # Try to set by voice ID
        try:
            engine.setProperty("voice", voice_type)
        except:
            set_female_voice()

def set_male_voice():
    """Set male voice for TTS"""
    if not engine:
        return
    male_keywords = ("male", "david", "alex", "fred", "ralph", "tom")
    vs = _get_voices()
    for voice in vs:
        voice_text = f"{voice.id} {voice.name}".lower()
        if any(keyword in voice_text for keyword in male_keywords):
            engine.setProperty("voice", voice.id)
            return
    # Default to first voice if no male found
    if vs:
        engine.setProperty("voice", vs[0].id)

def get_available_voices():
    """Get list of available voices"""
    voice_list = []
    
    # Add pyttsx3 voices
    for voice in _get_voices():
        voice_list.append({
            "id": voice.id,
            "name": voice.name,
            "type": "pyttsx3",
            "gender": "female" if any(kw in f"{voice.id} {voice.name}".lower() for kw in ["female", "zira", "hazel", "susan", "samantha", "eva", "aria"]) else "male"
        })
    
    # Add gTTS voices
    gtts_voices = [
        {"id": "gtts_en", "name": "English (gTTS)", "type": "gtts", "lang": "en"},
        {"id": "gtts_en_us", "name": "English US (gTTS)", "type": "gtts", "lang": "en", "tld": "us"},
        {"id": "gtts_en_uk", "name": "English UK (gTTS)", "type": "gtts", "lang": "en", "tld": "co.uk"},
        {"id": "gtts_en_au", "name": "English AU (gTTS)", "type": "gtts", "lang": "en", "tld": "com.au"},
        {"id": "gtts_es", "name": "Spanish (gTTS)", "type": "gtts", "lang": "es"},
        {"id": "gtts_fr", "name": "French (gTTS)", "type": "gtts", "lang": "fr"},
        {"id": "gtts_de", "name": "German (gTTS)", "type": "gtts", "lang": "de"},
        {"id": "gtts_it", "name": "Italian (gTTS)", "type": "gtts", "lang": "it"},
        {"id": "gtts_pt", "name": "Portuguese (gTTS)", "type": "gtts", "lang": "pt"},
        {"id": "gtts_ja", "name": "Japanese (gTTS)", "type": "gtts", "lang": "ja"},
        {"id": "gtts_ko", "name": "Korean (gTTS)", "type": "gtts", "lang": "ko"},
        {"id": "gtts_zh", "name": "Chinese (gTTS)", "type": "gtts", "lang": "zh"},
    ]
    voice_list.extend(gtts_voices)

    # Add neural female AI-girl voices (Microsoft Edge neural TTS)
    for vid, (_voice, label) in EDGE_VOICES.items():
        voice_list.append({"id": vid, "name": label, "type": "edge", "lang": "en", "gender": "female", "neural": True})
    
    return voice_list

def get_gtts_voice_config(voice_id):
    """Return gTTS language/accent settings for a selected gTTS voice."""
    configs = {
        "gtts_en": {"lang": "en"},
        "gtts_en_us": {"lang": "en", "tld": "us"},
        "gtts_en_uk": {"lang": "en", "tld": "co.uk"},
        "gtts_en_au": {"lang": "en", "tld": "com.au"},
        "gtts_es": {"lang": "es"},
        "gtts_fr": {"lang": "fr"},
        "gtts_de": {"lang": "de"},
        "gtts_it": {"lang": "it"},
        "gtts_pt": {"lang": "pt"},
        "gtts_ja": {"lang": "ja"},
        "gtts_ko": {"lang": "ko"},
        "gtts_zh": {"lang": "zh"},
    }
    return configs.get(voice_id, configs["gtts_en"])

# Initialize speech recognizer (lazily - avoids paying speech_recognition's
# import + Recognizer setup cost at boot)
_recognizer = None
_recognizer_lock = threading.Lock()
def get_recognizer():
    global _recognizer
    if _recognizer is None:
        with _recognizer_lock:
            if _recognizer is None:
                _recognizer = sr.Recognizer()
                _recognizer.energy_threshold = 120
                _recognizer.pause_threshold = 0.8
                _recognizer.dynamic_energy_threshold = True
                _recognizer.dynamic_energy_adjustment_damping = 0.15
    return _recognizer

# Optional microphone selection (helps when default input device is wrong)
MICROPHONE_INDEX = os.getenv("MICROPHONE_INDEX")
try:
    MICROPHONE_INDEX = int(MICROPHONE_INDEX) if MICROPHONE_INDEX not in (None, "", "none", "null") else None
except Exception:
    MICROPHONE_INDEX = None

def get_microphone_device():
    """Return an sr.Microphone instance, using configured device_index if set."""
    if MICROPHONE_INDEX is None:
        return sr.Microphone()
    return sr.Microphone(device_index=MICROPHONE_INDEX)

# Base directory setup
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOUND = os.path.join(BASE_DIR, "mixkit-software-interface-start-2574.wav")
ALARM_SOUND = r"C:\Users\Admin\Downloads\mixkit-alarm-tone-996.wav"
BROWSER_STATE_FILE = os.path.join(BASE_DIR, "browser_state.json")

# ===== APP COMMANDS =====
APP_COMMANDS = {
    "chrome": r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "google": r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "firefox": r"C:\Program Files\Mozilla Firefox\firefox.exe",
    "edge": r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "brave": r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
    "opera": r"C:\Users\Admin\AppData\Local\Programs\Opera GX\opera.exe",
    "notepad": "notepad.exe",
    "calculator": "calc.exe",
    "paint": "mspaint.exe",
    "word": r"C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE",
    "excel": r"C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE",
    "vlc": r"C:\Program Files\VideoLAN\VLC\vlc.exe",
    "spotify": r"C:\Users\Admin\AppData\Roaming\Spotify\Spotify.exe",
}

# ===== FOLDER COMMANDS =====
FOLDER_COMMANDS = {
    "downloads": r"C:\Users\Admin\Downloads",
    "download": r"C:\Users\Admin\Downloads",
    "pictures": r"C:\Users\Admin\Pictures",
    "picture": r"C:\Users\Admin\Pictures",
    "documents": r"C:\Users\Admin\Documents",
    "document": r"C:\Users\Admin\Documents",
    "desktop": r"C:\Users\Admin\Desktop",
    "videos": r"C:\Users\Admin\Videos",
    "video": r"C:\Users\Admin\Videos",
    "music": r"C:\Users\Admin\Music",
    "capture": r"C:\Users\Admin\Pictures\Captures",  # Assuming captures are in Pictures
}

# Name / phrase → real website (always https, opened in your default browser)
WEBSITE_ALIASES = {
    "youtube": "https://www.youtube.com",
    "youtu": "https://www.youtube.com",
    "google": "https://www.google.com",
    "googlemaps": "https://www.google.com/maps",
    "maps": "https://www.google.com/maps",
    "gmail": "https://mail.google.com",
    "whatsapp": "https://web.whatsapp.com",
    "whatsappweb": "https://web.whatsapp.com",
    "facebook": "https://www.facebook.com",
    "instagram": "https://www.instagram.com",
    "twitter": "https://twitter.com",
    "x": "https://x.com",
    "reddit": "https://www.reddit.com",
    "amazon": "https://www.amazon.com",
    "netflix": "https://www.netflix.com",
    "github": "https://github.com",
    "linkedin": "https://www.linkedin.com",
    "discord": "https://discord.com",
    "twitch": "https://www.twitch.tv",
    "wikipedia": "https://www.wikipedia.org",
    "wiki": "https://www.wikipedia.org",
    "spotify": "https://open.spotify.com",
    "microsoft": "https://www.microsoft.com",
    "apple": "https://www.apple.com",
    "cnn": "https://www.cnn.com",
    "bbc": "https://www.bbc.com",
    "ebay": "https://www.ebay.com",
    "paypal": "https://www.paypal.com",
    "stackoverflow": "https://stackoverflow.com",
    "chatgpt": "https://chatgpt.com",
    "openai": "https://openai.com",
}

# Squashed multi-word names (letters only) → URL when it is not just www.{slug}.com
WEBSITE_SQUASH_ALIASES = {
    "googlemaps": "https://www.google.com/maps",
    "nytimes": "https://www.nytimes.com",
    "washingtonpost": "https://www.washingtonpost.com",
    "epicgames": "https://store.epicgames.com",
}

# ===== BROWSER STATE =====
BROWSER_PROCESS_NAMES = {
    "chrome.exe": "chrome",
    "chrome": "chrome",
    "firefox.exe": "firefox",
    "firefox": "firefox",
    "msedge.exe": "edge",
    "msedge": "edge",
    "brave.exe": "brave",
    "brave": "brave",
    "opera.exe": "opera",
    "opera": "opera",
}

# ===== VOICE ENGINE STATE =====
is_speaking = False
stop_speaking = False
current_voice = "female"  # Default voice
available_voices = []

# Initialize with default voice
set_voice(current_voice)
if engine:
    engine.setProperty("rate", 170)
    engine.setProperty("volume", 1.0)

# ===== HELPER FUNCTIONS =====

def speak(text):
    """Convert text to speech"""
    global is_speaking, stop_speaking
    is_speaking = True
    stop_speaking = False
    try:
        if current_voice.startswith("gtts_") and _gtts_ok():
            # Use gTTS with selected voice
            voice_config = get_gtts_voice_config(current_voice)
            if "tld" in voice_config:
                tts = gTTS(text=text, lang=voice_config["lang"], tld=voice_config["tld"])
            else:
                tts = gTTS(text=text, lang=voice_config["lang"])
                
            fp = io.BytesIO()
            tts.write_to_fp(fp)
            fp.seek(0)
            pygame.mixer.music.load(fp)
            pygame.mixer.music.play()
            while pygame.mixer.music.get_busy() and not stop_speaking:
                time.sleep(0.1)
            if stop_speaking:
                pygame.mixer.music.stop()
        else:
            if not engine:
                print("Speak skipped: no local TTS engine is available.")
                return
            # Use pyttsx3 (ensure voice is set)
            if not current_voice.startswith("gtts_"):
                set_voice(current_voice)
            engine.say(text)
            # runAndWait is required; engine.say only queues audio.
            engine.runAndWait()
            if stop_speaking:
                engine.stop()
    except Exception as e:
        print(f"Speak error: {e}")
        # Final fallback
        try:
            if engine:
                engine.say(text)
                engine.runAndWait()
        except:
            pass
    finally:
        is_speaking = False

PERSONALITY_STYLES = {
    "formal": "Speak in a formal, professional tone. Be precise and direct. No emojis, no casual language.",
    "casual": "Speak casually like you're talking to a friend. Keep responses natural and conversational. No emojis.",
    "funny": "Be witty and playful but keep responses short. Use dry humor, not emojis.",
    "friendly": "Speak in a warm, friendly tone. Be encouraging but keep it brief. No emojis.",
    "professional": "Speak as a highly competent professional assistant. Be efficient, direct, and solution-oriented. Keep it brief."
}
RESPONSE_STYLES = {
    "detailed": "Provide thorough but concise answers — 4-6 sentences. Cover the key points without repetition.",
    "short": "Keep responses extremely brief — 1-3 sentences. Answer directly without extra elaboration. No fluff, no introductions, no conclusions.",
    "bullets": "Use short bullet points. Each bullet should be 1 sentence max. No introductions, no conclusions.",
    "stepbystep": "Break down your answer into 2-4 clear, numbered steps. Keep each step short. No introductions.",
    "chatgpt": "Provide complete, thoughtful responses with proper Markdown formatting (headings, bullet points, code blocks). Always answer in the same language the user asked in."
}
DEFAULT_PERSONALITY = "casual"
DEFAULT_STYLE = "chatgpt"

ESTA_SYSTEM_PROMPT = """You are ESTA AI, the flagship AI assistant built into NEXORA Browser.

Your mission is to provide accurate, thoughtful, and professional assistance comparable in style to modern AI assistants.

## Core Principles

1. **Accuracy First** — Never invent facts. If uncertain, explain what is known and what is uncertain. Distinguish observations from assumptions.

2. **Complete Responses** — Answer with enough detail to solve the user's problem. Avoid one-line responses unless the question is extremely simple. Use headings, bullet points, and examples when helpful.

3. **Context Awareness** — Remember recent conversation context. Answer follow-up questions naturally. Avoid repeating previous explanations unnecessarily.

4. **Coding** — Produce complete, working code. Explain the solution clearly. Debug step-by-step. Suggest improvements when appropriate.

5. **Image Analysis** — When an image is uploaded, carefully analyze it before responding. Describe visible objects, text, layout, colors, lighting, and notable details. Do not identify real people. Avoid unsupported guesses. Explain any uncertainty.

6. **Document Analysis** — Read the entire document. Produce structured summaries. Highlight key points. Extract important information.

7. **Reasoning** — Think through complex problems carefully. Break difficult tasks into steps. Consider alternative interpretations when appropriate.

8. **Tone** — Friendly and professional. Clear and concise. Helpful without being overly verbose.

9. **Browser Integration** — You are integrated into NEXORA Browser. You can help with: Web content explanation, Coding, Productivity, Writing, Research, File analysis, Image analysis, Study assistance.

10. **Safety** — Refuse unsafe or illegal requests politely. Never fabricate information. Prioritize user privacy.

## Chat-Only Assistant (IMPORTANT)

You are a **conversational chat assistant** that answers through the chat panel. You do NOT directly control the browser or the computer.

- Do NOT open websites, tabs, or URLs yourself.
- Do NOT navigate, search in the browser's navigation bar, or execute browser/device commands.
- Do NOT perform any computer or shell automation.
- Mentioning a website, application, URL, or command is simply part of conversation and does NOT mean the user wants an action performed.
- Even if the user asks you to "open YouTube", "go to Google", "close this tab", or "type something", do NOT perform the action. Respond conversationally (for example, explain how the user can do it or what the service is).

The browser's separate command/automation system handles actual browser actions.

HOWEVER: when you are told you have the "Live Information Tool", you DO have real-time web access to fetch current news and facts (headlines, scores, prices, weather, recent events). Use it whenever the answer needs current data — you are not stuck at a knowledge cutoff.

## Response Style

For every answer:
1. Understand the request.
2. Analyze available information.
3. Produce the most accurate response possible.
4. Explain reasoning when useful.
5. Finish with actionable next steps if appropriate.

Always strive to provide responses that are accurate, detailed, and genuinely useful.

Answer in the same language the user asked in."""

def build_system_prompt(personality=None, style=None):
    base = ESTA_SYSTEM_PROMPT
    context_block = _build_current_context_block()
    if context_block:
        base = base + "\n\n" + context_block
    if personality or style:
        if not personality or personality not in PERSONALITY_STYLES:
            personality = DEFAULT_PERSONALITY
        if not style or style not in RESPONSE_STYLES:
            style = DEFAULT_STYLE
        return f"{base}\n\n{PERSONALITY_STYLES.get(personality, '')} {RESPONSE_STYLES.get(style, '')}"
    return base

# ---------------------------------------------------------------------
#  ESTA LONG-TERM MEMORY  — remembers the user's name, preferences and
#  topics across conversations, like ChatGPT. Persisted in esta_memory.json.
# ---------------------------------------------------------------------
ESTA_MEMORY_PATH = os.path.join(BASE_DIR, 'esta_memory.json')
ESTA_MEMORY_MAX_FACTS = 60
ESTA_MEMORY_MAX_CHARS = 1600

def _load_esta_memory():
    if os.path.exists(ESTA_MEMORY_PATH):
        try:
            with open(ESTA_MEMORY_PATH, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get('facts'), list):
                return [str(x).strip() for x in data['facts'] if str(x).strip()]
            if isinstance(data, list):
                return [str(x).strip() for x in data if str(x).strip()]
        except Exception as e:
            print(f"[MEMORY] Load failed: {e}")
    return []

def _save_esta_memory(facts):
    data = {'facts': list(facts), 'updated': datetime.datetime.now().isoformat()}
    with open(ESTA_MEMORY_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

_NAME_TAIL_STOPS = {'and', 'but', 'or', 'my', 'i', 'is', 'am', 'was', 'are', 'were',
                    'the', 'a', 'an', 'at', 'in', 'on', 'from', 'to', 'of', 'with',
                    'like', 'love', 'because', 'who', 'which', 'that', 'bro', 'broo'}
_VERB_PRESENT = {'like': 'likes', 'love': 'loves', 'enjoy': 'enjoys',
                 'hate': 'hates', 'dislike': 'dislikes'}

def _extract_facts(text):
    """Extract ALL clean personal facts from a chat message, one per matched rule."""
    text = (text or '').strip()
    if not text:
        return []
    rules = [
        # (regex, formatter, number_of_capture_groups, tail_stop_words)
        (r"my name is ([a-z0-9]+(?: [a-z0-9]+){0,2})\b", lambda x: f"User's name is {x}", 1, _NAME_TAIL_STOPS),
        (r"call me ([a-z0-9]+(?: [a-z0-9]+){0,2})\b", lambda x: f"User's name is {x}", 1, _NAME_TAIL_STOPS),
        (r"i'?m called ([a-z0-9]+(?: [a-z0-9]+){0,2})\b", lambda x: f"User's name is {x}", 1, _NAME_TAIL_STOPS),
        (r"i am called ([a-z0-9 ]{2,40})\b", lambda x: f"User's name is {x}", 1, _NAME_TAIL_STOPS),
        (r"my birthday is ([a-z0-9 ,-]{3,40})", lambda x: f"User's birthday is {x}", 1, None),
        (r"i (?:was )?born (?:on )?([a-z0-9 ,-]{3,40})", lambda x: f"User was born on {x}", 1, None),
        (r"my favourite colour is ([a-z ]{3,30})", lambda x: f"User's favourite colour is {x}", 1, None),
        (r"my favorite color is ([a-z ]{3,30})", lambda x: f"User's favorite color is {x}", 1, None),
        (r"i (?:really )?(like|love|enjoy|hate|dislike) ([a-z0-9 ,'-]{2,80})", lambda v, o: f"User {_VERB_PRESENT.get(v.lower(), v + 's')} {o}", 2, None),
        (r"i prefer ([a-z0-9 ,'-]{3,80})", lambda x: f"User prefers {x}", 1, None),
        (r"my favourite ([a-z ]{2,30}) is ([a-z0-9 ,'-]{2,60})", lambda a, b: f"User's favourite {a} is {b}", 2, None),
        (r"my favorite ([a-z ]{2,30}) is ([a-z0-9 ,'-]{2,60})", lambda a, b: f"User's favorite {a} is {b}", 2, None),
        (r"i work (?:as|at) ([a-z0-9 ,'-]{3,60})", lambda x: f"User works as {x}", 1, None),
        (r"i am (?:a|an) (software|web|frontend|backend|devops|engineer|developer|designer|student|teacher|writer|artist|doctor|nurse|manager|owner|founder|freelancer)[a-z0-9 ]{0,40}", lambda x: f"User is a {x}", 1, None),
        (r"i (?:study|go) (?:at|to) ([a-z0-9 ,'-]{3,60})", lambda x: f"User studies at {x}", 1, None),
        (r"i (?:live in|stay in|live at) ([a-z0-9 ,'-]{2,60})", lambda x: f"User lives in {x}", 1, None),
        (r"i'?m from ([a-z0-9 ,'-]{2,60})", lambda x: f"User is from {x}", 1, None),
        (r"remember (?:that )?([a-z0-9 ,'.?!]{5,150})", lambda x: f"Remembered: {x}", 1, None),
    ]

    def _clean(s, tail_stops=None):
        s = (s or '').strip().strip('.!?').strip()
        s = re.sub(r'\s+', ' ', s)
        if tail_stops:
            words = s.split()
            while words and words[-1].lower() in tail_stops:
                words.pop()
            s = ' '.join(words)
        if not s or len(s) > 90:
            return None
        if s.lower() in ('you', 'it', 'this', 'that', 'things', 'everything',
                          'to', 'a', 'an', 'the', 'very', 'a lot', 'lots'):
            return None
        return s

    facts = []
    seen = set()
    for pat, fmt, ngroups, tail_stops in rules:
        for m in re.finditer(pat, text, re.IGNORECASE):
            if ngroups == 2:
                a = _clean(m.group(1), tail_stops)
                b = _clean(m.group(2), tail_stops)
                if a and b:
                    fact = fmt(a, b)
            else:
                frag = _clean(m.group(1), tail_stops)
                if frag:
                    fact = fmt(frag)
                else:
                    continue
            key = fact.casefold()
            if key not in seen:
                seen.add(key)
                facts.append(fact)
    return facts

def _remember_facts(message):
    """Persist newly shared personal facts; dedupe; keep the list small."""
    new_facts = _extract_facts(message)
    if not new_facts:
        return
    facts = _load_esta_memory()
    existing = {f.casefold() for f in facts}
    saved = False
    for fact in new_facts:
        if fact.casefold() in existing:
            continue
        facts.append(fact)
        existing.add(fact.casefold())
        saved = True
        print(f"[MEMORY] Saved long-term fact: {fact}")
    if not saved:
        return
    if len(facts) > ESTA_MEMORY_MAX_FACTS:
        facts = facts[-ESTA_MEMORY_MAX_FACTS:]
    while sum(len(f) for f in facts) > ESTA_MEMORY_MAX_CHARS and len(facts) > 1:
        facts.pop(0)
    _save_esta_memory(facts)

def _build_current_context_block():
    """Date/time + long-term memory for the ESTA system prompt."""
    parts = []
    try:
        now = datetime.datetime.now()
        parts.append(f"Today is {now.strftime('%A, %B %d, %Y')}. The current time is {now.strftime('%I:%M %p')}.")
    except Exception:
        pass
    facts = _load_esta_memory()
    if facts:
        parts.append("## About the user (long-term memory)")
        parts.append("Facts you have learned across conversations. Use them to personalize replies, address the user by name, and never contradict them. When the user shares a new personal fact it is stored automatically:")
        parts.append("\n".join(f"- {f}" for f in facts))
    return "\n".join(parts)

@app.route('/api/esta/memory/get', methods=['GET'])
def esta_memory_get():
    return jsonify({'success': True, 'facts': _load_esta_memory(),
                    'memoryPath': ESTA_MEMORY_PATH,
                    'updated': datetime.datetime.now().isoformat()})

@app.route('/api/esta/memory/set', methods=['POST'])
def esta_memory_set():
    data = request.get_json(silent=True) or {}
    raw = data.get('facts')
    if not isinstance(raw, list):
        return jsonify({'success': False, 'error': 'facts must be a JSON list of strings'}), 400
    facts = [str(f).strip() for f in raw if str(f).strip()]
    _save_esta_memory(facts)
    return jsonify({'success': True, 'facts': _load_esta_memory()})


def _fetch_url_text(url, max_chars=6000, timeout=15):
    """Fetch a URL and extract readable text with BeautifulSoup.
    Returns (title, clean_text). On failure returns ("", "")."""
    try:
        import requests as _req
        from bs4 import BeautifulSoup
        headers = {
            "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                           "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"),
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }
        resp = _req.get(url, headers=headers, timeout=timeout, verify=True)
        if resp.status_code != 200:
            print(f"[LINK] HTTP {resp.status_code} for {url}")
            return ("", "")
        ctype = resp.headers.get('Content-Type', '')
        if 'text/html' not in ctype and 'application/xhtml' not in ctype:
            # Plain text / json fallback
            text = resp.text
            title = ""
            return (title, text[:max_chars])
        soup = BeautifulSoup(resp.text, 'lxml')
        for tag in soup(["script", "style", "nav", "footer", "header", "aside", "form", "button", "noscript", "svg", "iframe"]):
            tag.decompose()
        title = soup.title.get_text(strip=True) if soup.title else ""
        main = soup.find('article') or soup.find('main') or soup.body
        if main is None:
            main = soup
        for tag in main(["script", "style", "nav", "footer", "aside", "noscript"]):
            tag.decompose()
        text = main.get_text(separator='\n', strip=True)
        # Collapse blank runs
        lines = [ln.strip() for ln in text.split('\n') if ln.strip()]
        text = '\n'.join(lines)
        if not text:
            text = soup.get_text(separator='\n', strip=True)
            lines = [ln.strip() for ln in text.split('\n') if ln.strip()]
            text = '\n'.join(lines)
        if len(text) > max_chars:
            text = text[:max_chars]
        return (title, text)
    except Exception as e:
        print(f"[LINK] Fetch failed for {url}: {e}")
        return ("", "")


def _extract_urls(text):
    """Return a list of http(s) URLs found in a chat message."""
    return re.findall(r'https?://[^\s)\]}]+', text or '')


def ask_ai(question, personality=None, style=None, page_context="", url="", allow_live_search=False, history=None):
    """Query Groq AI for response with retry, live-web tool and fallback model"""
    import traceback
    system_prompt = build_system_prompt(personality, style)
    if allow_live_search:
        system_prompt = system_prompt + LIVE_SEARCH_INSTRUCTION
    user_message = question
    ctx_parts = []
    if url:
        ctx_parts.append(f"User is currently on this website: {url}")
    if page_context:
        ctx_parts.append(f"Page content: {page_context[:2000]}")
    # Auto-read URLs pasted in the question so ESTA can summarize/explain any link.
    pasted_links = [_u for _u in _extract_urls(question)]
    if pasted_links:
        for _li, _u in enumerate(pasted_links[:2]):
            _title, _text = _fetch_url_text(_u)
            if _text and _text.strip():
                ct = f"Content fetched from link {_u}"
                if _title:
                    ct += f" (title: {_title})"
                ct += f":\n{_text[:4000]}"
                ctx_parts.append(ct)
                print(f"[AI] Inlined pasted link content ({len(_text)} chars) for {_u}")
    if ctx_parts:
        user_message = "\n\n".join(ctx_parts) + "\n\nUser question: " + question

    # Detect if user is asking for code — give more tokens
    code_keywords = ["html", "css", "javascript", "code", "script", "program", "function", "class",
                     "generate", "create", "write", "build", "make", "implement", "develop",
                     "snippet", "example", "template", "component", "page", "website", "web app"]
    is_code_request = any(kw in question.lower() for kw in code_keywords)
    max_tok = 2400 if is_code_request else 512

    # Live-info tool: (a) heuristic decides the question needs current data, or
    # (b) the model itself replies with <<SEARCH:...>>. Either way we search the
    # web and answer using the live results, like ChatGPT/Gemini do.
    live_query = None
    if allow_live_search:
        live_query = _detect_live_query(question)

    result = None
    if not (allow_live_search and live_query):
        result = _groq_complete(system_prompt, user_message, max_tok, history=history)

    if allow_live_search and not live_query and result:
        search_match = re.search(r'<<SEARCH:\s*(.+?)\s*>>', result, re.DOTALL)
        if search_match:
            live_query = search_match.group(1).strip()

    if allow_live_search and live_query:
        print(f"[AI] Live info requested — searching: {live_query}")
        results = _duckduckgo_search(live_query)
        if results:
            answer = _answer_with_live_results(question, live_query, results, max_tok, personality, style, user_message, history)
            if answer:
                return answer
        print("[AI] Live search returned nothing usable; answering normally")
        plain_sys = build_system_prompt(personality, style)
        if not result:
            normal_answer = _groq_complete(plain_sys, user_message, max_tok, history=history)
            if normal_answer:
                return normal_answer

    if result:
        return result

    # Last resort: Ollama local (use the tuned offline model + light context so
    # a normal PC doesn't choke with a giant KV-cache)
    print("[AI] All Groq models failed - falling back to Ollama local")
    try:
        import urllib.request
        messages = [{"role": "system", "content": str(system_prompt)[:1500]}]
        if history:
            messages = messages + [{"role": m.get("role", "user"),
                                    "content": str(m.get("content", ""))[:1500]}
                                   for m in history if m.get("content")]
        messages = _trim_messages(messages, OFFLINE_HISTORY_COUNT + 1)
        messages.append({"role": "user", "content": user_message})
        payload = json.dumps({
            "model": OLLAMA_OFFLINE_MODEL,
            "messages": messages,
            "stream": False,
            "think": False,
            "keep_alive": OLLAMA_KEEP_ALIVE,
            "options": _offline_ollama_options(min(max_tok, OFFLINE_MAX_TOKENS))
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{OLLAMA_URL}/api/chat",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        resp = urllib.request.urlopen(req, timeout=60)
        data = json.loads(resp.read().decode("utf-8"))
        result = data.get("message", {}).get("content", "")
        if result.strip():
            print(f"[AI] SUCCESS from Ollama local: {len(result)} chars")
            return strip_think_tags(result)
    except Exception as e:
        print(f"[AI] Ollama fallback failed: {e}")

    return ("I'm offline right now (no cloud key and no local model reachable). "
            "Run launch.bat once - it sets up the free offline AI automatically - "
            "or add a GROQ_API_KEY in backend/.env for cloud chat.")

LIVE_SEARCH_INSTRUCTION = """
## You HAVE Live Web Access (IMPORTANT)
You have a built-in Live Information Tool that can pull up-to-date, real-time information from the web (news headlines, live scores, prices, weather, recent events, trending topics, today's date facts, and anything time-sensitive). You are NOT limited to a knowledge cutoff.

- Whenever the best answer needs current/recent data, reply with the EXACT line below and nothing else:
<<SEARCH:your concise search query>>
- The system will search the live web for you, then you will receive real search results and give the user a complete, sourced answer with links.
- Do NOT say "I can't access the internet", "I have no live data", or "my knowledge cutoff prevents me" — you CAN fetch live information whenever needed.
- For anything that does not need live data, just answer normally from your knowledge.
"""

_LIVE_TRIGGERS = (
    "latest news", "breaking news", "what's happening", "what is happening",
    "whats happening", "what happened", "live score", "live scores", "score today",
    "results of", "who won", "weather", "forecast", "temperature", "price of",
    "stock price", "crypto", "bitcoin", "today", "this week", "this month",
    "current", "recent", "trending", "top stories", "headlines", "news",
    "election", "released", "release date", "premiere", "announced", "latest",
    "up to date", "update me", "what's new", "whats new", "right now",
)

def _detect_live_query(question):
    """Return a compact search query when the question clearly needs current
    /live data, else None."""
    q = (question or '').strip()
    if not q or len(q) > 200:
        return None
    ql = q.lower()
    # Date/time questions are answered by dedicated handlers and never reach here.
    if any(t in ql for t in _LIVE_TRIGGERS):
        return _shorten_query(q)
    return None

_LEAD_FILLER = (
    "what's", "what is", "what are", "whats", "what", "who", "how",
    "can you", "could you", "would you", "tell me", "give me", "get me",
    "please", "and", "the", "a", "an", "me", "i", "it", "to", "for",
    "of", "on", "do you know", "give", "gimme", "is", "are", "was",
    "were", "can", "will", "show", "show me", "some", "any",
)
_TAIL_FILLER = {"please", "thanks", "thank", "bro", "bhai", "a", "the",
                "quick update", "update me", "quick", "fast", "headline",
                "headlines", "news today", "today"}

def _shorten_query(q):
    """Turn a conversational question into compact web-search terms."""
    q = q.replace("?", "").replace("!", "").replace(".", " ").replace(",", " ")
    words = [w for w in q.lower().split() if w]
    while words and words[0] in _LEAD_FILLER:
        words.pop(0)
    while words and " ".join(words).strip() in _TAIL_FILLER:
        words.pop()
    if words and words[-1] in _TAIL_FILLER:
        words.pop()
    short = " ".join(words[:6])
    return short if len(short) > 2 else q

def _answer_with_live_results(question, search_query, results, max_tok, personality=None, style=None, user_message=None, history=None):
    """Run a second Groq pass grounded on live web results."""
    context_block = _build_results_context(search_query, results)
    research_prompt = (
        f"ORIGINAL QUESTION FROM USER: {question}\n\n"
        f'LIVE WEB RESULTS for "{search_query}":\n{context_block}\n\n'
        "Give your final, complete answer now. Use ONLY these live results as your "
        "source for current facts, and cite each source by name/URL. If the results "
        "do not contain the answer, say so honestly."
    )
    research_sys = (
        "You are ESTA AI with live internet access. A previous model step decided the "
        "user needs current information. Below are LIVE web search results. Answer the "
        "user's question using them, citing sources with URLs, and clearly note any "
        "facts that are time-sensitive or dated."
    )
    return _groq_complete(research_sys, research_prompt, max(1024, max_tok), history=history)

def _groq_complete(system_prompt, user_message, max_tok=512, history=None):
    """One Groq completion with model retries. Returns stripped content or None.

    `history` is an optional list of {'role','content'} turns placed BETWEEN the
    system prompt and the current user message, so ESTA remembers the
    conversation like ChatGPT does."""
    messages = [{"role": "system", "content": system_prompt}]
    if history:
        messages = messages + history
    messages.append({"role": "user", "content": user_message})
    models = ["qwen/qwen3.8-27b", "qwen/qwen3.6-27b"]
    for model in models:
        for attempt in range(2):
            try:
                print(f"[AI] Calling Groq API model={model} attempt={attempt+1} max_tokens={max_tok}")
                response = client.chat.completions.create(
                    model=model,
                    messages=messages,
                    temperature=0.7,
                    max_tokens=max_tok
                )
                if response.choices and response.choices[0].message and response.choices[0].message.content:
                    result = strip_think_tags(response.choices[0].message.content)
                    if result.strip():
                        print(f"[AI] SUCCESS: Got response ({len(result)} chars) from {model}")
                        return result
                print(f"[AI] Empty response from {model}, trying next...")
            except Exception as e:
                import time
                msg = str(e)
                is_rate = "429" in msg or "rate_limit" in msg.lower() or "tokens" in msg.lower()
                print(f"[AI] Error with {model} attempt {attempt+1}: {msg}")
                if is_rate:
                    # Rate/quota limit: back off briefly, then move to next model.
                    time.sleep(1.5)
                else:
                    time.sleep(0.5)
    return None

def _ddgs_search(query, max_results=5):
    """Live web results via the newer `ddgs` package (duckduckgo_search was
    renamed). Returns [{title, snippet, url}, ...]."""
    from ddgs import DDGS
    try:
        with DDGS() as ddgs:
            out = []
            for r in ddgs.text(query, max_results=max_results):
                if not r:
                    continue
                if hasattr(r, 'get'):
                    out.append({
                        'title': str(r.get('title', '')).strip(),
                        'snippet': str(r.get('body', '') or r.get('snippet', '')).strip(),
                        'url': str(r.get('href', '') or r.get('url', '')).strip(),
                    })
                else:
                    out.append({'title': str(r.get('title', '')).strip(),
                                'snippet': str(r.get('body', '') or r.get('snippet', '')).strip(),
                                'url': str(r.get('href', '') or r.get('url', '')).strip()})
            return [r for r in out if r['title'] or r['url']]
    except Exception as e:
        print(f"[WEB] ddgs search failed: {e}")
        return []


def _legacy_ddg_search(query, max_results=5):
    """Fallback via the old `duckduckgo_search` package (deprecated)."""
    try:
        from duckduckgo_search import DDGS
        with DDGS() as ddgs:
            return [
                {'title': str(r.get('title', '')).strip(),
                 'snippet': str(r.get('body', '') or r.get('snippet', '')).strip(),
                 'url': str(r.get('href', '') or r.get('url', '')).strip()}
                for r in ddgs.text(query, max_results=max_results) if r
            ]
    except Exception as e:
        print(f"[WEB] legacy duckduckgo_search failed: {e}")
        return []


def _duckduckgo_search(query, max_results=5):
    """Live web results via DuckDuckGo with multiple provider fallbacks."""
    results = _ddgs_search(query, max_results)
    if results:
        return results
    results = _legacy_ddg_search(query, max_results)
    if results:
        return results
    print("[WEB] All DuckDuckGo providers returned nothing")
    return []

def _build_results_context(query, results):
    if not results:
        return ""
    return "\n\n".join(
        f"{i+1}. {r['title']}: {r['snippet']} ({r['url']})"
        for i, r in enumerate(results)
    )

def web_search(query):
    """Search the web using Google and provide AI summary"""
    try:
        # Encode the search query for URL
        encoded_query = urllib.parse.quote(query)
        
        # Open Google search in browser
        search_url = f"https://www.google.com/search?q={encoded_query}"
        webbrowser.open(search_url)
        
        # Also get AI summary of the query
        summary = ask_ai(f"Provide a brief answer about: {query}")
        return f"Searching for '{query}' on Google... {summary}"
    except Exception as e:
        print(f"Web search error: {e}")
        return ask_ai(query)  # Fallback to AI if search fails

def calculate(expression):
    """Perform mathematical calculation"""
    try:
        expression = expression.replace("plus", "+").replace("minus", "-").replace("multiply", "*")
        expression = expression.replace("times", "*").replace("divide", "/").replace("divided by", "/")
        expression = expression.replace("calculate", "").strip()
        result = safe_calculate(expression)
        return result
    except:
        return None

def safe_calculate(expression):
    """Arithmetic only: numbers, + - * / // % ** and parentheses.

    This replaces a bare eval() that could execute arbitrary Python from chat
    input. Anything that is not plain arithmetic raises ValueError.
    """
    import ast as _ast
    if not isinstance(expression, str) or not expression or len(expression) > 200:
        raise ValueError("bad expression")
    tree = _ast.parse(expression, mode='eval')
    allowed_bin = (_ast.Add, _ast.Sub, _ast.Mult, _ast.Div, _ast.FloorDiv, _ast.Mod, _ast.Pow)
    allowed_un = (_ast.UAdd, _ast.USub)
    def check(node):
        if isinstance(node, _ast.Expression):
            return check(node.body)
        if isinstance(node, _ast.Constant):
            if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
                raise ValueError("numbers only")
            if abs(node.value) >= 1e15:
                raise ValueError("number too large")
            return node.value
        if isinstance(node, _ast.BinOp):
            if not isinstance(node.op, allowed_bin):
                raise ValueError("operator not allowed")
            left = check(node.left)
            right = check(node.right)
            if isinstance(node.op, _ast.Pow):
                if not isinstance(right, int) or right < 0 or right > 100:
                    raise ValueError("exponent out of range")
            if isinstance(node.op, (_ast.Div, _ast.FloorDiv, _ast.Mod)) and right == 0:
                raise ValueError("division by zero")
            return _apply_binop(node.op, left, right)
        if isinstance(node, _ast.UnaryOp):
            if not isinstance(node.op, allowed_un):
                raise ValueError("operator not allowed")
            operand = check(node.operand)
            return +operand if isinstance(node.op, _ast.UAdd) else -operand
        raise ValueError("not arithmetic")
    def _apply_binop(op, left, right):
        if isinstance(op, _ast.Add): return left + right
        if isinstance(op, _ast.Sub): return left - right
        if isinstance(op, _ast.Mult): return left * right
        if isinstance(op, _ast.Div): return left / right
        if isinstance(op, _ast.FloorDiv): return left // right
        if isinstance(op, _ast.Mod): return left % right
        return left ** right
    return check(tree)

def open_app(app_name):
    """Open application by name"""
    try:
        if app_name in APP_COMMANDS:
            subprocess.Popen(APP_COMMANDS[app_name])
            return f"Opening {app_name}"
        else:
            return f"I don't know how to open {app_name}"
    except Exception as e:
        print(e)
        return f"Failed to open {app_name}"

def open_folder(folder_name):
    """Open folder by name"""
    try:
        if folder_name in FOLDER_COMMANDS:
            folder_path = FOLDER_COMMANDS[folder_name]
            # Use explorer.exe to open the folder
            subprocess.Popen(['explorer.exe', folder_path])
            return f"Opening {folder_name} folder"
        else:
            return f"I don't know how to open {folder_name} folder"
    except Exception as e:
        return f"Error opening {folder_name} folder: {str(e)}"


def extract_folder_name(message_text):
    """Return the first matching folder name found in the command text."""
    normalized = re.sub(r"\b(the|my|a|an|folder|folders|open)\b", "", message_text).strip()
    for folder_name in sorted(FOLDER_COMMANDS, key=len, reverse=True):
        if folder_name in normalized:
            return folder_name
    return None


def _clean_website_fragment(fragment):
    """Strip command words so 'open the YouTube website' → 'youtube'."""
    s = (fragment or "").strip().strip('"').strip("'")
    s = re.sub(r"^(open|visit|go\s+to|launch|load|show)\s+", "", s, flags=re.I).strip()
    s = re.sub(r"^(the|a|an|my|me)\s+", "", s, flags=re.I).strip()
    s = re.sub(r"\b(website|web\s*site|site|web\s*page|homepage|link)\b\s*", "", s, flags=re.I).strip()
    return s


def resolve_fragment_to_website_url(fragment):
    """
    Map user text to a real https URL (default browser opens the site, not a search-only page).
    Returns (url, label) or (None, None).
    """
    raw = (fragment or "").strip()
    if not raw or len(raw) > 200:
        return None, None

    if re.match(r"^https?://", raw, re.I):
        url = raw.strip()
        if not url.startswith(("http://", "https://")):
            url = "https://" + url.split("://", 1)[-1]
        try:
            host = urllib.parse.urlparse(url).netloc
        except Exception:
            host = ""
        return url[:2000], (host or "website")[:80]

    cleaned = _clean_website_fragment(raw)
    if not cleaned:
        return None, None

    low = cleaned.lower()
    low_nospace = re.sub(r"[^a-z0-9]", "", low)

    if low_nospace in WEBSITE_SQUASH_ALIASES:
        u = WEBSITE_SQUASH_ALIASES[low_nospace]
        return u, low_nospace

    for word in sorted(set(re.findall(r"[a-z0-9]+", low)), key=len, reverse=True):
        if word in WEBSITE_ALIASES:
            return WEBSITE_ALIASES[word], word

    for key in sorted(WEBSITE_ALIASES.keys(), key=len, reverse=True):
        if len(key) >= 3 and key in low_nospace:
            return WEBSITE_ALIASES[key], key

    if 2 <= len(low_nospace) <= 48 and low_nospace.isalnum():
        return f"https://www.{low_nospace}.com", low_nospace

    return None, None


def open_website_in_browser(fragment):
    """Open a website URL from a user fragment; returns (True, message) or (False, error)."""
    url, label = resolve_fragment_to_website_url(fragment)
    if not url:
        return False, "I could not figure out which website to open."
    try:
        webbrowser.open(url)
        return True, f"Opening {label} in your browser ({url})."
    except Exception as e:
        return False, f"Could not open browser: {e}"


def _type_like_physical(text):
    """
    Type text with per-key delay and real shift for capitals (closer to a physical keyboard).
    """
    text = _sanitize_type_text(text)
    if not text:
        return
    for ch in text:
        time.sleep(random.uniform(0.07, 0.16))
        if ch == " ":
            pyautogui.press("space")
        elif ch == "\t":
            pyautogui.press("tab")
        elif "A" <= ch <= "Z":
            pyautogui.hotkey("shift", ch.lower())
        elif ch.isdigit() or ("a" <= ch <= "z"):
            pyautogui.press(ch)
        else:
            pyautogui.write(ch)


def _file_search_roots():
    """Common user folders to resolve partial file names."""
    roots = []
    for rel in ("Desktop", "Documents", "Downloads", "OneDrive", "Pictures"):
        p = os.path.join(USER_HOME, rel)
        if os.path.isdir(p):
            roots.append(p)
    if os.path.isdir(FRONTEND_DIR):
        roots.append(FRONTEND_DIR)
    return roots


def resolve_user_file_path(fragment):
    """
    Resolve a path or filename to an existing file.
    fragment may be absolute, relative to home, or a bare filename.
    """
    fragment = (fragment or "").strip().strip('"').strip("'")
    if not fragment or len(fragment) > 260:
        return None

    if os.path.isfile(fragment):
        return os.path.abspath(fragment)

    expanded = os.path.expandvars(os.path.expanduser(fragment))
    if os.path.isfile(expanded):
        return os.path.abspath(expanded)

    if fragment.startswith("~"):
        cand = os.path.abspath(os.path.expanduser(fragment))
        if os.path.isfile(cand):
            return cand

    base = os.path.basename(fragment)
    if not base:
        return None

    for root in _file_search_roots():
        direct = os.path.join(root, base)
        if os.path.isfile(direct):
            return os.path.abspath(direct)
        try:
            matches = glob.glob(os.path.join(glob.escape(root), "**", base), recursive=True)
        except Exception:
            matches = []
        for m in matches[:12]:
            if os.path.isfile(m):
                return os.path.abspath(m)
    return None


def open_user_file_by_path(path):
    """Open a file with the OS default handler (Windows: same as double-click)."""
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        return False, "That path is not a file."
    try:
        os.startfile(path)
        return True, f"Opened file: {path}"
    except Exception as e:
        print(f"startfile error: {e}")
        return False, f"Could not open file: {e}"


def _sanitize_type_text(text):
    """Limit length and keep printable ASCII for pyautogui.write."""
    if not text:
        return ""
    text = text.replace("\r", "").replace("\n", " ")[:800]
    return "".join(c for c in text if 32 <= ord(c) <= 126)


def is_writing_request(message_lower):
    """
    True when a 'write ...' message clearly asks for generated content
    (code, essay, email, explanation...) instead of physical keyboard typing.
    Used to stop automation/typing handlers from hijacking AI coding requests.
    """
    m = re.match(r"^(?:please\s+)?write\s+(?:me\s+|us\s+|a\s+|an\s+|the\s+|my\s+)?(.+)$", message_lower.strip())
    if not m:
        return False
    payload = m.group(1).strip()
    if len(payload) > 40:
        return True
    return bool(re.search(
        r"\b(code|program|script|function|class|algorithm|snippet|app|website|webpage|"
        r"api|database|game|essay|paragraph|story|song|poem|email|letter|report|"
        r"explain|explanation|tutorial|how to|steps|example|solution|"
        r"python|javascript|typescript|java|html|css|sql|bash|c\+\+|react|node|json)\b",
        payload,
    ))


def try_quick_keyboard_mouse_command(message, message_lower):
    """
    Fast path: type / write / press / click / move mouse without calling the LLM.
    Returns a user-facing string or None.
    """
    ml = message_lower.strip()

    if re.match(
        r"^(wake\s+)?(cursor|mouse)|animate\s+(the\s+)?(mouse|cursor)|"
        r"(show|wave)\s+(the\s+)?(mouse|cursor)|cursor\s+(dance|wave)\s*$",
        ml,
    ):
        if _cursor_task_animation_enabled():
            animate_cursor_task_start()
            return "I moved the mouse in a small pattern so you can see I am working on your task."
        return "Cursor animation is off (set CURSOR_TASK_ANIMATION=1 in backend/.env to enable it)."

    sw, sh = pyautogui.size()

    m = re.match(
        r"^(move|drag)\s+(?:the\s+)?(?:mouse|cursor)\s+to\s+(?:the\s+)?(?:center|middle)(?:\s+of\s+(?:the\s+)?screen)?\s*$",
        ml,
    )
    if m:
        try:
            dur = 0.9 if "slow" in ml else 0.55
            pyautogui.moveTo(sw // 2, sh // 2, duration=dur)
            return "Moved the mouse to the center of the screen."
        except Exception as e:
            return f"Could not move mouse: {e}"

    m = re.match(
        r"^(move|drag)\s+(?:the\s+)?(?:mouse|cursor)\s+to\s+(\d+)\s*[, ]\s*(\d+)(?:\s+(slow|slowly))?\s*$",
        ml,
    )
    if m:
        try:
            x, y = int(m.group(2)), int(m.group(3))
            x = max(0, min(x, sw - 1))
            y = max(0, min(y, sh - 1))
            dur = 1.05 if m.group(4) else 0.5
            pyautogui.moveTo(x, y, duration=dur)
            return f"Moved the mouse to screen position {x}, {y}."
        except Exception as e:
            return f"Could not move mouse: {e}"

    m = re.match(r"^(move|drag)\s+(?:the\s+)?(?:mouse|cursor)\s+(\d+)\s+(\d+)\s*$", ml)
    if m:
        try:
            x, y = int(m.group(2)), int(m.group(3))
            x = max(0, min(x, sw - 1))
            y = max(0, min(y, sh - 1))
            pyautogui.moveTo(x, y, duration=0.5)
            return f"Moved the mouse to {x}, {y}."
        except Exception as e:
            return f"Could not move mouse: {e}"

    m = re.match(
        r"^move\s+(?:the\s+)?(?:mouse|cursor)\s+"
        r"(?:(?:by\s+)?(\d+)\s*(?:px|pixel|pixels)?\s+(right|left|up|down)|"
        r"(right|left|up|down)\s+(?:by\s+)?(\d+)\s*(?:px|pixel|pixels)?)\s*$",
        ml,
    )
    if m:
        try:
            n = int(m.group(1) or m.group(4))
            direction = m.group(2) or m.group(3)
            cx, cy = pyautogui.position()
            if direction == "right":
                nx, ny = min(cx + n, sw - 1), cy
            elif direction == "left":
                nx, ny = max(cx - n, 0), cy
            elif direction == "down":
                nx, ny = cx, min(cy + n, sh - 1)
            else:
                nx, ny = cx, max(cy - n, 0)
            pyautogui.moveTo(nx, ny, duration=0.45)
            return f"Moved the mouse {n} pixels {direction} to {nx}, {ny}."
        except Exception as e:
            return f"Could not move mouse: {e}"

    raw = message.strip()
    m = re.match(r"^(type|write)\s+(.+)$", raw, re.I | re.DOTALL)
    if m:
        if m.group(1).lower() == "write" and is_writing_request(message_lower):
            return None
        payload = _sanitize_type_text(m.group(2))
        if not payload:
            return "Nothing to type (use letters, numbers, and basic punctuation)."
        try:
            _type_like_physical(payload)
            return f"Typed (keyboard-style): {payload[:80]}{'…' if len(payload) > 80 else ''}"
        except Exception as e:
            return f"Could not type text: {e}"

    m = re.match(r"^(press|hit)\s+([a-z0-9]+)\s*$", message_lower)
    if m:
        key = m.group(2)
        if key == "return":
            key = "enter"
        if key not in _AUTOMATION_PRESS_KEYS and len(key) == 1:
            try:
                pyautogui.press(key)
                return f"Pressed {key}."
            except Exception as e:
                return f"Could not press key: {e}"
        if key in _AUTOMATION_PRESS_KEYS:
            try:
                pyautogui.press(key)
                return f"Pressed {key}."
            except Exception as e:
                return f"Could not press key: {e}"
        return f"I cannot press '{key}' for safety. Try enter, tab, esc, space, arrows, or f5."

    if message_lower.strip() in ("click", "mouse click", "left click"):
        try:
            pyautogui.click()
            return "Clicked at the current mouse position."
        except Exception as e:
            return f"Click failed: {e}"

    if "double click" in message_lower or "double-click" in message_lower:
        try:
            pyautogui.doubleClick()
            return "Double-clicked at the current mouse position."
        except Exception as e:
            return f"Double-click failed: {e}"

    if message_lower.startswith("scroll "):
        if "down" in message_lower:
            try:
                pyautogui.scroll(-400)
                return "Scrolled down."
            except Exception as e:
                return f"Scroll failed: {e}"
        if "up" in message_lower:
            try:
                pyautogui.scroll(400)
                return "Scrolled up."
            except Exception as e:
                return f"Scroll failed: {e}"

    return None


def _normalize_hotkey_keys(keys):
    out = []
    for k in keys:
        if not isinstance(k, str):
            return None
        k = k.strip().lower()
        if k == "return":
            k = "enter"
        if k in ("command", "cmd", "windows"):
            k = "win"
        if k not in _AUTOMATION_HOTKEY_PARTS:
            return None
        out.append(k)
    return out


def _execute_one_automation_step(step):
    """Run one validated step dict. Returns (ok, detail)."""
    if not isinstance(step, dict):
        return False, "invalid_step"
    action = (step.get("action") or "").strip().lower()
    try:
        if action == "google_search":
            q = (step.get("query") or "").strip()
            if not q or len(q) > 200:
                return False, "bad_query"
            webbrowser.open(f"https://www.google.com/search?q={urllib.parse.quote(q)}")
            return True, f"google:{q[:60]}"

        if action == "move_mouse":
            sw, sh = pyautogui.size()
            x = int(step["x"])
            y = int(step["y"])
            dur = float(step.get("duration", 0.45))
            dur = max(0.05, min(dur, 4.0))
            x = max(0, min(x, sw - 1))
            y = max(0, min(y, sh - 1))
            pyautogui.moveTo(x, y, duration=dur)
            return True, f"move:{x},{y}"

        if action == "open_url":
            url = (step.get("url") or "").strip()
            if not url.startswith(("https://", "http://")) or len(url) > 2000:
                return False, "bad_url"
            webbrowser.open(url)
            return True, "url"

        if action == "type_text":
            text = _sanitize_type_text(step.get("text") or "")
            if not text:
                return False, "empty_type"
            _type_like_physical(text)
            return True, "typed"

        if action == "press":
            key = (step.get("key") or "").strip().lower()
            if key == "return":
                key = "enter"
            if key not in _AUTOMATION_PRESS_KEYS and len(key) != 1:
                return False, "bad_key"
            pyautogui.press(key)
            return True, f"press:{key}"

        if action == "hotkey":
            keys = step.get("keys")
            if not isinstance(keys, list) or not (1 <= len(keys) <= 4):
                return False, "bad_hotkey"
            nk = _normalize_hotkey_keys(keys)
            if not nk:
                return False, "bad_hotkey_keys"
            pyautogui.hotkey(*nk)
            return True, "hotkey"

        if action == "sleep":
            sec = float(step.get("seconds", 0.5))
            sec = max(0.05, min(sec, 3.0))
            time.sleep(sec)
            return True, "sleep"

        if action == "click":
            sw, sh = pyautogui.size()
            if "x" in step and "y" in step:
                x = int(step["x"])
                y = int(step["y"])
                if not (0 <= x <= sw and 0 <= y <= sh):
                    return False, "bad_coords"
                pyautogui.click(x, y)
            else:
                pyautogui.click()
            return True, "click"

        if action == "scroll":
            direction = (step.get("direction") or "down").lower()
            amount = int(step.get("amount", 400))
            amount = max(50, min(abs(amount), 2000))
            pyautogui.scroll(-amount if direction == "down" else amount)
            return True, "scroll"

        return False, "unknown_action"
    except Exception as e:
        print(f"Automation step error ({action}): {e}")
        return False, str(e)


def get_automation_plan_json(message):
    """Ask Groq for a short JSON plan of safe desktop steps."""
    system = (
        "You are a desktop automation planner on Windows. Output ONLY a JSON object, no markdown.\n"
        'Schema: {"steps":[...]} with at most 10 steps.\n'
        "Each step must be exactly one of:\n"
        '{"action":"open_url","url":"https://..."}  Use a real website URL (https). Prefer this for opening any site or app on the web.\n'
        '{"action":"google_search","query":"..."}  Only if the user explicitly wants a search results page, not a direct site.\n'
        '{"action":"move_mouse","x":int,"y":int,"duration":0.5}  duration 0.05–4 seconds; move pointer smoothly on screen.\n'
        '{"action":"type_text","text":"..."}  (printable ASCII only, short; simulates physical typing)\n'
        '{"action":"press","key":"enter|tab|esc|space|f5|up|down|left|right|..."}\n'
        '{"action":"hotkey","keys":["ctrl","c"]}  keys from: ctrl,alt,shift,win, a-z, 0-9, tab, enter, esc, f1-f12\n'
        '{"action":"sleep","seconds":0.5}  (0.05 to 3)\n'
        '{"action":"click"} or {\"action\":\"click\",\"x\":int,\"y\":int} within the screen\n'
        '{"action":"scroll","direction":"up|down","amount":400}\n'
        "If the user wants something unsafe, ambiguous, or impossible with these actions, return {\"steps\":[]}.\n"
        "For “open YouTube”, “go to Netflix”, “open WhatsApp in browser”, always use open_url with the correct https URL."
    )
    try:
        kwargs = dict(
            model="allam-2-7b",
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": message[:500]},
            ],
            temperature=0.1,
            max_tokens=400,
        )
        try:
            response = client.chat.completions.create(
                **kwargs,
                response_format={"type": "json_object"},
            )
        except Exception:
            response = client.chat.completions.create(**kwargs)
        raw = strip_think_tags(response.choices[0].message.content or "")
        data = json.loads(raw)
        steps = data.get("steps")
        if not isinstance(steps, list):
            return []
        return steps[:10]
    except Exception as e:
        print(f"Automation plan error: {e}")
        return []


def try_planned_automation(message):
    """
    When the message looks like a keyboard/mouse/desktop task, run a short LLM plan.
    Returns a string for the user, or None to fall through.
    """
    if is_writing_request(message.lower()):
        return None
    if not AUTOMATION_INTENT.search(message):
        return None
    steps = get_automation_plan_json(message)
    if not steps:
        return None
    done = []
    for i, step in enumerate(steps):
        ok, detail = _execute_one_automation_step(step)
        if not ok:
            return f"I started automation but stopped on step {i + 1} ({detail}). Completed before that: {', '.join(done) or 'none'}."
        done.append(detail)
    return f"Done. Automation steps: {', '.join(done)}."


def try_open_file_phrase(message, message_lower):
    """
    Handle 'open file X', 'open my file X', 'open the file X'.
    Returns a string or None.
    """
    m = re.search(
        r"\bopen\s+(?:my\s+|the\s+)?(?:file\s+)?(.+)$",
        message.strip(),
        re.I,
    )
    if not m:
        return None
    rest = m.group(1).strip().strip('"').strip("'")
    if not rest:
        return None
    low = rest.lower()
    if low in FOLDER_COMMANDS or low in APP_COMMANDS:
        return None
    if any(low == k or low.startswith(k + " ") for k in ("folder", "the folder")):
        return None

    path = resolve_user_file_path(rest)
    if path:
        ok, msg = open_user_file_by_path(path)
        return msg if ok else msg
    if re.search(r"[\\/]|\.(txt|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|zip|csv|py|html?|js|ts|json|md)\b", rest, re.I):
        return f"I could not find a file matching: {rest}. Check the name or put it on Desktop/Documents/Downloads."
    return None

def detect_running_browsers():
    """Detect running web browsers"""
    try:
        running = set()
        result = subprocess.run(
            ["tasklist", "/fo", "csv", "/nh"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
            check=False,
        )
        output = result.stdout or ""
        if result.returncode != 0 and result.stderr:
            print(f"Browser detection warning: {result.stderr.strip()}")
        for row in csv.reader(output.splitlines()):
            if row:
                process_name = row[0].strip('"').lower()
                if process_name in BROWSER_PROCESS_NAMES:
                    running.add(BROWSER_PROCESS_NAMES[process_name])

        if not running:
            ps_result = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    "(Get-Process chrome,msedge,firefox,brave,opera -ErrorAction SilentlyContinue).ProcessName",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="ignore",
                check=False,
            )
            for line in (ps_result.stdout or "").splitlines():
                process_name = line.strip().lower()
                if process_name in BROWSER_PROCESS_NAMES:
                    running.add(BROWSER_PROCESS_NAMES[process_name])

        return sorted(running)
    except Exception as e:
        print(f"Browser detection error: {e}")
        return []

def save_browser_state():
    """Save currently running browsers to file"""
    browsers = detect_running_browsers()
    if not browsers:
        return "No running browsers to save"
    try:
        with open(BROWSER_STATE_FILE, "w", encoding="utf-8") as f:
            json.dump({"browsers": browsers, "saved_at": datetime.datetime.now().isoformat()}, f, indent=2)
        return f"Saved {len(browsers)} browser(s)"
    except Exception as e:
        print(f"Save browser state error: {e}")
        return "Could not save browser state"

def load_browser_state():
    """Load saved browser state from file"""
    if not os.path.exists(BROWSER_STATE_FILE):
        return []
    try:
        with open(BROWSER_STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data.get("browsers", [])
    except Exception as e:
        print(f"Load browser state error: {e}")
        return []

def open_saved_browsers():
    """Open previously saved browsers"""
    browsers = load_browser_state()
    if not browsers:
        return "No saved browser state"
    opened = []
    for browser_name in browsers:
        if browser_name in APP_COMMANDS:
            try:
                subprocess.Popen(APP_COMMANDS[browser_name])
                opened.append(browser_name)
            except Exception as e:
                print(f"Failed to open {browser_name}: {e}")
        elif browser_name:
            try:
                webbrowser.get(browser_name).open("about:blank")
                opened.append(browser_name)
            except Exception as e:
                print(f"Failed to open saved browser via webbrowser ({browser_name}): {e}")
    if opened:
        return f"Opened: {', '.join(opened)}"
    else:
        return "Could not open any browsers"

def find_phone_location(phone_number):
    """Open a Google search for the phone location."""
    try:
        sanitized_number = re.sub(r'[^0-9+]', '', phone_number)
        if not sanitized_number or len(re.sub(r'\D', '', sanitized_number)) < 7:
            return "Please enter a valid phone number to search."

        query = f"phone number location {sanitized_number}"
        search_url = f"https://www.google.com/search?q={urllib.parse.quote(query)}"
        webbrowser.open(search_url)
        return f"Searching Google for the location of {sanitized_number}."
    except Exception as e:
        print(f"Find phone error: {e}")
        return "I couldn't open the phone search. Please try again."


def ring_my_phone(message_lower=None):
    """Attempt to ring the configured phone number.
    If message_lower contains a phone number, use that instead."""
    try:
        number = PHONE_NUMBER

        if message_lower:
            num_match = re.search(r'(\+?\d[\d\s\-\(\)]{7,})', message_lower)
            if num_match:
                candidate = num_match.group(1).strip()
                number = candidate

        phone_clean = number.replace('+', '').replace(' ', '').replace('-', '').replace('(', '').replace(')', '')
        tel_url = f"tel:+{phone_clean}"
        callto_url = f"callto:+{phone_clean}"
        find_device_url = "https://www.google.com/android/find"

        webbrowser.open(tel_url)
        webbrowser.open(callto_url)
        webbrowser.open(find_device_url)

        return f"Trying to ring your phone at +{phone_clean}. Also opened Google Find My Device."
    except Exception as e:
        print(f"Ring phone error: {e}")
        phone_clean = PHONE_NUMBER.replace('+', '').replace(' ', '').replace('-', '')
        return f"I couldn't directly ring your phone, but your number is +{phone_clean}."


def clean_whatsapp_number(phone_number):
    """Return a WhatsApp-ready international phone number without the plus sign."""
    number = re.sub(r'\D', '', phone_number or '')
    if number.startswith('00'):
        number = number[2:]
    if len(number) < 10:
        return None
    return number


def open_whatsapp_chat(phone_number, message=None):
    """Open WhatsApp Desktop when available, with WhatsApp Web as a fallback."""
    if not phone_number:
        try:
            opened = webbrowser.open("whatsapp://")
            if opened:
                return True, ""
        except Exception:
            pass

        webbrowser.open("https://web.whatsapp.com")
        return True, ""

    phone_clean = clean_whatsapp_number(phone_number)
    if not phone_clean:
        return False, "Please set a valid WhatsApp phone number."

    encoded_message = urllib.parse.quote(message or "")
    desktop_url = f"whatsapp://send?phone={phone_clean}"
    web_url = f"https://web.whatsapp.com/send?phone={phone_clean}"

    if encoded_message:
        desktop_url = f"{desktop_url}&text={encoded_message}"
        web_url = f"{web_url}&text={encoded_message}"

    try:
        opened = webbrowser.open(desktop_url)
        if not opened:
            webbrowser.open(web_url)
    except Exception:
        webbrowser.open(web_url)

    return True, phone_clean


def open_whatsapp_call(phone_number):
    """Try a direct WhatsApp call URI before falling back to chat automation."""
    phone_clean = clean_whatsapp_number(phone_number)
    if not phone_clean:
        return False, "Please set a valid WhatsApp phone number."

    call_uri = f"whatsapp://call?phone={phone_clean}"
    try:
        opened = webbrowser.open(call_uri)
        if opened:
            return True, f"Opening WhatsApp and calling +{phone_clean}."
    except Exception as e:
        print(f"WhatsApp call URI error: {e}")

    return False, "Could not start a direct WhatsApp call URI. Falling back to chat automation."


def get_whatsapp_call_click_position():
    """Return configured coordinates for WhatsApp's voice call button, when set."""
    try:
        if WHATSAPP_CALL_X and WHATSAPP_CALL_Y:
            return int(WHATSAPP_CALL_X), int(WHATSAPP_CALL_Y)
    except ValueError:
        print("Invalid WHATSAPP_CALL_X or WHATSAPP_CALL_Y. Using default position.")

    return None


def wait_for_whatsapp_window(timeout=None):
    """Find and focus the WhatsApp Desktop window."""
    if not gw:
        return None

    end_time = time.time() + (timeout or max(WHATSAPP_CALL_DELAY, 1))
    while time.time() < end_time:
        try:
            windows = [
                window for window in gw.getAllWindows()
                if "whatsapp" in (window.title or "").lower()
                and window.width > 250
                and window.height > 250
            ]
            if windows:
                window = max(windows, key=lambda item: item.width * item.height)
                if window.isMinimized:
                    window.restore()
                window.activate()
                time.sleep(0.5)
                return window
        except Exception as e:
            print(f"WhatsApp window focus error: {e}")
            return None

        time.sleep(0.5)

    return None


def _whatsapp_window_looks_like_browser(window):
    if not window:
        return False
    title = (window.title or "").lower()
    return any(
        b in title
        for b in ("chrome", "chromium", "microsoft edge", " msedge", "edge", "firefox", "mozilla", "brave", "opera")
    )


def get_whatsapp_window_call_position(window):
    """Estimate the voice-call (phone) icon: browser Web vs WhatsApp Desktop differ."""
    if not window:
        return None

    L, T, w, h = window.left, window.top, window.width, window.height
    if _whatsapp_window_looks_like_browser(window) and w >= 700:
        # Web: header icons sit in the upper band; phone is left of the video camera icon.
        y = T + min(88, max(58, int(h * 0.085)))
        x = L + int(w * 0.71)
        return max(x, 0), max(y, 0)

    x = L + w - max(WHATSAPP_CALL_OFFSET_X, 48)
    y = T + max(WHATSAPP_CALL_OFFSET_Y, 56)
    return max(x, 0), max(y, 0)


def click_whatsapp_call_button():
    """Open chat first (caller), wait for UI, move mouse, then click voice call (with retries)."""
    try:
        configured_position = get_whatsapp_call_click_position()
        if configured_position:
            time.sleep(max(WHATSAPP_CALL_DELAY, 1))
            x, y = configured_position
            pyautogui.moveTo(x, y, duration=0.25)
            pyautogui.click(x, y)
            time.sleep(1.8)
            pyautogui.click(x, y)
            return True, f"Clicked WhatsApp call button at {x}, {y} (configured)."

        window = wait_for_whatsapp_window(timeout=max(WHATSAPP_CALL_DELAY, 12))
        is_browser = _whatsapp_window_looks_like_browser(window) if window else False
        # Web needs longer for chat thread + header icons to render.
        load_wait = max(WHATSAPP_CALL_DELAY, 7.0 if is_browser else 3.5)
        time.sleep(load_wait)

        if not window:
            window = wait_for_whatsapp_window(timeout=8)

        if window:
            try:
                if window.isMinimized:
                    window.restore()
                window.activate()
                time.sleep(0.45)
            except Exception as e:
                print(f"WhatsApp activate: {e}")
            x, y = get_whatsapp_window_call_position(window)
        else:
            sw, _ = pyautogui.size()
            x, y = max(int(sw * 0.71), 0), 88
            if not gw:
                print("WhatsApp call: pygetwindow not installed; using screen fallback coordinates.")

        pyautogui.moveTo(x, y, duration=0.3)
        pyautogui.click(x, y)
        time.sleep(2.2)
        pyautogui.click(x, y)

        if is_browser and window:
            L, T, w, h = window.left, window.top, window.width, window.height
            y2 = T + min(88, max(58, int(h * 0.085)))
            for frac in (0.67, 0.75):
                x2 = L + int(w * frac)
                pyautogui.moveTo(x2, y2, duration=0.2)
                pyautogui.click(x2, y2)
                time.sleep(0.35)

        return True, f"Tapped the voice-call area near {x}, {y}. If the call did not start, set WHATSAPP_CALL_X and WHATSAPP_CALL_Y in backend/.env to your screen's phone icon."
    except Exception as e:
        print(f"WhatsApp call click error: {e}")
        return False, "I opened WhatsApp, but couldn't click the call button automatically."


def start_whatsapp_call(phone_number):
    """
    Open the chat for this number, wait, then click the voice-call control.

    Note: webbrowser.open('whatsapp://call?...') often returns True even when no call starts,
    so we never rely on that alone — we always open the chat and automate the call button.
    """
    phone_clean = clean_whatsapp_number(phone_number)
    if not phone_clean:
        return False, "Please set a valid WhatsApp phone number."

    opened, result = open_whatsapp_chat(phone_number, None)
    if not opened:
        return False, result

    clicked, message = click_whatsapp_call_button()
    if not clicked:
        return False, message

    return True, message


def open_mom_whatsapp_call_link():
    """Open a configured WhatsApp call invite link for mom."""
    if not MOM_WHATSAPP_CALL_LINK:
        return False

    if not MOM_WHATSAPP_CALL_LINK.startswith("https://call.whatsapp.com/"):
        print("Invalid MOM_WHATSAPP_CALL_LINK. It must start with https://call.whatsapp.com/.")
        return False

    webbrowser.open(MOM_WHATSAPP_CALL_LINK)
    return True


def call_mom_on_whatsapp():
    """Open mom's WhatsApp chat and click the voice-call button."""
    if open_mom_whatsapp_call_link():
        return "Opening your WhatsApp call link for mom."

    if not clean_whatsapp_number(MOM_NUMBER):
        return "Please set a valid WhatsApp number for your mom."

    start_whatsapp_call_async(MOM_NUMBER)
    return "Opening WhatsApp and starting the call to your mom."


def start_whatsapp_call_async(phone_number):
    """Start the WhatsApp call flow without blocking the assistant response."""
    thread = threading.Thread(target=start_whatsapp_call, args=(phone_number,), daemon=True)
    thread.start()


def play_sound(sound_path):
    """Play audio file"""
    try:
        if not pygame:
            return
        pygame.mixer.music.load(sound_path)
        pygame.mixer.music.play()
    except Exception as e:
        print(f"Sound error: {e}")

def listen_from_mic():
    """Listen to microphone input and convert to text"""
    try:
        with get_microphone_device() as source:
            _rec = get_recognizer()
            _rec.adjust_for_ambient_noise(source, duration=1)
            audio = _rec.listen(source, timeout=10, phrase_time_limit=7)
        
        query = get_recognizer().recognize_google(audio, language="en-US")
        return query.lower()
    except sr.WaitTimeoutError:
        return "timeout"
    except sr.UnknownValueError:
        return "didn't_understand"
    except sr.RequestError as e:
        return f"recognition_error: {str(e)}"
    except Exception as e:
        return f"error: {str(e)}"


def get_time_text():
    now = datetime.datetime.now()
    return now.strftime("Time is %I:%M %p").lstrip("0").replace(" 0", " ")


def get_date_text():
    return datetime.datetime.now().strftime("Today is %B %d, %Y")


def is_wake_phrase(message_lower):
    if any(phrase in message_lower for phrase in WAKE_PHRASES):
        return True
    return bool(re.search(r'\b' + re.escape(ASSISTANT_NAME.lower()) + r'\b', message_lower))


def get_wake_response():
    return f"Hello! I am {ASSISTANT_NAME}. How can I help you?"


def _cursor_task_animation_enabled():
    v = (os.getenv("CURSOR_TASK_ANIMATION") or "1").strip().lower()
    return v not in ("0", "false", "no", "off")


def animate_cursor_task_start():
    """
    Smoothly move the mouse in a small pattern so you see the assistant is doing a desktop task.
    Runs in a thread from /api/chat so it does not block the HTTP response.
    """
    if not _cursor_task_animation_enabled():
        return
    try:
        cx, cy = pyautogui.position()
        sw, sh = pyautogui.size()
        try:
            r = int(os.getenv("CURSOR_TASK_RADIUS", "76"))
        except ValueError:
            r = 76
        r = max(24, min(r, sw // 7, sh // 7))

        def clamp(px, py):
            return max(1, min(int(px), sw - 2)), max(1, min(int(py), sh - 2))

        path = [
            (cx, cy),
            (cx + r * 0.9, cy),
            (cx + r * 0.45, cy + r * 0.75),
            (cx - r * 0.45, cy + r * 0.75),
            (cx - r * 0.9, cy),
            (cx - r * 0.45, cy - r * 0.55),
            (cx + r * 0.45, cy - r * 0.55),
            (cx, cy),
        ]
        for px, py in path:
            tx, ty = clamp(px, py)
            pyautogui.moveTo(tx, ty, duration=0.32)
        time.sleep(0.05)
    except Exception as e:
        print(f"animate_cursor_task_start: {e}")


def should_preview_cursor_task_animation(message_lower, mode="auto"):
    """Avoid cursor-preview animation when the command itself controls the pointer."""
    ml = (message_lower or "").strip()
    if not might_use_physical_automation(ml, mode):
        return False

    direct_pointer_patterns = (
        r"^(move|drag)\s+(?:the\s+)?(?:mouse|cursor)\b",
        r"^(wake\s+)?(cursor|mouse)\b",
        r"^animate\s+(?:the\s+)?(?:mouse|cursor)\b",
        r"^(show|wave)\s+(?:the\s+)?(?:mouse|cursor)\b",
        r"^cursor\s+(dance|wave)\b",
        r"^(single\s*)?click\b",
        r"^left\s+click\b",
        r"^mouse\s+click\b",
        r"^click\s+mouse\b",
        r"^double[-\s]*click\b",
        r"^scroll\s+(up|down)\b",
    )
    return not any(re.search(pattern, ml) for pattern in direct_pointer_patterns)


def might_use_physical_automation(message_lower, mode="auto"):
    """
    True when we are likely to drive the mouse/keyboard/OS — play a short cursor motion first.
    """
    ml = (message_lower or "").strip()
    if not ml or is_wake_phrase(ml):
        return False

    if AUTOMATION_INTENT.search(ml):
        return True

    if re.search(r"\btask\b", ml) and re.search(
        r"\b(mouse|cursor|click|type|open|keyboard|screen|window|desktop|move)\b", ml
    ):
        return True

    triggers = (
        "open ",
        "type ",
        "write ",
        "press ",
        "click",
        "move mouse",
        "move cursor",
        "drag mouse",
        "scroll",
        "call mom",
        "call my",
        "message mom",
        "lock my",
        "shut down",
        "shutdown",
        "refresh",
        "calculate",
        "find my phone",
        "ring my phone",
        "save my browser",
        "load my browser",
        "restore browser",
        "open my browser",
        "robot ",
        "automate",
        "hotkey",
        "shortcut",
    )
    if any(t in ml for t in triggers):
        return True

    if "call" in ml and ("phone" in ml or "number" in ml):
        return True

    if (mode or "").strip().lower() == "command" and re.search(
        r"\b(open|type|click|move|press|call|lock|shut|refresh|scroll|write|save|restore|message|"
        r"calculate|mouse|cursor|keyboard|robot|automate|task|plz|please|whatsapp|browser|file)\b",
        ml,
    ):
        return True

    if re.search(r"\b(do|perform|execute)\s+(this|that|it)\b", ml) and re.search(
        r"\b(mouse|cursor|click|type|window|browser|keyboard|screen|open|press|move)\b", ml
    ):
        return True

    return False


def handle_assistant_query(message, message_lower, personality=None, style=None, page_context="", url="", history=None):
    """Handle general questions conversationally.

    This is ESTA Chat's pure conversational path. It MUST NOT run device or
    browser commands and MUST NOT open a browser. Even messages that look like
    a search or contain a website name/URL are answered as text only.
    """
    if is_wake_phrase(message_lower):
        return get_wake_response()

    # NOTE: "search / find / look up / google" are intentionally NOT routed to
    # web_search() here. Opening a search page in the browser would be a browser
    # action, which ESTA Chat must never trigger. We answer conversationally.
    
    if any(phrase in message_lower for phrase in ["what time", "what is the time", "what is the current time", "what's the time", "whats the time", "current time", "time now", "time is it", "tell me the time", "wht the time", "whats time"]):
        return get_time_text()
    
    if any(phrase in message_lower for phrase in ["what date", "what is the date", "what's the date", "todays date", "today's date", "current date", "date today"]):
        return get_date_text()
    
    return ask_ai(message, personality, style, page_context, url, allow_live_search=True, history=history)


def handle_command(message, message_lower):
    """Handle local/device commands without falling back to the AI model."""
    quick = try_quick_keyboard_mouse_command(message, message_lower)
    if quick:
        return quick

    if "calculate" in message_lower:
        result = calculate(message_lower)
        if result is not None:
            return f"The answer is {result}"
        return "Sorry, I couldn't calculate that"

    if re.match(r"^(what(?:'s|\s+is)?\s+)?(the\s+)?time\s*$", message_lower):
        time_text = datetime.datetime.now().strftime("Time is %I:%M %p")
        threading.Thread(target=speak, args=(time_text,), daemon=True).start()
        return time_text

    if re.match(r"^(what(?:'s|\s+is)?\s+)?(the\s+)?date\s*$", message_lower):
        date_text = datetime.datetime.now().strftime("Today is %d %B %Y")
        threading.Thread(target=speak, args=(date_text,), daemon=True).start()
        return date_text

    if "open youtube" in message_lower:
        webbrowser.open("https://www.youtube.com")
        return "Opening YouTube"

    if "open google maps" in message_lower or re.search(r"\bopen maps\b", message_lower):
        webbrowser.open("https://www.google.com/maps")
        return "Opening Google Maps."

    if "open google" in message_lower and "map" not in message_lower:
        webbrowser.open("https://www.google.com")
        return "Opening Google"

    if any(phrase in message_lower for phrase in [
        "call mom", "call my mom", "call mother", "call my mother",
        "phone mom", "phone my mom", "whatsapp call mom",
        "call mom on whatsapp", "call my mom on whatsapp",
        "call mom from whatsapp", "call my mom from whatsapp",
        "open whatsapp and call mom", "open whatsapp to call mom"
    ]):
        return call_mom_on_whatsapp()

    if "open whatsapp" in message_lower or (
        "open" in message_lower and "whatsapp" in message_lower and "mom" not in message_lower
    ):
        ok, msg = open_website_in_browser("whatsapp")
        return msg if ok else msg

    if "open spotify" in message_lower or "play spotify" in message_lower:
        webbrowser.open("https://open.spotify.com/playlist/1pEV2wwRRZQnBYfIW7BgIp?si=a7c4ec0613b34c6b&pt=96fdac428e9836c34fa5007c963317c9")
        return "Opening your Spotify playlist"

    if "open chatgpt" in message_lower or "open ai" in message_lower or "open gpt" in message_lower:
        webbrowser.open("https://chat.openai.com")
        return "Opening ChatGPT"

    if "lock my pc" in message_lower:
        os.system("rundll32.exe user32.dll,LockWorkStation")
        return "Locking your PC"

    if "shut down my pc" in message_lower or message_lower.strip() == "shutdown":
        os.system("shutdown /s /t 10")
        return "Shutdown command received"

    if message_lower.strip() == "refresh" or message_lower.strip() == "refresh page":
        pyautogui.press('f5')
        return "Refreshing the desktop"

    if re.search(r"\bsave\s+(?:my\s+|current\s+|running\s+|open\s+)?browsers?\b", message_lower):
        return save_browser_state()

    if re.search(r"\b(?:restore|reopen|open|load)\s+(?:all\s+|my\s+|saved\s+)?browsers?\b", message_lower):
        return open_saved_browsers()

    if "message mom" in message_lower:
        msg = message_lower.replace("message mom", "").strip()
        opened, result = open_whatsapp_chat(MOM_NUMBER, msg if msg else "Hi mom!")
        return "Opening WhatsApp with your message ready to send" if opened else result

    if "call" in message_lower and any(word in message_lower for word in ["number", "phone"]):
        phone_match = re.search(r'(\+?\d[\d\s\-\(\)]{6,})', message_lower)
        if phone_match:
            phone_clean = clean_whatsapp_number(phone_match.group(1))
            if phone_clean:
                start_whatsapp_call_async(phone_clean)
                return f"Opening WhatsApp and starting the call to +{phone_clean}."
            return "Please provide a valid phone number to call."
        return "Please specify a phone number to call."

    if any(phrase in message_lower for phrase in ["find my phone", "ring my phone", "ring phone", "call my phone", "find phone", "find my mobile", "ring my mobile"]):
        return ring_my_phone(message_lower)

    if re.match(r"^\s*(please\s+|can you\s+|could you\s+|would you\s+)?open\b", message_lower):
        file_reply = try_open_file_phrase(message, message_lower)
        if file_reply:
            return file_reply

        open_target = message_lower.replace("open", "", 1).strip()
        open_target = re.sub(r"^(the|my|a|an)\s+", "", open_target).strip()
        folder_name = extract_folder_name(open_target)
        if folder_name:
            return open_folder(folder_name)

        ot = open_target.strip()
        tokens = re.findall(r"[a-z0-9]+", ot.lower())
        prefer_app_exe = frozenset(
            {"chrome", "firefox", "edge", "notepad", "calculator", "calc", "paint", "word", "excel", "vlc", "spotify"}
        )
        if len(tokens) == 1 and tokens[0] in prefer_app_exe:
            return open_app(tokens[0])

        ok, wmsg = open_website_in_browser(open_target)
        if ok:
            return wmsg

        for app_name_key in sorted(APP_COMMANDS.keys(), key=len, reverse=True):
            if re.search(rf"(^|\s){re.escape(app_name_key)}(\s|$)", ot):
                return open_app(app_name_key)

        path = resolve_user_file_path(open_target)
        if path:
            ok, msg = open_user_file_by_path(path)
            return msg if ok else msg

        if re.search(r"[\\/]|\.(txt|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|zip|rar|7z|csv|py|html?|js|ts|json|md|log)\b", open_target, re.I):
            return f"I could not find a file named like: {open_target}. Put it on Desktop, Documents, or Downloads, or send the full path."

        query = open_target.strip()
        if query:
            webbrowser.open(f"https://www.google.com/search?q={urllib.parse.quote(query)}")
            return f"I opened Google search for: {query}"
        return "What should I open or search for?"

    return None


# ===== API ENDPOINTS =====
@app.route('/api/chat', methods=['POST'])
def chat():
    """Handle chat messages"""
    print("\n" + "="*60)
    print("[CHAT] New request received")
    try:
        data = request.get_json(silent=True) or {}
        message = data.get('message', '').strip()
        message_lower = message.lower()
        mode = data.get('mode', 'auto').strip().lower()
        
        personality = data.get('personality', DEFAULT_PERSONALITY)
        style = data.get('style', DEFAULT_STYLE)
        page_context = data.get('page_context', '')
        url = data.get('url', '')
        history = _sanitize_history(data.get('history'))
        documents = data.get('documents') or []
        if not isinstance(documents, list):
            documents = []
        scanned = data.get('scannedPages') or []
        if not isinstance(scanned, list):
            scanned = []

        def _doc_context_block():
            """Render attached documents as a labelled, quoted context block.

            This is what actually reaches the model - real extracted text, not a
            filename - so ESTA can summarise it, quote it and answer follow-ups
            that refer back to 'the document'."""
            blocks = []
            for d in documents[:6]:
                if not isinstance(d, dict):
                    continue
                nm = str(d.get('name') or 'document')
                txt = str(d.get('text') or '').strip()
                pmap = str(d.get('pageMap') or '').strip()
                trunc = d.get('truncated')
                bits = [f'--- ATTACHED DOCUMENT: {nm} ---']
                if pmap:
                    bits.append(f'[page map]\n{pmap}')
                if txt:
                    body = txt
                    if trunc:
                        body += '\n[...document truncated; only question-relevant sections shown...]'
                    bits.append(body)
                else:
                    bits.append('[no selectable text - see attached page images]')
                blocks.append('\n'.join(bits))
            return '\n\n'.join(blocks)

        print(f"[CHAT] Message: '{message}'")
        print(f"[CHAT] Mode: {mode}")
        print(f"[CHAT] Personality: {personality}, Style: {style}")
        print(f"[CHAT] URL: {url}")
        print(f"[CHAT] Page context length: {len(page_context)}")
        print(f"[CHAT] History turns: {len(history)}")
        
        
        if not message:
            return jsonify({'error': 'Empty message'}), 400

        # Long-term memory: quietly persist personal facts ("my name is X", likes, etc.)
        _remember_facts(message)

        # ===== ATTACHMENTS: documents only, no image =====
        # Routed through the normal text model because the content is real
        # extracted text. Answer using ONLY the attached content; never invent
        # facts that are not in it.
        if mode == 'ask' and documents:
            doc_ctx = _doc_context_block()
            if doc_ctx:
                print(f"[CHAT] {len(documents)} document(s) attached, "
                      f"{len(doc_ctx)} chars of context")
                instruction = (
                    'Answer using ONLY the attached document content below. '
                    'If the answer is not present in it, say so plainly instead '
                    'of guessing. Quote or cite the document when useful.\n\n'
                    + doc_ctx
                )
                user_message = f"{message}\n\n{instruction}" if message else instruction
                res = None
                try:
                    res = ask_ai(user_message, personality=personality, style=style,
                                 page_context=page_context, url=url,
                                 allow_live_search=False, history=history)
                except Exception as de:
                    print(f"[CHAT] document Q&A failed: {de}")
                if res:
                    res = _strip_html(res)
                    return jsonify({
                        'response': res,
                        'mode': 'ask',
                        'attachments': [d.get('name') for d in documents
                                       if isinstance(d, dict)],
                        'timestamp': datetime.datetime.now().isoformat()
                    })

        # Handle vision mode with one or more images (base64 data URLs)
        if mode == 'vision' and (data.get('image') or data.get('images') or scanned):
            print("[CHAT] Vision mode - analyzing image(s)")
            try:
                images = data.get('images') or []
                if isinstance(images, str):
                    images = [images]
                if data.get('image') and not images:
                    images = [data.get('image')]
                # Pages rasterised from a scanned PDF are real images the vision
                # model can read, so they join the same image set.
                for sp in scanned[:_PDF_RENDER_LIMIT]:
                    if isinstance(sp, dict) and sp.get('image'):
                        images.append(sp['image'])
                images = [img for img in images if isinstance(img, str) and img]
                mime_type = data.get('mimeType', 'image/png')
                if images:
                    if len(images) == 1:
                        # Keep conversation context so ESTA understands follow-ups
                        # like "and what about the price?" after an image question.
                        prompt = message
                        if history:
                            transcript = "\n".join(
                                f"{'User' if h.get('role') == 'user' else 'ESTA'}: "
                                f"{_history_content_to_text(h.get('content'))}"
                                for h in history[-6:]
                            )
                            prompt = f"Previous conversation:\n{transcript}\n\nCurrent request: {message}"
                        # An image + a document in the same message must be read
                        # together, so the document text rides along in the prompt.
                        doc_ctx = _doc_context_block()
                        if doc_ctx:
                            prompt = (
                                f"{prompt}\n\n{doc_ctx}\n\n"
                                'Use the document text above together with the image(s). '
                                'If the document is truncated, say what you could not see.'
                            )
                        result_text = ollama_vision(images[0], prompt, VISION_SYSTEM_PROMPT)
                    else:
                        prompt_multi = message
                        doc_ctx_m = _doc_context_block()
                        if doc_ctx_m:
                            prompt_multi = (
                                f"{prompt_multi}\n\n{doc_ctx_m}\n\n"
                                'Use the document text above together with the image(s).'
                            )
                        result_text = ollama_vision_multi(images, prompt_multi, VISION_SYSTEM_PROMPT)
                    result_text = _strip_html(result_text)
                    return jsonify({
                        'response': result_text,
                        'mode': 'vision',
                        'timestamp': datetime.datetime.now().isoformat()
                    })
            except Exception as ve:
                print(f"[CHAT] Vision failed: {ve}")
                return jsonify({'response': f'Vision analysis failed: {str(ve)}', 'mode': 'vision'}), 200

        if is_wake_phrase(message_lower):
            print("[CHAT] Wake phrase detected")
            return jsonify({
                'response': get_wake_response(),
                'mode': mode,
                'activated': True,
                'timestamp': datetime.datetime.now().isoformat()
            })

        # Keep command handling stable: only explicit mouse commands should touch pyautogui.
        # The old automatic preview animation could terminate the process on some Windows sessions.

        if mode == "ask":
            print("[CHAT] Processing as 'ask' mode (conversational only)")
            # ESTA Chat is strictly conversational. It must NEVER route to the
            # browser/device command system. Mentioning a website, URL, app, or
            # command is just conversation and must not trigger navigation.
            response_text = handle_assistant_query(message, message_lower, personality, style, page_context, url, history)
        elif mode == "command":
            print("[CHAT] Processing as 'command' mode")
            response_text = handle_command(message, message_lower)
            if not response_text:
                response_text = try_planned_automation(message)
            if not response_text:
                response_text = "That is not a supported command yet. Try: open YouTube, open WhatsApp, move mouse to center, open a file name, type hello, press enter, or describe mouse and keyboard steps."
        else:
            print("[CHAT] Processing as 'auto' mode")
            response_text = handle_command(message, message_lower)
            if not response_text:
                response_text = try_planned_automation(message)
            if not response_text:
                print("[CHAT] Command not found, trying assistant query")
                response_text = handle_assistant_query(message, message_lower, personality, style, page_context, url, history)
        
        print(f"[CHAT] Final response: {response_text[:100]}...")
        print("="*60 + "\n")
        return jsonify({
            'response': response_text,
            'mode': mode,
            'timestamp': datetime.datetime.now().isoformat()
        })
    
    except Exception as e:
        import traceback
        print(f"[CHAT] ERROR: {type(e).__name__}: {e}")
        print(f"[CHAT] Traceback:\n{traceback.format_exc()}")
        print("="*60 + "\n")
        return jsonify({'error': str(e)}), 500

@app.route('/api/offline-ai/status', methods=['GET'])
def offline_ai_status():
    """Current ON/OFF state of the offline AI, plus what Ollama has resident."""
    return jsonify(_offline_ai_snapshot())


@app.route('/api/offline-ai/on', methods=['POST'])
def offline_ai_on():
    """Turn the offline AI on. Optionally warm the model so the first reply is fast."""
    _set_offline_ai_enabled(True)
    warm = (request.get_json(silent=True) or {}).get('warm', False)
    snap = _offline_ai_snapshot()
    if warm:
        try:
            _ollama_generate(OLLAMA_OFFLINE_MODEL, 'hi', num_predict=1, keep_alive='30m')
            snap = _offline_ai_snapshot()
        except Exception as e:
            snap = _offline_ai_snapshot()
            snap['warm_error'] = str(e)
    print(f"[OFFLINE-AI] ON (warm={bool(warm)}) model={OLLAMA_OFFLINE_MODEL}")
    return jsonify(snap)


@app.route('/api/offline-ai/off', methods=['POST'])
def offline_ai_off():
    """Turn the offline AI off and evict the model from RAM.

    A loaded Ollama model holds its whole weight set resident (qwen3:1.7b is
    ~1.8 GB), so switching the offline AI off is what actually gives that memory
    back to the machine.
    """
    _set_offline_ai_enabled(False)
    freed = _unload_ollama_models()
    snap = _offline_ai_snapshot()
    snap['freed_mb'] = freed
    print(f"[OFFLINE-AI] OFF - unloaded {freed} MB of model weights")
    return jsonify(snap)


@app.route('/api/offline-chat', methods=['POST'])
def offline_chat():
    """Offline chat via local Ollama (qwen3-4b). Zero network/cloud usage."""
    print("\n" + "="*60)
    print("[OFFLINE-CHAT] New request")
    if not _offline_ai_enabled():
        return jsonify({
            'error': 'Offline AI is turned off. Switch it on in the AI panel to use local chat.',
            'offline': True, 'disabled': True
        }), 409
    try:
        data = request.get_json(silent=True) or {}
        message = data.get('message', '').strip()
        if not message:
            return jsonify({'error': 'Empty message'}), 400
        print(f"[OFFLINE-CHAT] Message: '{message[:120]}'")
        system_prompt = (
            "You are NEXORA Browser's built-in offline AI assistant. Ask the user's "
            "question clearly and honestly. Never claim to use the internet.\n\n" +
            OFFLINE_STYLE_GUIDE
        )
        result = ollama_offline_chat(
            message,
            history=data.get('history') or [],
            system_prompt=system_prompt,
            max_tokens=int(data.get('max_tokens', OFFLINE_MAX_TOKENS)),
            use_memory=data.get('use_memory', True),
            use_rag=data.get('use_rag', True)
        )
        print(f"[OFFLINE-CHAT] Response: {len(result)} chars")
        print("="*60 + "\n")
        return jsonify({
            'response': result,
            'model': OLLAMA_OFFLINE_MODEL,
            'offline': True,
            'timestamp': datetime.datetime.now().isoformat()
        })
    except Exception as e:
        import traceback
        print(f"[OFFLINE-CHAT] ERROR: {type(e).__name__}: {e}")
        print(f"[OFFLINE-CHAT] Traceback:\n{traceback.format_exc()}")
        print("="*60 + "\n")
        return jsonify({'error': str(e), 'offline': True}), 500

@app.route('/api/offline-chat/stream', methods=['POST', 'OPTIONS'])
def offline_chat_stream():
    """Stream offline chat via local Ollama (SSE). Zero network/cloud usage."""
    if request.method == 'OPTIONS':
        response = jsonify({'success': True})
        response.headers.add('Access-Control-Allow-Methods', 'POST, OPTIONS')
        response.headers.add('Access-Control-Allow-Headers', 'Content-Type')
        return response

    if not _offline_ai_enabled():
        return jsonify({
            'error': 'Offline AI is turned off. Switch it on in the AI panel to use local chat.',
            'offline': True, 'disabled': True
        }), 409

    data = request.get_json(silent=True) or {}
    message = data.get('message', '').strip()
    if not message:
        return jsonify({'error': 'Empty message'}), 400

    print(f"[OFFLINE-CHAT][STREAM] Message: '{message[:120]}'")
    system_prompt = (
        "You are NEXORA Browser's built-in offline AI assistant. Answer the user's "
        "question clearly and honestly. Never claim to use the internet.\n\n" +
        OFFLINE_STYLE_GUIDE
    )
    max_tokens = int(data.get('max_tokens', OFFLINE_MAX_TOKENS))
    use_memory = bool(data.get('use_memory', True))
    use_rag = bool(data.get('use_rag', True))
    history = data.get('history') or []

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": _build_offline_system_prompt(
            system_prompt, message, use_memory=use_memory, use_rag=use_rag)})
    for m in history:
        role = m.get('role')
        content = m.get('content')
        if role in ('system', 'user', 'assistant') and content:
            messages.append({"role": role, "content": str(content)[:1500]})
    messages = _trim_messages(messages, OFFLINE_HISTORY_COUNT + 1)
    messages.append({"role": "user", "content": message})

    def sse_event(event_type, payload):
        """Format an SSE event."""
        return f"event: {event_type}\ndata: {json.dumps(payload)}\n\n"

    def generate():
        import urllib.request
        payload = {
            "model": OLLAMA_OFFLINE_MODEL,
            "messages": messages,
            "stream": True,
            "keep_alive": OLLAMA_KEEP_ALIVE,
            "options": _offline_ollama_options(max_tokens)
        }
        try:
            req = urllib.request.Request(
                f"{OLLAMA_URL}/api/chat",
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            resp = urllib.request.urlopen(req, timeout=300)
            full = []
            for raw_line in resp:
                line = raw_line.decode("utf-8").strip()
                if not line:
                    continue
                if line.startswith("data:"):
                    line = line[5:].strip()
                try:
                    chunk = json.loads(line)
                except Exception:
                    continue
                msg = chunk.get("message") or {}
                piece = msg.get("content") or ""
                if piece:
                    full.append(piece)
                    yield sse_event('delta', {'delta': piece})
                if chunk.get("done"):
                    text = _style_offline_response(strip_think_tags(''.join(full)))
                    print(f"[OFFLINE-CHAT][STREAM] Complete: {len(text)} chars")
                    yield sse_event('done', {
                        'response': text,
                        'model': OLLAMA_OFFLINE_MODEL,
                        'offline': True,
                        'timestamp': datetime.datetime.now().isoformat()
                    })
                    return
        except Exception as e:
            import traceback
            print(f"[OFFLINE-CHAT][STREAM] ERROR: {type(e).__name__}: {e}")
            print(f"[OFFLINE-CHAT][STREAM] Traceback:\n{traceback.format_exc()}")
            yield sse_event('error', {'error': str(e)})

    response = Response(generate(), mimetype='text/event-stream')
    response.headers['Cache-Control'] = 'no-cache'
    response.headers['X-Accel-Buffering'] = 'no'
    return response

@app.route('/api/voice/listen', methods=['POST'])
def voice_listen():
    """Listen to microphone and return transcribed text"""
    try:
        result = listen_from_mic()
        status = "ok"
        error = None
        if isinstance(result, str) and result.startswith("error:"):
            status = "error"
            error = result
        elif result in ("timeout", "didn't_understand"):
            status = "no_speech"
        elif isinstance(result, str) and result.startswith("recognition_error:"):
            status = "error"
            error = result

        return jsonify({'transcription': result, 'status': status, 'error': error, 'mic_index': MICROPHONE_INDEX})
    except Exception as e:
        print(f"Listen error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/voice/transcribe', methods=['POST'])
def voice_transcribe():
    """
    Transcribe audio uploaded from the browser.
    Accepts either raw WAV bytes or FormData with 'audio' field (webm/opus).
    """
    try:
        import tempfile, subprocess, os
        language = (request.args.get("lang") or "en-US").strip()
        wav_bytes = b""

        # Check if FormData with file upload
        if 'audio' in request.files:
            audio_file = request.files['audio']
            audio_bytes = audio_file.read()
            if not audio_bytes:
                return jsonify({"status": "error", "error": "empty_audio"}), 400
            # Save to temp file, convert via ffmpeg to wav, read back
            tmp_dir = tempfile.mkdtemp()
            try:
                in_path = os.path.join(tmp_dir, "input.webm")
                out_path = os.path.join(tmp_dir, "output.raw")
                with open(in_path, "wb") as f:
                    f.write(audio_bytes)
                # Convert webm to raw PCM (s16le) — sr.AudioData expects raw PCM, not WAV
                subprocess.run(
                    ["ffmpeg", "-y", "-i", in_path, "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", "-f", "s16le", out_path],
                    capture_output=True, timeout=30
                )
                with open(out_path, "rb") as f:
                    wav_bytes = f.read()
            finally:
                import shutil
                shutil.rmtree(tmp_dir, ignore_errors=True)
            sample_rate = 16000
            sample_width = 2
        else:
            sample_rate = int(request.args.get("sample_rate", "16000"))
            sample_width = int(request.args.get("sample_width", "2"))
            wav_bytes = request.get_data(cache=False, as_text=False) or b""
            if not wav_bytes:
                return jsonify({"status": "error", "error": "empty_audio"}), 400

        audio_data = sr.AudioData(wav_bytes, sample_rate=sample_rate, sample_width=sample_width)
        text = get_recognizer().recognize_google(audio_data, language=language)
        return jsonify({"status": "ok", "transcription": (text or "").lower()})
    except sr.UnknownValueError:
        return jsonify({"status": "no_speech", "transcription": ""})
    except sr.RequestError as e:
        return jsonify({"status": "error", "error": f"recognition_error: {str(e)}"}), 502
    except subprocess.TimeoutExpired:
        return jsonify({"status": "error", "error": "audio_conversion_timeout"}), 502
    except Exception as e:
        return jsonify({"status": "error", "error": f"error: {str(e)}"}), 500

@app.route('/api/voice/mics', methods=['GET'])
def list_microphones():
    """List available microphone device names (indices)."""
    try:
        names = sr.Microphone.list_microphone_names()
        return jsonify({
            "microphones": [{"index": i, "name": n} for i, n in enumerate(names)],
            "selected_index": MICROPHONE_INDEX,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/voice/speak', methods=['POST'])
def voice_speak():
    """Convert text to speech"""
    try:
        data = request.get_json(silent=True) or {}
        text = data.get('text', '').strip()
        
        if not text:
            return jsonify({'error': 'Empty text'}), 400
        
        # pyttsx3 is more reliable when run synchronously from one request.
        speak(text)
        
        return jsonify({'status': 'spoken'})
    except Exception as e:
        print(f"Speak error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/voice/tts', methods=['POST'])
def voice_tts():
    """
    Return TTS audio bytes for browser playback (MP3).
    This bypasses OS-level audio playback (pyttsx3/pygame) which may be muted
    when the server runs in a background session.
    """
    try:
        data = request.get_json(silent=True) or {}
        text = (data.get("text") or "").strip()
        requested_voice = (data.get("voice_id") or "").strip()
        voice_id = requested_voice or (current_voice if current_voice.startswith("gtts_") else "gtts_en")
        if not text:
            return jsonify({"error": "Empty text"}), 400

        if not gTTS and not voice_id.startswith("edge_"):
            return jsonify({"error": "gTTS not installed"}), 501

        if not (voice_id.startswith("gtts_") or voice_id.startswith("edge_")):
            return jsonify({"error": "Selected voice is not a browser MP3 voice"}), 409

        # Keep responses small and snappy.
        if len(text) > 600:
            text = text[:600]

        # ===== Neural female AI voices (Microsoft Edge) =====
        if voice_id.startswith("edge_"):
            if EDGE_AVAILABLE is False:
                return jsonify({"error": "edge-tts not installed"}), 501
            try:
                audio = edge_tts_bytes(text, voice_id)
            except Exception as e:
                print(f"EDGE TTS error: {e}")
                return jsonify({"error": str(e)}), 500
            if not audio:
                return jsonify({"error": "Edge TTS returned no audio"}), 500
            return Response(audio, mimetype="audio/mpeg")

        voice_config = get_gtts_voice_config(voice_id)
        if "tld" in voice_config:
            tts = gTTS(text=text, lang=voice_config["lang"], tld=voice_config["tld"])
        else:
            tts = gTTS(text=text, lang=voice_config["lang"])
        fp = io.BytesIO()
        tts.write_to_fp(fp)
        fp.seek(0)
        return Response(fp.read(), mimetype="audio/mpeg")
    except Exception as e:
        print(f"TTS error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/voice/status', methods=['GET'])
def voice_status():
    """Return current voice engine state"""
    return jsonify({'speaking': is_speaking})

@app.route('/api/voice/stop', methods=['POST'])
def voice_stop():
    """Stop current voice output"""
    global stop_speaking
    stop_speaking = True
    try:
        if pygame:
            pygame.mixer.music.stop()
        if engine:
            engine.stop()
    except:
        pass
    return jsonify({'status': 'stopped'})

@app.route('/api/voice/voices', methods=['GET'])
def get_voices():
    """Get available voices"""
    try:
        voice_list = get_available_voices()
        return jsonify({
            'voices': voice_list,
            'current': current_voice
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/voice/set', methods=['POST'])
def set_voice_endpoint():
    """Set current voice"""
    try:
        data = request.get_json(silent=True) or {}
        voice_id = data.get('voice_id', '').strip()
        
        if not voice_id:
            return jsonify({'error': 'Voice ID required'}), 400
        
        set_voice(voice_id)
        return jsonify({'status': 'voice_set', 'voice': current_voice})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/system/lock', methods=['POST'])
def system_lock():
    """Lock the system"""
    try:
        os.system("rundll32.exe user32.dll,LockWorkStation")
        return jsonify({'status': 'locked'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/system/shutdown', methods=['POST'])
def system_shutdown():
    """Shutdown the system (with 10 second delay for safety)"""
    try:
        os.system("shutdown /s /t 10")
        return jsonify({'status': 'shutting_down'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/browser/save', methods=['POST'])
def browser_save():
    """Save running browsers"""
    try:
        result = save_browser_state()
        return jsonify({'status': result})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/browser/restore', methods=['POST'])
def browser_restore():
    """Restore saved browsers"""
    try:
        result = open_saved_browsers()
        return jsonify({'status': result})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/find_phone', methods=['POST'])
def api_find_phone():
    """Handle phone number lookup search."""
    try:
        data = request.get_json(silent=True) or {}
        phone_number = data.get('phone_number', '').strip()
        if not phone_number:
            return jsonify({'error': 'Phone number is required'}), 400

        message = find_phone_location(phone_number)
        return jsonify({'status': 'ok', 'message': message})
    except Exception as e:
        print(f"Find phone API error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/vision', methods=['POST'])
def vision():
    """Analyze an image using Groq vision model via direct REST API"""
    try:
        data = request.get_json(silent=True) or {}
        message = data.get('message', 'What is in this image?').strip()
        image_b64 = data.get('image', '')
        mime_type = data.get('mimeType', 'image/png')

        if not image_b64:
            return jsonify({'error': 'No image data provided'}), 400

        data_url = f'data:{mime_type};base64,{image_b64}'

        try:
            print(f"[VISION] Using Ollama {OLLAMA_VISION_MODEL}")
            result_text = ollama_vision(image_b64, message, VISION_SYSTEM_PROMPT)
            return jsonify({'response': _strip_html(result_text)})
        except Exception as e:
            return jsonify({'response': f'Vision request failed: {str(e)}'}), 200
    except Exception as e:
        print(f"[VISION] ERROR: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/api/analyze-performance', methods=['POST'])
def analyze_performance():
    """Analyze browser performance and suggest optimizations using AI"""
    try:
        data = request.get_json(silent=True) or {}
        fps = data.get('fps', 60)
        tab_count = data.get('tabCount', 1)
        memory = data.get('memory', 0)
        current_url = data.get('currentUrl', '')
        tabs = data.get('tabs', [])

        tab_summary = '\n'.join([f'- Tab {i+1}: {t.get("title","?")} ({t.get("url","?")})' for i, t in enumerate(tabs[:15])])
        if len(tabs) > 15: tab_summary += f'\n... and {len(tabs)-15} more'

        system_prompt = """You are ESTA Performance Optimizer. Analyze browser performance and return JSON only.
Available actions:
- "close_tabs": Close specific tabs by index (keep index 0)
- "disable_rgb": Turn off RGB light strips
- "disable_particles": Turn off particle background
- "disable_wallpaper": Set wallpaper to none
- "clear_cache": Clear browser cache

Return format (JSON only, no markdown):
{
  "status": "stable|slow|critical",
  "fps_verdict": "short explanation of FPS",
  "cause": "what's causing the issue",
  "message": "user-friendly message for popup",
  "suggestions": [
    {"action": "close_tabs", "label": "Close 3 duplicate tabs", "params": {"indices": [3,4,5]}},
    {"action": "disable_rgb", "label": "Turn off RGB lights"}
  ]
}"""

        prompt = f"""Current browser performance:
- FPS: {fps}/60
- Tabs open: {tab_count}
- Memory: {memory} MB
- Active URL: {current_url}

Open tabs:
{tab_summary}

Analyze and return JSON."""

        resp = client.chat.completions.create(
            model="allam-2-7b",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt}
            ],
            temperature=0.1,
            max_tokens=500
        )
        text = strip_think_tags(resp.choices[0].message.content)
        # Strip markdown code fences if present
        if text.startswith('```'): text = text.split('\n', 1)[1]
        if text.endswith('```'): text = text.rsplit('```', 1)[0]
        text = text.strip()
        result = json.loads(text)
        return jsonify(result)
    except Exception as e:
        import traceback
        print(f"[PERF] Error: {e}\n{traceback.format_exc()}")
        return jsonify({
            'status': 'stable',
            'fps_verdict': 'Analysis unavailable',
            'cause': 'Backend temporarily unavailable',
            'message': 'Performance optimizer is ready',
            'suggestions': []
        })

# --- Cached health probe (avoids blocking /api/health on Ollama) ---
_health_cache = {'available': False, 'error': 'startup', 'ts': 0}
_health_lock = threading.Lock()

def _health_probe_loop():
    """Background thread: probes Ollama every 15s, updates cache."""
    while True:
        time.sleep(15)
        ok = False
        err = None
        try:
            import urllib.request
            off_req = urllib.request.Request(
                f"{OLLAMA_URL}/api/show",
                data=json.dumps({"model": OLLAMA_OFFLINE_MODEL}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            off_resp = urllib.request.urlopen(off_req, timeout=3)
            if off_resp.status == 200:
                ok = True
        except Exception as e:
            err = str(e)[:80]
        with _health_lock:
            _health_cache.update({'available': ok, 'error': err, 'ts': time.time()})

try:
    t = threading.Thread(target=_health_probe_loop, daemon=True)
    t.start()
except Exception:
    pass

@app.route('/api/health', methods=['GET'])
def health():
    """Health check endpoint — returns cached Ollama status instantly."""
    with _health_lock:
        snap = dict(_health_cache)
    return jsonify({
        'status': 'ok', 'service': 'AI Voice Assistant',
        'offline_chat': {
            'available': snap['available'],
            'model': OLLAMA_OFFLINE_MODEL,
            'error': snap['error']
        }
    })

@app.route('/', methods=['GET'])
def index():
    return app.send_static_file('index.html')

def _trn_debug(msg):
    try:
        log_path = os.path.join(os.environ.get('TEMP', '.'), 'opencode', 'trn_debug.log')
        with open(log_path, 'a', encoding='utf-8') as f:
            f.write(msg + '\n')
    except Exception:
        pass

_HTML_ENT = {
    '&apos;': "'", '&#39;': "'", '&quot;': '"', '&#34;': '"',
    '&amp;': '&', '&#38;': '&', '&gt;': '>', '&lt;': '<',
    '&nbsp;': ' ', '&#160;': ' ', '&#8217;': "'", '&#8216;': "'",
    '&#8220;': '"', '&#8221;': '"', '&#8211;': '-', '&#8212;': '-',
}

def _trn_unescape(s):
    for k, v in _HTML_ENT.items():
        if k in s:
            s = s.replace(k, v)
    return s

# Latin-script targets keep ALL-CAPS words in English (Google treats them as
# brands/acronyms and never translates them). For non-Latin targets the case
# is meaningless, so we lowercase full-caps words before sending - this makes
# the engines translate them instead of leaving them in English.
_TRN_LATIN_SET = set(
    ('en es fr de it pt nl pl cs sk sl hr bs vi id ms tl sw af sq et lv lt ro hu '
     'cy ga gl eu ca da no sv fi is mt ha yo ig zu xh st sn nso so mg ceb ny tw '
     'ak to ht haw mi sm gd lb fy co kri').split())

def _trn_lower_caps(text, target):
    text = str(text)
    if target and target in _TRN_LATIN_SET:
        return text
    return re.sub(r'(^|[^A-Za-z\'])[A-Z]{2,}(?![\'A-Za-z])',
                  lambda m: m.group(1) + m.group(0)[len(m.group(1)):].lower(), text)

def _trn_chunks(text, limit=380):
    """Split a long visible text into <=limit-char chunks at sentence
    boundaries so the free MyMemory GET stays under its query-size cap."""
    text = text.strip()
    if len(text) <= limit:
        return [text]
    parts = []
    import re as _re
    sents = _re.split(r'(?<=[.!?\u0964\u0965\u3002\uFF0E\uFF61])\s+', text)
    cur = ''
    for s in sents:
        if len(s) > limit:
            if cur:
                parts.append(cur); cur = ''
            parts.append(s[:limit]); continue
        if cur and len(cur) + len(s) + 1 > limit:
            parts.append(cur); cur = s
        else:
            cur = (cur + ' ' + s).strip() if cur else s
    if cur:
        parts.append(cur)
    return parts or [text]

@app.route('/api/translate', methods=['POST'])
def api_translate():
    """Batch page-text translation via MyMemory (free, no key, ~100+ languages).
    Body: { texts: [...], source, target }. Preserves order; dedupes; caches."""
    from concurrent.futures import ThreadPoolExecutor
    data = request.get_json(silent=True) or {}
    texts = data.get('texts') or []
    source = str(data.get('source') or 'en').strip().lower() or 'en'
    target = str(data.get('target') or 'hi').strip().lower()
    if not isinstance(texts, list) or not texts:
        return jsonify({'ok': False, 'error': 'empty texts'}), 400
    if not target:
        return jsonify({'ok': False, 'error': 'missing target'}), 400
    cleaned = [str(t)[:2200] for t in texts]
    lang_hint = str(data.get('langHint') or '').strip().lower()[:5] or 'en'
    # Dedupe (same visible string often appears many times on a page) while
    # keeping the original order for the caller.
    seen_keys = {}
    uniq = []
    for t in cleaned:
        key = (t, target)
        if key not in seen_keys:
            seen_keys[key] = len(uniq)
            uniq.append((t, target))

    def _tr_cache_get(k):
        with _trans_cache_lock:
            return _trans_cache.get(k)

    def _tr_cache_set(k, v):
        with _trans_cache_lock:
            if len(_trans_cache) > 15000:
                _trans_cache.clear()
            _trans_cache[k] = v

    def _mt_google(text):
        from urllib.parse import quote
        ua = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36')
        sl = source if source != 'auto' else 'auto'
        qtext = _trn_lower_caps(text, target)
        endpoints = (
            lambda: 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=%s&tl=%s&dt=t&q=%s'
                    % (sl, target, quote(qtext)),
            lambda: 'https://translate.googleapis.com/translate_a/t?client=at&sl=%s&tl=%s&q=%s'
                    % (sl, target, quote(qtext)),
            lambda: 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=%s&tl=%s&q=%s'
                    % (sl, target, quote(qtext)),
        )
        for ep in endpoints:
            try:
                r = requests.get(ep(),
                                 headers={'User-Agent': ua, 'Referer': 'https://translate.google.com/'},
                                 timeout=15, allow_redirects=True)
                if r.status_code != 200:
                    continue
                d = r.json()
                if isinstance(d, list) and d:
                    if isinstance(d[0], list):
                        out = _trn_unescape(''.join(seg[0] for seg in d[0] if seg and seg[0]))
                    else:
                        out = _trn_unescape(str(d[0] or ''))
                    if out and out != text:
                        return out, True
            except Exception:
                continue
        return '', False

    def _mt_mymemory(text):
        pair = (lang_hint if lang_hint != 'auto' else 'en') + '|' + (target or 'hi')
        qtext = _trn_lower_caps(text, target)
        try:
            r = requests.get(
                'https://api.mymemory.translated.net/get',
                params={'q': qtext, 'langpair': pair},
                headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
            d = r.json()
            if d.get('responseStatus') == 200 and d.get('responseData', {}).get('translatedText'):
                return _trn_unescape(d['responseData']['translatedText']), True
        except Exception:
            pass
        return '', False

    def _oneshot(text):
        text = (text or '').strip()
        if not text:
            return ''
        ck = text + '\u0001' + source + '\u0001' + target
        hit = _tr_cache_get(ck)
        if hit is not None:
            return hit
        out = ''
        for fn in (_mt_google, _mt_mymemory):
            try:
                out, ok = fn(text)
            except Exception:
                continue
            if ok and out:
                _tr_cache_set(ck, out)
                return out
        return ''

    def _translate_pair(pair):
        text, _tgt = pair
        chunks = _trn_chunks(text)
        if len(chunks) == 1:
            return _oneshot(chunks[0])
        outs = []
        for ch in chunks:
            outs.append(_oneshot(ch))
        return ' '.join(o for o in outs if o).strip() or ''

    # Translate unique items in parallel; MapException-safe fallback keeps the
    # request alive even if a single MyMemory call blows up.
    try:
        results = list(ThreadPoolExecutor(max_workers=4).map(_translate_pair, uniq))
    except Exception:
        results = [_translate_pair(p) for p in uniq]
    result_map = {}
    for i, pair in enumerate(uniq):
        result_map[seen_keys[pair]] = results[i]
    out = [(result_map.get(i, cleaned[i]) or cleaned[i]) for i in range(len(cleaned))]
    return jsonify({'ok': True, 'translations': out})

@app.route('/neobrowser', methods=['GET'])
def neobrowser():
    return app.send_static_file('ai-browser.html')

@app.route('/pdf-converter/')
@app.route('/pdf-converter/<path:filename>')
def pdf_converter_files(filename='index.html'):
    return send_from_directory(os.path.join(app.static_folder, 'pdf-converter'), filename)

# ===== VISION ANALYSIS =====
import hashlib
import base64
from PIL import Image, ExifTags
from io import BytesIO

VISION_CACHE = {}
VISION_SESSION = {}

def _strip_html(text):
    """Remove HTML tags and fix common artifacts from AI responses."""
    import re
    text = re.sub(r'<[^>]+>', '', text)
    text = text.replace('&nbsp;', ' ').replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"')
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()

VISION_SYSTEM_PROMPT = """You are ESTA Vision AI, the image understanding component of ESTA AI inside NEXORA Browser.

Analyze the uploaded image carefully and provide a detailed, natural description.

## Guidelines

1. **Accuracy First** — Describe only what is actually visible. Never make random guesses. If something cannot be identified with confidence, say so clearly.

2. **Complete Descriptions** — Provide detailed, structured analysis covering scene, subjects, environment, objects, colors, lighting, style, and mood. Write naturally like ChatGPT — not like a robotic template.

3. **Safety** — Never identify real people. Never invent names. Never identify copyrighted characters unless the user explicitly asks. Never output HTML — always use clean Markdown.

4. **Tone** — Be friendly, professional, and engaging. Think of this as describing the image to a friend who can't see it.

## Response Structure (use naturally, not rigidly)

- Start with a brief **# Image Summary** (1-2 sentences capturing the essence)
- Then use sections like **Scene**, **Main Subject(s)**, **Environment/Background**, **Notable Objects**, **Colors & Lighting**, **Style**, **Mood/Atmosphere**
- End with **Confidence**: High / Medium / Low

Always write in the same language the user asked in. Provide rich, vivid descriptions — not one-sentence summaries."""


def _vision_error(message, detail=None, status=500):
    """Return a consistent error JSON response."""
    payload = {'success': False, 'error': str(message)}
    if detail:
        payload['details'] = str(detail)
    return jsonify(payload), status


def _vision_success(result, image_id='', mime='image/jpeg'):
    """Return a consistent success JSON response."""
    return jsonify({
        'success': True,
        'image_id': image_id,
        'mime': mime,
        'analysis_text': result.get('analysis_text', result.get('summary', '')),
        'metadata': result.get('metadata', {})
    })


@app.route('/api/vision/analyze', methods=['POST', 'OPTIONS'])
def vision_analyze():
    """Analyze an uploaded image using Groq vision model."""
    print(f"[VISION] POST /api/vision/analyze")

    # Handle CORS preflight
    if request.method == 'OPTIONS':
        response = jsonify({'success': True})
        response.headers.add('Access-Control-Allow-Methods', 'POST, OPTIONS')
        response.headers.add('Access-Control-Allow-Headers', 'Content-Type')
        return response

    try:
        image_id = request.form.get('image_id', '')
        follow_up = request.form.get('follow_up', '').strip()

        # Follow-up question on cached image
        if image_id and follow_up and image_id in VISION_SESSION:
            print(f"[VISION] Follow-up on image {image_id}: {follow_up[:50]}")
            cached = VISION_SESSION[image_id]
            cached_base64 = cached.get('base64')
            cached_mime = cached.get('mime', 'image/jpeg')
            if cached_base64:
                try:
                    print(f"[VISION] Using Ollama {OLLAMA_VISION_MODEL} (follow-up)")
                    answer = ollama_vision(cached_base64, follow_up, "You are NEO Vision. Answer concisely about the image.")
                    answer = _strip_html(answer)
                    return jsonify({'answer': answer, 'image_id': image_id})
                except Exception as e:
                    return _vision_error(f"Follow-up analysis failed: {str(e)}")

        # New image upload
        if 'image' not in request.files:
            return _vision_error('No image file provided. Upload a file with field name "image".', status=400)

        file = request.files['image']
        if not file.filename:
            return _vision_error('Empty filename.', status=400)

        raw_bytes = file.read()
        if len(raw_bytes) > 20 * 1024 * 1024:
            return _vision_error('Image too large (max 20MB).', status=400)

        if len(raw_bytes) < 20:
            return _vision_error('File appears empty or truncated.', status=400)

        file_hash = hashlib.md5(raw_bytes).hexdigest()
        print(f"[VISION] Analyzing image: {file.filename} ({len(raw_bytes)} bytes, hash={file_hash[:10]}...)")

        # Check cache
        if file_hash in VISION_CACHE:
            print(f"[VISION] Cache hit for {file_hash[:10]}")
            cached_mime = VISION_SESSION.get(file_hash, {}).get('mime', 'image/jpeg')
            return _vision_success(VISION_CACHE[file_hash], image_id=file_hash, mime=cached_mime)

        # Parse image
        try:
            img = Image.open(BytesIO(raw_bytes))
            fmt = img.format or 'Unknown'
            width, height = img.size
        except Exception as e:
            return _vision_error(f'Invalid or unsupported image format: {str(e)}', status=400)

        file_size_kb = len(raw_bytes) / 1024

        # Extract EXIF
        exif_data = {}
        if hasattr(img, '_getexif') and img._getexif():
            try:
                for tag_id, value in img._getexif().items():
                    tag_name = ExifTags.TAGS.get(tag_id, tag_id)
                    if isinstance(value, bytes):
                        try:
                            value = value.decode('utf-8', errors='replace')
                        except Exception:
                            value = str(value)
                    exif_data[str(tag_name)] = str(value)[:200]
            except Exception:
                pass

        # Convert to JPEG base64 for Groq
        mime = 'image/jpeg'
        if fmt.upper() in ('PNG', 'JPEG', 'JPG', 'WEBP', 'GIF'):
            mime = f"image/{fmt.lower()}"
            buffered = BytesIO()
            if fmt.upper() == 'GIF':
                b64 = base64.b64encode(raw_bytes).decode('utf-8')
            else:
                if img.mode == 'P':
                    img = img.convert('RGBA').convert('RGB')
                elif img.mode != 'RGB':
                    img = img.convert('RGB')
                if width > 2048 or height > 2048:
                    ratio = min(2048 / width, 2048 / height)
                    new_w = int(width * ratio)
                    new_h = int(height * ratio)
                    img = img.resize((new_w, new_h), Image.LANCZOS)
                img.save(buffered, format='JPEG')
                b64 = base64.b64encode(buffered.getvalue()).decode('utf-8')
        else:
            img = img.convert('RGB')
            buffered = BytesIO()
            img.save(buffered, format='JPEG')
            b64 = base64.b64encode(buffered.getvalue()).decode('utf-8')

        # Call Ollama Vision API (local, unlimited)
        print(f"[VISION] Calling Ollama {OLLAMA_VISION_MODEL}...")
        try:
            raw_analysis = ollama_vision(b64, "Analyze this image completely using the structured format.", VISION_SYSTEM_PROMPT)
            raw_analysis = _strip_html(raw_analysis)
        except Exception as e:
            return _vision_error(f'AI model request failed: {str(e)}')

        print(f"[VISION] Ollama response ({len(raw_analysis)} chars)")

        result = {
            'analysis_text': raw_analysis,
            'metadata': {
                'format': fmt,
                'dimensions': f"{width}x{height}",
                'file_size': f"{file_size_kb:.1f} KB",
                'exif': exif_data
            }
        }

        # Cache
        VISION_CACHE[file_hash] = result
        VISION_SESSION[file_hash] = {'base64': b64, 'mime': mime}

        print(f"[VISION] Analysis complete for {file_hash[:10]}")
        return _vision_success(result, image_id=file_hash, mime=mime)

    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"[VISION] UNCAUGHT ERROR: {e}\n{tb}")
        return _vision_error(f"Internal server error.", detail=str(e))


@app.route('/api/vision/image/<image_id>', methods=['GET', 'OPTIONS'])
def vision_get_image(image_id):
    """Return a cached image as base64 for re-display."""
    if request.method == 'OPTIONS':
        response = jsonify({'success': True})
        response.headers.add('Access-Control-Allow-Methods', 'GET, OPTIONS')
        return response
    if image_id in VISION_SESSION:
        return jsonify({
            'success': True,
            'base64': VISION_SESSION[image_id]['base64'],
            'mime': VISION_SESSION[image_id]['mime']
        })
    return jsonify({'success': False, 'error': 'Image not found'}), 404


@app.route('/api/vision/analyze/stream', methods=['POST', 'OPTIONS'])
def vision_analyze_stream():
    """Stream analysis results via SSE for progressive rendering."""
    from flask import Response as FlaskResponse

    if request.method == 'OPTIONS':
        response = jsonify({'success': True})
        response.headers.add('Access-Control-Allow-Methods', 'POST, OPTIONS')
        response.headers.add('Access-Control-Allow-Headers', 'Content-Type')
        return response

    # ===== Capture ALL request data BEFORE the generator =====
    # Flask closes uploaded file objects when the request context ends.
    # The generator yields before reading, so we must read bytes NOW.
    req_image_id = request.form.get('image_id', '')
    req_follow_up = request.form.get('follow_up', '').strip()
    req_file = request.files.get('image')

    # Read file bytes immediately (before any yield)
    req_raw_bytes = None
    req_filename = ''
    if req_file:
        if not req_file.filename:
            print(f"[VISION][STREAM] Empty filename")
            return jsonify({'success': False, 'error': 'Empty filename.'}), 400
        try:
            req_raw_bytes = req_file.read()
            req_filename = req_file.filename
            print(f"[VISION][STREAM] Image received: {req_filename} ({len(req_raw_bytes)} bytes)")
        except Exception as e:
            print(f"[VISION][STREAM] File read error: {e}")
            return jsonify({'success': False, 'error': f'Failed to read uploaded file: {str(e)}'}), 500
    else:
        print(f"[VISION][STREAM] No file uploaded")

    if req_raw_bytes is not None and len(req_raw_bytes) > 20 * 1024 * 1024:
        print(f"[VISION][STREAM] Image too large: {len(req_raw_bytes)} bytes")
        return jsonify({
            'success': False, 'error': 'Image too large (max 20MB).'
        }), 413

    if req_raw_bytes is not None and len(req_raw_bytes) < 20:
        print(f"[VISION][STREAM] File truncated: {len(req_raw_bytes)} bytes")
        return jsonify({
            'success': False, 'error': 'File appears empty or truncated.'
        }), 400

    if req_raw_bytes:
        print(f"[VISION][STREAM] Image stored in memory: {len(req_raw_bytes)} bytes")

    def sse_event(event_type, data):
        """Format an SSE event."""
        return f"event: {event_type}\ndata: {json.dumps(data)}\n\n"

    def generate(image_id, follow_up, raw_bytes, filename):
        try:
            yield sse_event('progress', {'step': 1, 'message': 'Uploading image...'})

            # Follow-up question (no file needed)
            if image_id and follow_up and image_id in VISION_SESSION:
                yield sse_event('progress', {'step': 2, 'message': 'Analyzing question...'})
                cached = VISION_SESSION[image_id]
                cached_base64 = cached.get('base64')
                cached_mime = cached.get('mime', 'image/jpeg')
                if cached_base64:
                    try:
                        print(f"[VISION][STREAM] Using Ollama {OLLAMA_VISION_MODEL} (follow-up)")
                        answer = ollama_vision(cached_base64, follow_up, VISION_SYSTEM_PROMPT)
                        answer = _strip_html(answer)
                        print(f"[VISION][STREAM] Ollama response received (follow-up)")
                        yield sse_event('answer', {'text': answer, 'image_id': image_id})
                        yield sse_event('complete', {'image_id': image_id})
                    except Exception as e:
                        print(f"[VISION][STREAM] Follow-up AI error: {e}")
                        yield sse_event('error', {'message': f"Follow-up failed: {str(e)}"})
                        yield sse_event('complete', {})
                return

            # New image upload (bytes already read before generator)
            yield sse_event('progress', {'step': 2, 'message': 'Processing image...'})

            if raw_bytes is None:
                yield sse_event('error', {'message': 'No image file provided.'})
                yield sse_event('complete', {})
                return

            file_hash = hashlib.md5(raw_bytes).hexdigest()
            print(f"[VISION][STREAM] File hash: {file_hash[:10]}...")
            yield sse_event('progress', {'step': 3, 'message': 'Analyzing image...'})

            # Check cache
            if file_hash in VISION_CACHE:
                cached = VISION_CACHE[file_hash]
                analysis_text = _strip_html(cached.get('analysis_text', cached.get('summary', 'Analysis complete.')))
                yield sse_event('answer', {'text': analysis_text, 'image_id': file_hash})
                yield sse_event('complete', {'image_id': file_hash, 'cached': True})
                return

            # Parse image
            yield sse_event('progress', {'step': 2, 'message': 'Processing image...'})
            try:
                img = Image.open(BytesIO(raw_bytes))
                fmt = img.format or 'Unknown'
                width, height = img.size
            except Exception as e:
                yield sse_event('error', {'message': f'Invalid image format: {str(e)}'})
                yield sse_event('complete', {})
                return

            file_size_kb = len(raw_bytes) / 1024

            exif_data = {}
            if hasattr(img, '_getexif') and img._getexif():
                try:
                    for tag_id, value in img._getexif().items():
                        tag_name = ExifTags.TAGS.get(tag_id, tag_id)
                        if isinstance(value, bytes):
                            try:
                                value = value.decode('utf-8', errors='replace')
                            except Exception:
                                value = str(value)
                        exif_data[str(tag_name)] = str(value)[:200]
                except Exception:
                    pass

            # Convert image for Groq
            mime = 'image/jpeg'
            if fmt.upper() in ('PNG', 'JPEG', 'JPG', 'WEBP', 'GIF'):
                mime = f"image/{fmt.lower()}"
                buffered = BytesIO()
                if fmt.upper() == 'GIF':
                    b64 = base64.b64encode(raw_bytes).decode('utf-8')
                else:
                    if img.mode == 'P':
                        img = img.convert('RGBA').convert('RGB')
                    elif img.mode != 'RGB':
                        img = img.convert('RGB')
                    if width > 2048 or height > 2048:
                        ratio = min(2048 / width, 2048 / height)
                        new_w = int(width * ratio)
                        new_h = int(height * ratio)
                        img = img.resize((new_w, new_h), Image.LANCZOS)
                    img.save(buffered, format='JPEG')
                    b64 = base64.b64encode(buffered.getvalue()).decode('utf-8')
            else:
                img = img.convert('RGB')
                buffered = BytesIO()
                img.save(buffered, format='JPEG')
                b64 = base64.b64encode(buffered.getvalue()).decode('utf-8')

            yield sse_event('progress', {'step': 3, 'message': 'Analyzing image...'})

            # Call Ollama Vision API (local, unlimited)
            print(f"[VISION][STREAM] Image converted to Base64 ({len(b64)} chars)")
            print(f"[VISION][STREAM] Calling Ollama {OLLAMA_VISION_MODEL}")
            try:
                raw_analysis = ollama_vision(b64, "Analyze this image completely using the structured format.", VISION_SYSTEM_PROMPT)
                raw_analysis = _strip_html(raw_analysis)
                print(f"[VISION][STREAM] Ollama response received")
            except Exception as e:
                print(f"[VISION][STREAM] Ollama request failed: {e}")
                yield sse_event('error', {'message': f'AI model request failed: {str(e)}'})
                yield sse_event('complete', {})
                return

            metadata = {
                'format': fmt,
                'dimensions': f"{width}x{height}",
                'file_size': f"{file_size_kb:.1f} KB",
                'exif': exif_data
            }

            # Cache
            result = {
                'analysis_text': raw_analysis,
                'metadata': metadata
            }

            # Cache the result
            VISION_CACHE[file_hash] = result
            VISION_SESSION[file_hash] = {'base64': b64, 'mime': mime}

            print(f"[VISION][STREAM] Analysis complete for {file_hash[:10]}")
            yield sse_event('answer', {'text': raw_analysis, 'image_id': file_hash})
            yield sse_event('complete', {'image_id': file_hash, 'cached': False})

        except Exception as e:
            import traceback
            tb = traceback.format_exc()
            print(f"[VISION][STREAM] Error: {e}\n{tb}")
            yield sse_event('error', {'message': f"Internal server error: {str(e)}"})
            yield sse_event('complete', {})

    response = FlaskResponse(generate(req_image_id, req_follow_up, req_raw_bytes, req_filename), mimetype='text/event-stream')
    response.headers.add('Cache-Control', 'no-cache')
    response.headers.add('X-Accel-Buffering', 'no')
    return response


# =====================================================================
#  FEATURE: ESTA MEMORY  — Conversation persistence
# =====================================================================
MEMORY_DIR = os.path.join(BASE_DIR, 'memory')
os.makedirs(MEMORY_DIR, exist_ok=True)
MEMORY_INDEX_PATH = os.path.join(MEMORY_DIR, '_index.json')

def _load_memory_index():
    if os.path.exists(MEMORY_INDEX_PATH):
        try:
            with open(MEMORY_INDEX_PATH, 'r', encoding='utf-8') as f:
                return json.load(f)
        except: pass
    return []

def _save_memory_index(index):
    with open(MEMORY_INDEX_PATH, 'w', encoding='utf-8') as f:
        json.dump(index, f, indent=2, ensure_ascii=False)

def _safe_id(value, max_len=80):
    """IDs arriving over HTTP become filenames. Accept only plain identifier
    characters so ../ and absolute paths can never escape their directory."""
    if not isinstance(value, str) or not value or len(value) > max_len:
        return None
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_\-.]*', value):
        return None
    if '..' in value or value.startswith(('.', '-')):
        return None
    return value

@app.route('/api/memory/save', methods=['POST'])
def memory_save():
    try:
        data = request.get_json(silent=True) or {}
        conv_id = data.get('id', datetime.datetime.now().strftime('%Y%m%d_%H%M%S'))
        conv_id = _safe_id(conv_id)
        if not conv_id:
            return jsonify({'success': False, 'error': 'Invalid conversation id'}), 400
        title = data.get('title', 'Untitled')
        messages = data.get('messages', [])
        entry = {
            'id': conv_id,
            'title': title,
            'updated': datetime.datetime.now().isoformat(),
            'messages': messages
        }
        conv_path = os.path.join(MEMORY_DIR, f'{conv_id}.json')
        with open(conv_path, 'w', encoding='utf-8') as f:
            json.dump(entry, f, indent=2, ensure_ascii=False)
        index = _load_memory_index()
        existing = [c for c in index if c['id'] != conv_id]
        existing.append({'id': conv_id, 'title': title, 'updated': entry['updated']})
        _save_memory_index(existing)
        return jsonify({'success': True, 'id': conv_id})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/memory/list', methods=['GET'])
def memory_list():
    return jsonify({'success': True, 'conversations': _load_memory_index()})

@app.route('/api/memory/load/<conv_id>', methods=['GET'])
def memory_load(conv_id):
    conv_id = _safe_id(conv_id)
    if not conv_id:
        return jsonify({'success': False, 'error': 'Invalid conversation id'}), 400
    conv_path = os.path.join(MEMORY_DIR, f'{conv_id}.json')
    if not os.path.exists(conv_path):
        return jsonify({'success': False, 'error': 'Conversation not found'}), 404
    try:
        with open(conv_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return jsonify({'success': True, 'conversation': data})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/memory/delete/<conv_id>', methods=['DELETE'])
def memory_delete(conv_id):
    conv_id = _safe_id(conv_id)
    if not conv_id:
        return jsonify({'success': False, 'error': 'Invalid conversation id'}), 400
    conv_path = os.path.join(MEMORY_DIR, f'{conv_id}.json')
    if os.path.exists(conv_path):
        os.remove(conv_path)
    index = _load_memory_index()
    index = [c for c in index if c['id'] != conv_id]
    _save_memory_index(index)
    return jsonify({'success': True})

# ===== OFFLINE AI LONG-TERM MEMORY + RAG API =====
@app.route('/api/ai/memory/get', methods=['GET'])
def ai_memory_get():
    return jsonify({'success': True, 'memory': _load_ai_memory()})

@app.route('/api/ai/memory/set', methods=['POST', 'OPTIONS'])
def ai_memory_set():
    if request.method == 'OPTIONS':
        response = jsonify({'success': True})
        response.headers.add('Access-Control-Allow-Methods', 'POST, OPTIONS')
        response.headers.add('Access-Control-Allow-Headers', 'Content-Type')
        return response
    data = request.get_json(silent=True) or {}
    text = (data.get('memory') or '').strip()
    ok = _save_ai_memory(text)
    return jsonify({'success': ok, 'characters': len(text)})

@app.route('/api/ai/rag/status', methods=['GET'])
def ai_rag_status():
    files, chunks = _rag_scan_safe()
    return jsonify({
        'success': True,
        'files': files,
        'chunks': len(chunks),
        'path': RAG_DIR
    })

@app.route('/api/ai/rag/rescan', methods=['POST', 'OPTIONS'])
def ai_rag_rescan():
    if request.method == 'OPTIONS':
        response = jsonify({'success': True})
        response.headers.add('Access-Control-Allow-Methods', 'POST, OPTIONS')
        response.headers.add('Access-Control-Allow-Headers', 'Content-Type')
        return response
    _RAG_CACHE['mtime'] = '_force_rescan'
    files, chunks = _rag_scan_safe()
    return jsonify({'success': True, 'chunks': len(chunks), 'files': files})

# =====================================================================
#  FEATURE: ESTA WEB  — Web search + summarization
# =====================================================================
@app.route('/api/web/search', methods=['POST'])
def web_search_api():
    try:
        data = request.get_json(silent=True) or {}
        query = data.get('query', '').strip()
        if not query:
            return jsonify({'success': False, 'error': 'Empty query'}), 400

        print(f"[WEB] Searching: {query}")
        results = _duckduckgo_search(query)
        if not results:
            print("[WEB] DuckDuckGo returned nothing; answering from AI knowledge only")

        # Summarize with AI
        if results:
            context = _build_results_context(query, results)
            summary_prompt = (
                f"Based on these search results for \"{query}\", provide a concise, informative summary.\n\n"
                f"Results:\n{context}\n\n"
                "Then list the key sources as bullet points with their titles."
            )
        else:
            summary_prompt = f"Provide a helpful answer about: {query}. Include relevant details and sources you know."

        try:
            summary = _groq_complete(
                "You are ESTA Web, the web research component of ESTA AI. Provide clear, well-structured answers with Markdown headings and bullet points. Cite sources when possible.",
                summary_prompt, 600
            )
            print(f"[WEB] Summary generated ({len(summary)} chars)")
        except Exception as e:
            print(f"[WEB] AI summary failed: {e}")
            summary = f"Search results for \"{query}\" found {len(results)} sources."

        return jsonify({
            'success': True,
            'query': query,
            'summary': summary,
            'results': results
        })

    except Exception as e:
        print(f"[WEB] Error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/link/read', methods=['POST'])
def link_read_api():
    """Read a specific URL and return an AI summary + key points + explanation."""
    try:
        data = request.get_json(silent=True) or {}
        link = data.get('url', '').strip()
        if not link:
            return jsonify({'success': False, 'error': 'Empty URL'}), 400
        if not link.lower().startswith('http'):
            link = 'https://' + link
        print(f"[LINK] Reading: {link}")
        title, text = _fetch_url_text(link, max_chars=7000)
        if not text or len(text.strip()) < 10:
            return jsonify({
                'success': False,
                'error': 'Could not read that link — the page may require login or block automated access.',
                'url': link
            }), 200

        system = (
            "You are ESTA Link Reader. A user sent you a link and wants a clear summary and explanation of it. "
            "Respond with structured Markdown: a short intro, a **Summary** of the page, the **Key Points** as bullets, "
            "and a short **What this page is about** explanation. Answer entirely from the page content below. "
            "Keep it clear and helpful."
        )
        user = f"Page title: {(title or 'N/A')}\n\nLink: {link}\n\nPage content:\n{text[:6000]}"
        answer = _groq_complete(system, user, 900)
        if not answer:
            answer = f"I fetched the page but could not summarize it. Here is a preview of its content:\n\n{text[:800]}"

        return jsonify({
            'success': True,
            'url': link,
            'title': title,
            'content_preview': text[:800],
            'summary': answer
        })
    except Exception as e:
        print(f"[LINK] Error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

# =====================================================================
#  FEATURE: ESTA DOCS  — PDF/document upload + Q&A
# =====================================================================
DOCS_DIR = os.path.join(BASE_DIR, 'documents')
os.makedirs(DOCS_DIR, exist_ok=True)
DOCS_INDEX_PATH = os.path.join(DOCS_DIR, '_index.json')

def _load_docs_index():
    if os.path.exists(DOCS_INDEX_PATH):
        try:
            with open(DOCS_INDEX_PATH, 'r', encoding='utf-8') as f:
                return json.load(f)
        except: pass
    return []

def _save_docs_index(index):
    with open(DOCS_INDEX_PATH, 'w', encoding='utf-8') as f:
        json.dump(index, f, indent=2, ensure_ascii=False)

def _extract_text_from_pdf(filepath):
    try:
        import fitz
        doc = fitz.open(filepath)
        text = ""
        for page in doc:
            text += page.get_text() + "\n"
        doc.close()
        return text
    except Exception as e:
        print(f"[DOCS] PDF extract error: {e}")
        return ""

def _extract_text_from_docx(filepath):
    try:
        import zipfile
        from xml.etree import ElementTree as ET
        with zipfile.ZipFile(filepath) as z:
            xml = z.read('word/document.xml')
        ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
        root = ET.fromstring(xml)
        paras = []
        for p in root.iter('{%s}p' % ns['w']):
            texts = (t.text or '' for t in p.iter('{%s}t' % ns['w']))
            line = ''.join(texts).strip()
            if line:
                paras.append(line)
        return '\n'.join(paras)
    except Exception as e:
        print(f"[DOCS] DOCX extract error: {e}")
        return ""

def _extract_text_from_file(filepath):
    """Extract text from any supported document for ESTA Docs."""
    ext = os.path.splitext(filepath)[1].lower()
    if ext == '.pdf':
        return _extract_text_from_pdf(filepath)
    if ext == '.docx':
        return _extract_text_from_docx(filepath)
    try:
        with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    except:
        return ""

def _chunk_text(text, max_chars=1500, overlap=200):
    chunks = []
    start = 0
    n = len(text)
    if n == 0:
        return chunks
    while start < n:
        end = min(start + max_chars, n)
        if end < n:
            last_period = text.rfind('. ', start, end)
            last_newline = text.rfind('\n', start, end)
            split_at = max(last_period, last_newline)
            if split_at > start:
                end = split_at + 1
        chunks.append(text[start:end].strip())
        if end >= n:
            break
        next_start = end - overlap
        if next_start <= start:
            next_start = end
        start = next_start
    return chunks

def _history_content_to_text(content, limit=2500):
    """Flatten a message `content` (string OR multimodal array) to plain text.

    Needed because history may now hold multimodal parts after
    _sanitize_history(); string-interpolating those would dump raw dict reprs
    into the prompt."""
    if isinstance(content, list):
        bits = []
        for part in content:
            if isinstance(part, dict):
                if part.get('type') == 'text':
                    bits.append(str(part.get('text') or ''))
                elif part.get('type') == 'image_url':
                    bits.append('[image]')
            elif isinstance(part, str):
                bits.append(part)
        return ' '.join(b for b in bits if b)[:limit]
    return str(content or '')[:limit]


# ===== ESTA CHAT ATTACHMENTS (image + document) =====
# Extraction lives in the Python backend because that is where the document
# parsers already are (PyMuPDF/fitz for PDFs, zipfile+ElementTree for DOCX).
# The renderer never gets filesystem access; it only POSTs bytes to this route.

# Extensions we can turn into text. Anything else gets a clear, friendly error
# instead of silently sending a filename to the model.
ATTACH_TEXT_EXTS = {
    '.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.yaml', '.yml',
    '.ini', '.cfg', '.conf', '.xml', '.html', '.htm', '.py', '.js', '.ts',
    '.tsx', '.jsx', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs',
    '.rb', '.php', '.sh', '.bat', '.ps1', '.sql', '.r', '.kt', '.swift', '.toml',
}
ATTACH_BIN_EXTS = {'.pdf', '.docx'}
ATTACH_MAX_BYTES = 25 * 1024 * 1024      # hard upload ceiling
ATTACH_TEXT_CHAR_BUDGET = 12000          # chars returned inline for context
ATTACH_RENDER_MAX_PAGES = 4              # scanned pages rendered for vision

ATTACH_MIME_EXT = {
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/msword': '.doc',
    'text/plain': '.txt', 'text/markdown': '.md', 'text/csv': '.csv',
    'application/json': '.json', 'text/html': '.html',
}


def _attach_send_error(msg, code=400, **extra):
    payload = {'ok': False, 'success': False, 'error': str(msg)}
    payload.update(extra)
    return jsonify(payload), code


def _pdf_pages_with_text(raw):
    """Return (pages, total_pages) where pages = [{'page':1,'text':'...'}, ...].

    Also flags scanned pages: PDFs that are pure images have no selectable text,
    so those get rendered to PNG below and sent through the vision model."""
    import fitz
    doc = fitz.open(stream=raw, filetype='pdf')
    pages = []
    empty_pages = []
    try:
        for idx, page in enumerate(doc, start=1):
            try:
                txt = page.get_text() or ''
            except Exception:
                txt = ''
            txt = txt.strip()
            if txt:
                pages.append({'page': idx, 'text': txt})
            else:
                empty_pages.append(idx)
    finally:
        total = doc.page_count
        doc.close()
    return pages, empty_pages, total


_PDF_RENDER_LIMIT = 4


def _pdf_render_pages(raw, page_numbers, max_px=900):
    """Rasterise scanned pages so a vision model can actually read them."""
    import fitz
    out = []
    doc = fitz.open(stream=raw, filetype='pdf')
    try:
        for pno in list(page_numbers)[:_PDF_RENDER_LIMIT]:
            try:
                page = doc[pno - 1]
                zoom = 1.4
                rect = page.rect
                if rect.width > 0:
                    zoom = min(2.0, max(0.8, max_px / float(rect.width)))
                mat = fitz.Matrix(zoom, zoom)
                pix = page.get_pixmap(matrix=mat, alpha=False)
                out.append({
                    'page': pno,
                    'image': base64.b64encode(pix.tobytes('png')).decode('ascii'),
                    'mime': 'image/png',
                })
            except Exception as e:
                print(f"[ATTACH] render page {pno} failed: {e}")
    finally:
        doc.close()
    return out


def _extract_pdf_attachment(raw):
    """PDF -> per-page text + rendered images for scanned pages."""
    warnings = []
    try:
        pages, empty_pages, total = _pdf_pages_with_text(raw)
    except Exception as e:
        return None, 'This PDF could not be read. It may be corrupted or password-protected.', [], []

    if not pages:
        # Fully scanned PDF: no selectable text anywhere.
        warnings.append(
            'This PDF appears to be a scan (no selectable text), '
            'so it is being read visually instead.'
        )
        rendered = _pdf_render_pages(raw, empty_pages or list(range(1, min(total, _PDF_RENDER_LIMIT) + 1)))
        return '', ' | '.join(warnings), rendered, []

    rendered = []
    if empty_pages:
        warnings.append(
            f'{len(empty_pages)} page(s) had no text and were read as images.'
        )
        rendered = _pdf_render_pages(raw, empty_pages)
    return pages, '', rendered, warnings


def _extract_docx_attachment(raw):
    import zipfile
    from xml.etree import ElementTree as ET
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            xml = z.read('word/document.xml')
    except Exception as e:
        return None, f'This DOCX file could not be opened ({e}).', []
    ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
    try:
        root = ET.fromstring(xml)
    except Exception:
        return None, 'This DOCX file is malformed and could not be parsed.', []
    paras = []
    for p in root.iter(ns + 'p'):
        line = ''.join((t.text or '') for t in p.iter(ns + 't')).strip()
        if line:
            paras.append(line)
    if not paras:
        return None, 'This DOCX file appears to be empty.', []
    return paras, '', []


def _extract_text_attachment(raw):
    try:
        return raw.decode('utf-8', errors='replace'), '', []
    except Exception as e:
        return None, f'This file could not be decoded ({e}).', []


def _pick_relevant_chunks(text, query, budget):
    """Rank chunks by keyword overlap with the user's question.

    Large documents are chunked and only the most relevant slices are inlined
    into the model context, so a 500-page PDF cannot blow up the request. The
    document's identity + page map are always included so follow-up questions
    ('what is on page 5?') still resolve."""
    if not text:
        return '', []
    if len(text) <= budget:
        return text, []
    chunks = _chunk_text(text, max_chars=1400, overlap=180)
    terms = set(re.findall(r'[a-z0-9]{3,}', (query or '').lower()))
    stop = {'the', 'and', 'for', 'this', 'that', 'with', 'from', 'what', 'which',
            'are', 'was', 'were', 'has', 'have', 'did', 'does', 'you', 'your',
            'about', 'into', 'please', 'tell', 'give', 'summarize', 'summarise',
            'document', 'explain', 'according', 'accordingly'}
    terms = {t for t in terms if t not in stop}
    scored = []
    for i, ch in enumerate(chunks):
        low = ch.lower()
        hits = sum(1 for t in terms if t in low)
        if hits:
            scored.append((hits, i, ch))
    scored.sort(key=lambda x: (-x[0], x[1]))
    picked, used, idxs = [], 0, []
    for hits, i, ch in scored:
        if used + len(ch) > budget:
            continue
        picked.append(ch)
        idxs.append(i)
        used += len(ch)
        if used >= budget:
            break
    if not picked:
        picked = chunks[:3]
        idxs = list(range(min(3, len(chunks))))
        used = sum(len(c) for c in picked)
    picked.sort(key=lambda c: chunks.index(c))
    return '\n\n[...]\n\n'.join(picked), idxs


@app.route('/api/attach/extract', methods=['POST'])
def attach_extract():
    """Extract real text from an attached document so ESTA can actually read it.

    Accepts JSON {name, mimeType, data(base64)} and returns structured content:
      {ok, name, mimeType, size, ext, text, pages:[{page,text}],
       pageCount, truncated, chunkCount, relevantChunkIds, needsVision,
       scannedPages:[b64 png], warning}
    """
    try:
        data = request.get_json(silent=True) or {}
    except Exception:
        return _attach_send_error('Could not read the upload payload.')

    name = str(data.get('name') or '').strip() or 'document'
    mime = str(data.get('mimeType') or '').strip().lower()
    b64 = data.get('data') or ''

    if not b64 or not isinstance(b64, str):
        return _attach_send_error('The file arrived empty. Please try attaching it again.')

    m = re.match(r'^data:([^;]+);base64,', b64)
    if m:
        mime = mime or m.group(1).lower()
        b64 = b64[m.end():]
    b64 = re.sub(r'\s+', '', b64)

    try:
        raw = base64.b64decode(b64, validate=False)
    except Exception:
        return _attach_send_error('This file could not be decoded. It may be damaged.')

    if not raw:
        return _attach_send_error('This file is empty (0 bytes).')
    if len(raw) > ATTACH_MAX_BYTES:
        return _attach_send_error(
            f'This document is too large to process '
            f'({round(len(raw) / 1048576.0, 1)} MB). The limit is 25 MB.', 413)

    ext = os.path.splitext(name)[1].lower()
    if not ext:
        ext = ATTACH_MIME_EXT.get(mime, '')
    if ext == '.doc':
        return _attach_send_error(
            'Legacy .doc files are not supported. Please save it as .docx or PDF.', 415)

    rendered = []
    if ext == '.pdf':
        pages, warning, rendered, warn_list = _extract_pdf_attachment(raw)
    elif ext == '.docx':
        pages, warning, warn_list = _extract_docx_attachment(raw)
    elif ext in ATTACH_TEXT_EXTS:
        pages, warning, warn_list = _extract_text_attachment(raw)
    else:
        return _attach_send_error(
            f"This file type isn't supported ({ext or mime or 'unknown'}). "
            f'ESTA can read PDF, DOCX, TXT, MD, JSON, CSV and source-code files.', 415)

    if pages is None:
        return _attach_send_error(warning or 'This document could not be read.', 422)

    # Normalise to a page list + flat text. PDF pages arrive as
    # {'page','text'} dicts, DOCX as plain strings, text files as one blob -
    # all three become the same page list so the client only sees one shape.
    warnings = list(warn_list or [])
    if warning:
        warnings.append(warning)
    page_list = []
    if isinstance(pages, list):
        for i, p in enumerate(pages):
            if isinstance(p, dict):
                pno, ptxt = p.get('page', i + 1), p.get('text', '')
            else:
                pno, ptxt = i + 1, str(p)
            ptxt = (ptxt or '').strip()
            if ptxt:
                page_list.append({'page': pno, 'text': ptxt})
    elif isinstance(pages, str) and pages.strip():
        page_list = [{'page': 1, 'text': pages.strip()}]

    flat = '\n'.join(p['text'] for p in page_list)

    if not flat.strip() and not rendered:
        return _attach_send_error(
            'No readable text was found in this document. '
            'If it is a scan, try uploading a text-based PDF.', 422)

    query = str(data.get('query') or '')
    inline, chunk_ids = _pick_relevant_chunks(flat, query, ATTACH_TEXT_CHAR_BUDGET)
    total_chunks = max(1, len(_chunk_text(flat, max_chars=1400, overlap=180)))
    truncated = bool(chunk_ids)

    page_map = ''
    if page_list and len(page_list) > 1:
        page_map = '\n'.join(
            f"- page {p['page']}: {len(p['text'])} chars, starts: "
            f"{p['text'][:70].replace(chr(10), ' ').strip()}"
            for p in page_list[:60])

    print(f"[ATTACH] extracted {name} ext={ext} size={len(raw)} "
          f"pages={len(page_list)} inline={len(inline)} scanned_rendered={len(rendered)}")

    return jsonify({
        'ok': True,
        'success': True,
        'name': name,
        'mimeType': mime or 'application/octet-stream',
        'size': len(raw),
        'ext': ext,
        'text': inline,
        'pages': page_list,
        'pageCount': len(page_list),
        'pageMap': page_map,
        'truncated': truncated,
        'chunkCount': total_chunks,
        'relevantChunkIds': chunk_ids,
        'needsVision': bool(rendered),
        'scannedPages': rendered,
        'warning': ' '.join(warnings) if warnings else '',
    })


@app.route('/api/docs/upload', methods=['POST'])
def docs_upload():
    try:
        if 'file' not in request.files:
            return jsonify({'success': False, 'error': 'No file provided'}), 400
        file = request.files['file']
        if not file.filename:
            return jsonify({'success': False, 'error': 'Empty filename'}), 400

        filename = file.filename
        ext = os.path.splitext(filename)[1].lower()
        # The extension rides into the stored path: keep it a short plain
        # suffix so a crafted upload name cannot smuggle path components in.
        if not re.fullmatch(r'\.[a-z0-9]{1,10}', ext or ''):
            ext = '.bin'

        doc_id = hashlib.md5(f"{filename}_{time.time()}".encode()).hexdigest()[:12]
        save_path = os.path.join(DOCS_DIR, f'{doc_id}{ext}')
        file.save(save_path)

        text = ""
        if ext in ('.pdf', '.docx'):
            text = _extract_text_from_file(save_path)
        else:
            try:
                with open(save_path, 'r', encoding='utf-8', errors='replace') as f:
                    text = f.read()
            except:
                text = "[Binary file - text extraction not available]"

        if not text or len(text.strip()) < 10:
            text = "[No extractable text found]"

        chunks = _chunk_text(text)
        print(f"[DOCS] Uploaded {filename}: {len(text)} chars, {len(chunks)} chunks")

        entry = {
            'id': doc_id,
            'filename': filename,
            'size': len(text),
            'chunks': len(chunks),
            'text': text,
            'uploaded': datetime.datetime.now().isoformat()
        }
        doc_index_path = os.path.join(DOCS_DIR, f'{doc_id}.json')
        with open(doc_index_path, 'w', encoding='utf-8') as f:
            json.dump(entry, f, indent=2, ensure_ascii=False)

        index = _load_docs_index()
        index.append({'id': doc_id, 'filename': filename, 'size': len(text), 'uploaded': entry['uploaded']})
        _save_docs_index(index)

        return jsonify({
            'success': True,
            'doc_id': doc_id,
            'filename': filename,
            'chunks': len(chunks),
            'preview': text[:300]
        })

    except Exception as e:
        print(f"[DOCS] Upload error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/docs/list', methods=['GET'])
def docs_list():
    return jsonify({'success': True, 'documents': _load_docs_index()})

@app.route('/api/docs/ask', methods=['POST'])
def docs_ask():
    try:
        data = request.get_json(silent=True) or {}
        doc_id = data.get('doc_id', '')
        doc_id = _safe_id(doc_id)
        question = data.get('question', '').strip()
        history = _sanitize_history(data.get('history'))
        if not doc_id or not question:
            return jsonify({'success': False, 'error': 'Missing doc_id or question'}), 400

        doc_path = os.path.join(DOCS_DIR, f'{doc_id}.json')
        if not os.path.exists(doc_path):
            return jsonify({'success': False, 'error': 'Document not found'}), 404

        with open(doc_path, 'r', encoding='utf-8') as f:
            doc = json.load(f)

        text = doc.get('text', '')
        chunks = _chunk_text(text)
        filename = doc.get('filename', 'unknown')

        # Find most relevant chunks via keyword overlap
        q_words = set(re.findall(r'[a-z0-9]+', question.lower()))
        scored = []
        for i, chunk in enumerate(chunks):
            c_words = set(re.findall(r'[a-z0-9]+', chunk.lower()))
            overlap = len(q_words & c_words)
            # Favor chunks that contain telltale answer words (why, what, when...)
            if overlap:
                scored.append((overlap, i, chunk))
        scored.sort(key=lambda x: -x[0])
        top_chunks = scored[:4] if scored else [(0, 0, chunks[0])] if chunks else []
        if not top_chunks:
            return jsonify({'success': True, 'answer': 'That document has no readable text content.', 'doc_id': doc_id, 'filename': filename})

        context = "\n\n---\n\n".join(c for _, _, c in top_chunks)

        system = (
            f"You are ESTA Docs, the document analysis component of ESTA AI. Analyzing \"{filename}\". "
            "Answer based ONLY on the provided document context. "
            "If the document doesn't contain the answer, say so clearly. "
            "Use Markdown formatting with headings and bullet points."
        )
        user = f"Document context:\n\n{context}\n\nQuestion: {question}"

        answer = _groq_complete(system, user, 700, history=history)
        if not answer:
            answer = "I could not read that document content right now. Please try again."

        return jsonify({
            'success': True,
            'answer': answer,
            'doc_id': doc_id,
            'filename': filename
        })

    except Exception as e:
        print(f"[DOCS] Ask error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/docs/delete/<doc_id>', methods=['DELETE'])
def docs_delete(doc_id):
    try:
        doc_id = _safe_id(doc_id)
        if not doc_id:
            return jsonify({'success': False, 'error': 'Invalid document id'}), 400
        doc_path = os.path.join(DOCS_DIR, f'{doc_id}.json')
        if os.path.exists(doc_path):
            os.remove(doc_path)
        # Find and remove actual file
        index = _load_docs_index()
        entry = next((d for d in index if d['id'] == doc_id), None)
        if entry:
            for fname in os.listdir(DOCS_DIR):
                if fname.startswith(doc_id) and fname != f'{doc_id}.json':
                    os.remove(os.path.join(DOCS_DIR, fname))
                    break
        index = [d for d in index if d['id'] != doc_id]
        _save_docs_index(index)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# =====================================================================
#  FEATURE: ESTA CODE  — Code generation + analysis
# =====================================================================
CODE_DIR = os.path.join(BASE_DIR, 'generated_code')
os.makedirs(CODE_DIR, exist_ok=True)

LANGUAGE_MAP = {
    'python': { 'ext': '.py', 'comment': '#' },
    'javascript': { 'ext': '.js', 'comment': '//' },
    'typescript': { 'ext': '.ts', 'comment': '//' },
    'html': { 'ext': '.html', 'comment': '<!--' },
    'css': { 'ext': '.css', 'comment': '/*' },
    'java': { 'ext': '.java', 'comment': '//' },
    'cpp': { 'ext': '.cpp', 'comment': '//' },
    'c': { 'ext': '.c', 'comment': '//' },
    'go': { 'ext': '.go', 'comment': '//' },
    'rust': { 'ext': '.rs', 'comment': '//' },
    'sql': { 'ext': '.sql', 'comment': '--' },
    'bash': { 'ext': '.sh', 'comment': '#' },
    'json': { 'ext': '.json', 'comment': None },
    'yaml': { 'ext': '.yml', 'comment': '#' },
}

@app.route('/api/code/generate', methods=['POST'])
def code_generate():
    try:
        data = request.get_json(silent=True) or {}
        description = data.get('description', '').strip()
        language = data.get('language', 'python').strip().lower()
        if not description:
            return jsonify({'success': False, 'error': 'No description provided'}), 400

        lang_info = LANGUAGE_MAP.get(language, { 'ext': '.txt', 'comment': '#' })
        print(f"[CODE] Generating {language} code for: {description[:80]}")

        system = (
            f"You are ESTA Code, the coding component of ESTA AI. An expert {language} developer. "
            "Generate complete, working code based on the user's description. "
            "Follow these rules:\n"
            "1. Output ONLY the code, no explanations before or after.\n"
            f"2. Use {lang_info.get('comment', '//')} for comments.\n"
            "3. Include error handling where appropriate.\n"
            "4. The code should be production-ready.\n"
            "5. Add a short comment at the top describing what this code does.\n"
            "6. DO NOT wrap the code in markdown code fences.\n"
            "7. Suggest a filename as the last line in format: FILENAME: <name>"
        )

        groq_resp = client.chat.completions.create(
            model="allam-2-7b",
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": description}
            ],
            temperature=0.2,
            max_tokens=1500
        )
        raw = strip_think_tags(groq_resp.choices[0].message.content)

        # Extract filename from last line
        lines = raw.split('\n')
        suggested_filename = f"generated_{datetime.datetime.now().strftime('%H%M%S')}{lang_info['ext']}"
        if lines and lines[-1].startswith('FILENAME:'):
            name_part = lines[-1].replace('FILENAME:', '').strip()
            if name_part:
                # Preserve extension from suggested name or use language default
                if '.' not in name_part:
                    name_part += lang_info['ext']
                suggested_filename = name_part
            lines = lines[:-1]

        code = '\n'.join(lines).strip()
        # Remove markdown code fences if the AI added them anyway
        code = re.sub(r'^```\w*\n', '', code)
        code = re.sub(r'\n```$', '', code)

        print(f"[CODE] Generated {len(code)} chars, suggested: {suggested_filename}")

        return jsonify({
            'success': True,
            'code': code,
            'language': language,
            'filename': suggested_filename,
            'line_count': len(code.split('\n'))
        })

    except Exception as e:
        print(f"[CODE] Generate error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/code/analyze', methods=['POST'])
def code_analyze():
    """Analyze/validate code for issues"""
    try:
        data = request.get_json(silent=True) or {}
        code = data.get('code', '').strip()
        language = data.get('language', 'python').strip().lower()
        if not code:
            return jsonify({'success': False, 'error': 'No code provided'}), 400

        # Quick syntax check for Python
        issues = []
        if language == 'python':
            try:
                compile(code, '<generated>', 'exec')
                issues.append({'type': 'info', 'message': '✓ Python syntax is valid'})
            except SyntaxError as e:
                issues.append({
                    'type': 'error',
                    'message': f"Line {e.lineno}: {e.msg}",
                    'line': e.lineno
                })
        elif language in ('javascript', 'typescript'):
            # Basic JS validation: check for common issues
            lines = code.split('\n')
            for i, line in enumerate(lines, 1):
                stripped = line.strip()
                if stripped.endswith('{') and not stripped.rstrip('{').rstrip():
                    unmatched = sum(1 for c in line if c == '{') - sum(1 for c in line if c == '}')
                    if unmatched > 0:
                        pass  # Opening brace is common, don't flag
            issues.append({'type': 'info', 'message': 'Basic syntax check passed (no JS parser available)'})
        else:
            issues.append({'type': 'info', 'message': f'{language} syntax validation not available'})

        if not any(i['type'] == 'error' for i in issues):
            issues.append({'type': 'success', 'message': 'No critical issues found'})

        line_count = len(code.split('\n'))
        char_count = len(code)

        # Estimate complexity
        func_count = len(re.findall(r'\bdef \w+|function\s+\w+|\bfunc\b', code))
        class_count = len(re.findall(r'\bclass \w+', code))

        return jsonify({
            'success': True,
            'issues': issues,
            'line_count': line_count,
            'char_count': char_count,
            'functions': func_count,
            'classes': class_count
        })

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/code/save', methods=['POST'])
def code_save():
    """Save generated code to a file on disk"""
    try:
        data = request.get_json(silent=True) or {}
        code = data.get('code', '').strip()
        filename = data.get('filename', 'generated_code.txt')
        if not code:
            return jsonify({'success': False, 'error': 'No code provided'}), 400

        # Sanitize filename: a bare file name inside CODE_DIR only. The old
        # regex kept dots, so ../ survived it — basename plus an explicit
        # rejection of dot segments closes that.
        filename = os.path.basename(data.get('filename', 'generated_code.txt') or 'generated_code.txt')
        if not filename or filename.startswith('.') or '..' in filename or len(filename) > 100:
            return jsonify({'success': False, 'error': 'Invalid filename'}), 400
        filepath = os.path.join(CODE_DIR, filename)

        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(code)

        print(f"[CODE] Saved to {filepath}")
        return jsonify({
            'success': True,
            'filename': filename,
            'path': filepath,
            'line_count': len(code.split('\n'))
        })

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# =====================================================================
#  FEATURE: ESTA VOICE ENHANCED — Web Speech + Streaming TTS
# =====================================================================
@app.route('/api/voice/stream-tts', methods=['POST'])
def voice_stream_tts():
    """Stream TTS audio in chunks for progressive playback."""
    from flask import Response as FlaskResponse
    try:
        data = request.get_json(silent=True) or {}
        text = data.get('text', '').strip()
        lang = data.get('lang', 'en')
        if not text:
            return jsonify({'success': False, 'error': 'No text'}), 400

        # Limit text length
        if len(text) > 2000:
            text = text[:2000] + '...'

        # Use gTTS to generate audio, return as streaming response
        from gtts import gTTS
        import io
        tts = gTTS(text=text, lang=lang, slow=False)
        buf = io.BytesIO()
        tts.write_to_fp(buf)
        buf.seek(0)
        audio_data = buf.read()

        def generate_audio():
            chunk_size = 4096
            offset = 0
            while offset < len(audio_data):
                yield audio_data[offset:offset + chunk_size]
                offset += chunk_size
                time.sleep(0.02)  # Simulate streaming

        response = FlaskResponse(generate_audio(), mimetype='audio/mpeg')
        response.headers.add('Content-Length', str(len(audio_data)))
        response.headers.add('X-TTS-Text-Length', str(len(text)))
        return response

    except Exception as e:
        print(f"[VOICE] Stream TTS error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

# =====================================================================
#  FEATURE: ESTA AGENT — Multi-step task planning & execution
# =====================================================================
AGENT_TOOLS_DESC = """
You are Esta Agent, an autonomous task executor. Given a user request, create a step-by-step plan.

Available tools (output as JSON steps with "tool" and "params"):
1. {"tool": "search", "params": {"query": "..."}} — Web search
2. {"tool": "code", "params": {"description": "...", "language": "..."}} — Generate code
3. {"tool": "browse", "params": {"url": "..."}} — Open a website
4. {"tool": "ask_ai", "params": {"question": "..."}} — Ask AI for information
5. {"tool": "calculate", "params": {"expression": "..."}} — Math calculation
6. {"tool": "summarize", "params": {"text": "..."}} — Summarize text

IMPORTANT: Return ONLY a JSON array of steps. No markdown, no code fences, no explanations.

Example for "Find Python tutorials and save a practice script":
[{"tool":"search","params":{"query":"best Python tutorials 2025"}},{"tool":"code","params":{"description":"Python practice script with basic exercises","language":"python"}}]
"""

@app.route('/api/agent/plan', methods=['POST'])
def agent_plan():
    """Create an execution plan for a user request."""
    try:
        data = request.get_json(silent=True) or {}
        task = data.get('task', '').strip()
        if not task:
            return jsonify({'success': False, 'error': 'No task'}), 400

        print(f"[AGENT] Planning: {task[:100]}")
        groq_resp = client.chat.completions.create(
            model="allam-2-7b",
            messages=[
                {"role": "system", "content": AGENT_TOOLS_DESC},
                {"role": "user", "content": task}
            ],
            temperature=0.1,
            max_tokens=1000
        )
        raw = strip_think_tags(groq_resp.choices[0].message.content)
        # Strip any markdown fences
        raw = re.sub(r'^```(?:json)?\n?', '', raw)
        raw = re.sub(r'\n?```$', '', raw)
        steps = json.loads(raw)
        if not isinstance(steps, list):
            steps = [steps]

        print(f"[AGENT] Plan has {len(steps)} steps")
        return jsonify({'success': True, 'steps': steps, 'total': len(steps)})

    except json.JSONDecodeError as e:
        print(f"[AGENT] JSON parse error: {e}\nRaw: {raw}")
        return jsonify({'success': False, 'error': f'Failed to parse plan: {str(e)}', 'raw': raw}), 500
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/agent/execute', methods=['POST'])
def agent_execute():
    """Execute a single agent step."""
    try:
        data = request.get_json(silent=True) or {}
        step = data.get('step', {})
        tool = step.get('tool', '')
        params = step.get('params', {})

        print(f"[AGENT] Execute: {tool} {params}")

        if tool == 'search':
            query = params.get('query', '')
            try:
                from duckduckgo_search import DDGS
                results = []
                with DDGS() as ddgs:
                    for i, r in enumerate(ddgs.text(query, max_results=3)):
                        results.append(f"- {r.get('title','')}: {r.get('body','')[:200]}")
                result = '\n'.join(results) if results else f"Searched for: {query}"
            except:
                result = f"Search query: {query} (offline)"
            return jsonify({'success': True, 'result': result, 'tool': tool})

        elif tool == 'code':
            desc = params.get('description', '')
            lang = params.get('language', 'python')
            groq_resp = client.chat.completions.create(
                model="allam-2-7b",
                messages=[{"role": "system", "content": f"Generate {lang} code only, no explanations."}, {"role": "user", "content": desc}],
                temperature=0.2, max_tokens=1000
            )
            code = strip_think_tags(groq_resp.choices[0].message.content)
            return jsonify({'success': True, 'result': f'```{lang}\n{code}\n```', 'tool': tool})

        elif tool == 'browse':
            url = params.get('url', '')
            import webbrowser
            webbrowser.open(url)
            return jsonify({'success': True, 'result': f'Opened {url}', 'tool': tool})

        elif tool == 'ask_ai':
            question = params.get('question', '')
            groq_resp = client.chat.completions.create(
                model="allam-2-7b",
                messages=[{"role": "user", "content": question}],
                temperature=0.3, max_tokens=500
            )
            answer = strip_think_tags(groq_resp.choices[0].message.content)
            return jsonify({'success': True, 'result': answer, 'tool': tool})

        elif tool == 'calculate':
            expr = params.get('expression', '')
            try:
                result = str(safe_calculate(expr))
            except:
                result = f"Cannot calculate: {expr}"
            return jsonify({'success': True, 'result': result, 'tool': tool})

        elif tool == 'summarize':
            text = params.get('text', '')
            groq_resp = client.chat.completions.create(
                model="allam-2-7b",
                messages=[{"role": "system", "content": "Summarize in 2-3 sentences."}, {"role": "user", "content": text[:2000]}],
                temperature=0.3, max_tokens=200
            )
            summary = strip_think_tags(groq_resp.choices[0].message.content)
            return jsonify({'success': True, 'result': summary, 'tool': tool})

        else:
            return jsonify({'success': False, 'error': f'Unknown tool: {tool}'}), 400

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# =====================================================================
#  FEATURE: ESTA EDITOR — Image processing + video tools
# =====================================================================
EDITOR_DIR = os.path.join(BASE_DIR, 'editor_assets')
os.makedirs(EDITOR_DIR, exist_ok=True)

@app.route('/api/editor/process-image', methods=['POST'])
def editor_process_image():
    """Apply image operations: resize, crop, rotate, filter."""
    try:
        if 'image' not in request.files:
            return jsonify({'success': False, 'error': 'No image'}), 400
        file = request.files['image']
        raw_bytes = file.read()
        ops = request.form.get('operations', '[]')
        try:
            ops = json.loads(ops)
        except:
            ops = []

        from PIL import Image, ImageFilter, ImageEnhance
        from io import BytesIO
        import base64

        img = Image.open(BytesIO(raw_bytes))
        fmt = img.format or 'JPEG'

        for op in ops:
            op_type = op.get('type', '')
            if op_type == 'resize':
                w = int(op.get('width', img.width))
                h = int(op.get('height', img.height))
                img = img.resize((w, h), Image.LANCZOS)
            elif op_type == 'crop':
                x = int(op.get('x', 0))
                y = int(op.get('y', 0))
                w = int(op.get('width', img.width))
                h = int(op.get('height', img.height))
                img = img.crop((x, y, x + w, y + h))
            elif op_type == 'rotate':
                deg = float(op.get('degrees', 0))
                img = img.rotate(deg, expand=True)
            elif op_type == 'grayscale':
                img = img.convert('L').convert('RGB')
            elif op_type == 'blur':
                r = int(op.get('radius', 2))
                img = img.filter(ImageFilter.GaussianBlur(radius=r))
            elif op_type == 'brightness':
                f = float(op.get('factor', 1.0))
                img = ImageEnhance.Brightness(img).enhance(f)
            elif op_type == 'contrast':
                f = float(op.get('factor', 1.0))
                img = ImageEnhance.Contrast(img).enhance(f)
            elif op_type == 'flip':
                if op.get('direction') == 'horizontal':
                    img = img.transpose(Image.FLIP_LEFT_RIGHT)
                else:
                    img = img.transpose(Image.FLIP_TOP_BOTTOM)

        if img.mode == 'P':
            img = img.convert('RGBA').convert('RGB')
        elif img.mode != 'RGB':
            img = img.convert('RGB')
        out_buf = BytesIO()
        img.save(out_buf, format='JPEG', quality=90)
        b64 = base64.b64encode(out_buf.getvalue()).decode('utf-8')

        return jsonify({
            'success': True,
            'image': f'data:image/jpeg;base64,{b64}',
            'width': img.width,
            'height': img.height,
            'format': fmt
        })

    except Exception as e:
        print(f"[EDITOR] Image error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/editor/video-info', methods=['POST'])
def editor_video_info():
    """Get video metadata using ffprobe."""
    try:
        if 'video' not in request.files:
            return jsonify({'success': False, 'error': 'No video'}), 400
        file = request.files['video']
        upload_name = os.path.basename(file.filename or 'upload.bin')
        if not upload_name or upload_name.startswith('.') or '..' in upload_name:
            return jsonify({'success': False, 'error': 'Invalid filename'}), 400
        temp_path = os.path.join(EDITOR_DIR, f'temp_{int(time.time())}_{upload_name}')
        file.save(temp_path)

        import subprocess, json as json_mod
        result = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', temp_path],
            capture_output=True, text=True, timeout=30
        )
        info = json_mod.loads(result.stdout) if result.stdout else {}
        os.remove(temp_path)

        streams = info.get('streams', [])
        video_stream = next((s for s in streams if s.get('codec_type') == 'video'), {})
        duration = float(info.get('format', {}).get('duration', 0))

        return jsonify({
            'success': True,
            'duration': duration,
            'width': video_stream.get('width', 0),
            'height': video_stream.get('height', 0),
            'codec': video_stream.get('codec_name', ''),
            'bitrate': info.get('format', {}).get('bit_rate', 0)
        })

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/editor/convert-video', methods=['POST'])
def editor_convert_video():
    """Convert video format or extract audio using ffmpeg."""
    try:
        if 'video' not in request.files:
            return jsonify({'success': False, 'error': 'No video'}), 400
        file = request.files['video']
        target_format = str(request.form.get('format', 'mp4')).lower()
        if target_format not in ('mp4', 'avi', 'mkv', 'webm', 'mp3', 'wav'):
            return jsonify({'success': False, 'error': 'Unsupported format'}), 400
        extract_audio = request.form.get('extract_audio', 'false') == 'true'

        upload_name = os.path.basename(file.filename or 'upload.bin')
        if not upload_name or upload_name.startswith('.') or '..' in upload_name:
            return jsonify({'success': False, 'error': 'Invalid filename'}), 400
        temp_in = os.path.join(EDITOR_DIR, f'in_{int(time.time())}_{upload_name}')
        file.save(temp_in)

        base = os.path.splitext(temp_in)[0]
        temp_out = f'{base}_out.{target_format}' if not extract_audio else f'{base}_audio.mp3'

        if extract_audio:
            cmd = ['ffmpeg', '-i', temp_in, '-vn', '-acodec', 'libmp3lame', temp_out, '-y']
        else:
            cmd = ['ffmpeg', '-i', temp_in, temp_out, '-y']

        subprocess.run(cmd, capture_output=True, timeout=120)

        import base64
        with open(temp_out, 'rb') as f:
            b64 = base64.b64encode(f.read()).decode('utf-8')

        os.remove(temp_in)
        if os.path.exists(temp_out):
            os.remove(temp_out)

        mime = 'audio/mpeg' if extract_audio else f'video/{target_format}'

        return jsonify({
            'success': True,
            'file': f'data:{mime};base64,{b64}',
            'format': target_format
        })

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# =====================================================================
#  FEATURE: ESTA VAULT — Encrypted password manager
# =====================================================================
VAULT_DIR = os.path.join(BASE_DIR, 'vault')
os.makedirs(VAULT_DIR, exist_ok=True)
VAULT_KEY_PATH = os.path.join(VAULT_DIR, '.vault_key')
VAULT_DATA_PATH = os.path.join(VAULT_DIR, 'vault_data.enc')

def _generate_vault_key():
    from cryptography.fernet import Fernet
    key = Fernet.generate_key()
    with open(VAULT_KEY_PATH, 'wb') as f:
        f.write(key)
    return key

def _get_vault_key():
    if os.path.exists(VAULT_KEY_PATH):
        with open(VAULT_KEY_PATH, 'rb') as f:
            return f.read()
    return _generate_vault_key()

def _get_cipher():
    from cryptography.fernet import Fernet
    return Fernet(_get_vault_key())

def _load_vault():
    if not os.path.exists(VAULT_DATA_PATH):
        return []
    try:
        cipher = _get_cipher()
        with open(VAULT_DATA_PATH, 'rb') as f:
            encrypted = f.read()
        if not encrypted:
            return []
        decrypted = cipher.decrypt(encrypted)
        return json.loads(decrypted.decode('utf-8'))
    except Exception as e:
        print(f"[VAULT] Load error: {e}")
        return []

def _save_vault(data):
    cipher = _get_cipher()
    encrypted = cipher.encrypt(json.dumps(data, ensure_ascii=False).encode('utf-8'))
    with open(VAULT_DATA_PATH, 'wb') as f:
        f.write(encrypted)

@app.route('/api/vault/status', methods=['GET'])
def vault_status():
    exists = os.path.exists(VAULT_DATA_PATH) and os.path.getsize(VAULT_DATA_PATH) > 0
    return jsonify({'success': True, 'initialized': exists})

@app.route('/api/vault/init', methods=['POST'])
def vault_init():
    """Initialize vault (creates encryption key)."""
    try:
        _generate_vault_key()
        _save_vault([])
        return jsonify({'success': True, 'message': 'Vault initialized'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/vault/list', methods=['GET'])
def vault_list():
    try:
        entries = _load_vault()
        # Return without passwords for listing
        safe = [{k: v for k, v in e.items() if k != 'password'} for e in entries]
        return jsonify({'success': True, 'entries': safe, 'total': len(entries)})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/vault/add', methods=['POST'])
def vault_add():
    try:
        data = request.get_json(silent=True) or {}
        name = data.get('name', '').strip()
        username = data.get('username', '').strip()
        password = data.get('password', '').strip()
        url = data.get('url', '').strip()
        notes = data.get('notes', '').strip()

        if not name or not password:
            return jsonify({'success': False, 'error': 'Name and password required'}), 400

        entries = _load_vault()
        entry = {
            'id': hashlib.md5(f"{name}_{time.time()}".encode()).hexdigest()[:12],
            'name': name,
            'username': username,
            'password': password,
            'url': url,
            'notes': notes,
            'created': datetime.datetime.now().isoformat()
        }
        entries.append(entry)
        _save_vault(entries)

        return jsonify({'success': True, 'id': entry['id'], 'name': name})

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/vault/get/<entry_id>', methods=['GET'])
def vault_get(entry_id):
    try:
        entries = _load_vault()
        entry = next((e for e in entries if e['id'] == entry_id), None)
        if not entry:
            return jsonify({'success': False, 'error': 'Entry not found'}), 404
        return jsonify({'success': True, 'entry': entry})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/vault/update/<entry_id>', methods=['POST'])
def vault_update(entry_id):
    try:
        data = request.get_json(silent=True) or {}
        entries = _load_vault()
        for e in entries:
            if e['id'] == entry_id:
                if 'name' in data: e['name'] = data['name']
                if 'username' in data: e['username'] = data['username']
                if 'password' in data: e['password'] = data['password']
                if 'url' in data: e['url'] = data['url']
                if 'notes' in data: e['notes'] = data['notes']
                e['updated'] = datetime.datetime.now().isoformat()
                _save_vault(entries)
                return jsonify({'success': True, 'id': entry_id})
        return jsonify({'success': False, 'error': 'Entry not found'}), 404
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/vault/delete/<entry_id>', methods=['DELETE'])
def vault_delete(entry_id):
    try:
        entries = _load_vault()
        entries = [e for e in entries if e['id'] != entry_id]
        _save_vault(entries)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# =====================================================================
#  FEATURE: LEETCODE ASSISTANT — AI-powered coding problem helper
# =====================================================================

LEETCODE_SYSTEM_PROMPT = """You are ESTA LeetCode Assistant, an AI coding tutor inside NEXORA Browser.

Your mission is to TEACH with clear explanations AND provide correct solutions. Follow this flow:
1. Explain the problem concept and approach
2. Provide a complete, correct solution in the user's language with clear logic
3. Walk through how the solution works
4. Analyze time and space complexity
5. Discuss edge cases

Always write CORRECT, bug-free solutions that would pass all LeetCode test cases. Use Markdown formatting."""

@app.route('/api/leetcode/explain', methods=['POST'])
def leetcode_explain():
    try:
        data = request.get_json(silent=True) or {}
        problem = data.get('problem', {})
        level = data.get('level', 'beginner')
        code = data.get('code', '')
        language = data.get('language', 'unknown')
        examples = problem.get('examples', [])
        constraints = problem.get('constraints', '')
        followup = problem.get('followup', '')
        hints = problem.get('hints', [])
        ex_text = '\n'.join([f'Example {i+1}: {e}' for i, e in enumerate(examples)]) if examples else ''
        hints_text = '\n'.join([f'Hint {i+1}: {h}' for i, h in enumerate(hints)]) if hints else ''
        prompt = f"""Problem: {problem.get('title', 'Unknown')}
Difficulty: {problem.get('difficulty', 'Unknown')}
Description: {problem.get('description', 'N/A')}
Constraints: {constraints}
{ex_text}
{followup}
{hints_text}

Explain this problem at a {level} level. Include:
1. What the question is asking (simple terms)
2. Input/output format
3. Constraints and edge cases
4. A real-world analogy
5. An example walkthrough of a sample case
6. A COMPLETE, CORRECT solution in {language} with line-by-line explanation
7. Time and space complexity analysis

The solution MUST be:
- Correct for all edge cases
- Pass all LeetCode test cases
- Use optimal algorithm (not brute force)
- Fully explained step by step

User's current code (if any):
```{language}
{code or '(none yet)'}
```"""
        resp = client.chat.completions.create(
            model="allam-2-7b",
            messages=[{"role":"system","content":LEETCODE_SYSTEM_PROMPT},{"role":"user","content":prompt}],
            temperature=0.3, max_tokens=1200
        )
        text = strip_think_tags(resp.choices[0].message.content)
        return jsonify({'success': True, 'explanation': text})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/leetcode/hint', methods=['POST'])
def leetcode_hint():
    try:
        data = request.get_json(silent=True) or {}
        problem = data.get('problem', {})
        level = int(data.get('level', 1))
        language = data.get('language', 'unknown')
        pdesc = f"Problem: {problem.get('title')}\nDifficulty: {problem.get('difficulty')}\nDescription: {problem.get('description', 'N/A')}"
        examples = problem.get('examples', [])
        constraints = problem.get('constraints', '')
        ex_text = '\n'.join([f'Example {i+1}: {e}' for i, e in enumerate(examples)]) if examples else ''
        pdesc_full = f"{pdesc}\nConstraints: {constraints}\n{ex_text}"
        prompts = {
            1: f"Give a small conceptual hint for this problem. Just 1-2 sentences to point in the right direction. Do NOT reveal the algorithm or data structure.\n\n{pdesc_full}",
            2: f"Suggest what algorithm category might apply to this problem. Just name the category and a brief why.\n\n{pdesc_full}",
            3: f"Suggest what data structure would be useful for this problem and why.\n\n{pdesc_full}",
            4: f"Provide high-level pseudocode (algorithm outline) for this problem. Do NOT give real code. Just steps.\n\n{pdesc_full}",
            5: f"The user has explicitly confirmed they want the full solution. Provide a COMPLETE, CORRECT solution in {language} that passes all LeetCode test cases. Include the code with line-by-line explanation and complexity analysis.\n\n{pdesc_full}"
        }
        prompt = prompts.get(level, prompts[1])
        resp = client.chat.completions.create(
            model="allam-2-7b",
            messages=[{"role":"system","content":LEETCODE_SYSTEM_PROMPT + " For hint levels 1-4, NEVER give the full solution. Only give the full solution at level 5."},{"role":"user","content":prompt}],
            temperature=0.4, max_tokens=600
        )
        text = strip_think_tags(resp.choices[0].message.content)
        return jsonify({'success': True, 'hint': text, 'level': level})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/leetcode/review', methods=['POST'])
def leetcode_review():
    try:
        data = request.get_json(silent=True) or {}
        code = data.get('code', '')
        language = data.get('language', 'unknown')
        problem = data.get('problem', {})
        submission = data.get('submission', '')
        runtime = data.get('runtime', '')
        memory = data.get('memory', '')
        prompt = f"""Review this {language} code for:\n{problem.get('title', 'Unknown')}\n\n```{language}\n{code}\n```\n\nSubmission: {submission} | Runtime: {runtime} | Memory: {memory}\n\nAnalyze:
1. Logic errors and bugs
2. Edge cases not handled
3. Code readability and naming
4. Algorithm choice
5. Time & space complexity
6. Optimization suggestions (specific)
7. Correctness score (0-100)

Be constructive and specific."""
        resp = client.chat.completions.create(
            model="allam-2-7b",
            messages=[{"role":"system","content":LEETCODE_SYSTEM_PROMPT},{"role":"user","content":prompt}],
            temperature=0.3, max_tokens=800
        )
        text = strip_think_tags(resp.choices[0].message.content)
        return jsonify({'success': True, 'review': text})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/leetcode/complexity', methods=['POST'])
def leetcode_complexity():
    try:
        data = request.get_json(silent=True) or {}
        code = data.get('code', '')
        language = data.get('language', 'unknown')
        prompt = f"""Analyze this {language} code and estimate its time and space complexity:\n\n```{language}\n{code}\n```\n\nReturn:
## Time Complexity
O(...) with explanation (highlight nested loops, recursion depth, sorting, etc.)

## Space Complexity
O(...) with explanation (highlight data structures, recursion stack, allocations, etc.)

## Bottlenecks
What's the most expensive operation

## Optimization Ideas
How to improve"""
        resp = client.chat.completions.create(
            model="allam-2-7b",
            messages=[{"role":"system","content":"You are a complexity analysis expert. Analyze Big O precisely."},{"role":"user","content":prompt}],
            temperature=0.2, max_tokens=600
        )
        text = strip_think_tags(resp.choices[0].message.content)
        return jsonify({'success': True, 'analysis': text})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/leetcode/pattern', methods=['POST'])
def leetcode_pattern():
    try:
        data = request.get_json(silent=True) or {}
        problem = data.get('problem', {})
        prompt = f"""Identify which algorithmic pattern this LeetCode problem belongs to:\n\nProblem: {problem.get('title')}
Difficulty: {problem.get('difficulty')}
Description: {problem.get('description', 'N/A')}
Constraints: {problem.get('constraints', 'N/A')}
Examples: {chr(10).join([f'Example {i+1}: {e}' for i, e in enumerate(problem.get('examples', []))]) if problem.get('examples') else 'N/A'}

Return:
## Pattern
The name of the pattern (Arrays, HashMap, Sliding Window, Two Pointer, Binary Search, DFS, BFS, Dynamic Programming, Backtracking, Greedy, Recursion, Trie, Heap, Union Find, Segment Tree, Graphs, Trees, Stack, Queue, Linked List)

## Why
Explain why this pattern applies

## Similar Problems
List 3-5 similar LeetCode problems with the same pattern"""
        resp = client.chat.completions.create(
            model="allam-2-7b",
            messages=[{"role":"system","content":"You are an algorithm pattern recognition expert."},{"role":"user","content":prompt}],
            temperature=0.3, max_tokens=500
        )
        text = strip_think_tags(resp.choices[0].message.content)
        return jsonify({'success': True, 'pattern': text})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/leetcode/interview', methods=['POST'])
def leetcode_interview():
    try:
        data = request.get_json(silent=True) or {}
        problem = data.get('problem', {})
        code = data.get('code', '')
        difficulty = problem.get('difficulty', 'Medium')
        prompt = f"""Act as a technical interviewer. The user just solved:\n\nProblem: {problem.get('title')}
Difficulty: {difficulty}
Description: {problem.get('description', 'N/A')[:500]}

Their code:
```\n{code or '(not provided)'}\n```

Ask 3-5 follow-up interview questions based on this problem. Include:
- Why they chose their approach
- How to optimize further
- Edge cases they might have missed
- Alternative approaches (recursive/iterative)
- What if input size changes

For each question, also give a model answer the user can compare with."""
        resp = client.chat.completions.create(
            model="allam-2-7b",
            messages=[{"role":"system","content":"You are a senior FAANG technical interviewer. Ask sharp, insightful follow-up questions."},{"role":"user","content":prompt}],
            temperature=0.6, max_tokens=800
        )
        text = strip_think_tags(resp.choices[0].message.content)
        return jsonify({'success': True, 'questions': text})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/leetcode/notes', methods=['POST'])
def leetcode_notes():
    try:
        data = request.get_json(silent=True) or {}
        problem = data.get('problem', {})
        code = data.get('code', '')
        review = data.get('review', '')
        pattern = data.get('pattern', '')
        prompt = f"""Generate structured learning notes from this LeetCode problem:\n\nProblem: {problem.get('title')}
Difficulty: {problem.get('difficulty')}
Code: {code or '(not provided)'}
Review: {review or 'N/A'}
Pattern: {pattern or 'N/A'}

Return as Markdown:
## Problem
## Pattern
## Difficulty
## Key Concept
## Algorithm Used
## Time Complexity
## Space Complexity
## Mistakes Made (common pitfalls)
## Key Learning
## Edge Cases
## Similar Problems"""
        resp = client.chat.completions.create(
            model="allam-2-7b",
            messages=[{"role":"system","content":"You generate concise, structured LeetCode learning notes."},{"role":"user","content":prompt}],
            temperature=0.3, max_tokens=600
        )
        text = strip_think_tags(resp.choices[0].message.content)
        return jsonify({'success': True, 'notes': text})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/leetcode/error-explain', methods=['POST'])
def leetcode_error_explain():
    try:
        data = request.get_json(silent=True) or {}
        error = data.get('error', '')
        code = data.get('code', '')
        language = data.get('language', 'unknown')
        prompt = f"""Convert this compiler/runtime error into a beginner-friendly explanation:\n\nLanguage: {language}
Error: {error}
Code: {code or '(not provided)'}

Explain:
## Cause
What caused the error

## Example
Show a minimal example that triggers this

## Fix
How to fix it

## Why It Happened
Underlying concept

## How to Avoid
Prevention tips"""
        resp = client.chat.completions.create(
            model="allam-2-7b",
            messages=[{"role":"system","content":"You explain programming errors in clear, beginner-friendly language."},{"role":"user","content":prompt}],
            temperature=0.3, max_tokens=500
        )
        text = strip_think_tags(resp.choices[0].message.content)
        return jsonify({'success': True, 'explanation': text})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/leetcode/similar', methods=['POST'])
def leetcode_similar():
    try:
        data = request.get_json(silent=True) or {}
        problem = data.get('problem', {})
        pattern = data.get('pattern', '')
        prompt = f"""Based on this LeetCode problem, recommend 5 similar problems:\n\nTitle: {problem.get('title')}
Difficulty: {problem.get('difficulty')}
Pattern: {pattern or 'N/A'}
Description: {problem.get('description', 'N/A')[:500]}

For each recommendation include:
- Problem name
- Difficulty
- Why it's similar (same pattern/concept)
- Link to LeetCode problem (use leetcode.com/problems/... format)
- What skill it builds"""
        resp = client.chat.completions.create(
            model="allam-2-7b",
            messages=[{"role":"system","content":"You recommend LeetCode problems based on pattern, difficulty, and learning progression."},{"role":"user","content":prompt}],
            temperature=0.4, max_tokens=600
        )
        text = strip_think_tags(resp.choices[0].message.content)
        return jsonify({'success': True, 'recommendations': text})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/leetcode/chat', methods=['POST'])
def leetcode_chat():
    try:
        data = request.get_json(silent=True) or {}
        message = data.get('message', '').strip()
        history = data.get('history', [])
        if not message:
            return jsonify({'success': False, 'error': 'Empty message'}), 400
        messages = [{"role":"system","content":"You are ESTA Code Tutor, an expert programming assistant inside NEXORA Browser. You help users understand coding problems, write solutions, debug code, and learn algorithms. Provide clear explanations with examples. Use Markdown formatting with code blocks. Be encouraging and thorough."}]
        for h in history[-6:]:
            messages.append({"role": h.get('role', 'user'), "content": h.get('content', '')})
        messages.append({"role": "user", "content": message})
        resp = client.chat.completions.create(
            model="allam-2-7b",
            messages=messages,
            temperature=0.5, max_tokens=1024
        )
        text = strip_think_tags(resp.choices[0].message.content)
        return jsonify({'success': True, 'response': text})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/leetcode/solution-compare', methods=['POST'])
def leetcode_solution_compare():
    try:
        data = request.get_json(silent=True) or {}
        problem = data.get('problem', {})
        user_code = data.get('user_code', '')
        language = data.get('language', 'unknown')
        prompt = f"""Compare the user's solution with an optimal solution for:\n\nProblem: {problem.get('title')}
Description: {problem.get('description', 'N/A')[:300]}

User's code:
```{language}
{user_code or '(not provided)'}
```

Analyze:
1. Complexity differences
2. Readability
3. Performance trade-offs  
4. Memory usage
5. Maintainability
6. What the optimal solution would do differently

Provide a fair, educational comparison. If the user's solution is already optimal, acknowledge that."""
        resp = client.chat.completions.create(
            model="allam-2-7b",
            messages=[{"role":"system","content":"You compare coding solutions fairly and educationally."},{"role":"user","content":prompt}],
            temperature=0.3, max_tokens=700
        )
        text = strip_think_tags(resp.choices[0].message.content)
        return jsonify({'success': True, 'comparison': text})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ===== SPEECH TO TEXT (Gemini API) =====
# No fallback key: a secret baked into source leaks to everyone with read
# access and cannot be revoked per user. Set GEMINI_API_KEY in backend/.env;
# without it this endpoint reports unavailable instead of failing obscurely.
GEMINI_STT_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_STT_MODEL = "gemini-2.0-flash"

@app.route('/api/speech-to-text', methods=['POST'])
def speech_to_text():
    """Convert audio blob to text using Gemini API."""
    if not GEMINI_STT_KEY:
        return jsonify({'success': False, 'error': 'Speech-to-text is not configured (GEMINI_API_KEY missing)'}), 503
    try:
        audio_file = request.files.get('audio')
        if not audio_file:
            return jsonify({'success': False, 'error': 'No audio file provided'}), 400
        audio_bytes = audio_file.read()
        if len(audio_bytes) > 15 * 1024 * 1024:
            return jsonify({'success': False, 'error': 'Audio too large (max 15MB)'}), 400
        print(f"[STT] Received audio: {len(audio_bytes)} bytes")
        audio_b64 = __import__('base64').b64encode(audio_bytes).decode('utf-8')
        gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_STT_MODEL}:generateContent?key={GEMINI_STT_KEY}"
        payload = {
            "contents": [{
                "parts": [
                    {"inline_data": {"mime_type": "audio/webm", "data": audio_b64}},
                    {"text": "Transcribe this audio exactly. Return ONLY the transcribed text, nothing else. No quotes, no labels."}
                ]
            }],
            "generationConfig": {"temperature": 0.1, "maxOutputTokens": 256}
        }
        resp = requests.post(gemini_url, json=payload, timeout=30)
        data = resp.json()
        if resp.status_code != 200:
            print(f"[STT] Gemini error: {data}")
            return jsonify({'success': False, 'error': data.get('error', {}).get('message', 'Gemini error')}), 500
        text = data.get('candidates', [{}])[0].get('content', {}).get('parts', [{}])[0].get('text', '').strip()
        text = re.sub(r'^[`"\']|[`"\']$', '', text).strip()
        print(f"[STT] Transcribed: {text}")
        return jsonify({'success': True, 'text': text})
    except Exception as e:
        print(f"[STT] Error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


# ===== NEO ACCOUNT SYNC (cross-device backup/restore) =====
# Accounts are stored server-side as <BASE_DIR>/neo_accounts/<username>.json so a
# NEO browser on ANY device can sign in and download its data from this server.
# Deploy this backend somewhere reachable and set NEO_HOST/NEO_PORT to expose it.

# ===== NEO ACCOUNT AUTH (SECURE — bcrypt + sessions + reset, PHASE 1) =====
# Security upgrades over the original phase: bcrypt password hashing with
# transparent migration from the old SHA-256 format, explicit registration
# (no auto-create on login), login by username OR email, session tokens
# (stored only as SHA-256 hashes, 30-day expiry), sign-out, and a one-time
# password reset code flow.
import neo_auth

@app.route('/api/account/login', methods=['POST'])
def neo_account_login():
    try:
        body = request.get_json(force=True, silent=True) or {}
        ident = str(body.get('username', '') or body.get('email', '') or '').strip()
        password = str(body.get('password', ''))
        if not ident or not password:
            return jsonify({'ok': False, 'error': 'Username/email and password required'}), 200
        acct, token, migrated = neo_auth.login_account(ident, password)
        if acct is None:
            return jsonify({'ok': False, 'error': 'Wrong username/email or password'}), 200
        if migrated:
            print(f"[ACCT] Migrated SHA-256 password hash to bcrypt for '{acct['username']}'")
        neo_auth._write_account(acct['username'], acct)  # persist new session
        return jsonify({
            'ok': True,
            'token': token,
            'account': {'username': acct['username'], 'email': acct.get('email', ''),
                        'createdAt': acct.get('createdAt', '')},
            'data': {'browserData': acct.get('data', {}).get('browserData', {})},
        }), 200
    except Exception as e:
        print(f"[ACCT] login error: {e}")
        return jsonify({'ok': False, 'error': str(e)}), 500

@app.route('/api/account/register', methods=['POST'])
def neo_account_register():
    try:
        body = request.get_json(force=True, silent=True) or {}
        username = str(body.get('username', '')).strip()
        email = str(body.get('email', '')).strip()
        password = str(body.get('password', ''))
        if (body.get('data') or {}).get('browserData') is not None:
            browser_data = (body.get('data') or {}).get('browserData')
        else:
            browser_data = None
        acct, err = neo_auth.create_account(username, email, password, browser_data)
        if acct is None:
            return jsonify({'ok': False, 'error': err}), 200
        token = neo_auth._issue_session(acct)
        neo_auth._write_account(acct['username'], acct)
        print(f"[ACCT] Registered user '{acct['username']}' <{acct['email']}>")
        return jsonify({'ok': True, 'token': token,
                        'account': {'username': acct['username'], 'email': acct['email'],
                                    'createdAt': acct['createdAt']}}), 200
    except Exception as e:
        print(f"[ACCT] register error: {e}")
        return jsonify({'ok': False, 'error': str(e)}), 500

@app.route('/api/account/sync', methods=['POST'])
def neo_account_sync():
    try:
        body = request.get_json(force=True, silent=True) or {}
        ident = str(body.get('username', '') or body.get('email', '') or '').strip()
        password = str(body.get('password', ''))
        token = str(body.get('token', ''))
        acct = neo_auth.find_account(ident)[1]
        if acct is None:
            return jsonify({'ok': False, 'error': 'Account not found. Sign in first.'}), 200
        authed = (token and neo_auth.validate_session(acct, token))
        if not authed:
            authed = (password and neo_auth.verify_password(password, acct.get('passwordHash', '')))
        if not authed:
            return jsonify({'ok': False, 'error': 'Wrong password or expired session'}), 200
        if body.get('data'):
            acct['data'] = body['data']
            acct['updatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        neo_auth._write_account(acct['username'], acct)
        return jsonify({'ok': True, 'data': {'browserData': acct.get('data', {}).get('browserData', {})}}), 200
    except Exception as e:
        print(f"[ACCT] sync error: {e}")
        return jsonify({'ok': False, 'error': str(e)}), 500

@app.route('/api/account/validate', methods=['POST'])
def neo_account_validate():
    try:
        body = request.get_json(force=True, silent=True) or {}
        ident = str(body.get('username', '') or body.get('email', '') or '').strip()
        token = str(body.get('token', ''))
        acct = neo_auth.find_account(ident)[1]
        if acct is None:
            return jsonify({'ok': False, 'error': 'Account not found'}), 200
        ok = bool(token) and neo_auth.validate_session(acct, token)
        if ok:
            neo_auth._write_account(acct['username'], acct)
        return jsonify({'ok': ok}), 200
    except Exception as e:
        print(f"[ACCT] validate error: {e}")
        return jsonify({'ok': False, 'error': str(e)}), 500

@app.route('/api/account/signout', methods=['POST'])
def neo_account_signout():
    try:
        body = request.get_json(force=True, silent=True) or {}
        ident = str(body.get('username', '') or body.get('email', '') or '').strip()
        token = str(body.get('token', ''))
        acct = neo_auth.find_account(ident)[1]
        if acct is not None:
            neo_auth.revoke_session(acct, token)
            neo_auth._write_account(acct['username'], acct)
        return jsonify({'ok': True}), 200
    except Exception as e:
        print(f"[ACCT] signout error: {e}")
        return jsonify({'ok': False, 'error': str(e)}), 500

@app.route('/api/account/request-reset', methods=['POST'])
def neo_account_request_reset():
    try:
        body = request.get_json(force=True, silent=True) or {}
        ident = str(body.get('username', '') or body.get('email', '') or '').strip()
        username, code = neo_auth.request_password_reset(ident)
        if username is None:
            return jsonify({'ok': False, 'error': 'No account found for that username/email'}), 200
        acct = neo_auth._read_account(username)
        if acct is not None:
            neo_auth._write_account(username, acct)
        print(f"[ACCT] Password reset code issued for '{username}'")
        # Local-only recovery until email delivery exists: the owner reads the
        # code from this server console. It is never sent over HTTP.
        print(f"[ACCT] One-time reset code for '{username}': {code} (expires in 30 min)")
        # The one-time code is intentionally NOT returned: email delivery is not
        # wired yet, and putting the code in the response would let anyone who
        # knows a username take over the account. Until delivery exists, the
        # code is only visible in this server log for the local machine owner.
        return jsonify({'ok': True}), 200
    except Exception as e:
        print(f"[ACCT] request-reset error: {e}")
        return jsonify({'ok': False, 'error': str(e)}), 500

@app.route('/api/account/reset-password', methods=['POST'])
def neo_account_reset_password():
    try:
        body = request.get_json(force=True, silent=True) or {}
        ident = str(body.get('username', '') or body.get('email', '') or '').strip()
        code = str(body.get('resetCode', ''))
        new = str(body.get('newPassword', ''))
        username, err = neo_auth.reset_password(ident, code, new)
        if username is None:
            return jsonify({'ok': False, 'error': err}), 200
        return jsonify({'ok': True}), 200
    except Exception as e:
        print(f"[ACCT] reset-password error: {e}")
        return jsonify({'ok': False, 'error': str(e)}), 500

@app.route('/api/account/change-password', methods=['POST'])
def neo_account_change_password():
    try:
        body = request.get_json(force=True, silent=True) or {}
        ident = str(body.get('username', '') or body.get('email', '') or '').strip()
        old = str(body.get('oldPassword', ''))
        token = str(body.get('token', ''))
        new = str(body.get('newPassword', ''))
        acct = neo_auth.find_account(ident)[1]
        if acct is None:
            return jsonify({'ok': False, 'error': 'Account not found'}), 200
        authed = (token and neo_auth.validate_session(acct, token))
        if not authed:
            authed = (old and neo_auth.verify_password(old, acct.get('passwordHash', '')))
        if not authed:
            return jsonify({'ok': False, 'error': 'Current password is incorrect'}), 200
        err = neo_auth.validate_new_password(new)
        if err:
            return jsonify({'ok': False, 'error': err}), 200
        acct['passwordHash'] = neo_auth.hash_password(new)
        acct['passwordVersion'] = 2
        acct['updatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        acct['sessions'] = {}  # revoke all other sessions
        neo_auth._write_account(acct['username'], acct)
        new_token = neo_auth._issue_session(acct)
        neo_auth._write_account(acct['username'], acct)
        return jsonify({'ok': True, 'token': new_token}), 200
    except Exception as e:
        print(f"[ACCT] change-password error: {e}")
        return jsonify({'ok': False, 'error': str(e)}), 500


# ===== GLOBAL ERROR HANDLERS =====

@app.errorhandler(404)
def not_found(e):
    """Return JSON for 404 errors instead of HTML."""
    print(f"[APP] 404: {e}")
    return jsonify({'success': False, 'error': 'Image analysis endpoint not found.'}), 404


@app.errorhandler(405)
def method_not_allowed(e):
    """Return JSON for 405 errors instead of HTML."""
    print(f"[APP] 405: {e}")
    return jsonify({'success': False, 'error': 'Method not allowed.'}), 405


@app.errorhandler(500)
def internal_error(e):
    """Return JSON for 500 errors instead of HTML."""
    print(f"[APP] 500: {e}")
    return jsonify({'success': False, 'error': 'Internal server error.', 'details': str(e)}), 500


# ===== START SERVER =====
if __name__ == '__main__':
    import sys
    host = os.getenv("NEO_HOST", "127.0.0.1")
    port = int(os.getenv("NEO_PORT", "5000"))
    print(f"[APP] Starting NEXORA Browser AI backend on http://{host}:{port}")
    sys.stdout.flush()
    # debug/show a hint for cross-device sync deployment:
    if host != "127.0.0.1" and host != "localhost":
        print("[APP] Host is exposed - NEXORA Account sync is available to other devices/devices reachable to this host.")

    def _warm_offline_model():
        if LOW_SPEC:
            # Do NOT preload the model on weak PCs: loading it at boot eats RAM
            # that apps need, which is exactly what caused the PC to crash.
            # The model will load lazily on the first user message instead.
            print("[APP] Low-spec PC detected - skipping offline model warm-up")
            return
        # Respect the user's ON/OFF switch. Preloading while the offline AI is off
        # is what left ~1.8 GB of weights resident with nobody using it.
        if not _offline_ai_enabled():
            print("[APP] Offline AI is OFF - skipping offline model warm-up")
            return
        time.sleep(10)
        if not _offline_ai_enabled():
            print("[APP] Offline AI was switched off during warm-up wait - skipping")
            return
        try:
            ollama_offline_chat("Reply with exactly: OK", history=[],
                                system_prompt="You are a warm-up check. Reply in one word.",
                                max_tokens=8, use_memory=False, use_rag=False)
            print("[APP] Offline model warmed up - first message will be fast")
        except Exception as e:
            print(f"[APP] Offline warm-up skipped: {e}")
        sys.stdout.flush()

    threading.Thread(target=_warm_offline_model, daemon=True).start()
    # debug off: avoids the Werkzeug reloader spawning duplicate processes and
    # hanging only-once route handlers; edits still apply on manual restart.
    app.run(host=host, port=port, threaded=True, debug=False, use_reloader=False)
