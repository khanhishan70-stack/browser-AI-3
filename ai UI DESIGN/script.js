// ===== CONFIG =====
const API_BASE_URL = window.location.origin && window.location.origin !== 'null'
  ? `${window.location.origin}/api`
  : 'http://127.0.0.1:5000/api';
const BACKEND_URL = window.location.origin && window.location.origin !== 'null'
  ? window.location.origin
  : 'http://127.0.0.1:5000';

// ===== DOM ELEMENTS =====
const chatForm = document.getElementById('chatForm');
const userInput = document.getElementById('userInput');
const chatMessages = document.getElementById('chatMessages');
const suggestionBtn = document.getElementById('suggestionBtn');
const voiceModeBtn = document.getElementById('voiceModeBtn');
const speakerBtn = document.getElementById('speakerBtn');
const stopVoiceBtn = document.getElementById('stopVoiceBtn');
const micBtn = document.getElementById('micBtn');
const voiceIndicator = document.getElementById('voiceIndicator');
const voiceSelect = document.getElementById('voiceSelect');
const phoneSearchForm = document.getElementById('phoneSearchForm');
const phoneNumberInput = document.getElementById('phoneNumberInput');
const askModeBtn = document.getElementById('askModeBtn');
const commandModeBtn = document.getElementById('commandModeBtn');
const commandStrip = document.getElementById('commandStrip');
const assistantVisual = document.getElementById('assistantVisual');
const assistantVisualStatus = document.querySelector('.assistant-visual-status');

// Security features are disabled in this build.

// ===== STATE =====
let voiceModeEnabled = false;
let voiceOutputEnabled = true;
let isRecording = false;
let recognition = null;
let estaActivated = false;
let estaAwaitingCommand = false;
let voiceListenSession = 0;
let voiceRestartTimer = null;
let assistantMode = 'ask';
let consecutiveVoiceMisses = 0;
let ttsAudio = null;

const samplePrompts = [
  'What is the current time?',
  'What is today\'s date?',
  'Calculate 2 plus 2',
  'Open Google',
  'Open WhatsApp',
  'Open my file notes.txt',
  'Type hello world',
  'Press enter',
  'Move mouse to center',
  'Move mouse to 400, 300',
  'Animate mouse',
  'Open ChatGPT',
  'Open Spotify',
  'Lock my PC',
  'Search for AI news',
  'Find my phone',
  'Call my mom',
  'Find information about machine learning',
];

// ===== COMMAND/SEARCH DETECTION =====
function isCommand(message) {
  const commandKeywords = ['lock', 'shutdown', 'save browser', 'load browser', 'restore browser', 'open browser', 'message mom', 'message my mom', 'call my mom', 'call mom', 'call mother', 'phone mom', 'find my phone', 'ring my phone', 'type ', 'press ', 'double click', 'scroll', 'robot', 'automate', 'shortcut', 'hotkey', 'move mouse', 'move cursor', 'drag mouse', 'animate mouse', 'wake cursor', 'wake mouse', 'show mouse', 'cursor wave'];
  const text = message.toLowerCase();
  return commandKeywords.some(keyword => text.includes(keyword));
}

function isSearchQuery(message) {
  const searchKeywords = ['search', 'find', 'look up', 'what is', 'who is', 'how to', 'tell me about', 'information about', 'google'];
  const text = message.toLowerCase();
  return searchKeywords.some(keyword => text.includes(keyword));
}

function isDirectCommand(message) {
  const text = message.toLowerCase().trim();
  return /^(open|call|phone|message|lock|shutdown|shut down|refresh|save|load|restore|calculate|type|write|press|click|scroll|robot|automate|move|drag|animate|wake)\b/.test(text)
    || text.includes('call my mom')
    || text.includes('call mom')
    || text.includes('message mom')
    || text.includes('ring my phone')
    || text.includes('find my phone')
    || /^(double\s*click|mouse\s+click)\b/.test(text);
}

// ===== CHECK BACKEND CONNECTION =====
async function checkBackendConnection() {
  try {
    const response = await fetch(`${API_BASE_URL}/health`);
    if (response.ok) {
      console.log('Backend connected successfully');
      return true;
    }
  } catch (error) {
    console.error('Backend connection failed:', error);
    showSystemMessage('Backend not connected. Make sure Python server is running on port 5000');
    return false;
  }
}

// ===== MESSAGE FUNCTIONS =====
function addMessage(content, role) {
  const messageElement = document.createElement('div');
  messageElement.className = `message ${role}-message`;
  messageElement.innerHTML = `
    <span class="message-role">${role === 'user' ? 'You' : 'Assistant'}</span>
    <p>${content}</p>
  `;
  chatMessages.appendChild(messageElement);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showSystemMessage(text) {
  const messageElement = document.createElement('div');
  messageElement.className = 'message system-message';
  messageElement.innerHTML = `<p>${text}</p>`;
  chatMessages.appendChild(messageElement);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addBotReply(text, shouldSpeak = true) {
  addMessage(text, 'bot');
  if (shouldSpeak && (voiceOutputEnabled || voiceModeEnabled)) {
    speakText(text);
  }
}

async function addSpokenBotReply(text) {
  addBotReply(text, false);
  if (voiceOutputEnabled || voiceModeEnabled) {
    await speakText(text);
    await waitForSpeechToFinish();
    await wait(400);
  }
}

function setVoiceOutputEnabled(enabled, showMessage = true) {
  voiceOutputEnabled = enabled;
  speakerBtn.classList.toggle('active', voiceOutputEnabled);
  console.log('Voice Output:', voiceOutputEnabled ? 'ON' : 'OFF');
  if (showMessage) {
    showSystemMessage(voiceOutputEnabled ? 'Voice Output ON' : 'Voice Output OFF');
  }
}

function setAssistantMode(mode, showMessage = true) {
  assistantMode = mode === 'command' ? 'command' : 'ask';
  const isCommandMode = assistantMode === 'command';

  askModeBtn.classList.toggle('active', !isCommandMode);
  commandModeBtn.classList.toggle('active', isCommandMode);
  commandStrip.hidden = !isCommandMode;
  userInput.placeholder = isCommandMode
    ? 'Type a command like call my mom, open WhatsApp, or lock my PC...'
    : 'Ask a question or search the web...';

  if (showMessage) {
    showSystemMessage(isCommandMode
      ? 'Command Activation mode is active.'
      : 'Ask/Search mode is active.');
  }
}

// ===== API FUNCTIONS =====
async function sendChat(message, mode = assistantMode) {
  try {
    const response = await fetch(`${API_BASE_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: message,
        mode: mode
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data.response || 'No response received';
  } catch (error) {
    console.error('Chat error:', error);
    return `Error: ${error.message}`;
  }
}

async function speakText(text) {
  if (assistantVisual) {
    setAssistantVisualState('speaking', 'Speaking...');
  }

  try {
    const selectedVoiceId = voiceSelect?.value || '';
    const selectedLabel = (voiceSelect?.selectedOptions?.[0]?.textContent || '').toLowerCase();

    // Prefer MP3-from-backend playback. This is the most reliable across embedded browsers.
    if (!selectedVoiceId || selectedVoiceId.startsWith('gtts_')) {
      const ttsResp = await fetch(`${API_BASE_URL}/voice/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice_id: selectedVoiceId })
      });
      if (ttsResp.ok) {
        const blob = await ttsResp.blob();
        const url = URL.createObjectURL(blob);
        if (ttsAudio) {
          try { ttsAudio.pause(); } catch (_) {}
        }
        ttsAudio = new Audio(url);
        ttsAudio.onended = () => {
          try { URL.revokeObjectURL(url); } catch (_) {}
        };
        await ttsAudio.play().catch((err) => {
          console.error('Audio play blocked:', err);
          showSystemMessage('Audio is blocked by the browser. Click anywhere on the page once, then try again.');
        });
        return;
      }
    }

    if (selectedVoiceId && !selectedVoiceId.startsWith('gtts_')) {
      const localResp = await fetch(`${API_BASE_URL}/voice/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (localResp.ok) {
        return;
      }
    }

    // Next: browser-native TTS (may be unavailable in embedded contexts).
    if ('speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined') {
      try { window.speechSynthesis.cancel(); } catch (_) {}

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US';

      const voices = window.speechSynthesis.getVoices ? window.speechSynthesis.getVoices() : [];
      if (voices && voices.length) {
        const preferFemale = selectedLabel.includes('female') || selectedLabel.includes('zira') || selectedLabel.includes('aria');
        const preferMale = selectedLabel.includes('male') || selectedLabel.includes('david');
        const match = voices.find(v => v.lang?.toLowerCase().startsWith('en') && (
          (preferFemale && (v.name || '').toLowerCase().includes('zira')) ||
          (preferMale && (v.name || '').toLowerCase().includes('david'))
        )) || voices.find(v => v.lang?.toLowerCase().startsWith('en'));
        if (match) utterance.voice = match;
      }

      await new Promise((resolve) => {
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        window.speechSynthesis.speak(utterance);
      });
      return;
    }

    // Last fallback: ask the backend to speak locally.
    await fetch(`${API_BASE_URL}/voice/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text })
    });
  } catch (error) {
    console.error('Speak error:', error);
  } finally {
    if (assistantVisual && !assistantVisual.classList.contains('listening')) {
      await waitForSpeechToFinish();
    }
  }
}

function findPhoneLocation(phoneNumber) {
  const sanitizedNumber = phoneNumber.replace(/[^0-9+]/g, '');
  if (!sanitizedNumber || sanitizedNumber.replace(/\D/g, '').length < 7) {
    addBotReply('Please enter a valid phone number.' , false);
    return;
  }

  const query = `phone number location ${encodeURIComponent(sanitizedNumber)}`;
  const searchUrl = `https://www.google.com/search?q=${query}`;
  window.open(searchUrl, '_blank');
  addBotReply(`Opening Google search for ${sanitizedNumber}.`, false);
}

async function stopVoice() {
  try {
    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch (_) {}
    }
    if (ttsAudio) {
      try { ttsAudio.pause(); } catch (_) {}
      ttsAudio = null;
    }
    await fetch(`${API_BASE_URL}/voice/stop`, {
      method: 'POST'
    });
  } catch (error) {
    console.error('Stop voice error:', error);
  }
}

async function loadVoices() {
  try {
    const response = await fetch(`${API_BASE_URL}/voice/voices`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    
    // Clear existing options
    voiceSelect.innerHTML = '';
    
    // Add available voices
    data.voices.forEach(voice => {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = voice.name;
      if (voice.id === data.current) {
        option.selected = true;
      }
      voiceSelect.appendChild(option);
    });
  } catch (error) {
    console.error('Load voices error:', error);
  }
}

async function setVoice(voiceId) {
  try {
    const response = await fetch(`${API_BASE_URL}/voice/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice_id: voiceId })
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    console.log('Voice set to:', voiceId);
  } catch (error) {
    console.error('Set voice error:', error);
  }
}

async function listenVoice() {
  // Prefer browser-native speech recognition (more reliable than Python mic deps on Windows).
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    return await new Promise((resolve) => {
      const rec = new SpeechRecognition();
      rec.lang = 'en-US';
      rec.interimResults = false;
      rec.maxAlternatives = 1;

      let settled = false;
      let lastError = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try { rec.stop(); } catch (_) {}
        resolve(value || '');
      };

      rec.onresult = (event) => {
        const transcript = event?.results?.[0]?.[0]?.transcript || '';
        finish(transcript.toLowerCase());
      };

      rec.onerror = (event) => {
        lastError = event?.error || 'unknown';
        console.error('Web Speech error:', lastError, event);
        // If the browser service is unreachable, fall back to WAV->backend transcription.
        if (lastError === 'network') {
          finish('__FALLBACK_WAV__');
          return;
        }
        showSystemMessage(`Microphone error: ${lastError}`);
        finish('');
      };

      rec.onnomatch = () => finish('');
      rec.onend = () => finish('');

      try {
        rec.start();
      } catch (e) {
        console.error('Web Speech start failed:', e);
        finish('');
      }
    });
  }

  try {
    const response = await fetch(`${API_BASE_URL}/voice/listen`, {
      method: 'POST'
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    if (data && data.status === 'error' && data.error) {
      showSystemMessage(`Microphone error: ${data.error}`);
    }
    return data.transcription || '';
  } catch (error) {
    console.error('Listen error:', error);
    return '';
  }
}

function encodeWavFromFloat32(float32Samples, sampleRate) {
  // 16-bit PCM mono WAV
  const numSamples = float32Samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  let offset = 0;

  const writeString = (s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    offset += s.length;
  };

  writeString('RIFF');
  view.setUint32(offset, 36 + numSamples * 2, true); offset += 4;
  writeString('WAVE');
  writeString('fmt ');
  view.setUint32(offset, 16, true); offset += 4;      // Subchunk1Size
  view.setUint16(offset, 1, true); offset += 2;       // PCM
  view.setUint16(offset, 1, true); offset += 2;       // Mono
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, sampleRate * 2, true); offset += 4; // ByteRate
  view.setUint16(offset, 2, true); offset += 2;       // BlockAlign
  view.setUint16(offset, 16, true); offset += 2;      // BitsPerSample
  writeString('data');
  view.setUint32(offset, numSamples * 2, true); offset += 4;

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, float32Samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

async function recordWavAndTranscribe(durationMs = 3500) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  const chunks = [];

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
  };

  source.connect(processor);
  processor.connect(audioCtx.destination);

  await wait(durationMs);

  processor.disconnect();
  source.disconnect();
  stream.getTracks().forEach(t => t.stop());

  const sampleRate = audioCtx.sampleRate;
  await audioCtx.close();

  const totalLength = chunks.reduce((sum, arr) => sum + arr.length, 0);
  const merged = new Float32Array(totalLength);
  let pos = 0;
  for (const arr of chunks) { merged.set(arr, pos); pos += arr.length; }

  const wavBlob = encodeWavFromFloat32(merged, sampleRate);

  const resp = await fetch(`${API_BASE_URL}/voice/transcribe?sample_rate=${sampleRate}&sample_width=2&lang=en-US`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: await wavBlob.arrayBuffer(),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.status === 'error') {
    showSystemMessage(`Microphone error: ${data.error || 'transcription_failed'}`);
    return '';
  }
  return (data.transcription || '').toLowerCase();
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function setAssistantVisualState(state, message) {
  if (!assistantVisual) return;
  assistantVisual.classList.remove('listening', 'speaking', 'active');
  if (state) {
    assistantVisual.classList.add(state, 'active');
  }
  if (assistantVisualStatus) {
    assistantVisualStatus.textContent = message || (state === 'listening' ? 'Listening...' : state === 'speaking' ? 'Speaking...' : 'Ready');
  }
}

function clearAssistantVisualState() {
  if (!assistantVisual) return;
  assistantVisual.classList.remove('listening', 'speaking', 'active');
  if (assistantVisualStatus) {
    assistantVisualStatus.textContent = 'Ready';
  }
}

async function waitForSpeechToFinish(timeout = 12000) {
  const startedAt = Date.now();
  await wait(250);

  while (Date.now() - startedAt < timeout) {
    try {
      const response = await fetch(`${API_BASE_URL}/voice/status`);
      if (response.ok) {
        const data = await response.json();
        if (!data.speaking) {
          if (assistantVisual && !assistantVisual.classList.contains('listening')) {
            clearAssistantVisualState();
          }
          return;
        }
      }
    } catch (error) {
      console.error('Voice status error:', error);
      if (assistantVisual && !assistantVisual.classList.contains('listening')) {
        clearAssistantVisualState();
      }
      return;
    }
    await wait(250);
  }
  if (assistantVisual && !assistantVisual.classList.contains('listening')) {
    clearAssistantVisualState();
  }
}

// ===== WAKE WORD DETECTION =====
function detectWakeWord(transcription) {
  if (!transcription) return false;
  const text = transcription.toUpperCase().trim();
  return text.includes('HELLO ESTA') || text.includes('HI ESTA') || text.includes('HEY ESTA') || text === 'ESTA' || /^ESTA[.!?,;:\s]*$/.test(text);
}

async function activateEsta() {
  estaActivated = true;
  estaAwaitingCommand = true;
  const statusDiv = document.getElementById('estaStatus');
  if (statusDiv) {
    statusDiv.textContent = 'ESTA Active - Ready for command';
    statusDiv.classList.add('active');
  }
  if (headerTextSizeEl) headerTextSizeEl.hidden = false;
  await addSpokenBotReply('Hello! I am ESTA. How can I help you?');
}

function deactivateEsta() {
  estaActivated = false;
  estaAwaitingCommand = false;
  const statusDiv = document.getElementById('estaStatus');
  if (statusDiv) {
    statusDiv.textContent = 'Say "HELLO ESTA" to activate';
    statusDiv.classList.remove('active');
  }
  if (headerTextSizeEl) headerTextSizeEl.hidden = true;
}

async function submitCurrentPrompt() {
  const prompt = userInput.value.trim();
  if (!prompt) return;

  addMessage(prompt, 'user');
  userInput.value = '';

  if (detectWakeWord(prompt)) {
    await activateEsta();
    return;
  }

  const requestMode = isDirectCommand(prompt) ? 'command' : assistantMode;

  addBotReply('Processing...', false);

  try {
    const response = await sendChat(prompt, requestMode);
    const lastReply = document.querySelector('.bot-message:last-of-type');
    if (lastReply) {
      lastReply.querySelector('p').textContent = response;
    }
    if (voiceOutputEnabled || voiceModeEnabled) {
      await speakText(response);
      await waitForSpeechToFinish();
      await wait(400);
    }
  } catch (error) {
    console.error('Error:', error);
    const lastReply = document.querySelector('.bot-message:last-of-type');
    if (lastReply) {
      lastReply.querySelector('p').textContent = 'Error: ' + error.message;
    }
  }
}

// ===== VOICE RECOGNITION (BACKEND) =====
function scheduleNextVoiceListen(delay = 900) {
  if (!voiceModeEnabled) return;

  clearTimeout(voiceRestartTimer);
  voiceRestartTimer = setTimeout(() => {
    if (voiceModeEnabled && !isRecording) {
      startVoiceRecording();
    }
  }, delay);
}
    
async function startVoiceRecording() {
  if (isRecording) return;

  const sessionId = ++voiceListenSession;
  isRecording = true;
  micBtn.classList.add('recording');
  voiceIndicator.classList.add('active');
  if (assistantVisual) {
    setAssistantVisualState('listening', 'Listening...');
  }

  try {
    if (!voiceModeEnabled) {
      showSystemMessage('Listening...');
    }
    let transcription = await listenVoice();
    if (transcription === '__FALLBACK_WAV__') {
      showSystemMessage('Speech service blocked. Using audio fallback...');
      transcription = await recordWavAndTranscribe(3500);
    }

    if (sessionId !== voiceListenSession) {
      return;
    }

    if (transcription && !transcription.includes('error') && !transcription.includes('didn\'t')) {
      consecutiveVoiceMisses = 0;
      if (detectWakeWord(transcription)) {
        stopVoiceRecording(voiceModeEnabled);
        await activateEsta();
        scheduleNextVoiceListen();
        return;
      }

      if (voiceModeEnabled) {
        estaActivated = true;
        estaAwaitingCommand = true;
      }

      if (estaAwaitingCommand) {
        userInput.value = transcription;

        if (!voiceModeEnabled) {
          if (isCommand(transcription)) {
            speakText(`Executing command: ${transcription}`);
          } else if (isSearchQuery(transcription)) {
            speakText(`Searching for: ${transcription}`);
          } else {
            speakText(`Processing: ${transcription}`);
          }
        }

        if (!voiceModeEnabled) {
          estaAwaitingCommand = false;
        }
        stopVoiceRecording(voiceModeEnabled);
        await submitCurrentPrompt();

        if (voiceModeEnabled) {
          estaActivated = true;
          estaAwaitingCommand = true;
          scheduleNextVoiceListen();
        } else {
          deactivateEsta();
        }
        return;
      }

      userInput.value = transcription;
      stopVoiceRecording(voiceModeEnabled);
      if (voiceModeEnabled) {
        await submitCurrentPrompt();
        scheduleNextVoiceListen();
      }
    } else {
      consecutiveVoiceMisses += 1;
      if (!voiceModeEnabled || consecutiveVoiceMisses % 3 === 1) {
        showSystemMessage('Could not understand. Please try again.');
      }
      stopVoiceRecording(voiceModeEnabled);
      scheduleNextVoiceListen(voiceModeEnabled ? 1200 : 700);
    }
  } catch (error) {
    console.error('Voice recording error:', error);
    showSystemMessage('Microphone error: ' + error.message);
    stopVoiceRecording(false);
    scheduleNextVoiceListen(1200);
  }
}

function stopVoiceRecording(keepVisualActive = false) {
  isRecording = false;
  if (!keepVisualActive) {
    micBtn.classList.remove('recording');
    voiceIndicator.classList.remove('active');
    if (assistantVisual) {
      clearAssistantVisualState();
    }
  }
}

// Security features are disabled in this build.

// ===== EVENT LISTENERS =====

// Voice mode toggle
voiceModeBtn.addEventListener('click', async () => {
  voiceModeEnabled = !voiceModeEnabled;
  voiceModeBtn.classList.toggle('active', voiceModeEnabled);
  console.log('Voice Mode:', voiceModeEnabled ? 'ON' : 'OFF');
  showSystemMessage(voiceModeEnabled ? 'Voice Mode ON - continuous listening started' : 'Voice Mode OFF - chat mode active');

  if (voiceModeEnabled) {
    setAssistantMode('command', false);
    setVoiceOutputEnabled(true, false);
    estaActivated = true;
    estaAwaitingCommand = true;
    const statusDiv = document.getElementById('estaStatus');
    if (statusDiv) {
      statusDiv.textContent = 'ESTA Active - Continuous voice mode';
      statusDiv.classList.add('active');
    }
    await speakText('Voice command mode is active.');
    await waitForSpeechToFinish();
    scheduleNextVoiceListen(100);
  } else {
    clearTimeout(voiceRestartTimer);
    voiceListenSession++;
    deactivateEsta();
    stopVoiceRecording();
  }
});

askModeBtn.addEventListener('click', () => {
  setAssistantMode('ask');
});

commandModeBtn.addEventListener('click', () => {
  setAssistantMode('command');
});

document.querySelectorAll('.command-chip').forEach((button) => {
  button.addEventListener('click', () => {
    setAssistantMode('command', false);
    userInput.value = button.dataset.command || '';
    userInput.focus();
  });
});

// Voice output toggle
speakerBtn.addEventListener('click', () => {
  setVoiceOutputEnabled(!voiceOutputEnabled);
});

// Stop voice button
stopVoiceBtn.addEventListener('click', async () => {
  await stopVoice();
  showSystemMessage('Voice output stopped');
});

// Microphone button
micBtn.addEventListener('click', (e) => {
  e.preventDefault();
  if (!isRecording) {
    startVoiceRecording();
  } else {
    voiceListenSession++;
    stopVoiceRecording();
  }
});

// Chat form submission
chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await submitCurrentPrompt();
});

// Suggestion button
suggestionBtn.addEventListener('click', () => {
  setAssistantMode('ask', false);
  const prompt = samplePrompts[Math.floor(Math.random() * samplePrompts.length)];
  userInput.value = prompt;
  userInput.focus();
});

// Voice selector
voiceSelect.addEventListener('change', async (e) => {
  const selectedVoice = e.target.value;
  await setVoice(selectedVoice);
});

if (phoneSearchForm) {
  phoneSearchForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const phoneNumber = phoneNumberInput.value.trim();
    if (!phoneNumber) return;

    addMessage(phoneNumber, 'user');
    phoneNumberInput.value = '';
    addBotReply('Looking up that phone number...', false);
    await findPhoneLocation(phoneNumber);
  });
}

// ===== TEXT SIZE CONTROL =====
const textSizeBtns = document.querySelectorAll('.size-btn');
const headerTextSizeEl = document.getElementById('headerTextSize');
const headerSizeBtns = document.querySelectorAll('.header-size-btn');
function setTextSize(size) {
  document.body.setAttribute('data-text-size', size);
  localStorage.setItem('esta-text-size', size);
  textSizeBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === size);
  });
  headerSizeBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === size);
  });
}
textSizeBtns.forEach(btn => {
  btn.addEventListener('click', () => setTextSize(btn.dataset.size));
});
headerSizeBtns.forEach(btn => {
  btn.addEventListener('click', () => setTextSize(btn.dataset.size));
});
const savedSize = localStorage.getItem('esta-text-size') || 'medium';
setTextSize(savedSize);

// ===== INITIALIZATION =====
document.addEventListener('DOMContentLoaded', async () => {
  console.log('ESTA AI Assistant UI loaded');
  setAssistantMode('ask', false);
  setVoiceOutputEnabled(true, false);
  const connected = await checkBackendConnection();
  if (connected) {
    await loadVoices(); // Load available voices
    showSystemMessage('ESTA is ready! Say "HELLO ESTA" to activate, then give your command.');
    speakText('ESTA is online and ready. Say Hello ESTA to get started with commands or searches.');
  }
});
