from flask import Flask, request, jsonify, Response, send_from_directory
from flask_cors import CORS
import os
from dotenv import load_dotenv
from groq import Groq
import datetime
import json
import re
import csv
import glob
import subprocess
import webbrowser
import urllib.parse
import pyttsx3
import speech_recognition as sr
import threading
import time
import random
import pyautogui
try:
    import pygame
except ImportError:
    pygame = None
import ctypes
import requests
import io

try:
    import pygetwindow as gw
except ImportError:
    gw = None

try:
    from gtts import gTTS
except ImportError:
    gTTS = None

# Load environment variables
load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.abspath(os.path.join(BASE_DIR, '..'))
USER_HOME = os.path.expanduser("~")
app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path='')
app.json.ensure_ascii = False
app.config['JSON_AS_ASCII'] = False
CORS(app)

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.12

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
PASSWORD = os.getenv("PASSWORD", "77296")
MOM_NUMBER = os.getenv("MOM_NUMBER", "+919833733073").strip()
PHONE_NUMBER = os.getenv("PHONE_NUMBER", "+919921718519").strip()
MOM_WHATSAPP_CALL_LINK = os.getenv("MOM_WHATSAPP_CALL_LINK", "").strip()
WHATSAPP_CALL_DELAY = float(os.getenv("WHATSAPP_CALL_DELAY", "8"))
WHATSAPP_CALL_X = os.getenv("WHATSAPP_CALL_X")
WHATSAPP_CALL_Y = os.getenv("WHATSAPP_CALL_Y")
WHATSAPP_CALL_OFFSET_X = env_int("WHATSAPP_CALL_OFFSET_X", 132)
WHATSAPP_CALL_OFFSET_Y = env_int("WHATSAPP_CALL_OFFSET_Y", 56)

# Initialize Groq AI
groq_api_key = os.getenv("GROQ_API_KEY")
if not groq_api_key:
    print("❌ ERROR: GROQ_API_KEY not found in .env file!")
    print("Please add your API key to backend/.env")
    exit(1)

print(f"Groq API key loaded: {groq_api_key[:10]}...")  # Print first 10 chars for verification
client = Groq(api_key=groq_api_key)

# Initialize pygame mixer for sounds
try:
    pygame.mixer.init()
except:
    pass

# Initialize text-to-speech engines
try:
    engine = pyttsx3.init()  # Backup TTS engine
except Exception as e:
    print(f"pyttsx3 init error: {e}")
    engine = None
gtts_available = False
try:
    # Test gTTS
    if gTTS:
        tts = gTTS(text="test", lang='en')
        gtts_available = True
except:
    gtts_available = False
voices = engine.getProperty("voices") if engine else []

def set_female_voice():
    """Set female voice for TTS"""
    if not engine:
        return
    female_keywords = ("female", "zira", "hazel", "susan", "samantha", "eva", "aria")
    for voice in voices:
        voice_text = f"{voice.id} {voice.name}".lower()
        if any(keyword in voice_text for keyword in female_keywords):
            engine.setProperty("voice", voice.id)
            return
    if len(voices) > 1:
        engine.setProperty("voice", voices[1].id)

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
    for voice in voices:
        voice_text = f"{voice.id} {voice.name}".lower()
        if any(keyword in voice_text for keyword in male_keywords):
            engine.setProperty("voice", voice.id)
            return
    # Default to first voice if no male found
    if voices:
        engine.setProperty("voice", voices[0].id)

def get_available_voices():
    """Get list of available voices"""
    voice_list = []
    
    # Add pyttsx3 voices
    for voice in voices:
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

# Initialize speech recognizer
recognizer = sr.Recognizer()
recognizer.energy_threshold = 120
recognizer.pause_threshold = 0.8
recognizer.dynamic_energy_threshold = True
recognizer.dynamic_energy_adjustment_damping = 0.15

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
        if current_voice.startswith("gtts_") and gtts_available:
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

ESTA_SYSTEM_PROMPT = """You are ESTA AI, the flagship AI assistant built into Neo Browser.

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

9. **Browser Integration** — You are integrated into Neo Browser. You can help with: Web content explanation, Coding, Productivity, Writing, Research, File analysis, Image analysis, Study assistance.

10. **Safety** — Refuse unsafe or illegal requests politely. Never fabricate information. Prioritize user privacy.

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
    if personality or style:
        if not personality or personality not in PERSONALITY_STYLES:
            personality = DEFAULT_PERSONALITY
        if not style or style not in RESPONSE_STYLES:
            style = DEFAULT_STYLE
        return f"{ESTA_SYSTEM_PROMPT}\n\n{PERSONALITY_STYLES.get(personality, '')} {RESPONSE_STYLES.get(style, '')}"
    return ESTA_SYSTEM_PROMPT


def ask_ai(question, personality=None, style=None, page_context="", url=""):
    """Query Groq AI for response"""
    import traceback
    try:
        print(f"[AI] Calling Groq API with question: {question}")
        print(f"[AI] Using model: llama-3.1-8b-instant")
        print(f"[AI] API Key present: {bool(groq_api_key)}")
        print(f"[AI] URL: {url}")
        print(f"[AI] Page context length: {len(page_context)}")
        
        system_prompt = build_system_prompt(personality, style)
        user_message = question
        if url or page_context:
            ctx_parts = []
            if url:
                ctx_parts.append(f"User is currently on this website: {url}")
            if page_context:
                ctx_parts.append(f"Page content: {page_context[:2000]}")
            user_message = "\n\n".join(ctx_parts) + "\n\nUser question: " + question
        
        response = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message} 
            ],
            temperature=0.7,
            max_tokens=1024
        )
        if response.choices and response.choices[0].message and response.choices[0].message.content:
            result = response.choices[0].message.content.strip()
            print(f"[AI] SUCCESS: Got response ({len(result)} chars)")
            return result
        else:
            print("[AI] ERROR: Empty response from API")
            return "Sorry, no response from AI."
    except Exception as e:
        print(f"[AI] ERROR: {type(e).__name__}: {e}")
        print(f"[AI] Full traceback:\n{traceback.format_exc()}")
        return "Sorry, I could not answer that."

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
        result = eval(expression)
        return result
    except:
        return None

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
            model="llama-3.1-8b-instant",
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
        raw = (response.choices[0].message.content or "").strip()
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
            recognizer.adjust_for_ambient_noise(source, duration=1)
            audio = recognizer.listen(source, timeout=10, phrase_time_limit=7)
        
        query = recognizer.recognize_google(audio, language="en-US")
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


def handle_assistant_query(message, message_lower, personality=None, style=None, page_context="", url=""):
    """Handle general questions and web searches without running device commands."""
    if is_wake_phrase(message_lower):
        return get_wake_response()
    
    if any(keyword in message_lower for keyword in ["search", "find", "look up", "google"]):
        query = message_lower.replace("search", "").replace("find", "").replace("look up", "").replace("google", "").strip()
        if query:
            return web_search(query)
        return "What would you like me to search for?"
    
    if any(phrase in message_lower for phrase in ["what time", "what is the time", "what is the current time", "what's the time", "whats the time", "current time", "time now", "time is it", "tell me the time", "wht the time", "whats time"]):
        return get_time_text()
    
    if any(phrase in message_lower for phrase in ["what date", "what is the date", "what's the date", "todays date", "today's date", "current date", "date today"]):
        return get_date_text()
    
    return ask_ai(message, personality, style, page_context, url)


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
        
        print(f"[CHAT] Message: '{message}'")
        print(f"[CHAT] Mode: {mode}")
        print(f"[CHAT] Personality: {personality}, Style: {style}")
        print(f"[CHAT] URL: {url}")
        print(f"[CHAT] Page context length: {len(page_context)}")
        
        
        if not message:
            return jsonify({'error': 'Empty message'}), 400

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
            print("[CHAT] Processing as 'ask' mode")
            response_text = handle_command(message, message_lower)
            if not response_text:
                response_text = try_planned_automation(message)
            if not response_text:
                response_text = handle_assistant_query(message, message_lower, personality, style, page_context, url)
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
                response_text = handle_assistant_query(message, message_lower, personality, style, page_context, url)
        
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
        text = recognizer.recognize_google(audio_data, language=language)
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

        if not gTTS:
            return jsonify({"error": "gTTS not installed"}), 501

        if not voice_id.startswith("gtts_"):
            return jsonify({"error": "Selected voice is not a browser MP3 voice"}), 409

        # Keep responses small and snappy.
        if len(text) > 600:
            text = text[:600]

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

        if not groq_api_key:
            return jsonify({'response': '⚠️ AI vision not configured. No API key.'}), 200

        data_url = f'data:{mime_type};base64,{image_b64}'

        # Use direct REST API call (old groq client v0.4.x doesn't support multimodal)
        model = 'qwen/qwen3.6-27b'
        try:
            resp = requests.post(
                'https://api.groq.com/openai/v1/chat/completions',
                headers={
                    'Authorization': f'Bearer {groq_api_key}',
                    'Content-Type': 'application/json',
                },
                json={
                    'model': model,
                    'messages': [
                        {
                            'role': 'system',
                            'content': VISION_SYSTEM_PROMPT
                        },
                        {
                            'role': 'user',
                            'content': [
                                {'type': 'text', 'text': message},
                                {'type': 'image_url', 'image_url': {'url': data_url}}
                            ]
                        }
                    ],
                    'temperature': 0.3,
                    'max_tokens': 800,
                },
                timeout=30,
            )
            if resp.status_code == 200:
                result = resp.json()
                if result.get('choices') and result['choices'][0].get('message') and result['choices'][0]['message'].get('content'):
                    return jsonify({'response': _strip_html(result['choices'][0]['message']['content'])})
            return jsonify({'response': f'Vision model error: HTTP {resp.status_code}: {resp.text[:300]}'}), 200
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
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt}
            ],
            temperature=0.1,
            max_tokens=500
        )
        text = resp.choices[0].message.content.strip()
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

@app.route('/api/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({'status': 'ok', 'service': 'AI Voice Assistant'})

@app.route('/', methods=['GET'])
def index():
    return app.send_static_file('index.html')

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

VISION_SYSTEM_PROMPT = """You are ESTA Vision AI, the image understanding component of ESTA AI inside Neo Browser.

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
                    response = client.chat.completions.create(
                    model="qwen/qwen3.6-27b",
                    messages=[
                        {"role": "system", "content": "You are NEO Vision. Answer concisely about the image."},
                        {"role": "user", "content": [
                            {"type": "image_url", "image_url": {"url": f"data:{cached_mime};base64,{cached_base64}"}},
                            {"type": "text", "text": follow_up}
                        ]}
                    ],
                    temperature=0.3,
                    max_tokens=500
                    )
                    answer = _strip_html(response.choices[0].message.content)
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

        # Call Groq Vision API
        print(f"[VISION] Calling Groq vision API...")
        try:
            groq_response = client.chat.completions.create(
                model="qwen/qwen3.6-27b",
                messages=[
                    {"role": "system", "content": VISION_SYSTEM_PROMPT},
                    {"role": "user", "content": [
                        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                        {"type": "text", "text": "Analyze this image completely using the structured format."}
                    ]}
                ],
                temperature=0.3,
                max_tokens=1200
            )
        except Exception as e:
            return _vision_error(f'AI model request failed: {str(e)}')

        raw_analysis = _strip_html(groq_response.choices[0].message.content)
        print(f"[VISION] Groq response ({len(raw_analysis)} chars)")

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
                        print(f"[VISION][STREAM] AI request sent (follow-up)")
                        response = client.chat.completions.create(
                            model="qwen/qwen3.6-27b",
                            messages=[
                    {"role": "system", "content": VISION_SYSTEM_PROMPT},
                                {"role": "user", "content": [
                                    {"type": "image_url", "image_url": {"url": f"data:{cached_mime};base64,{cached_base64}"}},
                                    {"type": "text", "text": follow_up}
                                ]}
                            ],
                            temperature=0.3,
                            max_tokens=500
                        )
                        print(f"[VISION][STREAM] AI response received (follow-up)")
                        answer = _strip_html(response.choices[0].message.content)
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

            # Call Groq Vision API
            print(f"[VISION][STREAM] Image converted to Base64 ({len(b64)} chars)")
            print(f"[VISION][STREAM] AI request sent")
            try:
                groq_response = client.chat.completions.create(
                    model="qwen/qwen3.6-27b",
                    messages=[
                        {"role": "system", "content": VISION_SYSTEM_PROMPT},
                        {"role": "user", "content": [
                            {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                            {"type": "text", "text": "Analyze this image completely using the structured format."}
                        ]}
                    ],
                    temperature=0.3,
                    max_tokens=1200
                )
                print(f"[VISION][STREAM] AI response received")
            except Exception as e:
                print(f"[VISION][STREAM] AI request failed: {e}")
                yield sse_event('error', {'message': f'AI model request failed: {str(e)}'})
                yield sse_event('complete', {})
                return

            raw_analysis = _strip_html(groq_response.choices[0].message.content)

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

@app.route('/api/memory/save', methods=['POST'])
def memory_save():
    try:
        data = request.get_json(silent=True) or {}
        conv_id = data.get('id', datetime.datetime.now().strftime('%Y%m%d_%H%M%S'))
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
    conv_path = os.path.join(MEMORY_DIR, f'{conv_id}.json')
    if os.path.exists(conv_path):
        os.remove(conv_path)
    index = _load_memory_index()
    index = [c for c in index if c['id'] != conv_id]
    _save_memory_index(index)
    return jsonify({'success': True})

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
        results = []
        try:
            from duckduckgo_search import DDGS
            with DDGS() as ddgs:
                for i, r in enumerate(ddgs.text(query, max_results=5)):
                    results.append({
                        'title': r.get('title', ''),
                        'snippet': r.get('body', ''),
                        'url': r.get('href', '')
                    })
        except Exception as e:
            print(f"[WEB] DuckDuckGo search failed: {e}")
            # Fallback: use Groq knowledge
            pass

        # Summarize with AI
        if results:
            context = "\n\n".join(
                f"{i+1}. {r['title']}: {r['snippet']}"
                for i, r in enumerate(results)
            )
            summary_prompt = (
                f"Based on these search results for \"{query}\", provide a concise, informative summary.\n\n"
                f"Results:\n{context}\n\n"
                "Then list the key sources as bullet points with their titles."
            )
        else:
            summary_prompt = f"Provide a helpful answer about: {query}. Include relevant details and sources you know."

        try:
            groq_resp = client.chat.completions.create(
                model="llama-3.1-8b-instant",
                messages=[
                    {"role": "system", "content": "You are ESTA Web, the web research component of ESTA AI. Provide clear, well-structured answers with Markdown headings and bullet points. Cite sources when possible."},
                    {"role": "user", "content": summary_prompt}
                ],
                temperature=0.3,
                max_tokens=600
            )
            summary = groq_resp.choices[0].message.content.strip()
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

def _chunk_text(text, max_chars=1500, overlap=200):
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + max_chars, len(text))
        if end < len(text):
            last_period = text.rfind('. ', start, end)
            last_newline = text.rfind('\n', start, end)
            split_at = max(last_period, last_newline)
            if split_at > start:
                end = split_at + 1
        chunks.append(text[start:end].strip())
        start = end - overlap
        if start < 0:
            start = 0
    return chunks

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

        doc_id = hashlib.md5(f"{filename}_{time.time()}".encode()).hexdigest()[:12]
        save_path = os.path.join(DOCS_DIR, f'{doc_id}{ext}')
        file.save(save_path)

        text = ""
        if ext == '.pdf':
            text = _extract_text_from_pdf(save_path)
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
        question = data.get('question', '').strip()
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
        q_words = set(question.lower().split())
        scored = []
        for i, chunk in enumerate(chunks):
            c_words = set(chunk.lower().split())
            overlap = len(q_words & c_words)
            scored.append((overlap, i, chunk))
        scored.sort(key=lambda x: -x[0])
        top_chunks = scored[:3]
        context = "\n\n---\n\n".join(c for _, _, c in top_chunks)

        system = (
            f"You are ESTA Docs, the document analysis component of ESTA AI. Analyzing \"{filename}\". "
            "Answer based ONLY on the provided document context. "
            "If the document doesn't contain the answer, say so clearly. "
            "Use Markdown formatting."
        )
        user = f"Document context:\n\n{context}\n\nQuestion: {question}"

        groq_resp = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user}
            ],
            temperature=0.2,
            max_tokens=500
        )
        answer = groq_resp.choices[0].message.content.strip()

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
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": description}
            ],
            temperature=0.2,
            max_tokens=1500
        )
        raw = groq_resp.choices[0].message.content.strip()

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

        # Sanitize filename
        filename = re.sub(r'[^\w\.\-]', '_', filename)
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
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": AGENT_TOOLS_DESC},
                {"role": "user", "content": task}
            ],
            temperature=0.1,
            max_tokens=1000
        )
        raw = groq_resp.choices[0].message.content.strip()
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
                model="llama-3.1-8b-instant",
                messages=[{"role": "system", "content": f"Generate {lang} code only, no explanations."}, {"role": "user", "content": desc}],
                temperature=0.2, max_tokens=1000
            )
            code = groq_resp.choices[0].message.content.strip()
            return jsonify({'success': True, 'result': f'```{lang}\n{code}\n```', 'tool': tool})

        elif tool == 'browse':
            url = params.get('url', '')
            import webbrowser
            webbrowser.open(url)
            return jsonify({'success': True, 'result': f'Opened {url}', 'tool': tool})

        elif tool == 'ask_ai':
            question = params.get('question', '')
            groq_resp = client.chat.completions.create(
                model="llama-3.1-8b-instant",
                messages=[{"role": "user", "content": question}],
                temperature=0.3, max_tokens=500
            )
            answer = groq_resp.choices[0].message.content.strip()
            return jsonify({'success': True, 'result': answer, 'tool': tool})

        elif tool == 'calculate':
            expr = params.get('expression', '')
            try:
                result = str(eval(expr, {"__builtins__": {}}, {}))
            except:
                result = f"Cannot calculate: {expr}"
            return jsonify({'success': True, 'result': result, 'tool': tool})

        elif tool == 'summarize':
            text = params.get('text', '')
            groq_resp = client.chat.completions.create(
                model="llama-3.1-8b-instant",
                messages=[{"role": "system", "content": "Summarize in 2-3 sentences."}, {"role": "user", "content": text[:2000]}],
                temperature=0.3, max_tokens=200
            )
            summary = groq_resp.choices[0].message.content.strip()
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
        temp_path = os.path.join(EDITOR_DIR, f'temp_{int(time.time())}_{file.filename}')
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
        target_format = request.form.get('format', 'mp4')
        extract_audio = request.form.get('extract_audio', 'false') == 'true'

        temp_in = os.path.join(EDITOR_DIR, f'in_{int(time.time())}_{file.filename}')
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

LEETCODE_SYSTEM_PROMPT = """You are ESTA LeetCode Assistant, an AI coding tutor inside Neo Browser.

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
            model="llama-3.1-8b-instant",
            messages=[{"role":"system","content":LEETCODE_SYSTEM_PROMPT},{"role":"user","content":prompt}],
            temperature=0.3, max_tokens=1200
        )
        text = resp.choices[0].message.content.strip()
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
            model="llama-3.1-8b-instant",
            messages=[{"role":"system","content":LEETCODE_SYSTEM_PROMPT + " For hint levels 1-4, NEVER give the full solution. Only give the full solution at level 5."},{"role":"user","content":prompt}],
            temperature=0.4, max_tokens=600
        )
        text = resp.choices[0].message.content.strip()
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
            model="llama-3.1-8b-instant",
            messages=[{"role":"system","content":LEETCODE_SYSTEM_PROMPT},{"role":"user","content":prompt}],
            temperature=0.3, max_tokens=800
        )
        text = resp.choices[0].message.content.strip()
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
            model="llama-3.1-8b-instant",
            messages=[{"role":"system","content":"You are a complexity analysis expert. Analyze Big O precisely."},{"role":"user","content":prompt}],
            temperature=0.2, max_tokens=600
        )
        text = resp.choices[0].message.content.strip()
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
            model="llama-3.1-8b-instant",
            messages=[{"role":"system","content":"You are an algorithm pattern recognition expert."},{"role":"user","content":prompt}],
            temperature=0.3, max_tokens=500
        )
        text = resp.choices[0].message.content.strip()
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
            model="llama-3.1-8b-instant",
            messages=[{"role":"system","content":"You are a senior FAANG technical interviewer. Ask sharp, insightful follow-up questions."},{"role":"user","content":prompt}],
            temperature=0.6, max_tokens=800
        )
        text = resp.choices[0].message.content.strip()
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
            model="llama-3.1-8b-instant",
            messages=[{"role":"system","content":"You generate concise, structured LeetCode learning notes."},{"role":"user","content":prompt}],
            temperature=0.3, max_tokens=600
        )
        text = resp.choices[0].message.content.strip()
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
            model="llama-3.1-8b-instant",
            messages=[{"role":"system","content":"You explain programming errors in clear, beginner-friendly language."},{"role":"user","content":prompt}],
            temperature=0.3, max_tokens=500
        )
        text = resp.choices[0].message.content.strip()
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
            model="llama-3.1-8b-instant",
            messages=[{"role":"system","content":"You recommend LeetCode problems based on pattern, difficulty, and learning progression."},{"role":"user","content":prompt}],
            temperature=0.4, max_tokens=600
        )
        text = resp.choices[0].message.content.strip()
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
        messages = [{"role":"system","content":"You are ESTA Code Tutor, an expert programming assistant inside Neo Browser. You help users understand coding problems, write solutions, debug code, and learn algorithms. Provide clear explanations with examples. Use Markdown formatting with code blocks. Be encouraging and thorough."}]
        for h in history[-6:]:
            messages.append({"role": h.get('role', 'user'), "content": h.get('content', '')})
        messages.append({"role": "user", "content": message})
        resp = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=messages,
            temperature=0.5, max_tokens=1024
        )
        text = resp.choices[0].message.content.strip()
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
            model="llama-3.1-8b-instant",
            messages=[{"role":"system","content":"You compare coding solutions fairly and educationally."},{"role":"user","content":prompt}],
            temperature=0.3, max_tokens=700
        )
        text = resp.choices[0].message.content.strip()
        return jsonify({'success': True, 'comparison': text})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


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
    print(f"[APP] Starting NEO Browser AI backend on http://127.0.0.1:5000")
    sys.stdout.flush()
    app.run(host='127.0.0.1', port=5000, debug=True, use_reloader=False)
