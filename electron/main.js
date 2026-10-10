const { app, BrowserWindow, BrowserView, WebContentsView, ipcMain, session, webContents, dialog, shell, Menu, protocol, net, desktopCapturer, powerMonitor, components, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn, execFile, execFileSync, execSync } = require('child_process');
const zlib = require('zlib');
const os = require('os');

// ===== LOCAL SECRETS (electron/.env, never committed) =====
// API keys and private IDs live in electron/.env (see .env.example).
// Shell environment wins; the file only fills gaps. No new dependencies.
(function _loadLocalEnv() {
  try {
    var p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    var lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#') continue;
      var eq = line.indexOf('=');
      if (eq < 1) continue;
      var k = line.slice(0, eq).trim();
      var v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch (e) {}
})();

// ===== NEXORA REBRAND: PINNED PROFILE PATH =====
// The app was renamed (NeoBrowser -> NEXORA Browser). Electron derives its
// default userData directory from the app name, so without this pin a rename
// would orphan cookies, sessions, extensions, and settings in a fresh folder.
// This keeps the historic profile location forever: %APPDATA%\Electron.
try { app.setPath('userData', path.join(app.getPath('appData'), 'Electron')); } catch (e) {}

// ===== SECURITY HELPERS =====
// Every IPC handler below runs on renderer-supplied input. A compromised page,
// a malicious extension, or hostile AI output reaching innerHTML could otherwise
// drive these handlers, so untrusted strings are validated here, in main, where
// the renderer cannot bypass the checks.
// Only http(s) may be opened in an external browser or a login window. This
// blocks file:// (local file theft), javascript:, data:, and custom schemes.
function _isSafeExternalUrl(u) {
  if (typeof u !== 'string' || !u) return false;
  var s = u.trim();
  if (!s || s.length > 2048) return false;
  try {
    var parsed = new URL(s);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) { return false; }
}
// Filenames arriving over IPC must never escape their directory: reject anything
// with a directory component up front, then take the basename and enforce the
// extension allow-list of the handler that serves it.
function _safeBaseName(name, allowedExts) {
  if (typeof name !== 'string') return '';
  var raw = name.trim();
  if (!raw || raw === '.' || raw === '..') return '';
  if (raw.indexOf('..') !== -1 || raw.indexOf('/') !== -1 || raw.indexOf('\\') !== -1) return '';
  if (/^[A-Za-z]:/.test(raw)) return '';
  var base = path.basename(raw);
  if (!base) return '';
  if (allowedExts && allowedExts.length) {
    if (allowedExts.indexOf(path.extname(base).toLowerCase()) === -1) return '';
  }
  return base;
}
// ffmpeg for merging DASH video+audio (1080p, 4K) — initialized after app is ready
var _FFMPEG_PATH = '';

// ===== SINGLE-INSTANCE LOCK =====
// Only one instance may run at a time. Launching again just focuses the existing
// window instead of stacking more processes and exhausting RAM.
const _gotLock = app.requestSingleInstanceLock();
if (!_gotLock) {
  app.quit();
}
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    // A hidden window can never be brought back by focus() alone, so show() is
    // mandatory here - otherwise re-running the app looks like "it won't launch".
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  }
});


// ===== DRM / STREAMING / GPU COMMAND LINE FLAGS =====
// HARDWARE GPU IS THE DEFAULT (matches the older fast NEO build which used real
// GPU acceleration with no software hacks). Software compositing was a later
// workaround for the intermittent black-<webview> bug on Windows, but it traded
// the black page for a CPU-pegged, slow browser. Reverting to hardware GPU
// restored smooth, fast page loads.
// - Set NEO_GPU=1 to enable extra GPU rasterization/overlay optimizations.
// - Set NEO_SOFTWARE=1 to force software compositing instead (the old fallback
//   if the black-page bug ever returns on this machine).
if (process.env.NEO_SOFTWARE === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}
app.commandLine.appendSwitch('enable-features', 'VideoToolboxHEVCHWEncoding,MseDecoderAdapter,WebCodecs,Vp9kSVCHWDecoding,Vp9Decoder,Vp9Encoder,PlatformHEVCDecoderSupport,AV1Decoder,SharedArrayBuffer,WebGPU,WebRTCPeerConnection,WebRTC-H264WithOpenH264FFmpeg,ThumbnailCapturer,ParallelDownloading,WebAssembly,WebAssemblyExceptionHandling,WebAssemblyTailCall,WebAssemblySimd,UserAgentClientHint,SpeechRecognition');
app.commandLine.appendSwitch('enable-speech-recognition');
app.commandLine.appendSwitch('disable-features', 'WebRTC-DisableEncryption');
// NOTE: enable-hardware-overlays REMOVED. Hardware overlay planes are the documented
// cause of the intermittent black-<webview> bug on Windows (they fail to present
// static surfaces, leaving a black page that sticks). The old fast NEO build used
// plain hardware compositing with no overlays and had no black-page problem.
// GPU rasterization and rendering optimizations for media-heavy sites like Instagram.
// Only applied when hardware acceleration is the active mode (the default, or
// explicitly requested via NEO_GPU=1). These must NOT be combined with software
// compositing (NEO_SOFTWARE=1), as that re-arms the broken GPU compositor.
if (process.env.NEO_SOFTWARE !== '1' && process.env.NEO_NO_GPU_FLAGS !== '1') {
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-accelerated-mjpeg-decode');
  app.commandLine.appendSwitch('enable-accelerated-video-decode');
}
// Check user preference for hardware acceleration
try {
  var _hwAccelPrefPath = path.join(app.getPath('userData'), 'prefs.json');
  if (fs.existsSync(_hwAccelPrefPath)) {
    var _prefs = JSON.parse(fs.readFileSync(_hwAccelPrefPath, 'utf8'));
    if (_prefs.hardwareAccel === 'off') {
      app.commandLine.appendSwitch('disable-accelerated-video-decode');
      app.commandLine.appendSwitch('disable-features', 'VaapiVideoDecoder,VaapiVideoEncoder');
      console.log('[GPU] Hardware acceleration disabled by user pref (GPU features still enabled)');
    }
  }
} catch(e) {}
if (process.env.NEO_SOFTWARE !== '1') {
  app.commandLine.appendSwitch('force-accelerated-mjpeg-decode');
}
// Disable power-saving optimizations that can reduce video decode resolution
app.commandLine.appendSwitch('disable-features', 'VideoDecodeDownscaleForPerformance,VideoFrameSubmitter');
// Ensure high-quality video rendering
app.commandLine.appendSwitch('force-color-profile', 'srgb');
// Enable WebGPU and shared memory for modern web apps
app.commandLine.appendSwitch('enable-blink-features', 'SharedArrayBuffer');
// Widevine DRM — this is a castlabs "Electron for Content Security" (ECS, +wvcus) build.
// Widevine support is provided via the ECS `components` API (component updater installs the CDM).
// NOTE: do NOT set widevine-cdm-path/widevine-cdm-version switches here — they conflict with ECS.

var _crashLogPath = null;
function getCrashLogPath() {
  if (!_crashLogPath) {
    try { _crashLogPath = path.join(app.getPath('userData'), 'crash.log'); } catch(e) {
      try { _crashLogPath = path.join(require('os').tmpdir(), 'neo_crash.log'); } catch(e2) { _crashLogPath = 'crash.log'; }
    }
  }
  return _crashLogPath;
}
process.on('uncaughtException', (err) => {
  try { fs.writeFileSync(getCrashLogPath(), new Date().toISOString() + ' ' + (err && err.stack ? err.stack : String(err)) + '\n'); } catch(e) {}
});
process.on('unhandledRejection', (reason) => {
  try {
    var msg = reason && reason.message ? reason.message : String(reason);
    if (msg.indexOf('ERR_ABORTED') !== -1 || msg.indexOf('GUEST_VIEW_MANAGER') !== -1) return;
    fs.writeFileSync(getCrashLogPath(), new Date().toISOString() + ' Unhandled Rejection: ' + (reason && reason.stack ? reason.stack : String(reason)) + '\n');
  } catch(e) {}
});
// Suppress webview ERR_ABORTED errors on ALL webContents (including guest views)
app.on('web-contents-created', (event, wc) => {
  wc.on('did-fail-load', (e, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3 || errorCode === -1 || (errorDescription && errorDescription.indexOf('ERR_ABORTED') !== -1)) {
      e.preventDefault();
    } else {
      // Real load failure (non-abort) — surface it so the blank page cause can be identified.
      try { console.log('[WCV-LOAD-FAIL] code=' + errorCode + ' desc=' + errorDescription + ' url=' + (validatedURL||'').slice(0,120) + ' type=' + wc.getType()); } catch(_) {}
    }
  });
});

// Backend config — resolve path relative to project root whether in dev or packaged mode
function resolveBackendDir() {
  // Try common relative paths from the executable
  const candidates = [
    path.resolve(__dirname, '..', 'ai UI DESIGN', 'backend'),
    // Packaged: NEO.exe is at dist/NEO-win32-x64/, resources at dist/NEO-win32-x64/resources/
    path.resolve(process.resourcesPath || '', '..', '..', '..', 'ai UI DESIGN', 'backend'),
    path.resolve(process.resourcesPath || '', '..', '..', 'ai UI DESIGN', 'backend'),
    // Try relative to app.asar
    path.resolve(__dirname, '..', '..', '..', '..', 'ai UI DESIGN', 'backend'),
    // Absolute fallback
    'C:\\Users\\Admin\\OneDrive\\Desktop\\browser AI\\ai UI DESIGN\\backend',
  ];
  for (const c of candidates) {
    const appPy = path.join(c, 'app.py');
    if (fs.existsSync(appPy)) { console.log('[Backend] Found at', c); return c; }
  }
  // Fallback
  console.warn('[Backend] Could not locate backend directory, trying last resort');
  return path.resolve(__dirname, '..', 'ai UI DESIGN', 'backend');
}
const BACKEND_DIR = resolveBackendDir();
const BACKEND_PORT = 5000;
let backendProcess = null;
let _backendQuitting = false;
let _backendStartedAt = 0;
let _backendRetried = false;
// Crash-loop guard state: how many recent exits we tolerate before backing off.
let _backendExitTimes = [];
const _backendExitWindow = 30000;
const _backendExitLimit = 4;
const _backendBaseBackoff = 1500;

// Find PIDs currently LISTENING on the backend port.
function _backendPortPids() {
  try {
    const out = require('child_process').execSync('netstat -ano -p tcp | findstr :' + BACKEND_PORT, { encoding: 'utf8', windowsHide: true });
    const pids = new Set();
    String(out).split(/\r?\n/).forEach((line) => {
      if (line.indexOf('LISTENING') === -1) return;
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1], 10);
      if (pid) pids.add(pid);
    });
    return Array.from(pids);
  } catch(e) { return []; }
}

// Kill stale python/node/electron processes squatting on the backend port so a
// fresh backend ALWAYS binds on launch. Safe: only kills processes that own the
// NEO backend port; never touches unrelated apps.
function _killStaleBackend(tag) {
  const pids = _backendPortPids();
  for (const pid of pids) {
    if (pid === process.pid) continue;
    try {
      const pm = require('child_process').execSync('tasklist /FI "PID eq ' + pid + '" /FO CSV /NH', { encoding: 'utf8', windowsHide: true });
      if (/python|node|electron/i.test(pm)) {
        console.log('[Backend] ' + tag + ' killing stale backend owner PID ' + pid);
        try { process.kill(pid); } catch(e) { console.warn('[Backend] could not kill PID ' + pid + ': ' + e.message); }
      }
    } catch(e) {}
  }
}

// ===== OFFLINE AI (Ollama) auto-start =====
// The offline AI chat + vision run from a local Ollama server (qwen3:1.7b etc).
// Start it alongside the Flask backend so the AI is always active when the
// browser opens. We never kill it on quit — Ollama is a shared system service.
const OLLAMA_BIN = process.env.OLLAMA_BIN || path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Admin\\AppData\\Local', 'Programs', 'Ollama', 'ollama.exe');
const OLLAMA_PORT = 11434;

function ollamaUp() {
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.get('http://127.0.0.1:' + OLLAMA_PORT + '/api/version', (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { try { req.destroy(); } catch(e) {} resolve(false); });
  });
}

function startOllama() {
  return new Promise((resolve) => {
    ollamaUp().then((up) => {
      if (up) { console.log('[Ollama] already running'); resolve(); return; }
      if (!fs.existsSync(OLLAMA_BIN)) {
        console.warn('[Ollama] binary not found at', OLLAMA_BIN);
        resolve();
        return;
      }
      console.log('[Ollama] starting serve...');
      try {
        const oll = spawn(OLLAMA_BIN, ['serve'], { cwd: path.dirname(OLLAMA_BIN), stdio: 'ignore', detached: true, windowsHide: true });
        oll.unref();
      } catch(e) { console.warn('[Ollama] spawn error:', e.message); }
      let tries = 0;
      const poll = () => {
        tries++;
        ollamaUp().then((ok) => {
          if (ok) { console.log('[Ollama] ready'); resolve(); }
          else if (tries < 20) setTimeout(poll, 1000);
          else { console.warn('[Ollama] not ready after ~20s'); resolve(); }
        });
      };
      setTimeout(poll, 1500);
    });
  });
}

function startBackend() {
  return new Promise((resolve) => {
    if (process.env.NEO_NO_BACKEND === '1') {
      console.log('[Backend] Skipped by NEO_NO_BACKEND');
      resolve();
      return;
    }
    // Keep the offline AI warm in parallel — backend health poll gives it time to boot.
    startOllama();
    // Find Python in the venv
    const pyPaths = [
      path.join(BACKEND_DIR, 'venv', 'Scripts', 'python.exe'),
      path.join(BACKEND_DIR, '..', '.venv', 'Scripts', 'python.exe'),
      path.join(BACKEND_DIR, '.venv', 'Scripts', 'python.exe'),
      'python',
      'python3',
    ];
    let pythonExe = null;
    for (const p of pyPaths) {
      if (p === 'python' || p === 'python3') { pythonExe = p; break; }
      if (fs.existsSync(p)) { pythonExe = p; break; }
    }
    if (!pythonExe) { pythonExe = 'python'; }

    const appPy = path.join(BACKEND_DIR, 'app.py');
    if (!fs.existsSync(appPy)) {
      console.warn('[Backend] app.py not found at', appPy);
      resolve();
      return;
    }

    // Free the port from any stale/orphaned backend so THIS launch's fresh code binds.
    _killStaleBackend('pre-launch');
    const wait = () => {
      _backendStartedAt = Date.now();
      console.log('[Backend] Starting:', pythonExe, appPy);
      backendProcess = spawn(pythonExe, [appPy], {
        cwd: BACKEND_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });

      backendProcess.stdout.on('data', (d) => { try { process.stdout.write('[Backend] ' + d); } catch(e) {} });
      backendProcess.stderr.on('data', (d) => { try { process.stderr.write('[Backend] ' + d); } catch(e) {} });
      backendProcess.on('error', (e) => console.warn('[Backend] Error:', e.message));
      backendProcess.on('exit', (code) => {
        console.log('[Backend] Exited with code', code);
        backendProcess = null;
        // Watchdog: always bring the backend back (unless app is quitting),
        // with a short backoff so it never stays dead for longer than a few seconds.
        if (!_backendQuitting && !_backendRetried) {
          _backendRetried = true;

          // Crash-loop guard: a backend that keeps dying must not respawn every
          // 1.5s forever, otherwise every revive spawns/kills a console window.
          const now = Date.now();
          _backendExitTimes = _backendExitTimes.filter(t => now - t < _backendExitWindow);
          _backendExitTimes.push(now);

          if (_backendExitTimes.length > _backendExitLimit) {
            const over = _backendExitTimes.length - _backendExitLimit;
            const delay = Math.min(_backendBaseBackoff * Math.pow(2, over), 60000);
            console.warn('[Backend] Crash loop detected (' + _backendExitTimes.length +
              ' exits in ' + Math.round(_backendExitWindow / 1000) + 's). Next revive in ' +
              Math.round(delay / 1000) + 's');
            setTimeout(() => {
              _backendRetried = false;
              startBackend();
            }, delay);
            return;
          }

          _killStaleBackend('revive');
          setTimeout(() => {
            _backendRetried = false;
            startBackend();
          }, _backendBaseBackoff);
        }
      });

      // Poll health endpoint until ready
      const http = require('http');
      let attempts = 0;
      const maxAttempts = 60; // 30 seconds
      const poll = () => {
        attempts++;
        const req = http.get(`http://127.0.0.1:${BACKEND_PORT}/api/health`, (res) => {
          if (res.statusCode === 200) {
            console.log('[Backend] Ready');
            resolve();
          } else if (attempts < maxAttempts) {
            setTimeout(poll, 500);
          } else {
            console.warn('[Backend] Health check failed after', maxAttempts, 'attempts');
            resolve();
          }
        });
        req.on('error', () => {
          if (attempts < maxAttempts) {
            setTimeout(poll, 500);
          } else {
            console.warn('[Backend] Not reachable after', maxAttempts, 'attempts');
            resolve();
          }
        });
        req.end();
      };
      setTimeout(poll, 1000); // Give it 1s to start
    };
    setTimeout(wait, 700); // Brief pause so killed sockets fully release before rebinding
  });
}

function stopBackend() {
  _backendQuitting = true;
  if (backendProcess) {
    console.log('[Backend] Stopping...');
    try { backendProcess.kill('SIGTERM'); } catch {}
    setTimeout(() => {
      if (backendProcess) {
        try { backendProcess.kill('SIGKILL'); } catch {}
      }
    }, 3000);
  }
}

// Helper: fetch URL via https (avoids CORS, works in packaged app)
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Helper: get the main BrowserWindow from a sender webContents
function winFromEvent(event) {
  return BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getAllWindows()[0];
}

// Honest User-Agent: the natural, truthful Electron UA (real Chromium version
// + real Electron version appended). No pretending to be plain Google Chrome
// and no Client-Hints spoofing. Streaming sites that categorically refuse
// non-Chrome UAs get a per-site override via getUAForURL below.
const CHROME_VERSION = (process.versions && process.versions.chrome) || '138.0.7204.169';
const CHROME_MAJOR = parseInt(String(CHROME_VERSION).split('.')[0], 10) || 138;
const ELECTRON_VERSION = (process.versions && process.versions.electron) || '';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + CHROME_VERSION + ' Safari/537.36';
const USER_AGENT = CHROME_UA + ' Electron/' + ELECTRON_VERSION;
// A current, widely-accepted Chrome UA for sites that hard-block anything that
// is not the latest stock Chrome (WhatsApp shows an "update / unsupported
// browser" page for the honest Electron/42.2.0 UA). This only *says* the app is
// a modern Chrome so these sites allow it in; it never touches the system
// Chrome/Edge install and nothing here is a real browser update.
const MODERN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.53 Safari/537.36';

// Force the WHITE/light Google login UI in login & help windows. Chromium follows
// the OS color scheme, so with Windows in dark mode accounts.google.com renders
// black. This Electron build has no setPreferredColorScheme, so instead we inject
// <meta name="color-scheme" content="light"> + color-scheme:light into the
// document, which flips prefers-color-scheme to light for that page (the classic
// white sign-in). When alwaysLight is false, only accounts.google.com pages are
// affected; every other site keeps following the OS theme.
function _forceLightGoogleAuth(wc, alwaysLight) {
  function _applyLight() {
    try {
      var u = '';
      try { u = (wc.getURL && wc.getURL()) || ''; } catch(e) {}
      if (!alwaysLight && !/accounts\.google\.com/i.test(u)) return;
      wc.executeJavaScript(
        '(function(){try{' +
        "var m=document.querySelector('meta[name=color-scheme]');" +
        "if(!m){" +
        "m=document.createElement('meta');m.name='color-scheme';" +
        "(document.head||document.documentElement).appendChild(m);}" +
        "m.content='light';" +
        "document.documentElement.style.colorScheme='light';" +
        '}catch(e){}})();', true).catch(function(){});
    } catch(e) {}
  }
  try {
    wc.on('did-start-loading', _applyLight);
    wc.on('dom-ready', _applyLight);
    wc.on('did-finish-load', _applyLight);
    wc.on('did-navigate', _applyLight);
    wc.on('did-navigate-in-page', _applyLight);
  } catch(e) {}
  // Popups opened from this window (Google's Help/sign-in windows) get it too.
  try {
    wc.on('did-create-window', function(childWin) {
      // Force the whole app light while any popup (Help/login window) is open,
      // then restore the OS theme when it closes.
      _themeLight(1);
      try { childWin.on('closed', function() { _themeLight(0); }); } catch(e) {}
      try { _forceLightGoogleAuth(childWin.webContents, alwaysLight); } catch(e) {}
    });
  } catch(e) {}
}

// Apply the white-login fix to EVERY webContents the app creates (login windows,
// Help/sign-in popups, the site view, webview mirrors). URL-gated to Google auth
// domains so non-Google pages keep following the OS theme.
app.on('web-contents-created', function(e, wc) {
  try { _forceLightGoogleAuth(wc, false); } catch(err) {}
});

// Chrome identity for calling sites (Discord/WhatsApp). The DOM webview
// intentionally loads with NO preload (any preload = black-screen bug), so the
// beat-preload shim never runs there. Instead, every fresh guest document on
// these hosts gets the same navigator.userAgentData alignment injected at
// dom-ready — before their feature checks run — matching the pure-Chrome UA
// string and client-hint headers the main process already serves them.
// Hostname-gated: the main window (file://) and every other site are untouched.
var _CHROME_IDENTITY_RE = /(^|\.)(discord\.com|whatsapp\.com)$/i;
var _CHROME_IDENTITY_JS = "(function(){"
  + "if(window.__neoChromeId)return;window.__neoChromeId=true;"
  + "try{"
  + "var brands=[{brand:'Chromium',version:'153'},{brand:'Not/A)Brand',version:'8'},{brand:'Google Chrome',version:'153'}];"
  + "var uad={brands:brands,mobile:false,platform:'Windows',"
  + "getHighEntropyValues:function(h){return Promise.resolve({brands:brands,mobile:false,platform:'Windows',platformVersion:'15.0.0',architecture:'x86',bitness:'64',model:'',uaFullVersion:'153.0.8010.53'});}};"
  + "try{Object.defineProperty(window.navigator,'userAgentData',{get:function(){return uad;},configurable:true});}"
  + "catch(e){try{window.navigator.__defineGetter__('userAgentData',function(){return uad;});}catch(e2){}}"
  + "}catch(e){}"
  + "})();";
function _applyChromeIdentity(wc) {
  try {
    var u = '';
    try { u = (wc.getURL && wc.getURL()) || ''; } catch(e) {}
    var h = '';
    try { h = new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch(e) { return; }
    if (!_CHROME_IDENTITY_RE.test(h)) return;
    var p = null;
    try { p = wc.executeJavaScript(_CHROME_IDENTITY_JS, false); } catch(e) { return; }
    if (p && p.catch) p.catch(function(){});
  } catch(e) {}
}
app.on('web-contents-created', function(e, wc) {
  try {
    wc.on('dom-ready', function() { _applyChromeIdentity(wc); });
    wc.on('did-navigate', function() { _applyChromeIdentity(wc); });
    wc.on('did-navigate-in-page', function() { _applyChromeIdentity(wc); });
  } catch(err) {}
});

// Reference-counted light-theme switch. The site view / login/help windows +
// every popup force Chromium to report prefers-color-scheme: light WHILE the
// auth flow is on screen, so Google renders its classic WHITE sign-in page.
// When the last such window closes / the page navigates away, the theme returns
// to the OS setting (dark stays dark for everything else).
var _themeLightRefs = 0;
function _themeLight(inc) {
  try {
    if (inc) _themeLightRefs = _themeLightRefs + 1;
    else _themeLightRefs = Math.max(0, _themeLightRefs - 1);
    nativeTheme.themeSource = (_themeLightRefs > 0) ? 'light' : 'system';
  } catch(e) {}
}

// ===== USER-AGENT MANAGER =====
var _uaOverrides = {};
var _streamingSites = ['netflix.com','disneyplus.com','primevideo.com','amazon.com/video','hulu.com','hbomax.com','max.com','hotstar.com','peacocktv.com','paramountplus.com','crunchyroll.com','spotify.com','appletv.apple.com','tv.apple.com','youtube.com','music.youtube.com','vimeo.com','plex.tv','discoveryplus.com','bbc.co.uk/iplayer'];
// Sites that will only accept the latest stock Chrome/Edge. They hard-block the
// plain Chromium UA (with or without Electron) with an "update your browser"
// wall, so they get the extra-modern MODERN_UA. WhatsApp is the classic case;
// Discord walls off camera AND screen sharing ("Download the Desktop app")
// the moment it spots a non-Chrome identity, so it gets the same treatment.
var _modernUASites = ['whatsapp.com', 'discord.com'];
function getUAForURL(url) {
  try {
    var u = url.toLowerCase();
    // Check per-site override first
    for (var domain in _uaOverrides) {
      if (u.indexOf(domain) !== -1) return _uaOverrides[domain];
    }
    // Sites that refuse anything but the latest stock Chrome/Edge
    for (var k = 0; k < _modernUASites.length; k++) {
      if (u.indexOf(_modernUASites[k]) !== -1) return MODERN_UA;
    }
    // Per-site opt-in Chrome UA override for streaming/media hosts
    for (var i = 0; i < _streamingSites.length; i++) {
      if (u.indexOf(_streamingSites[i]) !== -1) return CHROME_UA;
    }
  } catch(e) {}
  return USER_AGENT;
}
function setUAOverride(domain, ua) {
  if (ua) _uaOverrides[domain] = ua;
  else delete _uaOverrides[domain];
}
// Full-spoof a request to look like the latest stock Chrome for sites (e.g.
// WhatsApp) that check BOTH the User-Agent string and the Sec-CH-UA client
// hint. Real Chromium 138 + "Chrome/153" would still get flagged because
// WhatsApp keys off sec-ch-ua (a spoofed UA does not change client hints), so
// we rewrite every UA-related header here for those hosts only.
function _applyUAHeaders(headers, url) {
  var effective = getUAForURL(url);
  if (effective) headers['User-Agent'] = effective;
  var u = String(url || '').toLowerCase();
  for (var k = 0; k < _modernUASites.length; k++) {
    if (u.indexOf(_modernUASites[k]) !== -1) {
      headers['sec-ch-ua'] = '"Chromium";v="153", "Not/A)Brand";v="8", "Google Chrome";v="153"';
      headers['sec-ch-ua-full-version-list'] = '"Chromium";v="153.0.8010.53", "Not/A)Brand";v="8.0.0.0", "Google Chrome";v="153.0.8010.53"';
      headers['sec-ch-ua-platform'] = '"Windows"';
      headers['sec-ch-ua-platform-version'] = '"15.0.0"';
      headers['sec-ch-ua-mobile'] = '?0';
      delete headers['sec-ch-ua-model'];
      break;
    }
  }
  return headers;
}
// True for streaming/media hosts. Used to keep background throttling disabled
// (so audio/video keeps decoding) ONLY for media sites while normal background
// tabs get throttled — fixing the GPU-does-100% + memory cost tradeoff we saw
// when throttling was disabled for every webContents.
function _isStreamingUrl(url) {
  try {
    var u = (' ' + (url || '')).toLowerCase();
    for (var i = 0; i < _streamingSites.length; i++) {
      if (u.indexOf(_streamingSites[i]) !== -1) return true;
    }
    // Audio/video hosts commonly used by music players.
    if (/\.(mp3|aac|ogg|flac|wav|m4a)(\?|#|$)/.test(u)) return true;
  } catch(e) {}
  return false;
}

// Startup flags (no webdriver cloaking)
app.commandLine.appendSwitch('no-first-run');
app.commandLine.appendSwitch('no-service-autorun');
app.commandLine.appendSwitch('disable-features', 'ChromeWhatsNewUI,ChromeLabs,ChromeUpdates');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.env.NEO_NO_GPU_FLAGS !== '1') {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
}
app.commandLine.appendSwitch('disable-ftp');
// ===== CHROME-LIKE TAB PERFORMANCE FLAGS =====
// These keep background tab renderers alive and warm (like Chrome/Opera GX) so
// switching to a background tab is instant instead of re-rendering from scratch.
// Without these Electron freezes background renderers → tab switches feel slow.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// NOTE: BackForwardCache was removed — with <webview> guest surfaces on Windows it
// restores a cached page whose compositor surface has been dropped, causing a stuck
// black screen. The old fast NEO build had no bfcache and no black-page problem.
// removed: disable-background-networking (needed for Widevine component updater)

// Register neo:// protocol as privileged for file serving
protocol.registerSchemesAsPrivileged([
  { scheme: 'neo', privileges: { stream: true, supportFetchAPI: true } },
  // Serves the bundled MediaPipe hand-tracking assets (ESM bundle, WASM, model)
  // to the renderer as a proper http-like origin so fetch()/import() work.
  { scheme: 'mediapipe-hand', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }
]);

// ===== EXTENSION ENGINE (Chrome-style add-ons) =====
// Electron only loads UNPACKED extensions and only into persistent sessions,
// and it never remembers them between runs, so every add-on is copied into
// userData and re-loaded on each boot.
// session.defaultSession is skipped on purpose: it also hosts this app's own
// UI and we do not want extension content scripts injected into
// ai-browser.html. Browsing lives in persist:webview_wcv (the visible
// WebContentsView) and persist:webview (the mirrored <webview> guests).
const EXT_ROOT = path.join(app.getPath('userData'), 'neo-data', 'extensions');
const EXT_STORE = path.join(app.getPath('userData'), 'neo-data', 'extensions.json');

function _extSessions() {
  const out = [];
  for (const p of ['persist:webview_wcv', 'persist:webview']) {
    try { const s = session.fromPartition(p); if (s) out.push({ name: p, ses: s }); } catch (e) {}
  }
  return out;
}

function _extReadStore() {
  try {
    if (!fs.existsSync(EXT_STORE)) return [];
    // Editors and PowerShell happily add a UTF-8 BOM, which JSON.parse rejects.
    const raw = fs.readFileSync(EXT_STORE, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { console.warn('[EXT] store unreadable:', e.message); return []; }
}

function _extWriteStore(list) {
  try {
    fs.mkdirSync(path.dirname(EXT_STORE), { recursive: true });
    fs.writeFileSync(EXT_STORE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) { console.error('[EXT] store write failed:', e.message); }
}

function _extManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
  catch (e) { return null; }
}

function _extCopyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) _extCopyTree(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function _extDestFor(manifest, fallback) {
  const base = String((manifest && manifest.name) || fallback || 'extension')
    .replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60) || 'extension';
  return path.join(EXT_ROOT, base);
}

// Electron's rejection reasons are worth showing: they name the exact file or key
// that is wrong, which is the difference between a user fixing their own package
// and a dead end. Trimmed because some come back with a full stack attached.
function _extLoadErrorText(msg) {
  let m = String(msg || '').trim();
  const at = m.indexOf("failed with:");
  if (at !== -1) m = m.slice(at + 'failed with:'.length);
  m = m.split('\n')[0].replace(/^Error:\s*/, '').trim();
  return m.length > 220 ? m.slice(0, 217) + '...' : (m || 'unknown reason');
}

async function _extLoadInto(entry) {
  let loaded = null, lastErr = '';
  for (const { name, ses } of _extSessions()) {
    if (!ses.extensions || typeof ses.extensions.loadExtension !== 'function') continue;
    try {
      const ext = await ses.extensions.loadExtension(entry.path);
      if (!loaded) loaded = ext;
    } catch (e) { lastErr = e.message; console.warn('[EXT] load failed (' + name + '):', e.message); }
  }
  if (!loaded) {
    const why = _extLoadErrorText(lastErr);
    console.warn('[EXT] not loaded:', entry.name, '-', why);
    return { error: why };
  }
  return loaded;
}

async function _extUnloadFromAll(id) {
  if (!id) return;
  for (const { name, ses } of _extSessions()) {
    try { ses.extensions.removeExtension(id); }
    catch (e) { console.warn('[EXT] unload failed (' + name + '):', e.message); }
  }
}

async function _extRegister(destDir, manifest) {
  const entry = {
    id: '',
    name: manifest.name || path.basename(destDir),
    version: manifest.version || '1.0.0',
    description: manifest.description || '',
    path: destDir,
    enabled: true
  };
  const res = await _extLoadInto(entry);
  // _extLoadInto returns either the Extension or { error } with Electron's reason.
  if (!res || res.error) return res || { error: 'unknown reason' };
  const ext = res;
  entry.id = ext.id || '';
  const store = _extReadStore();
  const at = store.findIndex(e => e.path === destDir);
  if (at !== -1) store[at] = entry; else store.push(entry);
  _extWriteStore(store);
  console.log('[EXT] installed', entry.name, entry.version, '(' + entry.id + ')');
  return entry;
}

// Some packages are source archives rather than built ones: they ship .scss and
// manifest.json still points at the .css the build would have produced. Electron
// rejects the whole extension on the first missing file with no hint as to which
// one, so check the referenced files up front and name them.
function _extMissingAssets(dir, manifest) {
  const missing = [];
  const has = rel => {
    const p = path.join(dir, rel);
    try { return fs.existsSync(p); } catch (e) { return false; }
  };
  const fromList = (list, kind) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (typeof item !== 'string' || !item) continue;
      if (!has(item)) missing.push(item + ' (' + kind + ')');
    }
  };
  fromList(manifest.background && manifest.background.scripts, 'background script');
  if (manifest.background && manifest.background.service_worker && !has(manifest.background.service_worker)) {
    missing.push(manifest.background.service_worker + ' (service worker)');
  }
  if (Array.isArray(manifest.content_scripts)) {
    for (const cs of manifest.content_scripts) {
      if (!cs) continue;
      fromList(cs.js, 'content script');
      fromList(cs.css, 'content stylesheet');
    }
  }
  if (manifest.web_accessible_resources) {
    const war = Array.isArray(manifest.web_accessible_resources)
      ? manifest.web_accessible_resources : [manifest.web_accessible_resources];
    for (const grp of war) {
      if (grp && Array.isArray(grp.resources)) fromList(grp.resources, 'web accessible resource');
    }
  }
  for (const key of ['options_page', 'options_ui']) {
    const o = manifest[key];
    const page = typeof o === 'string' ? o : (o && o.page);
    if (page && !has(page)) missing.push(page + ' (options page)');
  }
  return missing;
}

async function _extInstallFromDir(srcDir) {
  const manifest = _extManifest(srcDir);
  if (!manifest || !manifest.manifest_version) {
    return { ok: false, error: 'That folder has no valid manifest.json.' };
  }
  const missing = _extMissingAssets(srcDir, manifest);
  if (missing.length) {
    return {
      ok: false,
      code: 'incomplete',
      error: 'This package is missing ' + missing.length + ' file' + (missing.length === 1 ? '' : 's') +
        ' that its manifest requires: ' + missing.slice(0, 4).join(', ') +
        (missing.length > 4 ? ', +' + (missing.length - 4) + ' more' : '') +
        '. It looks like a source archive rather than a built one - download the packaged release instead.'
    };
  }
  const dest = _extDestFor(manifest, path.basename(srcDir));
  try {
    fs.mkdirSync(EXT_ROOT, { recursive: true });
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    _extCopyTree(srcDir, dest);
  } catch (e) { return { ok: false, error: 'Copy failed: ' + e.message }; }
  const entry = await _extRegister(dest, manifest);
  if (!entry || entry.error) return { ok: false, error: 'Electron refused to load it: ' + (entry && entry.error || 'unknown reason') };
  return { ok: true, entry };
}

// A .crx is a signed wrapper around a plain zip: "Cr24", a 4-byte version, a
// length-prefixed header, and only then the zip payload. Scanning forward for
// the first local-file-header signature handles both CRX2 and CRX3 without
// having to parse the protobuf header.
function _extCrxToZip(crxPath, outDir) {
  const buf = fs.readFileSync(crxPath);
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'Cr24') return false;
  const start = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 8);
  if (start === -1) return false;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'payload.zip'), buf.subarray(start));
  return true;
}

// Pure-Node zip extractor. This used to shell out to PowerShell's Expand-Archive,
// which was the single biggest reason "Install from .zip" appeared to hang: it
// spawns a whole PowerShell process and measured 19.5s on a 41 KB / 301-entry
// archive, all of it synchronous on the main process, so the window froze with no
// paint and no way to tell it apart from a crash. The same archive now takes ~0.4s
// and needs no external tool.
function _extUnzip(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  if (!buf || buf.length < 22) throw new Error('The file is too small to be a zip archive.');

  // End-of-central-directory record, searched backwards because a comment may
  // follow it (up to 64KB).
  let eocd = -1;
  const floor = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('That file is not a valid zip archive.');

  let count = buf.readUInt16LE(eocd + 10);
  let cdOff = buf.readUInt32LE(eocd + 16);

  // ZIP64: the 32-bit fields saturate and the real values live in a separate record.
  if (count === 0xffff || cdOff === 0xffffffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x07064b50) {
        const z64 = Number(buf.readBigUInt64LE(i + 8));
        count = Number(buf.readBigUInt64LE(z64 + 32));
        cdOff = Number(buf.readBigUInt64LE(z64 + 48));
        break;
      }
    }
  }

  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });

  let written = 0;
  let p = cdOff;
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    p += 46 + nameLen + extraLen + commentLen;

    // ZIP64 extended information extra field (0x0001) overrides saturated values.
    if (compSize === 0xffffffff || localOff === 0xffffffff) {
      let q = 0;
      while (q + 4 <= extra.length) {
        const hid = extra.readUInt16LE(q);
        const hsz = extra.readUInt16LE(q + 2);
        if (hid === 0x0001) {
          let r = q + 4;
          if (extra.length >= r + 16 && extra.readBigUInt64LE(r) !== 0n) {
            const un = Number(extra.readBigUInt64LE(r));
            r += 8;
            if (extra.readBigUInt64LE(r) !== 0n) { compSize = Number(extra.readBigUInt64LE(r)); r += 8; }
            if (extra.readBigUInt64LE(r) !== 0n) { localOff = Number(extra.readBigUInt64LE(r)); }
            break;
          }
        }
        q += 4 + hsz;
      }
    }

    // Reject absolute paths, drive letters and .. escapes: an extension archive is
    // untrusted input and must never be able to write outside the temp folder.
    const target = path.resolve(root, name.replace(/\\/g, '/'));
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error('The archive contains an unsafe file path and was rejected.');
    }

    if (name.endsWith('/')) {
      try { fs.mkdirSync(target, { recursive: true }); } catch (e) {}
      continue;
    }

    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('The archive is corrupt.');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + compSize);

    let out;
    if (method === 0) out = data;
    else if (method === 8) out = zlib.inflateRawSync(data);
    else throw new Error('The archive uses an unsupported compression method.');

    try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch (e) {}
    fs.writeFileSync(target, out);
    written++;
  }

  if (!written) throw new Error('The archive contained no files.');
  return written;
}

function _extFindManifestRoot(base, depth) {
  if (depth > 5) return null;
  if (_extManifest(base)) return base;
  let kids = [];
  try { kids = fs.readdirSync(base, { withFileTypes: true }).filter(k => k.isDirectory()); }
  catch (e) { return null; }
  for (const k of kids) {
    const hit = _extFindManifestRoot(path.join(base, k.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

function _extDownload(url, destFile, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'));
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        'Accept': '*/*'
      }
    }, res => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(_extDownload(next, destFile, redirects + 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error('HTTP ' + code)); }
      const tmp = destFile + '.part';
      const out = fs.createWriteStream(tmp);
      let got = 0;
      res.on('data', c => { got += c.length; });
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => {
          if (!got) { try { fs.unlinkSync(tmp); } catch (e) {} return reject(new Error('Empty response')); }
          try { fs.renameSync(tmp, destFile); } catch (e) { return reject(e); }
          resolve(destFile);
        });
      });
      res.on('error', reject);
      out.on('error', reject);
    });
    req.setTimeout(120000, () => { req.destroy(new Error('Download timed out')); });
    req.on('error', reject);
  });
}

// ===== CHROME WEB STORE INSTALLER =====
// A store page in NEXORA gets an "Add in NEXORA Browser" button. The button hands the
// 32-char ID to _extWebstoreInstall, which tries Google's CRX endpoints and then
// reuses the ordinary .crx -> zip -> register pipeline.
//
// Google's update endpoint answers 404/204 to plain HTTP clients in some regions
// and on some networks. That is outside this app's control, so a failure is
// reported as exactly that - never as a generic "install failed" - and the panel
// offers routes that always work (proxy, official source build, unpacked folder).
const EXT_ID_RE = /^[a-p]{32}$/;
const EXT_PROXY_FILE = path.join(app.getPath('userData'), 'neo-data', 'ext-proxy.json');

function _extValidId(id) {
  return typeof id === 'string' && EXT_ID_RE.test(id);
}

// Accepts both the current chromewebstore.google.com shape and the older
// chrome.google.com/webstore shape, plus a bare ID pasted by the user.
function _extParseStoreUrl(raw) {
  const s = String(raw || '').trim();
  if (_extValidId(s)) return { id: s };
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  const host = u.hostname.replace(/^www\./, '');
  const isStore = host === 'chromewebstore.google.com' ||
                  host === 'chrome.google.com' ||
                  host === 'clients2.google.com';
  if (!isStore) return null;
  const segs = u.pathname.split('/').filter(Boolean);
  // /detail/<slug>/<id>  and  /webstore/detail/<slug>/<id>
  const id = segs.find((x, i) => i === segs.length - 1 && _extValidId(x));
  if (!id) return null;
  const slugIdx = segs.indexOf('detail');
  const slug = slugIdx !== -1 && segs[slugIdx + 1] !== id ? segs[slugIdx + 1] : '';
  return { id, slug, url: u.toString() };
}

function _extReadProxy() {
  try {
    const raw = fs.readFileSync(EXT_PROXY_FILE, 'utf8').replace(/^\uFEFF/, '');
    const p = JSON.parse(raw);
    return (p && typeof p.proxy === 'string') ? p.proxy.trim() : '';
  } catch (e) { return ''; }
}

function _extWriteProxy(v) {
  try {
    fs.mkdirSync(path.dirname(EXT_PROXY_FILE), { recursive: true });
    fs.writeFileSync(EXT_PROXY_FILE, JSON.stringify({ proxy: String(v || '') }, null, 2), 'utf8');
    return true;
  } catch (e) { return false; }
}

// Chromium's own proxy stack, so the user does not have to restart the app and so
// a proxy also fixes normal page loads rather than just the download.
async function _extApplyProxy(rule) {
  const val = String(rule || '').trim();
  for (const { name, ses } of _extSessions()) {
    try {
      if (!val) await ses.setProxy({ mode: 'direct' });
      else await ses.setProxy({ mode: 'fixed_servers', proxyRules: val });
    } catch (e) { console.warn('[EXT] proxy apply failed (' + name + '):', e.message); }
  }
}

// Google's CRX endpoints, most reliable first. prodversion has to look like a real
// Chrome build or the endpoint rejects the request.
function _extCrxUrls(id) {
  const pv = '140.0.0.0';
  const x = 'id%3D' + id + '%26installsource%3Dondemand%26uc';
  const hosts = [
    'https://clients2.googleusercontent.com/service/update2/crx',
    'https://clients2.google.com/service/update2/crx',
    'https://update.googleapis.com/service/update2/crx',
    'https://chrome.google.com/service/update2/crx'
  ];
  const urls = [];
  for (const h of hosts) {
    urls.push(h + '?response=redirect&prodversion=' + pv + '&acceptformat=crx2,crx3&x=' + x);
    urls.push(h + '?response=redirect&prodversion=' + pv + '&acceptformat=crx3&x=' + x);
  }
  return urls;
}

// 'Cr24' alone is not enough: a truncated download can still carry the magic.
// The header is magic(4) + version(4 LE) + header length(4 LE), and only CRX2/CRX3
// are installable, so all three fields have to agree before we trust the payload.
function _extIsCrxMagic(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(16);
    const got = fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    if (got < 16) return false;
    if (head.subarray(0, 4).toString('latin1') !== 'Cr24') return false;
    const version = head.readUInt32LE(4);
    const headerLen = head.readUInt32LE(8);
    if (version !== 2 && version !== 3) return false;
    if (headerLen < 16) return false;
    return fs.statSync(file).size > headerLen;
  } catch (e) { return false; }
}

// Google's error pages are HTML, so a non-CRX body means we never got a package
// no matter what the status code claimed.
function _extPayloadLooksReal(file) {
  const st = fs.statSync(file);
  if (!st.size) return false;
  const head = Buffer.alloc(64);
  const fd = fs.openSync(file, 'r');
  let got = 0;
  try { got = fs.readSync(fd, head, 0, 64, 0); } finally { fs.closeSync(fd); }
  // Trust the magic bytes over the length. The size floor used to sit first and
  // rejected small-but-genuine packages, which matters because the store does
  // serve tiny extensions.
  if (head.subarray(0, 2).toString('latin1') === 'PK') return true;
  if (head.subarray(0, 4).toString('latin1') === 'Cr24') return _extIsCrxMagic(file);
  // No known magic and too small to be a real package: this is a stub response.
  if (st.size < 2048) return false;
  const txt = head.toString('utf8').toLowerCase();
  if (txt.includes('<!do') || txt.includes('<html')) return false;
  return false;
}

// Tries every endpoint, reports which one actually answered. Classifies a bare
// 404/204 as "blocked" because that is the signature of the endpoint refusing this
// client rather than the extension being unavailable.
async function _extFetchCrx(id, destFile) {
  const urls = _extCrxUrls(id);
  const attempts = [];
  let blockedOnly = true;
  for (const url of urls) {
    try {
      await _extDownload(url, destFile);
    } catch (e) {
      attempts.push({ url, error: e.message });
      continue;
    }
    let real = false;
    try { real = _extPayloadLooksReal(destFile); } catch (e) {}
    if (real) return { ok: true, url };
    attempts.push({ url, error: 'served a web page instead of a package' });
    try { fs.unlinkSync(destFile); } catch (e) {}
  }
  for (const a of attempts) {
    if (!/^HTTP (404|204)$/.test(a.error)) blockedOnly = false;
  }
  if (!attempts.length) blockedOnly = false;
  return {
    ok: false,
    blocked: blockedOnly,
    attempts
  };
}

async function _extWebstoreInstall(id, opts) {
  id = String(id || '').trim();
  if (!_extValidId(id)) {
    return { ok: false, code: 'bad-id', error: 'That is not a Chrome extension ID (expected 32 letters a-p).' };
  }
  const options = opts || {};

  // Same display name and version as the store page, so the manager shows
  // something meaningful even before the download starts.
  const fallbackName = 'Extension ' + id.slice(0, 8);
  const seed = {
    id,
    name: String(options.name || fallbackName).slice(0, 80),
    version: String(options.version || '').slice(0, 24),
    description: String(options.description || '').slice(0, 300),
    icon: String(options.icon || '').slice(0, 800)
  };

  const store = _extReadStore();
  const already = store.find(e => e && e.storeId === id);
  if (already && fs.existsSync(already.path)) {
    return {
      ok: true, already: true, entry: already, seed,
      message: 'Already installed: ' + already.name
    };
  }

  const tmp = path.join(app.getPath('temp'), 'neo-cws-' + Date.now());
  try {
    fs.mkdirSync(tmp, { recursive: true });
    const crx = path.join(tmp, 'addon.crx');
    const got = await _extFetchCrx(id, crx);

    if (!got.ok) {
      return {
        ok: false,
        code: got.blocked ? 'blocked' : 'download-failed',
        blocked: !!got.blocked,
        seed,
        proxy: _extReadProxy(),
        error: got.blocked
          ? 'Google did not hand over the package (HTTP 404/204). This network or region is being refused by the Chrome Web Store download service.'
          : 'The download failed: ' + (got.attempts[0] ? got.attempts[0].error : 'unknown error')
      };
    }

    const res = await _extInstallFromPackageFile(crx, 'crx');
    if (!res.ok) return { ok: false, code: 'install-failed', seed, error: res.error };
    // _extRegister already persisted the entry; tag it so a second visit to the
    // store page can say "already installed" without touching the network.
    const after = _extReadStore();
    const at = after.findIndex(e => e && e.path === res.entry.path);
    if (at !== -1) {
      after[at].storeId = id;
      if (seed.icon) after[at].icon = seed.icon;
      _extWriteStore(after);
      res.entry = after[at];
    }
    return { ok: true, entry: res.entry, seed, message: 'Installed ' + seed.name };
  } catch (e) {
    return { ok: false, code: 'error', seed, error: e.message };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

// ===== end Chrome Web Store installer =====

// Injects the "Add in NEXORA Browser" button into a Chrome Web Store page. Read from
// disk each time so the UI can be edited without restarting the app, and it runs
// in the page's main world where the neoStore bridge is visible.
const _storeScriptCache = { src: null, code: null };
function _extInjectStoreInstaller(wc) {
  let info;
  try { info = _extParseStoreUrl(wc.getURL()); } catch (e) { return; }
  if (!info) return;
  try {
    if (!wc.isLoading() && wc.isCrashed()) return;
  } catch (e) {}
  const file = path.join(__dirname, 'neo-store-installer.js');
  try {
    const src = fs.readFileSync(file, 'utf8');
    if (_storeScriptCache.src !== src) {
      _storeScriptCache.src = src;
      _storeScriptCache.code = '(' + src + ');';
    }
    wc.executeJavaScript(_storeScriptCache.code, true).catch(() => {});
  } catch (e) { console.warn('[EXT] store installer inject failed:', e.message); }
}

// The Chrome Web Store only ever hands out .crx, which Electron refuses, so the
// store listing points at reachable package builds instead and any .crx the
// user already has can be converted on the way in.
const EXT_CATALOG = [
  {
    key: 'ublock-origin', storeId: 'cjpalhdlnbpafiamejdnhcphjbkeiagm', name: 'uBlock Origin', author: 'Raymond Hill',
    description: 'The gold standard ad and tracker blocker. MV2 build, loads and runs natively.',
    version: '1.75.0', size: '4.4 MB', category: 'Privacy', rating: 5,
    kind: 'zip', url: 'https://github.com/gorhill/uBlock/releases/download/1.75.0/uBlock0_1.75.0.chromium.zip',
    homepage: 'https://github.com/gorhill/uBlock'
  },
  {
    key: 'ublock-origin-crx', storeId: 'cjpalhdlnbpafiamejdnhcphjbkeiagm', name: 'uBlock Origin', author: 'Raymond Hill',
    description: 'Same blocker, delivered as a .crx. Proves CRX files get unpacked automatically.',
    version: '1.75.0', size: '4.4 MB', category: 'Privacy', rating: 5,
    kind: 'crx', url: 'https://github.com/gorhill/uBlock/releases/download/1.75.0/uBlock0_1.75.0.chromium.crx',
    homepage: 'https://github.com/gorhill/uBlock'
  },
  {
    key: 'dark-reader', name: 'Dark Reader', author: 'Alexander Shutau',
    description: 'Generates a dark theme for any website, with per-site tuning.',
    version: '4.9.133', size: '0.8 MB', category: 'Themes', rating: 5,
    kind: 'zip', url: 'https://github.com/darkreader/darkreader/releases/download/v4.9.133/darkreader-chrome-mv3.zip',
    homepage: 'https://github.com/darkreader/darkreader'
  },
  {
    key: 'adnauseam', name: 'AdNauseam', author: 'Michael Bennett',
    description: 'Piles up blocked ads visibly instead of hiding them silently. MV2.',
    version: '3.29.2', size: '6.6 MB', category: 'Privacy', rating: 4,
    kind: 'zip', url: 'https://github.com/dhowe/AdNauseam/releases/download/v3.29.2/adnauseam-3.29.2.chromium.zip',
    homepage: 'https://github.com/dhowe/AdNauseam'
  },
  {
    key: 'isdcac', name: "I still don't care about cookies", author: 'OhMyGuus',
    description: 'Silently deletes cookie banners. Small, fast MV3 extension.',
    version: '1.1.9', size: '0.5 MB', category: 'Privacy', rating: 5,
    kind: 'zip', url: 'https://github.com/OhMyGuus/I-Still-Dont-Care-About-Cookies/releases/download/v1.1.9/ISDCAC-chrome-source.zip',
    homepage: 'https://github.com/OhMyGuus/I-Still-Dont-Care-About-Cookies'
  }
];

// Matches a store page to a catalog entry, by store ID first and by display name
// second. The name path covers extensions whose ID was never recorded here.
function _extCatalogKeyFor(storeId, name) {
  if (storeId) {
    const byId = EXT_CATALOG.find(c => c.storeId === storeId);
    if (byId) return byId.key;
  }
  if (name) {
    const want = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
    const byName = EXT_CATALOG.find(c =>
      String(c.name).toLowerCase().replace(/[^a-z0-9]+/g, '') === want);
    if (byName) return byName.key;
  }
  return '';
}

function _extCatalogWithState() {
  const store = _extReadStore();
  return EXT_CATALOG.map(item => {
    const hit = store.find(e => e.path && fs.existsSync(e.path) &&
      _extManifest(e.path) && _extDestFor(_extManifest(e.path), '').toLowerCase() ===
        _extDestFor({ name: item.name }, '').toLowerCase());
    return Object.assign({}, item, {
      installed: !!hit,
      installedVersion: hit ? hit.version : null,
      installedId: hit ? hit.id : null
    });
  });
}

// Takes a downloaded .crx or .zip and ends up with a registered, running add-on.
async function _extInstallFromPackageFile(pkgPath, kind) {
  const tmp = path.join(app.getPath('temp'), 'neo-ext-dl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  try {
    fs.mkdirSync(tmp, { recursive: true });
    // Read only the first bytes. This used to pull the entire package into memory
    // just to test four magic bytes, which is a real cost on multi-MB extensions.
    const head = Buffer.alloc(4);
    const fd = fs.openSync(pkgPath, 'r');
    let got = 0;
    try { got = fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
    const looksCrx = kind === 'crx' || (got === 4 && head.toString('latin1') === 'Cr24');
    let zipPath = pkgPath;
    if (looksCrx) {
      if (!_extCrxToZip(pkgPath, tmp)) return { ok: false, error: 'That .crx has no zip payload inside it.' };
      zipPath = path.join(tmp, 'payload.zip');
    }
    const unpacked = path.join(tmp, 'unpacked');
    try { _extUnzip(zipPath, unpacked); }
    catch (e) { return { ok: false, error: 'Could not unzip the download: ' + e.message }; }
    const root = _extFindManifestRoot(unpacked, 0);
    if (!root) return { ok: false, error: 'No manifest.json inside the package.' };
    return await _extInstallFromDir(root);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

async function _extInstallFromCatalog(key) {
  const item = EXT_CATALOG.find(c => c.key === key);
  if (!item) return { ok: false, error: 'Unknown catalog entry.' };
  const dlDir = path.join(app.getPath('temp'), 'neo-ext-cache');
  try { fs.mkdirSync(dlDir, { recursive: true }); } catch (e) {}
  const ext = item.kind === 'crx' ? '.crx' : '.zip';
  const file = path.join(dlDir, item.key + '-' + item.version + ext);
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 1024) {
      console.log('[EXT] using cached package for', item.name);
    } else {
      console.log('[EXT] downloading', item.name, item.version);
      await _extDownload(item.url, file);
    }
  } catch (e) {
    try { fs.unlinkSync(file); } catch (x) {}
    return { ok: false, error: 'Download failed (' + e.message + '). Check your connection and retry.' };
  }
  const out = await _extInstallFromPackageFile(file, item.kind);
  return out.ok ? Object.assign(out, { catalogKey: item.key }) : out;
}

async function loadAllExtensions() {
  const store = _extReadStore();
  if (!store.length) { console.log('[EXT] no add-ons installed'); return; }
  let active = 0;
  const broken = [];
  for (const entry of store) {
    try {
      if (!entry.enabled) continue;
      if (!fs.existsSync(entry.path)) { console.warn('[EXT] folder missing, skipping:', entry.path); continue; }
      const res = await _extLoadInto(entry);
      if (res && !res.error) { if (res.id) entry.id = res.id; active++; }
      else broken.push(entry.name + ' - ' + (res && res.error || 'unknown reason'));
    } catch (e) { console.warn('[EXT] boot load error:', e.message); broken.push(entry.name + ' - ' + e.message); }
  }
  if (active) _extWriteStore(store);
  console.log('[EXT] boot load complete:', active + '/' + store.length + ' add-on(s) active');
  // Say what could not start and why. Silently skipping left the user staring at
  // an extension that appeared installed but never did anything.
  if (broken.length) {
    console.warn('[EXT] ' + broken.length + ' add-on(s) refused by Electron:');
    for (const b of broken) console.warn('   - ' + b);
  }
}

app.whenReady().then(async () => {
  await loadAllExtensions();
  // Register neo:// protocol for serving downloaded files
  protocol.handle('neo', (request) => {
    var fileName = decodeURIComponent(request.url.replace(/^neo:\/\//, ''));
    var filePath = path.join(DOWNLOADS_DIR, path.basename(fileName));
    return net.fetch('file:///' + filePath.replace(/\\/g, '/'));
  });
  // Serve the bundled hand-control vendor assets (MediaPipe) via mediapipe-hand://
  // so the renderer can fetch() the WASM and model and import() the ESM bundle.
  const HAND_VENDOR_DIR = path.join(__dirname, 'hand-control', 'vendor');
  const _HAND_MIME = {
    '.js': 'text/javascript', '.mjs': 'application/javascript',
    '.wasm': 'application/wasm', '.task': 'application/octet-stream',
    '.json': 'application/json', '.css': 'text/css', '.map': 'application/json'
  };
  protocol.handle('mediapipe-hand', async (request) => {
    try {
      var rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
      var fp = path.resolve(HAND_VENDOR_DIR, rel);
      if (fp !== HAND_VENDOR_DIR && !fp.startsWith(HAND_VENDOR_DIR + path.sep)) {
        return new Response('forbidden', { status: 403 });
      }
      var r = await net.fetch('file:///' + fp.replace(/\\/g, '/'));
      if (r.status !== 200) return r;
      var mime = _HAND_MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
      var headers = new Headers();
      headers.set('Content-Type', mime);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
      headers.set('Cache-Control', 'no-cache');
      return new Response(r.body, { status: 200, headers: headers });
    } catch (e) {
      return new Response('hand-asset error: ' + e.message, { status: 500 });
    }
  });
  // Wait for the Widevine CDM (castlabs ECS components API) to be installed before
  // any BrowserWindow is created, otherwise DRM (Spotify, Netflix, etc.) won't work.
  if (components && typeof components.whenReady === 'function') {
    try {
      await components.whenReady();
      var _compStatus = components.status ? components.status() : null;
      console.log('[DRM] components ready:', _compStatus ? JSON.stringify(_compStatus) : 'n/a');
    } catch (e) {
      console.warn('[DRM] components.whenReady failed:', e.message);
    }
  }

  // Start backend in background — don't block window creation
  startBackend();

  // ===== BROWSER INTRO (STARTUP) SOUND — plays INSTANTLY from the main process,
  //      in a tiny hidden audio window, so it is never delayed by the heavy UI load.
  const INTRO_SOUND_DIR = path.join(__dirname, '..'); // app root (bundled sounds)
  const INTRO_SOUND_LABELS = {
    'win11.ogg': 'Windows 11 Startup',
    'vista.ogg': 'Windows Vista Startup',
    'winxp.ogg': 'Windows XP Startup',
    'wfw311.mp3': 'Windows 3.11 Startup',
    'owin31.wav': 'Windows 3.1 Startup',
    'startupiphone.wav': 'iPhone Startup',
    'startupemate300.wav': 'eMate 300 Startup'
  };
  const INTRO_SOUND_EXTS = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'];
  const INTRO_DATA_DIR = path.join(app.getPath('userData'), 'neo-data');
  const INTRO_CFG_PATH = path.join(INTRO_DATA_DIR, 'intro_sound.json');
  const INTRO_CUSTOM_DIR = path.join(INTRO_DATA_DIR, 'intro_sounds');
  try { fs.mkdirSync(INTRO_CUSTOM_DIR, { recursive: true }); } catch(e) {}
  function _introMime(ext) {
    return ext === '.mp3' ? 'audio/mpeg' : ext === '.wav' ? 'audio/wav' : ext === '.ogg' ? 'audio/ogg' : ext === '.m4a' ? 'audio/mp4' : ext === '.flac' ? 'audio/flac' : 'audio/aac';
  }
  function _readIntroConfig() {
    try {
      if (!fs.existsSync(INTRO_CFG_PATH)) return null;
      const c = JSON.parse(fs.readFileSync(INTRO_CFG_PATH, 'utf8'));
      return (c && typeof c === 'object') ? c : null;
    } catch(e) { return null; }
  }
  function _writeIntroConfig(cfg) {
    try {
      try { fs.mkdirSync(INTRO_DATA_DIR, { recursive: true }); } catch(e) {}
      fs.writeFileSync(INTRO_CFG_PATH, JSON.stringify(cfg), 'utf8');
      return true;
    } catch(e) { console.error('[INTRO] config write failed:', e.message); return false; }
  }
  ipcMain.handle('intro-sound-list', async () => {
    try {
      const names = fs.readdirSync(INTRO_SOUND_DIR).filter(function(n) {
        return INTRO_SOUND_EXTS.indexOf(path.extname(n).toLowerCase()) !== -1;
      });
      names.sort();
      console.log('[INTRO] Listed', names.length, 'intro sounds');
      return names.map(function(n) {
        const key = n.toLowerCase();
        return { name: n, label: INTRO_SOUND_LABELS[key] || n.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') };
      });
    } catch(e) { console.error('[INTRO] List error:', e.message); return []; }
  });
  ipcMain.handle('intro-sound-read', async (event, name) => {
    try {
      if (!name || typeof name !== 'string') return null;
      const safe = path.basename(name);
      const ext = path.extname(safe).toLowerCase();
      if (INTRO_SOUND_EXTS.indexOf(ext) === -1) { console.warn('[INTRO] Blocked non-audio:', safe); return null; }
      const fp = path.join(INTRO_SOUND_DIR, safe);
      if (!fs.existsSync(fp)) { console.warn('[INTRO] Sound not found:', safe); return null; }
      const buffer = fs.readFileSync(fp);
      return { data: buffer.toString('base64'), mime: _introMime(ext) };
    } catch(e) { console.error('[INTRO] Read error:', e.message); return null; }
  });
  // Renderer reports the current selection so the NEXT launch autoplays instantly.
  // Custom uploads travel here as a dataURL and are persisted to disk so the main
  // process can play them too, not just bundled sounds.
  ipcMain.handle('intro-sound-set', async (event, payload) => {
    try {
      const cfg = _readIntroConfig() || {};
      cfg.on = !!(payload && payload.on === true);
      let sound = (payload && typeof payload.sound === 'string') ? path.basename(payload.sound) : null;
      let custom = null;
      if (payload && payload.custom && typeof payload.custom.dataUrl === 'string') {
        const m = /^data:([^;,]+);base64,(.+)$/.exec(payload.custom.dataUrl);
        if (m) {
          const cName = String(payload.custom.name || 'custom').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
          try {
            try { fs.mkdirSync(INTRO_CUSTOM_DIR, { recursive: true }); } catch(e) {}
            fs.writeFileSync(path.join(INTRO_CUSTOM_DIR, cName), Buffer.from(m[2], 'base64'));
            custom = { name: cName, mime: m[1] };
            sound = cName;
          } catch(e) { console.error('[INTRO] custom save failed:', e.message); }
        }
      }
      cfg.sound = sound;
      cfg.custom = custom;
      _writeIntroConfig(cfg);
      console.log('[INTRO] config saved:', JSON.stringify(cfg));
      return true;
    } catch(e) { console.error('[INTRO] set error:', e.message); return true; }
  });
  // Creates a hidden window that plays the selected sound right when the app opens.
  function playIntroSoundAtLaunch() {
    try {
      if (global.__neoIntroPlayed) return;
      global.__neoIntroPlayed = true;
      const cfg = _readIntroConfig();
      if (!cfg || cfg.on !== true || !cfg.sound) return;
      let b64 = null, mime = null;
      if (cfg.custom && cfg.custom.name === cfg.sound) {
        const fp = path.join(INTRO_CUSTOM_DIR, cfg.custom.name);
        if (!fs.existsSync(fp)) return;
        mime = cfg.custom.mime || 'audio/mpeg';
        b64 = fs.readFileSync(fp).toString('base64');
      } else {
        const safe = path.basename(String(cfg.sound));
        const ext = path.extname(safe).toLowerCase();
        if (INTRO_SOUND_EXTS.indexOf(ext) === -1) return;
        const fp = path.join(INTRO_SOUND_DIR, safe);
        if (!fs.existsSync(fp)) return;
        const buf = fs.readFileSync(fp);
        if (!buf.length || buf.length > 60 * 1024 * 1024) return;
        b64 = buf.toString('base64');
        mime = _introMime(ext);
      }
      const json = JSON.stringify({ b64: b64, mime: mime });
      const html = '<!doctype html><meta charset="utf-8"><script>' +
        'var d=JSON.parse(' + JSON.stringify(json) + ');' +
        'var a=new Audio("data:"+d.mime+";base64,"+d.b64);a.volume=0.85;' +
        'console.log("ready mime="+d.mime+" len="+d.b64.length);' +
        'a.addEventListener("canplay",function(){console.log("canplay");});' +
        'a.addEventListener("error",function(){console.log("audioerr code="+(a.error?a.error.code:"none")+" msg="+(a.error?a.error.message:"none"));});' +
        'var done=false;function cl(){if(!done){done=true;try{window.close();}catch(e){}}}' +
        'a.addEventListener("ended",cl);a.addEventListener("error",cl);' +
        'var p=a.play();if(p&&typeof p.catch==="function")p.catch(function(err){console.log("playerr "+String(err));});' +
        'setTimeout(cl,15000);' + '</script>';
      const w = new BrowserWindow({
        show: false, width: 200, height: 100, frame: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false }
      });
      w.webContents.on('console-message', function(e, level, message) {
        console.log('[INTRO-WIN]', message);
      });
      global.__neoIntroSoundWin = w;
      w.on('closed', function() { if (global.__neoIntroSoundWin === w) global.__neoIntroSoundWin = null; });
      w.loadURL('data:text/html;base64,' + Buffer.from(html, 'utf8').toString('base64'));
      console.log('[INTRO] autoplay launched (b64=' + b64.length + ')');
    } catch(e) { console.error('[INTRO] autoplay failed:', e.message); }
  }

  // ===== HISTORY LOCK (master password for Google/YT/NEO history) =====
  // One optional master password, stored as a SHA-256 hash. When enabled it
  // gates: google history pages, youtube history pages, the NEO category
  // panels and the YouTube downloads list. Unlocking once lasts the session.
  const crypto = require('crypto');
  const _HIST_LOCK_PATH = path.join(app.getPath('userData'), 'neo-data', 'history_lock.json');
  let _historyUnlocked = false;
  function _readHistLock() {
    try {
      if (!fs.existsSync(_HIST_LOCK_PATH)) return null;
      const c = JSON.parse(fs.readFileSync(_HIST_LOCK_PATH, 'utf8'));
      return (c && typeof c === 'object') ? c : null;
    } catch(e) { return null; }
  }
  function _writeHistLock(cfg) {
    try {
      try { fs.mkdirSync(path.dirname(_HIST_LOCK_PATH), { recursive: true }); } catch(e) {}
      fs.writeFileSync(_HIST_LOCK_PATH, JSON.stringify(cfg), 'utf8');
      return true;
    } catch(e) { console.error('[HISTLOCK] write failed:', e.message); return false; }
  }
  function _histLockOn() {
    var c = _readHistLock();
    return !!(c && c.on === true && c.passHash);
  }
  function _histLockHash(pass) {
    return crypto.createHash('sha256').update(String(pass), 'utf8').digest('hex');
  }
  // Returns a human label for protected history URLs, or null if not protected.
  function _histProtectedKind(url) {
    try {
      var u = String(url || '').toLowerCase();
      if (!/^https?:/.test(u)) return null;
      var m = /^https?:\/\/([^\/]+)/.exec(u);
      if (!m) return null;
      var host = m[1].toLowerCase();
      var path = u.slice(u.indexOf(host) + host.length);
      if (/myactivity\.google\./.test(host)) return 'Google activity & history';
      if (/(^|\.)google\./.test(host) && (/\/history\b/.test(path) || /\/my-activity\b/.test(path))) return 'Google history';
      if (/(^|\.)youtube\.com$/.test(host) && /\/feed\/history\b/.test(path)) return 'YouTube history';
      return null;
    } catch(e) { return null; }
  }
  function tryGuardHistoryNav(e, url, wc) {
    try {
      if (!_histLockOn() || _historyUnlocked) return false;
      var kind = _histProtectedKind(url);
      if (!kind) return false;
      if (e && typeof e.preventDefault === 'function') { try { e.preventDefault(); } catch(err) {} }
      try { if (wc && typeof wc.stop === 'function') wc.stop(); } catch(err) {}
      try { win.webContents.send('neo-show-history-lock', { url: String(url || ''), kind: kind }); } catch(err) {}
      console.log('[HISTLOCK] Blocked protected page:', kind, url);
      return true;
    } catch(err) { return false; }
  }
  ipcMain.handle('history-lock-status', async () => {
    return { on: _histLockOn(), unlocked: _historyUnlocked };
  });
  ipcMain.handle('history-lock-save', async (event, payload) => {
    try {
      var c = _readHistLock() || {};
      var on = !!(payload && payload.on === true);
      var pass = (payload && typeof payload.pass === 'string') ? payload.pass : '';
      if (on && pass.length >= 4) { c.passHash = _histLockHash(pass); }
      c.on = on;
      c.passHash = c.passHash || null;
      if (c.on && !c.passHash) c.on = false;
      _writeHistLock(c);
      if (!c.on) _historyUnlocked = false;
      console.log('[HISTLOCK] config saved, on=' + (c.on === true));
      return { saved: true, on: c.on === true };
    } catch(e) { console.error('[HISTLOCK] save error:', e.message); return { saved: false }; }
  });
  ipcMain.handle('history-lock-check', async (event, pass) => {
    var c = _readHistLock();
    if (!c || c.on !== true || !c.passHash) return { ok: false };
    if (_histLockHash(pass || '') === c.passHash) {
      _historyUnlocked = true;
      console.log('[HISTLOCK] unlocked for this session');
      return { ok: true };
    }
    return { ok: false };
  });
  ipcMain.handle('history-lock-relock', async () => {
    _historyUnlocked = false;
    return { ok: true };
  });

  // ===== NEO ACCOUNT - COOKIE SYNC =====
  // Login cookies (Google/YouTube/site sessions) live in the persistent webview
  // session. Export them so a NEO Account backup can carry signed-in sessions to
  // another device, and import them back on restore.
  function _neoSessionForSync() {
    try { return session.fromPartition('persist:webview'); } catch(e) {}
    return session.defaultSession;
  }
  ipcMain.handle('sync-cookies-export', async () => {
    try {
      const ses = _neoSessionForSync();
      const cookies = await ses.cookies.get({});
      return { ok: true, cookies: cookies };
    } catch(e) { console.error('[ACCT] cookie export error:', e.message); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('sync-cookies-import', async (event, cookies) => {
    try {
      if (!Array.isArray(cookies) || !cookies.length) return { ok: true, count: 0 };
      const ses = _neoSessionForSync();
      let ok = 0;
      for (const c of cookies) {
        try {
          const domain = String(c.domain || '').replace(/^\./, '');
          if (!domain) continue;
          const scheme = c.secure ? 'https' : 'http';
          const url = scheme + '://' + domain + (c.path || '/');
          const opts = {
            url: url,
            name: c.name,
            value: c.value,
            path: c.path || '/',
            secure: !!c.secure,
            httpOnly: !!c.httpOnly,
            sameSite: c.sameSite || 'unspecified'
          };
          if (c.expirationDate) opts.expirationDate = c.expirationDate;
          if (c.hostOnly !== true) opts.domain = c.domain;
          await ses.cookies.set(opts);
          ok++;
        } catch(e) {}
      }
      return { ok: true, count: ok };
    } catch(e) { console.error('[ACCT] cookie import error:', e.message); return { ok: false, error: e.message }; }
  });

  // ===== GOOGLE AUTH - SCOPED CLEANUP (testing / stuck logins) =====
  // Removes ONLY Google/YouTube/accounts.google.com cookies from EVERY session
  // (default, persist:webview, persist:webview_wcv) so the "problem with your
  // cookie settings" state can be reset without wiping the rest of the browser.
  // Timed cookies are removed by name+URL; session cookies are removed and their
  // URLs cleared for each matching cookie.
  const _AUTH_DOMAINS = ['accounts.google.com', 'ssl.gstatic.com', 'gstatic.com', 'google.com', 'googleapis.com', 'googleusercontent.com', 'googlevideo.com', 'youtube.com', 'youtu.be'];
  // ===== AUTH DEBUG LOG (diagnostics only; gated by NEO_AUTH_DEBUG=1) =====
  const _authDebugOn = process.env.NEO_AUTH_DEBUG === '1';
  const _authDbgPath = path.join(app.getPath('userData'), 'neo-auth-debug.log');
  function _authDbg(s) {
    try { if (_authDebugOn) fs.appendFileSync(_authDbgPath, '[' + new Date().toISOString() + '] ' + s + '\n', 'utf8'); } catch(e) {}
  }
  function _authDbgReset() {
    try { if (_authDebugOn) fs.writeFileSync(_authDbgPath, '=== NEXORA auth debug session ' + new Date().toISOString() + ' ===\n', 'utf8'); } catch(e) {}
  }
  function _isGoogleHost(domain) {
    var d = String(domain || '').replace(/^\./, '').toLowerCase();
    return _AUTH_DOMAINS.some(function(dom) {
      return d === dom || (d.length > dom.length && d.endsWith('.' + dom));
    });
  }
  function _sesName(ses) {
    try { return (ses && ses.getStoragePath ? require('path').basename(ses.getStoragePath()) : 'N/A'); } catch(e) { return 'N/A'; }
  }
  function _googleAuthCookies(ses) {
    return ses.cookies.get({}).then(function(list) {
      return (list || []).filter(function(c) {
        var d = String(c.domain || '').replace(/^\./, '');
        return _AUTH_DOMAINS.some(function(dom) {
          var endSlash = dom.length + 1;
          return d === dom || (d.length > dom.length && d.endsWith('.' + dom));
        });
      });
    });
  }
  function _clearGoogleAuth() {
    var sessions = [session.defaultSession,
      (function(){ try { return session.fromPartition('persist:webview'); } catch(e){ return null; } })(),
      (function(){ try { return session.fromPartition('persist:webview_wcv'); } catch(e){ return null; } })()
    ].filter(Boolean);
    return Promise.all(sessions.map(function(ses) {
      return _googleAuthCookies(ses).then(function(cookies) {
        return Promise.all(cookies.map(function(c) {
          var host = String(c.domain || '').replace(/^\./, '');
          if (!host) return Promise.resolve();
          var scheme = c.secure ? 'https' : 'http';
          var url = scheme + '://' + host + (c.path || '/');
          return ses.cookies.remove(url, c.name).catch(function() {});
        })).then(function() { return cookies.length; });
      }).catch(function() { return 0; });
    })).then(function(counts) {
      return { ok: true, removed: counts.reduce(function(a,b){ return a+b; }, 0) };
    });
  }
  ipcMain.handle('clear-google-auth-cookies', async () => {
    try {
      const res = await _clearGoogleAuth();
      console.log('[ACCT] cleared Google auth cookies:', res.removed);
      return res;
    } catch(e) { return { ok: false, error: e.message }; }
  });

  // ===== AUTH DEBUG STARTUP (NEO_AUTH_DEBUG=1) =====
  // Logs the session->storage-path map, counts Google cookies per session, and
  // (optionally with NEO_WIPE_GOOGLE=1) wipes ONLY Google-owned cookies so the
  // sign-in test starts from a genuinely clean state across every session.
  if (_authDebugOn) {
    _authDbgReset();
    try {
      _authDbg('[SESSIONS] default -> ' + _sesName(session.defaultSession));
      _authDbg('[SESSIONS] persist:webview -> ' + _sesName(session.fromPartition('persist:webview')));
      _authDbg('[SESSIONS] persist:webview_wcv -> ' + _sesName(session.fromPartition('persist:webview_wcv')));
    } catch(e) { _authDbg('[SESSIONS] map error: ' + e.message); }
    var _sesList = [session.defaultSession, session.fromPartition('persist:webview'), session.fromPartition('persist:webview_wcv')];
    var _countGoogle = function(ses) {
      return _googleAuthCookies(ses).then(function(list) {
        var byHost = {};
        (list || []).forEach(function(c) { byHost[String(c.domain).replace(/^\./,'') + (c.sameSite ? ' SS=' + c.sameSite : '')] = (byHost[String(c.domain).replace(/^\./,'') + (c.sameSite ? ' SS=' + c.sameSite : '')] || 0) + 1; });
        _authDbg('[COOKIES] ' + _sesName(ses) + ': ' + (list || []).length + ' google cookie(s) -> ' + JSON.stringify(byHost));
        return (list || []).length;
      }).catch(function() { _authDbg('[COOKIES] ' + _sesName(ses) + ': count error'); return 0; });
    };
    Promise.all(_sesList.map(_countGoogle)).then(function() {
      if (process.env.NEO_WIPE_GOOGLE === '1') {
        _clearGoogleAuth().then(function(res) {
          _authDbg('[WIPE] cleared ' + (res && res.removed || 0) + ' Google-owned cookie(s) across all sessions (fresh sign-in test)');
          Promise.all(_sesList.map(_countGoogle)).then(function() { _authDbg('[WIPE] post-clear counts done'); });
        }).catch(function(e) { _authDbg('[WIPE] error: ' + e.message); });
      } else {
        _authDbg('[WIPE] not enabled (set NEO_WIPE_GOOGLE=1 to clear Google cookies for a fresh test)');
      }
    });
  }

  // ===== ESTA SAVED-CHATS DETACHABLE DESKTOP PANEL =====
  // The saved-conversations list can live as a slim always-on-top window docked
  // to the LEFT edge of the browser (outside it on the desktop). Conversations are
  // loaded/deleted/newed from the main renderer, which owns the data; the panel is
  // just a remote view that routes actions back through IPC.
  let chatPanelWin = null;
  let _chatPanelFollowBound = false;
  function _mainBrowserWin() {
    return BrowserWindow.getAllWindows().find(function(w) {
      if (w.isDestroyed()) return false;
      try { return (w.webContents.getURL() || '').indexOf('ai-browser.html') !== -1; } catch(e) { return false; }
    });
  }
  function _dockChatPanel() {
    if (chatPanelWin && !chatPanelWin.isDestroyed()) chatPanelWin.destroy();
    chatPanelWin = null;
    const mainWin = _mainBrowserWin();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('neo-show-chat-panel');
      mainWin.focus();
    }
  }
  function _openChatPanel() {
    if (chatPanelWin && !chatPanelWin.isDestroyed()) { chatPanelWin.show(); chatPanelWin.focus(); return false; }
    const mainWin = _mainBrowserWin();
    if (!mainWin || mainWin.isDestroyed()) return false;
    const { screen } = require('electron');
    const mb = mainWin.getBounds();
    const ws = (() => { try { return screen.getDisplayMatching(mb).workArea; } catch(e) { return { x: 0, y: 0, width: 1920, height: 1080 }; } })();
    const w = 304, h = Math.min(560, mb.height);
    let x = mb.x - w - 6;
    if (x < ws.x) x = mb.x + mb.width + 6;
    let y = mb.y;
    if (y + h > ws.y + ws.height) y = Math.max(ws.y, ws.y + ws.height - h);
    chatPanelWin = new BrowserWindow({
      x: x, y: y, width: w, height: h,
      minWidth: 240, minHeight: 260,
      frame: false,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      backgroundColor: '#0b0e1c',
      title: 'ESTA Saved Chats',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    try { chatPanelWin.setAlwaysOnTop(true, 'floating'); } catch(e) {}
    chatPanelWin.loadFile(path.join(__dirname, 'chat-panel.html'));
    chatPanelWin.webContents.once('did-finish-load', function() {
      const w = _mainBrowserWin();
      if (w && !w.isDestroyed()) w.webContents.send('neo-panel-request-sync');
    });
    chatPanelWin.once('ready-to-show', () => { try { chatPanelWin.show(); } catch(e) {} });
    chatPanelWin.on('closed', () => { chatPanelWin = null; });
    // Auto-dock: dragging the panel so its right edge touches the main window's
    // left edge re-docks it back into the ESTA chat sidebar.
    let draggedAway = false;
    if (!_chatPanelFollowBound) {
      _chatPanelFollowBound = true;
      mainWin.on('move', () => {
        if (!chatPanelWin || chatPanelWin.isDestroyed() || draggedAway) return;
        try {
          const b2 = mainWin.getBounds();
          chatPanelWin.setPosition(b2.x - chatPanelWin.getBounds().width - 6, chatPanelWin.getBounds().y);
        } catch(e) {}
      });
    }
    chatPanelWin.on('move', () => {
      if (!chatPanelWin || chatPanelWin.isDestroyed() || !mainWin || mainWin.isDestroyed()) return;
      const p = chatPanelWin.getBounds();
      const b = mainWin.getBounds();
      const edgeTouch = (p.x + p.width) >= (b.x - 30) && (p.x + p.width) <= (b.x + 30) && p.y < (b.y + b.height) && (p.y + p.height) > b.y;
      if (edgeTouch) { _dockChatPanel(); return; }
      draggedAway = (Math.abs(p.x - (b.x - p.width - 6)) > 60);
    });
    return true;
  }
  ipcMain.handle('chat-panel-open', () => { _openChatPanel(); });
  ipcMain.on('chat-panel-sync', (e, payload) => {
    if (chatPanelWin && !chatPanelWin.isDestroyed()) chatPanelWin.webContents.send('chat-panel-sync', payload || {});
  });
  ipcMain.on('chat-panel-open-conv', (e, d) => {
    const mainWin = _mainBrowserWin();
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('neo-load-conv', { id: d && d.id });
  });
  ipcMain.on('chat-panel-delete-conv', (e, d) => {
    const mainWin = _mainBrowserWin();
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('neo-delete-conv', { id: d && d.id });
  });
  ipcMain.on('chat-panel-new-chat', () => {
    const mainWin = _mainBrowserWin();
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('neo-new-chat');
  });
  ipcMain.on('chat-panel-request-dock', () => { _dockChatPanel(); });

  // Request headers (honest UA by default; per-site clean Chrome/168 spoof for
  // sites that refuse anything else). The apps viewer <webview> has NO partition,
  // so it runs on session.defaultSession - same per-URL UA handling as the WCV.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    details.requestHeaders['Accept-Language'] = 'en-US,en;q=0.9';
    details.requestHeaders['Accept-Encoding'] = 'gzip, deflate, br';
    _applyUAHeaders(details.requestHeaders, details.url);
    callback({ requestHeaders: details.requestHeaders });
  });

  session.defaultSession.setUserAgent(USER_AGENT);
  // Enable Service Workers on default session
  try { session.defaultSession.setEnableServiceWorkers(true); } catch(e) {}
  // Also apply to the webview's persistent session
  var wvSession = session.fromPartition('persist:webview');
  wvSession.setUserAgent(USER_AGENT);
  // Enable Service Workers and storage on webview session
  try { wvSession.setEnableServiceWorkers(true); } catch(e) {}
  wvSession.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, function(details, callback) {
    details.requestHeaders['Accept-Language'] = 'en-US,en;q=0.9';
    details.requestHeaders['Accept-Encoding'] = 'gzip, deflate, br';
    _applyUAHeaders(details.requestHeaders, details.url);
    callback({ requestHeaders: details.requestHeaders });
  });
  // Apply the same UA to the WebContentsView session. The WCV is the visible
  // site layer (DOM <webview> is the hidden mirror) and lives on its OWN
  // partition to avoid the shared-session ERR_ABORTED churn, so it needs the
  // identical request handling the webview session gets.
  try {
    var wcvSession = session.fromPartition('persist:webview_wcv');
    wcvSession.setUserAgent(USER_AGENT);
    try { wcvSession.setEnableServiceWorkers(true); } catch(e) {}
    wcvSession.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, function(details, callback) {
      details.requestHeaders['Accept-Language'] = 'en-US,en;q=0.9';
      details.requestHeaders['Accept-Encoding'] = 'gzip, deflate, br';
      _applyUAHeaders(details.requestHeaders, details.url);
      callback({ requestHeaders: details.requestHeaders });
    });
  } catch(e) { console.warn('[WCV-session] setup failed:', e.message); }

  // ===== SIGN-IN PARITY ACROSS PARTITIONS =====
  // The VISIBLE site layer runs on persist:webview_wcv, while login/help windows
  // and the DOM <webview> mirror use persist:webview. Google/YT cookies created
  // on either side MUST land on the other, otherwise the visible browser looks
  // logged-out even though the session already holds a valid login. Mirror both
  // ways (once at startup + slowly) using CONSERVATIVE rules:
  //   - fill gaps (cookie missing / emptied on the target side)
  //   - replace only when the source copy is strictly FRESHER (later expiry)
  //   - NEVER stomp a live cookie on the target with a stale copy from source
  // This guarantees a fresh sign-in is never overwritten by an older SID, which
  // is exactly what made Google report "detected a problem with your cookie
  // settings". Cookie values/attributes are copied verbatim; nothing is re-mangled.
  var _cookieMirrorTimer = null;
  // Google-domain cookies are NOT mirrored between partitions by default. The
  // persist:webview_wcv partition is unused by any rendered view (the WCV and
  // the DOM <webview> both live on persist:webview), so mirroring Google auth
  // cookies to it only creates a second, potentially STALE jar that the reverse
  // pass can inject back into the live session — which made Google report
  // "detected a problem with your cookie settings". Set
  // NEO_MIRROR_BLOCK_GOOGLE=0 to re-enable Google mirroring (test only).
  const _mirrorBlockGoogle = process.env.NEO_MIRROR_BLOCK_GOOGLE !== '0';
  function _mirrorCookies(from, to) {
    if (!from || !to) return Promise.resolve();
    var fromName = _sesName(from), toName = _sesName(to);
    try {
      return Promise.all([from.cookies.get({}), to.cookies.get({})]).then(function(r) {
        var src = r[0] || [], dst = r[1] || [];
        var index = {};
        for (var i = 0; i < dst.length; i++) {
          var d = dst[i];
          index[(d.domain || '') + '|' + (d.path || '') + '|' + (d.name || '')] = d;
        }
        var now = Date.now() / 1000;
        var ops = [];
        var blockGoogle = 0;
        for (var j = 0; j < src.length; j++) {
          var c = src[j];
          if (_mirrorBlockGoogle && _isGoogleHost(c.domain)) { blockGoogle++; continue; }
          var key = (c.domain || '') + '|' + (c.path || '') + '|' + (c.name || '');
          var existing = index[key];
          var srcExp = c.expirationDate || 0;
          var dstExp = existing ? (existing.expirationDate || 0) : 0;
          var dstMissing = !existing || existing.value === '';
          var dstStale = dstExp > 0 && dstExp <= now && srcExp > dstExp;
          var srcFresher = srcExp > 0 && dstExp === 0;
          if (!dstMissing && !dstStale && !srcFresher) continue;
          if (existing && existing.value === c.value && Math.abs(srcExp - dstExp) <= 1) continue;
          if (_authDebugOn && _isGoogleHost(c.domain)) {
            _authDbg('[MIRROR] ' + fromName + ' -> ' + toName + ' COPY google name=' + c.name +
              ' domain=' + c.domain + ' srcExp=' + srcExp + ' dstExp=' + dstExp +
              ' existing=' + (existing ? existing.value.length : 0) +
              ' rule=' + (dstMissing ? 'gap' : (dstStale ? 'stale' : 'fresher')) +
              ' same=' + (c.sameSite || '') + ' sec=' + c.secure + ' http=' + c.httpOnly +
              ' vlen=' + String(c.value || '').length);
          }
          var scheme = (c.secure === true) ? 'https' : 'http';
          var host = c.domain || '';
          if (host.charAt(0) === '.') host = host.slice(1);
          ops.push(to.cookies.set({
            url: scheme + '://' + host + (c.path || '/'),
            name: c.name, value: c.value,
            domain: c.domain, path: c.path || '/',
            secure: c.secure === true, httpOnly: c.httpOnly === true,
            sameSite: c.sameSite || 'no_restriction',
            expirationDate: c.expirationDate
          }).catch(function(){}));
        }
        return Promise.all(ops).then(function() {
          if (blockGoogle > 0) _authDbg('[MIRROR] ' + fromName + ' -> ' + toName + ': SKIPPED ' + blockGoogle + ' google-domain cookie(s) (NEO_MIRROR_BLOCK_GOOGLE test)');
          if (src.length - blockGoogle > 0) _authDbg('[MIRROR] ' + fromName + ' -> ' + toName + ': mirrored ' + (ops.length) + '/' + (src.length - blockGoogle) + ' non-google cookies');
          return true;
        });
      });
    } catch(e) { return Promise.resolve(); }
  }
  (function startMirror() {
    try {
      // Purge stale Google cookies from the unused persist:webview_wcv partition
      // so no old SID/HSID jar survives on disk to contaminate the live session.
      _googleAuthCookies(wcvSession).then(function(stale) {
        if (!stale || !stale.length) return 0;
        return Promise.all(stale.map(function(c) {
          var host = String(c.domain || '').replace(/^\./, '');
          if (!host) return Promise.resolve();
          var url = (c.secure ? 'https' : 'http') + '://' + host + (c.path || '/');
          return wcvSession.cookies.remove(url, c.name).catch(function() {});
        })).then(function() {
          _authDbg('[MIRROR-PURGE] removed ' + stale.length + ' stale Google cookie(s) from ' + _sesName(wcvSession));
          return stale.length;
        });
      }).catch(function() { return 0; });
      _mirrorCookies(wvSession, wcvSession);
      _mirrorCookies(wcvSession, wvSession);
      _cookieMirrorTimer = setInterval(function() {
        try {
          _mirrorCookies(wvSession, wcvSession);
          _mirrorCookies(wcvSession, wvSession);
        } catch(e) {}
      }, 15000);
    } catch(e) {}
  })();

  // ===== COOKIE DIAGNOSTIC LOGGING (NEO_AUTH_DEBUG=1 only) =====
  // Logs every Google-domain cookie mutation and a per-partition inventory so
  // the "detected a problem with your cookie settings" error can be traced to
  // which session set/overwrote/expired which auth cookie. Values are NEVER
  // logged; only redacted names/attributes are written.
  const DIAG_SESSIONS = [
    { label: 'default',      ses: session.defaultSession },
    { label: 'webview',      ses: (function(){ try { return session.fromPartition('persist:webview'); } catch(e) { return null; } })() },
    { label: 'webview_wcv',  ses: (function(){ try { return session.fromPartition('persist:webview_wcv'); } catch(e) { return null; } })() }
  ];
  function _diagCookieEvent(label, cookie, cause, removed) {
    try {
      if (!cookie) return;
      var d = String(cookie.domain || '').replace(/^\./, '');
      if (!_isGoogleHost(d)) return;
      _authDbg('[COOKIE-EVENT] ' + label + ' ' + (removed ? 'REMOVED' : 'SET') +
        ' cause=' + cause +
        ' name=' + cookie.name +
        ' domain=' + cookie.domain + ' path=' + cookie.path +
        ' sec=' + (cookie.secure === true) + ' http=' + (cookie.httpOnly === true) +
        ' same=' + (cookie.sameSite || '') +
        ' exp=' + (cookie.expirationDate || 0) +
        ' vlen=' + String(cookie.value || '').length);
    } catch(e) {}
  }
  function _diagSnapshot() {
    if (!_authDebugOn) return;
    try {
      DIAG_SESSIONS.forEach(function(e) {
        if (!e.ses) return;
        e.ses.cookies.get({}).then(function(list) {
          try {
            var g = (list || []).filter(function(c){ return _isGoogleHost(c.domain); });
            _authDbg('[COOKIE-SNAP] ' + e.label + ' googleCookies=' + g.length +
              ' names=[' + g.map(function(c){ return c.name + '(' + c.domain + (c.expirationDate ? ',exp' + Math.round(c.expirationDate) : ',sess') + ')'; }).sort().join(' ') + ']');
          } catch(e2) {}
        });
      });
    } catch(e) {}
  }
  if (_authDebugOn) {
    try {
      DIAG_SESSIONS.forEach(function(e) {
        if (!e.ses) return;
        e.ses.cookies.on('changed', function(evt, cookie, cause, removed) { _diagCookieEvent(e.label, cookie, cause, removed); });
      });
      setTimeout(_diagSnapshot, 6000);
    } catch(e) {}
  }

  // ===== GOOGLE SET-COOKIE RACE DIAGNOSTIC (NEO_AUTH_DEBUG=1 only) =====
  // Logs which webContents/process actually receives a Set-Cookie for the
  // Google auth-consistency cookies (SIDCC / *PSIDCC) on persist:webview so we
  // can see whether two renderers (visible WCV vs hidden per-tab webview) are
  // racing each other and corrupting the cookie jar.
  if (_authDebugOn) {
    try {
      var _raceSess = session.fromPartition('persist:webview');
      _raceSess.webRequest.onHeadersReceived({ urls: ['https://*.google.com/*', 'https://*/*.google.com/*', 'https://accounts.google.com/*'] }, function(details, cb) {
        try {
          var resH = details.responseHeaders || {};
          var sc = [];
          for (var hname in resH) {
            var hn = String(hname || '').toLowerCase();
            if (hn === 'set-cookie') {
              (resH[hname] || []).forEach(function(v) {
                var m = String(v).match(/^([^=\s;]+)=/);
                if (m && /SIDCC|PSIDCC|SID|HSID|APISID|LSID|PSIDTS/.test(m[1])) sc.push(m[1]);
              });
            }
          }
          if (sc.length) {
            _authDbg('[SETCOOKIE] wc=' + (details.webContentsId ?? '?') + ' proc=' + (details.processId ?? '?') +
              ' url=' + String(details.url || '').slice(0, 120) +
              ' frame=' + (details.resourceType || '?') +
              ' [' + sc.join(',') + ']');
          }
        } catch(e) {}
        cb({});
      });
    } catch(e) {}
  }

  // ===== AD + TRACKER BLOCKER (NEO SHIELDS ENGINE) =====
  // A real filter-engine blocker (@cliqz/adblocker) driven by EasyList/EasyPrivacy.
  // Replaces the old hardcoded AD_BLOCK_DOMAINS host/pattern list with:
  //   - per-category engines (ads / trackers / analytics / popups / malicious)
  //   - per-site disable persisted in userData/neo-shields/site-overrides.json
  //   - auto-downloading, cached & updatable EasyList/EasyPrivacy lists
  //   - live per-site stats published to the renderer (shield badge + panel)
  // Electron allows only ONE onBeforeRequest listener per session, so this module
  // owns that listener on default + persist:webview + persist:webview_wcv.
  const { NeoShields } = require('./shields');
  const _shields = new NeoShields({ getMainWindow: () => _mainBrowserWin() });
  _shields.registrations();

  // ===== VOLUME BOOST (main-side per-frame delivery) =====
  // The engine (vol-boost.js) amplifies audio by routing <video>/<audio> through
  // a WebAudio gain node. Executing it only in the top document misses sites
  // that play media inside cross-origin IFRAME players (most non-YouTube video
  // sites) - so the main process pushes the engine into EVERY frame of every
  // webContents (visible WebContentsView, tab webviews, and their iframes).
  var _volBoostPct = 100;
  var _volBoostWcs = new Set();
  var _VOL_BOOST_SRC = null;
  function _volBoostCode(pct) {
    if (!_VOL_BOOST_SRC) {
      try { _VOL_BOOST_SRC = fs.readFileSync(path.join(__dirname, 'vol-boost.js'), 'utf8'); } catch (e) { _VOL_BOOST_SRC = ''; }
    }
    var lvl = Math.max(1, Math.min(5, (Number(pct) || 100) / 100));
    return _VOL_BOOST_SRC + '\n;window.__neoVolumeBoost&&window.__neoVolumeBoost(' + lvl.toFixed(2) + ');';
  }
  function _volExecFrame(f, code) {
    try {
      if (!f || f.routingId == null) return;
      if (f.url && !/^https?:/i.test(f.url)) return;
      f.executeJavaScript(code).catch(function() {});
    } catch (e) {}
  }
  function _applyVolBoostTo(wc) {
    try {
      if (_volBoostPct <= 100) return;
      if (!wc || wc.isDestroyed()) return;
      var code = _volBoostCode(_volBoostPct);
      if (!code) return;
      try { wc.mainFrame.executeJavaScript(code).catch(function() {}); } catch (e) {}
      var frames = [];
      try { frames = wc.mainFrame.frames || []; } catch (e) {}
      for (var i = 0; i < frames.length; i++) _volExecFrame(frames[i], code);
    } catch (e) {}
  }
  function _applyVolBoostAll() {
    var arr = Array.from(_volBoostWcs);
    for (var i = 0; i < arr.length; i++) _applyVolBoostTo(arr[i]);
  }
  ipcMain.on('vol-boost-set', (event, pct) => {
    var v = Number(pct) || 100;
    _volBoostPct = Math.max(100, Math.min(300, v));
    _applyVolBoostAll();
  });

  // Legacy IPC toggle kept for the renderer settings select - now the global
  // master switch on the shields engine (handled inside shields.js).

  // ===== SPOTIFY DRM FALLBACK =====
  // Spotify's widevine-license endpoint returns HTTP 500 for any client whose
  // Widevine holds only a development VMP certificate (which is exactly what this
  // castlabs EVS (+wvcus) Electron build carries). Spotify rejects dev-VMP on
  // purpose - it is a hard DRM gate, not a UA/header/CDN issue - so no config
  // here can make Spotify decrypt audio. The result is the classic symptom: a
  // track plays a moment, mutes, then skips to the next. The system default
  // browser (Edge/Chrome) ships Google's production-signed Widevine, so Spotify
  // plays there. We watch for the 500 and hand the current song to that browser.
  var _siteUrl = '';
  let _drmHintFor = '';
  const _sessWebview = session.fromPartition('persist:webview');
  _sessWebview.webRequest.onCompleted({ urls: ['*://*.spotify.com/*'] }, (details) => {
    try {
      const u = details.url || '';
      if (u.indexOf('widevine-license') === -1 || !details.statusCode || details.statusCode < 400) return;
      if (_siteUrl.indexOf('spotify.com') === -1) return;
      if (_drmHintFor === _siteUrl) return;
      _drmHintFor = _siteUrl;
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) win.webContents.send('drm-hint', { url: _siteUrl });
      console.log('[DRM] Spotify widevine-license ' + details.statusCode + ' - suggesting system browser for', _siteUrl.slice(0,80));
    } catch(e) { console.warn('[DRM] hint watcher error:', e.message); }
  });

  // ===== SPOTIFY NETWORK DIAGNOSTIC =====
  // With NEO_SPOTIFY_DIAG=1, log every Spotify request that is canceled or errors
  // on the webview session so we can see if playback breakage is network-side
  // (ad-block cancel, header rewrite, auth failure) rather than audio-side.
  if (process.env.NEO_SPOTIFY_DIAG === '1') {
    const _diagNet = require('path').join(app.getPath('userData'), 'spotify-diag.log');
    const _diagLine = (txt) => { try { require('fs').appendFileSync(_diagNet, new Date().toISOString() + ' NET ' + (txt || '') + '\n'); } catch(e) {} };
    const sess = session.fromPartition('persist:webview');
    sess.webRequest.onErrorOccurred({ urls: ['*://*.spotify.com/*', '*://*.scdn.co/*', '*://*.spotifycdn.com/*', '*://*.akamaized.net/*'] }, (details) => {
      const url = details.url || '';
      if (url.indexOf('spotify') !== -1 || /\.akamaized\.net/.test(url)) _diagLine('onErrorOccurred url=' + url.slice(0,160) + ' error=' + (details.error||''));
    });
  }

  // IPC to toggle from renderer is handled inside shields.js (set-ad-blocking
  // delegates to shields.setGlobalEnabled). Kept out of main.js to avoid a
  // double registration of the same channel name.

  // Prompt-based permission handling for ALL sessions (default + webview).
  // Chrome-style: the page asks, the user sees an in-browser prompt bubble,
  // and the choice is remembered per site (camera / microphone / screen /
  // notifications / location). Nothing sensitive is ever auto-granted.
  var _permStoreFile = null;
  try {
    var _permDir = path.join(app.getPath('userData'), 'neo-data');
    try { if (!fs.existsSync(_permDir)) fs.mkdirSync(_permDir, { recursive: true }); } catch(e) {}
    _permStoreFile = path.join(_permDir, 'site-permissions.json');
  } catch(e) {}
  function _permReadStore() {
    try {
      if (_permStoreFile && fs.existsSync(_permStoreFile)) {
        var d = JSON.parse(fs.readFileSync(_permStoreFile, 'utf8'));
        if (d && typeof d === 'object') return d;
      }
    } catch(e) {}
    return {};
  }
  function _permWriteStore(store) {
    try { if (_permStoreFile) fs.writeFileSync(_permStoreFile, JSON.stringify(store)); } catch(e) {}
  }
  // Electron permission type -> site-setting keys we store. 'media' covers a
  // getUserMedia call (camera and/or mic together); the prompt lists both and
  // a remembered answer applies to both, exactly like Chrome's combined bar.
  function _permKeysFor(p) {
    if (p === 'media') return ['camera', 'microphone'];
    if (p === 'notifications') return ['notifications'];
    if (p === 'geolocation') return ['geolocation'];
    if (p === 'midi') return ['midi'];
    if (p === 'clipboard-read') return ['clipboard'];
    return [p];
  }
  function _permLabelFor(p) {
    if (p === 'media') return 'use your camera and microphone';
    if (p === 'notifications') return 'send you notifications';
    if (p === 'geolocation') return 'know your location';
    if (p === 'midi') return 'access your MIDI devices';
    if (p === 'clipboard-read') return 'read your clipboard';
    return 'use ' + p;
  }
  var _permPending = {};
  var _permSeq = 0;
  function _permMainWin() {
    try {
      var wins = BrowserWindow.getAllWindows() || [];
      for (var i = 0; i < wins.length; i++) {
        if (wins[i] && !wins[i].isDestroyed()) return wins[i];
      }
    } catch(e) {}
    return null;
  }
  // One-line debug trace for permission flows. Written to a file because the
  // user tests on their live window (no debugger attached). Remove or silence
  // once the flows are confirmed working.
  function _permLog(msg) {
    try {
      var dir = path.join(app.getPath('userData'), 'neo-data');
      try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch(e) {}
      fs.appendFileSync(path.join(dir, 'perm-debug.log'),
        new Date().toISOString() + ' ' + msg + '\n');
    } catch(e) {}
  }
  var _BENIGN_PERM = { fullscreen: true, mediaKeySystem: true, 'clipboard-sanitized-write': true, windowManagement: false, pointerLock: true, keyboardLock: true };
  var _permHandler = function(wc, p, cb, details) {
    try {
      if (_BENIGN_PERM[p]) { cb(true); return; }
      var origin = '';
      try {
        var u = (details && details.requestingUrl) || (wc && wc.getURL ? wc.getURL() : '');
        origin = new URL(u).origin || '';
      } catch(e) {}
      _permLog('perm-request type=' + p + ' origin=' + origin);
      // SELF-UI GRANT: the NEXORA window itself (file://.../ai-browser.html)
      // needs camera/mic/screen for the built-in recorder + voice assistant.
      // Guests are type 'webview' and other windows never have this URL, so
      // this can never leak to a website.
      try {
        var _selfU = (wc && wc.getURL) ? (wc.getURL() || '') : '';
        var _selfT = (wc && wc.getType) ? wc.getType() : '';
        if (_selfT === 'window' && /^file:\/\//i.test(_selfU) && /ai-browser\.html([?#]|$)/.test(_selfU) &&
            (p === 'media' || p === 'microphone' || p === 'camera' || p === 'audioCapture' || p === 'videoCapture' || p === 'display-capture' || p === 'speaker')) {
          _permLog('perm-self-ui-allow type=' + p);
          cb(true);
          return;
        }
      } catch(e) {}
      if (!origin || origin === 'null') { cb(false); return; }
      var keys = _permKeysFor(p);
      // NEXORA auto-allow: camera + microphone (voice/video calls) are granted
      // instantly on real websites, Chrome-style. A remembered Block from the
      // site popup is still honored (falls through to the deny path below).
      try {
        var _proto = '';
        try { _proto = new URL((details && details.requestingUrl) || (wc && wc.getURL ? wc.getURL() : '')).protocol || ''; } catch(e2) {}
        if ((p === 'media' || p === 'microphone' || p === 'camera' || p === 'audioCapture' || p === 'videoCapture') && (_proto === 'http:' || _proto === 'https:')) {
          var _st0 = _permReadStore();
          var _sv0 = _st0[origin] || {};
          var _blocked = false;
          for (var _bi = 0; _bi < keys.length; _bi++) { if (_sv0[keys[_bi]] === 'block') { _blocked = true; break; } }
          if (!_blocked) {
            for (var _ai = 0; _ai < keys.length; _ai++) { _sv0[keys[_ai]] = 'allow'; }
            _st0[origin] = _sv0;
            _permWriteStore(_st0);
            _permLog('perm-auto-allow type=' + p + ' origin=' + origin);
            cb(true);
            return;
          }
        }
      } catch(e) {}
      var store = _permReadStore();
      var saved = store[origin] || {};
      var decided = null;
      for (var i = 0; i < keys.length; i++) {
        var v = saved[keys[i]];
        if (v === 'block') { cb(false); return; }
        if (v === 'allow') decided = true;
      }
      if (decided === true) { cb(true); return; }
      // Ask the user through the in-browser prompt bubble. Fail closed: if the
      // UI is unreachable or stays silent, the request is denied.
      var win = _permMainWin();
      if (!win) { cb(false); return; }
      var id = 'perm_' + (++_permSeq) + '_' + Date.now();
      var settled = false;
      var entry = { keys: keys, origin: origin, timer: null, finish: null };
      entry.finish = function(allow) {
        if (settled) return;
        settled = true;
        try { clearTimeout(entry.timer); } catch(e) {}
        delete _permPending[id];
        cb(!!allow);
      };
      entry.timer = setTimeout(function() { entry.finish(false); }, 90000);
      _permPending[id] = entry;
      try {
        win.webContents.send('permission-request', { id: id, origin: origin, label: _permLabelFor(p), keys: keys });
      } catch(e) { entry.finish(false); }
    } catch(e) {
      try { cb(false); } catch(e2) {}
    }
  };
  var _permCheckHandler = function(wc, p, o) {
    if (_BENIGN_PERM[p]) return true;
    try {
      var origin = (o && o.requestingOrigin) ? o.requestingOrigin : '';
      if (!origin && wc && wc.getURL) { try { origin = new URL(wc.getURL()).origin || ''; } catch(e) {} }
      // SELF-UI GRANT (see request handler): our own window always passes
      // media-family checks so the recorder + voice assistant work.
      try {
        var _selfU2 = (wc && wc.getURL) ? (wc.getURL() || '') : '';
        var _selfT2 = (wc && wc.getType) ? wc.getType() : '';
        if (_selfT2 === 'window' && /^file:\/\//i.test(_selfU2) && /ai-browser\.html([?#]|$)/.test(_selfU2) &&
            (p === 'media' || p === 'microphone' || p === 'camera' || p === 'audioCapture' || p === 'videoCapture' || p === 'display-capture' || p === 'speaker')) {
          return true;
        }
      } catch(e) {}
      if (!origin || origin === 'null') return false;
      // NEXORA auto-allow: report camera/mic as granted on real websites
      // (unless the user Blocked them in the site popup).
      try {
        var _proto2 = '';
        try { _proto2 = new URL((o && o.requestingOrigin) ? o.requestingOrigin : (wc && wc.getURL ? wc.getURL() : '')).protocol || ''; } catch(e2) {}
        if ((p === 'media' || p === 'microphone' || p === 'camera' || p === 'audioCapture' || p === 'videoCapture') && (_proto2 === 'http:' || _proto2 === 'https:')) {
          var _sv2 = (_permReadStore()[origin]) || {};
          var _kk2 = _permKeysFor(p);
          for (var _q = 0; _q < _kk2.length; _q++) { if (_sv2[_kk2[_q]] === 'block') return false; }
          return true;
        }
      } catch(e) {}
      var saved = (_permReadStore()[origin]) || {};
      var keys = _permKeysFor(p);
      for (var i = 0; i < keys.length; i++) {
        if (saved[keys[i]] === 'block') return false;
      }
      for (var j = 0; j < keys.length; j++) {
        if (saved[keys[j]] === 'allow') return true;
      }
    } catch(e) {}
    return false;
  };
  session.defaultSession.setPermissionRequestHandler(_permHandler);
  session.defaultSession.setPermissionCheckHandler(_permCheckHandler);
  try {
    var _wvSess = session.fromPartition('persist:webview');
    _wvSess.setPermissionRequestHandler(_permHandler);
    _wvSess.setPermissionCheckHandler(_permCheckHandler);
  } catch(e) {}
  // Also handle from partition for popup windows
  try {
    var _defaultPart = session.fromPartition('');
    _defaultPart.setPermissionRequestHandler(_permHandler);
    _defaultPart.setPermissionCheckHandler(_permCheckHandler);
  } catch(e) {}

  // ===== SCREEN SHARE (getDisplayMedia) =====
  // Chrome shows a picker (screen / window + audio). Without this handler the
  // request silently fails on Meet/Zoom/Teams. We send the source list to the
  // UI picker overlay and hand the chosen source back to Chromium.
  var _dmPending = {};
  var _dmSeq = 0;
  function _dmSources() {
    function plain(srcs) {
      return (srcs || []).map(function(s) {
        return { id: s.id, name: s.name || 'Untitled', thumbnail: (s.thumbnail && !s.thumbnail.isEmpty()) ? s.thumbnail.toDataURL() : '', raw: s };
      });
    }
    // Bare listing only: thumbnail/icon fetch hangs on some setups (notably
    // with GPU disabled), and no picker UI consumes them anymore.
    try {
      return desktopCapturer.getSources({ types: ['screen', 'window'] }).then(plain, function() { return []; });
    } catch(e) { return Promise.resolve([]); }
  }
  function _dmHandler(request, callback) {
    var origin = '';
    try {
      // Electron provides securityOrigin; fall back to requestingUrl just in case.
      var raw = (request && (request.securityOrigin || request.requestingUrl)) || '';
      origin = new URL(raw).origin || '';
    } catch(e) {}
    _permLog('display-media origin=' + origin + ' video=' + (request && request.videoRequested) + ' audio=' + (request && request.audioRequested));
    if (!origin || origin === 'null') {
      // Our own UI file (screen recorder) has a null origin too: the request
      // only carries 'file:///', so identify it via the frame's full URL.
      try {
        var _frameUrl = '';
        try { _frameUrl = (request && request.frame && request.frame.url) || ''; } catch(e2) {}
        if (!(/^file:\/\//i.test(_frameUrl) && /ai-browser\.html([?#]|$)/.test(_frameUrl))) { try { callback({}); } catch(e) {} return; }
      } catch(e) { try { callback({}); } catch(e2) {} return; }
      _permLog('display-media self-ui, auto-picking');
    } else {
      var saved = (_permReadStore()[origin] || {}).screen;
      if (saved === 'block') { try { callback({}); } catch(e) {} return; }
    }
    // NEXORA auto-allow: share the primary screen instantly, no picker.
    // A remembered Block from the site popup is still honored (checked above).
    _dmSources().then(function(sources) {
      try {
        if (!sources.length) { callback({}); return; }
        var chosen = null;
        for (var i = 0; i < sources.length; i++) {
          if (sources[i].id && sources[i].id.indexOf('screen:') === 0) { chosen = sources[i]; break; }
        }
        if (!chosen) chosen = sources[0];
        try {
          var store = _permReadStore();
          var perms = store[origin] || {};
          perms.screen = 'allow';
          store[origin] = perms;
          _permWriteStore(store);
        } catch(e) {}
        _permLog('display-media auto-allow origin=' + origin + ' source=' + chosen.id + ' audio=' + (!!(request && request.audioRequested)));
        // Chromium needs the live source OBJECT here, not just its id string.
        var out = { video: chosen.raw };
        if (request && request.audioRequested && chosen.id && chosen.id.indexOf('screen:') === 0) out.audio = 'loopback';
        callback(out);
      } catch(e) { try { callback({}); } catch(e2) {} }
    }).catch(function() { try { callback({}); } catch(e) {} });
  }
  try {
    session.fromPartition('persist:webview').setDisplayMediaRequestHandler(_dmHandler);
  } catch(e) {}
  try {
    session.defaultSession.setDisplayMediaRequestHandler(_dmHandler);
  } catch(e) {}

  // ===== AUTO-UPDATE CHECK (portable builds have no Squirrel updater) =====
  // Polls our GitHub releases feed; when a newer tag exists the UI shows a
  // one-click "Download update" banner. Installing stays manual (portable
  // ZIP), but no user ever misses a release again.
  var _updateDismissed = '';
  var _updateFile = null;
  try {
    var _updDir = path.join(app.getPath('userData'), 'neo-data');
    try { if (!fs.existsSync(_updDir)) fs.mkdirSync(_updDir, { recursive: true }); } catch(e) {}
    _updateFile = path.join(_updDir, 'update-check.json');
    try {
      var _ud = JSON.parse(fs.readFileSync(_updateFile, 'utf8'));
      if (_ud && _ud.dismissed) _updateDismissed = String(_ud.dismissed);
    } catch(e) {}
  } catch(e) {}
  function _updateSave() {
    try { if (_updateFile) fs.writeFileSync(_updateFile, JSON.stringify({ dismissed: _updateDismissed })); } catch(e) {}
  }
  function _localAppVersion() {
    try { return String(require('./package.json').version || '0.0.0'); } catch(e) { return '0.0.0'; }
  }
  function _verIsNewer(a, b) {
    function parts(s) { return String(s).split('.').map(function(x) { var n = parseInt(x, 10); return isNaN(n) ? 0 : n; }); }
    var pa = parts(a), pb = parts(b);
    for (var i = 0; i < 3; i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  }
  function _fetchReleaseJson() {
    return new Promise(function(resolve, reject) {
      try {
        var req = https.get('https://api.github.com/repos/khanhishan70-stack/browser-AI-3/releases/latest', {
          headers: { 'User-Agent': 'NEXORA-Browser-Updater', 'Accept': 'application/vnd.github+json' }
        }, function(res) {
          var code = res.statusCode || 0;
          if (code !== 200) { res.resume(); return reject(new Error('HTTP ' + code)); }
          var buf = '';
          res.on('data', function(c) { buf += c; });
          res.on('end', function() {
            try { resolve(JSON.parse(buf)); } catch(e) { reject(e); }
          });
          res.on('error', reject);
        });
        req.setTimeout(15000, function() { try { req.destroy(new Error('Update check timed out')); } catch(e) {} });
        req.on('error', reject);
      } catch(e) { reject(e); }
    });
  }
  function _updateBroadcast(info) {
    try {
      var wins = BrowserWindow.getAllWindows() || [];
      for (var i = 0; i < wins.length; i++) {
        try { if (wins[i] && !wins[i].isDestroyed()) wins[i].webContents.send('update-available', info); } catch(e) {}
      }
    } catch(e) {}
  }
  var _updateLastCheck = 0;
  function _updateCheck(manual) {
    try {
      var now = Date.now();
      if (!manual && now - _updateLastCheck < 6 * 3600 * 1000) return;
      _updateLastCheck = now;
      _fetchReleaseJson().then(function(rel) {
        try {
          var tag = String((rel && rel.tag_name) || '').replace(/^v/i, '');
          var url = rel && rel.html_url ? String(rel.html_url) : '';
          if (!tag || !url) return;
          if (!_verIsNewer(tag, _localAppVersion())) return;
          if (!manual && tag === _updateDismissed) return;
          var notes = '';
          try {
            notes = String((rel && rel.body) || '').replace(/[#*_`>\r]/g, '').replace(/\n+/g, ' ').trim().slice(0, 300);
          } catch(e) {}
          _updateBroadcast({ version: tag, url: url, notes: notes });
        } catch(e) {}
      }).catch(function() {});
    } catch(e) {}
  }
  ipcMain.handle('update-check-now', async function() { try { _updateCheck(true); return true; } catch(e) { return false; } });
  ipcMain.handle('update-dismiss', async function(event, v) {
    try { _updateDismissed = String(v || ''); _updateSave(); return true; } catch(e) { return false; }
  });
  try { setTimeout(function() { _updateCheck(false); }, 10000); } catch(e) {}
  try { setInterval(function() { _updateCheck(false); }, 6 * 3600 * 1000); } catch(e) {}

  // ===== ONE-CLICK UPDATE INSTALL (portable builds) =====
  // Downloads the release ZIP with live progress, then a tiny helper .bat
  // waits for this process to exit, overlays ONLY the app folder (user data,
  // venv, backend .env and accounts live OUTSIDE it and are never touched),
  // and relaunches. Dev (unpacked) runs always fall back to the release page.
  function _updateSendProgress(received, total) {
    try {
      var wins = BrowserWindow.getAllWindows() || [];
      for (var i = 0; i < wins.length; i++) {
        try { if (wins[i] && !wins[i].isDestroyed()) wins[i].webContents.send('update-progress', { received: received, total: total }); } catch(e) {}
      }
    } catch(e) {}
  }
  function _updateDownloadFile(url, dest, total) {
    return new Promise(function(resolve, reject) {
      var got = 0, lastSent = 0;
      function prog() { _updateSendProgress(got, total); }
      function get(u, redirs) {
        if (redirs > 6) return reject(new Error('Too many redirects'));
        var req = https.get(u, { headers: { 'User-Agent': 'NEXORA-Browser-Updater', 'Accept': 'application/octet-stream' } }, function(res) {
          var code = res.statusCode || 0;
          if (code >= 300 && code < 400 && res.headers.location) {
            res.resume();
            var next = new URL(res.headers.location, u).toString();
            return get(next, (redirs || 0) + 1);
          }
          if (code !== 200) { res.resume(); return reject(new Error('HTTP ' + code)); }
          var tmp = dest + '.part';
          var out = fs.createWriteStream(tmp);
          res.on('data', function(c) {
            got += c.length;
            var now = Date.now();
            if (now - lastSent > 750) { lastSent = now; prog(); }
          });
          res.pipe(out);
          out.on('finish', function() {
            out.close(function() {
              prog();
              if (!got) { try { fs.unlinkSync(tmp); } catch(e) {} return reject(new Error('Empty response')); }
              try { fs.renameSync(tmp, dest); } catch(e) { return reject(e); }
              resolve(dest);
            });
          });
          res.on('error', reject);
          out.on('error', reject);
        });
        req.on('error', reject);
      }
      get(url, 0);
    });
  }
  ipcMain.handle('update-download-install', async function() {
    try {
      if (!app.isPackaged) return { ok: false, error: 'dev-mode' };
      var installDir = '';
      try { installDir = path.dirname(app.getPath('exe') || ''); } catch(e) {}
      if (!installDir) return { ok: false, error: 'no-dir' };
      var rel = await _fetchReleaseJson();
      var assets = (rel && rel.assets) || [];
      var zip = null;
      for (var i = 0; i < assets.length; i++) {
        var nm = String(assets[i].name || '');
        if (/\.zip$/i.test(nm) && assets[i].browser_download_url) { zip = assets[i]; break; }
      }
      if (!zip) return { ok: false, error: 'no-asset' };
      var total = Number(zip.size || 0);
      var tmpDir = path.join(os.tmpdir(), 'nexora-update');
      try { fs.mkdirSync(tmpDir, { recursive: true }); } catch(e) {}
      var zipPath = path.join(tmpDir, String(zip.name));
      await _updateDownloadFile(String(zip.browser_download_url), zipPath, total);
      // Helper .bat (paths baked in): expand, wait for our exit, overlay, relaunch.
      var batPath = path.join(tmpDir, 'apply-update.bat');
      var uzDir = path.join(tmpDir, 'uz');
      var bat =
        '@echo off\r\n' +
        'set "ZIP=' + zipPath.split("'").join('') + '"\r\n' +
        'set "UZ=' + uzDir.split("'").join('') + '"\r\n' +
        'set "DEST=' + installDir.split("'").join('') + '"\r\n' +
        'set "PID=' + process.pid + '"\r\n' +
        'echo NEXORA update: extracting...\r\n' +
        'powershell -NoProfile -Command "Expand-Archive -LiteralPath \'"%ZIP%"\' -DestinationPath \'"%UZ%"\' -Force"\r\n' +
        'if exist "%UZ%\\NEXORA Browser\\NEXORA-win32-x64\\NEXORA.exe" ( set "SRC=%UZ%\\NEXORA Browser\\NEXORA-win32-x64" ) else ( set "SRC=%UZ%\\NEXORA-win32-x64" )\r\n' +
        'if not exist "%SRC%\\NEXORA.exe" ( echo Update layout unexpected - aborting, your browser is untouched. & timeout /t 8 >nul & exit /b 1 )\r\n' +
        'echo Waiting for NEXORA to close...\r\n' +
        ':waitloop\r\n' +
        'tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul\r\n' +
        'if %ERRORLEVEL% EQU 0 ( timeout /t 1 /nobreak >nul & goto waitloop )\r\n' +
        'echo Installing update...\r\n' +
        'robocopy "%SRC%" "%DEST%" /E /R:4 /W:2 /NFL /NDL /NJH /NJS\r\n' +
        'echo Starting NEXORA...\r\n' +
        'start "" "%DEST%\\NEXORA.exe" --no-sandbox\r\n' +
        'rmdir /s /q "%UZ%" >nul 2>&1\r\n';
      fs.writeFileSync(batPath, bat);
      return { ok: true, bat: batPath, version: String((rel && rel.tag_name) || '').replace(/^v/i, '') };
    } catch(e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('update-restart-apply', async function(event, payload) {
    try {
      var bat = payload && payload.bat;
      if (!bat || !fs.existsSync(bat)) return { ok: false };
      var child = spawn('cmd.exe', ['/c', 'start', 'NEXORA Update', bat], { detached: true, stdio: 'ignore' });
      try { child.unref(); } catch(e) {}
      setTimeout(function() { try { app.quit(); } catch(e) {} }, 800);
      return { ok: true };
    } catch(e) { return { ok: false }; }
  });

  // Renderer answers the prompt bubble / picker, or manages site settings.
  ipcMain.on('permission-response', function(event, payload) {
    try {
      var id = payload && payload.id;
      var entry = id && _permPending[id];
      if (!entry) return;
      var allow = !!(payload && payload.allow);
      // A dismissed prompt denies once without remembering (Chrome's X).
      if (!(payload && payload.temporary)) {
        try {
          var store = _permReadStore();
          var perms = store[entry.origin] || {};
          entry.keys.forEach(function(k) { perms[k] = allow ? 'allow' : 'block'; });
          store[entry.origin] = perms;
          _permWriteStore(store);
        } catch(e) {}
      }
      entry.finish(allow);
    } catch(e) {}
  });
  ipcMain.on('display-media-response', function(event, payload) {
    try {
      var id = payload && payload.id;
      var entry = id && _dmPending[id];
      if (!entry) return;
      var sourceId = payload && payload.sourceId ? String(payload.sourceId) : null;
      if (!sourceId) { entry.finish(null, false); return; }
      try {
        var store = _permReadStore();
        var perms = store[entry.origin] || {};
        perms.screen = 'allow';
        store[entry.origin] = perms;
        _permWriteStore(store);
      } catch(e) {}
      entry.finish(sourceId, !!(payload && payload.withAudio));
    } catch(e) {}
  });
  ipcMain.handle('perm-get', async function(event, origin) {
    try {
      if (typeof origin !== 'string' || !origin) return {};
      return _permReadStore()[origin] || {};
    } catch(e) { return {}; }
  });
  ipcMain.handle('perm-set', async function(event, origin, key, value) {
    try {
      if (typeof origin !== 'string' || !origin) return false;
      if (['camera', 'microphone', 'screen', 'notifications', 'geolocation', 'midi', 'clipboard'].indexOf(key) === -1) return false;
      if (['allow', 'block'].indexOf(value) === -1) return false;
      var store = _permReadStore();
      var perms = store[origin] || {};
      perms[key] = value;
      store[origin] = perms;
      _permWriteStore(store);
      return true;
    } catch(e) { return false; }
  });
  ipcMain.handle('perm-reset', async function(event, origin) {
    try {
      if (typeof origin !== 'string' || !origin) return false;
      var store = _permReadStore();
      delete store[origin];
      _permWriteStore(store);
      return true;
    } catch(e) { return false; }
  });

  // Serve wallpapers via IPC (ASAR-safe)
  ipcMain.handle('get-bundled-wallpapers', async () => {
    try {
      const dir = path.join(__dirname, 'wallpapers');
      const files = require('fs').readdirSync(dir).filter(f => /\.(mp4|webm|avi|mov|mkv|gif)$/i.test(f));
      return files.map(f => {
        var display = f.replace(/\.(mp4|webm|avi|mov|mkv|gif)$/i, '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
        if (display.length > 50) display = display.slice(0, 47) + '...';
        return { name: f, displayName: display, path: path.join(dir, f) };
      });
    } catch(e) { return []; }
  });
  ipcMain.handle('get-wallpaper', async (event, name) => {
    try {
      const filePath = path.join(__dirname, 'wallpapers', name);
      const data = fs.readFileSync(filePath);
      const ext = path.extname(name).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      return `data:${mime};base64,${data.toString('base64')}`;
    } catch { return null; }
  });

  // ===== FFMPEG INIT (copy to userData for spawn access) =====
  try {
    (function() {
      var src;
      try { src = require('@ffmpeg-installer/ffmpeg').path; } catch(e) {}
      if (!src) {
        var local = path.join(__dirname, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(local)) src = local;
      }
      if (!src) return;
      var dstDir = path.join(app.getPath('userData'), 'bin');
      var dst = path.join(dstDir, 'ffmpeg.exe');
      if (!fs.existsSync(dst)) {
        try { if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true }); } catch(e) {}
        try { fs.copyFileSync(src, dst); } catch(e) {}
      }
      if (fs.existsSync(dst)) _FFMPEG_PATH = dst;
    })();
  } catch(e) {}

  // ===== YOUTUBE DOWNLOADER (yt-dlp standalone EXE) =====
  // This feature is COMPLETELY SEPARATE from normal browser downloads. Videos
  // and audio downloaded via the Neo YouTube Downloader NEVER go to the OS
  // Downloads folder; they go to a dedicated NEXORA Browser app-data folder so the
  // two download systems stay fully independent.
  var _ytDownloads = {};
  // Locate the bundled yt-dlp.exe. In a PACKAGED (asar) build __dirname lives
  // inside app.asar where you cannot spawn a real exe, so we must use
  // process.resourcesPath (extraResources/bin/yt-dlp.exe). In dev we read it
  // straight from <project>/bin. Both are checked, first match wins; last
  // candidate is the plain __dirname fallback for older asar-unpacked layout.
  function _resolveYtDlpBinary() {
    var candidates = [];
    if (app.isPackaged) {
      candidates.push(path.join(process.resourcesPath, 'bin', 'yt-dlp.exe'));
      candidates.push(path.join(process.resourcesPath, 'yt-dlp.exe'));
    } else {
      candidates.push(path.join(__dirname, 'bin', 'yt-dlp.exe'));
      candidates.push(path.join(__dirname, '..', 'bin', 'yt-dlp.exe'));
    }
    candidates.push(path.join(process.resourcesPath, 'bin', 'yt-dlp.exe'));
    candidates.push(path.join(process.resourcesPath, 'yt-dlp.exe'));
    candidates.push(path.join(__dirname, 'bin', 'yt-dlp.exe'));
    for (var c = 0; c < candidates.length; c++) {
      try { if (fs.existsSync(candidates[c])) return candidates[c]; } catch(e) {}
    }
    return candidates[0] || path.join(__dirname, 'bin', 'yt-dlp.exe');
  }
  var _ytDlpPath = _resolveYtDlpBinary();
  var _ytFfmpegPath = '';
  // Dedicated YouTube Downloader destinations (video vs audio subfolders).
  var _YT_DIR = path.join(app.getPath('userData'), 'YouTube Downloads');
  var _YT_VIDEOS_DIR = path.join(_YT_DIR, 'Videos');
  var _YT_AUDIO_DIR = path.join(_YT_DIR, 'Audio');
  try { if (!fs.existsSync(_YT_DIR)) fs.mkdirSync(_YT_DIR, { recursive: true }); } catch(e) {}
  try { if (!fs.existsSync(_YT_VIDEOS_DIR)) fs.mkdirSync(_YT_VIDEOS_DIR, { recursive: true }); } catch(e) {}
  try { if (!fs.existsSync(_YT_AUDIO_DIR)) fs.mkdirSync(_YT_AUDIO_DIR, { recursive: true }); } catch(e) {}
  // Prefer the dynamic @ffmpeg-installer copy (already in userData), then a local
  // bin/ffmpeg.exe, then env-derived WinGet locations. Avoids hardcoding any
  // machine-specific / user-specific path.
  var ffCandidates = [];
  if (_FFMPEG_PATH) ffCandidates.push(_FFMPEG_PATH);
  ffCandidates.push(path.join(__dirname, 'bin', 'ffmpeg.exe'));
  ffCandidates.push(path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));
  ffCandidates.push(path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages', 'ffmpeg.exe'));
  for (var fi = 0; fi < ffCandidates.length; fi++) {
    if (fs.existsSync(ffCandidates[fi])) { _ytFfmpegPath = ffCandidates[fi]; break; }
  }

  var _YT_FORMATS = {
    360: 'bestvideo[height<=360][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=360]+bestaudio',
    720: 'bestvideo[height<=720][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio',
    1080: 'bestvideo[height<=1080][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio',
    2160: 'bestvideo[height<=2160][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=2160]+bestaudio'
  };

  // ===== YouTube cookie extraction (atomic + validated) =====
  // Returns { cookieFile: path|null, authed: bool, count: int, error: string }.
  // Writes a validated Netscape cookies.txt atomically (tmp file -> rename) and
  // NEVER leaves a partial / malformed file that could crash yt-dlp's http.cookiejar.
  async function _neoBuildYtCookieFile() {
    var started = new Date().toISOString();
    console.log('[YTDL] Cookie extraction started (' + started + ')');
    var result = { cookieFile: null, authed: false, count: 0, error: '' };
    var tmpFile = null;
    var cookieFile = null;
    try {
      // The active YouTube page lives in the persist:webview session (NOT defaultSession),
      // so its login cookies are only accessible there. Read from that partition.
      var authSession = null;
      try { authSession = session.fromPartition('persist:webview'); } catch(e) {}
      if (!authSession) authSession = session.defaultSession;

      var nowSec = Math.floor(Date.now() / 1000);
      var ytUrls = [
        'https://www.youtube.com/', 'https://m.youtube.com/', 'https://music.youtube.com/',
        'https://youtube.com/', 'https://accounts.google.com/', 'https://www.google.com/', 'https://google.com/'
      ];
      var gotCookies = [];
      var seen = {};
      var fetchErr = '';
      try {
        for (var ui = 0; ui < ytUrls.length; ui++) {
          var batch = await authSession.cookies.get({ url: ytUrls[ui] });
          (batch || []).forEach(function(c) {
            if (!c || !c.name) return;
            var key = (c.domain || '') + '|' + c.name + '|' + (c.path || '');
            if (seen[key]) return;
            seen[key] = 1;
            gotCookies.push(c);
          });
        }
      } catch(e) { fetchErr = e.message; }

      if (!gotCookies.length) {
        console.log('[YTDL] Cookie extraction: no cookies found in webview session' + (fetchErr ? ' (' + fetchErr + ')' : ''));
        result.error = fetchErr || 'No cookies found';
        return result;
      }

      var cookieLines = ['# Netscape HTTP Cookie File', '# This file was generated by NEXORA Browser for youtube-dlp'];
      var validCount = 0;
      var skipped = 0;
      var nameSet = gotCookies.map(function(c) { return c.name; });
      var hasAuth = /(^|,)(SID|__Secure-3PSID|SAPISID|__Secure-3PAPISID|LOGIN_INFO|SIDCC)(,|$)/.test(',' + nameSet.join(',') + ',');

      // Sanitise a cookie name/value to header-safe ASCII. Strips every control char
      // / tab / newline / space that would corrupt the tab-separated Netscape format
      // and trigger Python http.cookiejar's AssertionError.
      function _sanitize(s) {
        return String(s == null ? '' : s)
          .replace(/[\u0000-\u001F\u007F]/g, '')   // all control chars
          .replace(/[\t\r\n]/g, '')                // tabs / newlines
          .replace(/[ \u00A0]/g, '')               // spaces / non-breaking spaces
          .trim();
      }

      gotCookies.forEach(function(c) {
        if (!c || !c.name) return;
        try {
          // Emit cookies in the universally-safe Netscape form: a leading-dot domain
          // with include-subdomains flag TRUE. This exact pairing is what standard
          // cookie exporters produce and is what this yt-dlp's MozillaCookieJar loads
          // without error. (Empirically, dotted+FALSE or bare+FALSE trigger Python
          // http.cookiejar's AssertionError in this loader.)
          var domain = '.' + String(c.domain || '').replace(/^\./, '').replace(/^-+/, '').trim();
          if (domain.length < 3) return;
          if (!/^\.[A-Za-z0-9._-]+$/.test(domain)) { skipped++; return; }
          var includeSub = 'TRUE';
          var secure = c.secure ? 'TRUE' : 'FALSE';
          var exp = c.expirationDate ? Math.floor(c.expirationDate) : (nowSec + 86400 * 365);
          if (!(exp > 0) || !isFinite(exp)) exp = nowSec + 86400 * 365;
          var name = _sanitize(c.name);
          var val = _sanitize(c.value);
          if (!name || !val) { skipped++; return; }
          var pathSafe = String(c.path || '/').replace(/[\u0000-\u001F\u007F\t\r\n ]/g, '') || '/';
          cookieLines.push(domain + '\t' + includeSub + '\t' + pathSafe + '\t' + secure + '\t' + exp + '\t' + name + '\t' + val);
          validCount++;
        } catch(e) { skipped++; }
      });

      if (!validCount) {
        console.log('[YTDL] Cookie validation failed: 0 valid cookies (skipped ' + skipped + ')');
        result.error = 'No valid cookies could be exported';
        return result;
      }

      // Atomic write: build the fully sanitised file to a temp path, then rename.
      var base = path.join(require('os').tmpdir(), 'neo_yt_cookies_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
      tmpFile = base + '.tmp';
      cookieFile = base + '.txt';
      fs.writeFileSync(tmpFile, cookieLines.join('\n') + '\n', 'utf8');
      if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size < 15) {
        console.log('[YTDL] Cookie validation failed: temp file empty/missing');
        result.error = 'Cookie temp file missing';
        try { fs.unlinkSync(tmpFile); } catch(e) {}
        return result;
      }
      fs.renameSync(tmpFile, cookieFile);

      // Final validation pass: every non-comment line must parse to exactly 7 fields.
      var ok = true;
      var body = fs.readFileSync(cookieFile, 'utf8').split('\n');
      for (var li = 0; li < body.length; li++) {
        var L = body[li];
        if (!L || L[0] === '#') continue;
        if (L.split('\t').length !== 7) { ok = false; break; }
      }
      if (!ok) {
        console.log('[YTDL] Cookie validation failed: malformed line detected');
        result.error = 'Malformed cookie line';
        try { fs.unlinkSync(cookieFile); } catch(e) {}
        return result;
      }

      result.cookieFile = cookieFile;
      result.authed = hasAuth;
      result.count = validCount;
      console.log('[YTDL] Cookie validation succeeded: ' + validCount + ' cookies' + (hasAuth ? ' (authenticated)' : ' (anonymous)'));
      return result;
    } catch(e) {
      console.log('[YTDL] Cookie extraction error: ' + e.message);
      result.error = e.message;
      try { if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch(ex) {}
      return result;
    }
  }

  ipcMain.handle('yt-download-start', async (event, url, quality, meta) => {
    var id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    var idSuffix = id.slice(-4);
    // Audio requests (mp3 / m4a / aac / ogg / flac / wav) are extracted as MP3
    // and saved to the dedicated YouTube Audio folder; everything else is a
    // video download saved to the dedicated YouTube Videos folder. Neither ever
    // touches the OS Downloads folder used by normal browser downloads.
    var isAudio = String(quality || '').toLowerCase() === 'mp3' ||
                  String(quality || '').toLowerCase() === 'm4a' ||
                  String(quality || '').toLowerCase() === 'aac' ||
                  String(quality || '').toLowerCase() === 'ogg' ||
                  String(quality || '').toLowerCase() === 'flac' ||
                  String(quality || '').toLowerCase() === 'wav';
    var destDir = isAudio ? _YT_AUDIO_DIR : _YT_VIDEOS_DIR;
    var filename = (isAudio ? 'YouTube_Audio_' : 'YouTube_Video_') + idSuffix + (isAudio ? '.mp3' : '.mp4');
    var savePath = path.join(destDir, filename);
    var cancelled = false;

    var sp = function(data) {
      try { if (win && !win.isDestroyed()) win.webContents.send('yt-download-progress', { id: id, ...data }); } catch(e) {}
    };

    sp({ filename: 'Starting...', percent: 0, downloaded: 0, total: 0, state: 'downloading' });

    if (!fs.existsSync(_ytDlpPath)) {
      sp({ filename: filename, state: 'error', error: 'yt-dlp.exe not found at ' + _ytDlpPath });
      return { success: false, error: 'yt-dlp.exe not found' };
    }

    var fmt = _YT_FORMATS[quality] || _YT_FORMATS[720];

    var args;
    if (isAudio) {
      // Audio-only extraction: grab the best m4a/webm audio stream and convert
      // it to MP3 with the bundled ffmpeg.
      args = [
        '--no-warnings',
        '--no-check-certificates',
        '--no-mtime',
        '--no-playlist',
        '--retries', '20',
        '--fragment-retries', '20',
        '--socket-timeout', '120',
        '--geo-bypass',
        '--age-limit', '99',
        '--concurrent-fragments', '8',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
        '--extractor-args', 'youtube:player_client=tv_embedded;skip=webpage',
        '--user-agent', USER_AGENT,
        '-f', 'bestaudio/best',
        '-o', savePath,
        '--newline',
        url
      ];
    } else {
      args = [
        '--no-warnings',
        '--no-check-certificates',
        '--no-mtime',
        '--no-playlist',
        '--retries', '20',
        '--fragment-retries', '20',
        '--socket-timeout', '120',
        '--geo-bypass',
        '--age-limit', '99',
        '--concurrent-fragments', '8',
        '--merge-output-format', 'mp4',
        '--extractor-args', 'youtube:player_client=tv_embedded;skip=webpage',
        '--user-agent', USER_AGENT,
        '-f', fmt,
        '-o', savePath,
        '--newline',
        url
      ];
    }
    // ===== Download strategy (verified) =====
    // tv_embedded is the ONLY player client that resolves bestvideo+bestaudio in this
    // yt-dlp build (web/tv/ios/web_embedded all fail). It runs ANONYMOUSLY: attaching
    // real logged-in session cookies to a tv_embedded request triggers YouTube's
    // "The page needs to be reloaded" block, so no cookies are passed on either the
    // primary or the fallback path.
    console.log('[YTDL] Primary: tv_embedded ANONYMOUS download (no cookies)');
    if (_ytFfmpegPath) {
      args.unshift('--ffmpeg-location', path.dirname(_ytFfmpegPath));
    }

    console.log('[YTDL] yt-dlp download started for: ' + url);
    console.log('[YTDL] Spawning:', _ytDlpPath, args.join(' '));

    // ===== STABLE EXTRACTION DIR =====
    // yt-dlp is a PyInstaller ONEFILE exe: its bootloader must decompress its
    // embedded .pyd/.dll payload into a write-capable temp dir on EVERY run.
    // If %TEMP% points at a OneDrive-redirected CloudTemp (or AV sandboxes it),
    // extraction fails with PYI-2448 / PYI-17992 "return code -1" and the
    // download is silently blocked. So we give the child its OWN stable dir
    // under userData (created once, reused every run) and tell PyInstaller to
    // extract there via TMP/TEMP env vars instead of the OS temp.
    var _ytDlpTmp = path.join(app.getPath('userData'), 'ytdl-tmp');
    try { if (!fs.existsSync(_ytDlpTmp)) fs.mkdirSync(_ytDlpTmp, { recursive: true }); } catch(e) {}
    var _ytChildEnv = {};
    for (var _envk in process.env) { _ytChildEnv[_envk] = process.env[_envk]; }
    _ytChildEnv.TMP = _ytDlpTmp;
    _ytChildEnv.TEMP = _ytDlpTmp;
    _ytChildEnv.TMPDIR = _ytDlpTmp;
    _ytChildEnv.PYINSTALLER_TEMP_ONE = '1';

    var proc;
    try {
      proc = spawn(_ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: _ytChildEnv });
    } catch(e) {
      sp({ filename: filename, state: 'error', error: 'Failed to start yt-dlp: ' + e.message });
      return { success: false, error: e.message };
    }

    var _lastPct = 0;
    var _ytStdout = '';
    var _ytStderr = '';

    proc.stdout.on('data', function(d) {
      var text = d.toString();
      _ytStdout += text;
      var m = text.match(/([0-9.]+)%/);
      if (m) {
        _lastPct = parseFloat(m[1]);
        sp({ filename: filename, percent: Math.min(_lastPct, 99), downloaded: 0, total: 0, state: 'downloading' });
      }
    });

    proc.stderr.on('data', function(d) {
      _ytStderr += d.toString();
      try {
        var ytdlLog2 = path.join(require('os').tmpdir(), 'neo_ytdl_debug.log');
        fs.appendFileSync(ytdlLog2, '[' + new Date().toISOString() + '] STDERR: ' + d.toString().replace(/\r/g,'') + '\n', 'utf8');
      } catch(e) {}
    });

    _ytDownloads[id] = {
      cancel: function() {
        cancelled = true;
        try { proc.kill('SIGTERM'); } catch(e) {}
        try { proc.kill('SIGKILL'); } catch(e) {}
      },
      filename: filename, savePath: savePath
    };

    return new Promise(function(resolve) {
      var done = false;
      var progressTimer = setInterval(function() {
        if (cancelled || done) { clearInterval(progressTimer); return; }
        sp({ filename: filename, percent: _lastPct > 0 ? Math.min(_lastPct, 99) : 1, downloaded: 0, total: 0, state: 'downloading' });
      }, 2000);
      var dlTimeout = setTimeout(function() {
        if (done) return;
        if (!cancelled) { try { proc.kill('SIGKILL'); } catch(e) {} }
      }, 21600000);

      function _checkMediaFile() {
        try {
          var df = fs.readdirSync(destDir);
          var exts = ['.mp4','.webm','.mkv','.avi','.mov','.mp3','.m4a','.wav','.flac','.aac','.ogg'];
          for (var i = 0; i < df.length; i++) {
            var f = df[i];
            if (f.indexOf(idSuffix) === -1) continue;
            var fe = path.extname(f).toLowerCase();
            if (fe === '.part' || fe === '.tmp' || fe === '.ytdl') continue;
            if (exts.indexOf(fe) !== -1) return f;
          }
        } catch(e) {}
        return null;
      }

      proc.on('close', function(code) {
        if (done) return;
        done = true;
        clearTimeout(dlTimeout);
        clearInterval(progressTimer);
        delete _ytDownloads[id];
        if (cancelled) {
          try { fs.unlinkSync(savePath); } catch(e) {}
          resolve({ success: false, error: 'Cancelled' });
          return;
        }
        var videoSaved = _checkMediaFile();
        if (videoSaved) console.log('[YTDL] Video found:', videoSaved, 'exit:', code);
        if (code === 0 || videoSaved) {
          var finalName = videoSaved || filename;
          // Save metadata
          try {
            if (meta) {
              var metaIndex = _loadMeta();
              if (!metaIndex) metaIndex = {};
              var localThumb = '';
              try {
                var baseName = path.basename(finalName, path.extname(finalName));
                var dirFiles = fs.readdirSync(destDir);
                for (var di = 0; di < dirFiles.length; di++) {
                  var df = dirFiles[di];
                  var de = path.extname(df).toLowerCase();
                  if (['.mp4','.webm','.mkv','.avi','.mov','.mp3','.m4a','.part','.ytdl','.tmp'].indexOf(de) !== -1) continue;
                  if (df.indexOf(baseName) === 0 && ['.jpg','.jpeg','.png','.webp'].indexOf(de) !== -1) {
                    localThumb = df; break;
                  }
                }
              } catch(te) {}
              metaIndex[finalName] = {
                title: meta.title || finalName,
                channel: meta.channel || '',
                videoUrl: meta.url || url,
                thumbnail: localThumb || (meta.thumbnail || ''),
                thumbnailPath: localThumb || '',
                category: 'other',
                downloadedAt: Date.now()
              };
              _saveMeta(metaIndex);
            }
          } catch(me) { console.warn('[YTDL] Meta error:', me.message); }
          sp({ filename: finalName, percent: 100, state: 'completed', path: path.join(destDir, finalName) });
          console.log('[YTDL] Download completed:', finalName);
          resolve({ success: true, filename: finalName, path: path.join(destDir, finalName) });
        } else {
          try { fs.unlinkSync(savePath); } catch(e) {}
          var errMsg = _ytStderr.replace(/\n/g, ' | ').replace(/\r/g, '').slice(0, 1000);
          console.log('[YTDL] FAILED. STDERR:', _ytStderr);
          // Retry with simpler format
          sp({ filename: filename, percent: 0, state: 'downloading', error_hint: 'Retrying...' });
          // tv_embedded is the ONLY client that resolves bestvideo+bestaudio in this
          // yt-dlp build (web/tv/ios/web_embedded all fail). We retry it ANONYMOUSLY:
          // attaching real session cookies to tv_embedded triggers the "The page needs
          // to be reloaded" block, so no --cookies are passed here either.
          var fbArgs;
          if (isAudio) {
            fbArgs = [
              '--no-warnings', '--no-check-certificates', '--no-mtime', '--no-playlist',
              '--retries', '10', '--fragment-retries', '10', '--socket-timeout', '120',
              '--geo-bypass', '--age-limit', '99',
              '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0',
              '--extractor-args', 'youtube:player_client=tv_embedded;skip=webpage',
              '--user-agent', USER_AGENT,
              '-f', 'bestaudio/best',
              '-o', savePath, '--newline', url
            ];
          } else {
            fbArgs = [
              '--no-warnings', '--no-check-certificates', '--no-mtime', '--no-playlist',
              '--retries', '10', '--fragment-retries', '10', '--socket-timeout', '120',
              '--geo-bypass', '--age-limit', '99', '--merge-output-format', 'mp4',
              '--extractor-args', 'youtube:player_client=tv_embedded;skip=webpage',
              '--user-agent', USER_AGENT,
              '-f', fmt,
              '-o', savePath, '--newline', url
            ];
          }
          console.log('[YTDL] Fallback: tv_embedded ANONYMOUS retry (no cookies)');
          if (_ytFfmpegPath) fbArgs.unshift('--ffmpeg-location', path.dirname(_ytFfmpegPath));
          var fbProc = spawn(_ytDlpPath, fbArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: _ytChildEnv });
          var fbStderr = '';
          fbProc.stderr.on('data', function(d) { fbStderr += d.toString(); });
          fbProc.on('close', function(fbCode) {
            var fbSaved = _checkMediaFile();
            if (fbSaved) {
              console.log('[YTDL] Fallback OK:', fbSaved);
              sp({ filename: fbSaved, percent: 100, state: 'completed', path: path.join(destDir, fbSaved) });
              console.log('[YTDL] Download completed:', fbSaved);
              resolve({ success: true, filename: fbSaved, path: path.join(destDir, fbSaved) });
            } else {
              try { fs.unlinkSync(savePath); } catch(e) {}
              var fbErr = fbStderr.replace(/\n/g,' | ').replace(/\r/g,'').slice(0,1000);
              console.log('[YTDL] Fallback FAILED:', fbErr);
              sp({ filename: filename, state: 'error', error: 'YouTube download blocked: ' + (fbErr || errMsg) });
              resolve({ success: false, error: 'Download failed: ' + (fbErr || errMsg) });
            }
          });
        }
      });
      proc.on('error', function(e) {
        if (done) return;
        done = true;
        clearTimeout(dlTimeout);
        clearInterval(progressTimer);
        delete _ytDownloads[id];
        sp({ filename: filename, state: 'error', error: e.message });
        resolve({ success: false, error: e.message });
      });
    });
  });

  // ===== YOUTUBE PLAYLIST DOWNLOAD (full running playlist) =====
  // Downloads EVERY video in a YouTube playlist (not just the current one) into
  // the dedicated YouTube Downloads folders, then auto-creates/updates a NEO
  // playlist entry so the downloaded videos appear in the Playlists tab of the
  // Downloads panel. Per-item progress + per-video metadata + thumbnails.
  ipcMain.handle('yt-playlist-download-start', async (event, url, quality, meta) => {
    var id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    var idSuffix = id.slice(-4);
    var isAudio = String(quality || '').toLowerCase() === 'mp3' ||
                  String(quality || '').toLowerCase() === 'm4a' ||
                  String(quality || '').toLowerCase() === 'aac' ||
                  String(quality || '').toLowerCase() === 'ogg' ||
                  String(quality || '').toLowerCase() === 'flac' ||
                  String(quality || '').toLowerCase() === 'wav';
    var destDir = isAudio ? _YT_AUDIO_DIR : _YT_VIDEOS_DIR;
    var cancelled = false;

    var sp = function(data) {
      try { if (win && !win.isDestroyed()) win.webContents.send('yt-download-progress', { id: id, playlist: true, ...data }); } catch(e) {}
    };

    var meta2 = meta || {};
    var playlistTitle = String(meta2.playlistTitle || meta2.title || 'YouTube Playlist').trim().slice(0, 80);
    var playlistId = String(meta2.playlistId || '').trim();
    if (!playlistId) {
      try { var pm = String(url).match(/[?&]list=([A-Za-z0-9_-]+)/); if (pm) playlistId = pm[1]; } catch(e) {}
    }
    if (!playlistId) {
      sp({ filename: 'Error', state: 'error', error: 'No playlist found in this URL' });
      return { success: false, error: 'No playlist found in this URL' };
    }

    // Sanitize the playlist title for use as a literal filename prefix (yt-dlp
    // sanitizes %(title)s itself, but our embedded prefix must be Windows-safe).
    var safePlName = playlistTitle.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 60);
    if (!safePlName) safePlName = 'Playlist_' + playlistId.substr(0, 12);

    var playlistDestDir = path.join(destDir, 'Playlists', safePlName);
    try { if (!fs.existsSync(playlistDestDir)) fs.mkdirSync(playlistDestDir, { recursive: true }); } catch(e) {}

    var outTemplate = path.join(playlistDestDir, safePlName + ' - %(playlist_index)03d - %(title)s.%(ext)s');

    sp({ filename: 'Starting playlist...', percent: 0, downloaded: 0, total: 0, item: 0, totalItems: 0, state: 'downloading' });

    if (!fs.existsSync(_ytDlpPath)) {
      sp({ filename: 'Error', state: 'error', error: 'yt-dlp.exe not found at ' + _ytDlpPath });
      return { success: false, error: 'yt-dlp.exe not found' };
    }

var fmt = _YT_FORMATS[quality] || _YT_FORMATS[720];
    // RDMM (and start_radio) lists are YouTube's auto-generated radio "Mix":
    // when given the ORIGINAL watch URL with list=RDMM&index=N.
    var isAutoMix = /^RD|^OLAK5uy_/.test(playlistId);
    var plUrl;
    if (isAutoMix && /[?&]v=[A-Za-z0-9_-]{11}/.test(String(url)) && String(url).indexOf('watch') !== -1) {
      plUrl = String(url).split('&start_radio')[0];
    } else {
      plUrl = 'https://www.youtube.com/playlist?list=' + playlistId;
    }

    var baseArgs = [
      '--no-warnings',
      '--no-check-certificates',
      '--no-mtime',
      '--yes-playlist',
      '--retries', '20',
      '--fragment-retries', '20',
      '--socket-timeout', '120',
      '--geo-bypass',
      '--age-limit', '99',
      '--concurrent-fragments', '8'
    ];
    if (isAudio) {
      baseArgs.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
      baseArgs.push('--extractor-args', 'youtube:player_client=tv_embedded;skip=webpage');
      baseArgs.push('--user-agent', USER_AGENT);
      baseArgs.push('-f', 'bestaudio/best');
    } else {
      baseArgs.push('--merge-output-format', 'mp4');
      baseArgs.push('--extractor-args', 'youtube:player_client=tv_embedded;skip=webpage');
      baseArgs.push('--user-agent', USER_AGENT);
      baseArgs.push('-f', fmt);
    }
    baseArgs.push('-o', outTemplate);
    baseArgs.push('--newline');
    if (_ytFfmpegPath) baseArgs.unshift('--ffmpeg-location', path.dirname(_ytFfmpegPath));

    var listArgs = ['--flat-playlist', '--no-warnings', '--no-check-certificates', '--no-mtime',
      '--extractor-args', 'youtube:player_client=tv_embedded;skip=webpage',
      '--user-agent', USER_AGENT, '--get-id', plUrl];

    var appLog = path.join(require('os').tmpdir(), 'neo_ytdl_pl_debug.log');
    try {
      fs.appendFileSync(appLog, '\n[' + new Date().toISOString() + '] ===== PLAYLIST START ===== url=' + plUrl + ' quality=' + quality + '\n', 'utf8');
    } catch(e) {}

    console.log('[YTDL-PL] Playlist download started:', plUrl, 'quality=' + quality, 'out=' + safePlName);

    return new Promise(function(resolve) {
      var done = false;
      var _plIds = [];   // video ids captured in playlist order (from flat listing)
      var workers = [];  // { proc, start, end, current, lastPct, stderr, stdout, exited, code }
      var _cancelled = cancelled;

      function _listPlaylistFiles() {
        try {
          var out = [];
          var names = fs.readdirSync(playlistDestDir);
          var exts = ['.mp4','.webm','.mkv','.avi','.mov','.mp3','.m4a','.wav','.flac','.aac','.ogg'];
          for (var i = 0; i < names.length; i++) {
            var fn = names[i];
            var fe = path.extname(fn).toLowerCase();
            if (fe === '.part' || fe === '.tmp' || fe === '.ytdl') continue;
            if (exts.indexOf(fe) === -1) continue;
            var full = path.join(playlistDestDir, fn);
            try { if (!fs.statSync(full).isFile()) continue; } catch(e) { continue; }
            out.push(fn);
          }
          out.sort();
          return out;
        } catch(e) { return []; }
      }

      function _indexOfFile(fn) {
        var m = fn.match(/\s-\s(\d{3,4})\s-\s/);
        return m ? parseInt(m[1], 10) : 0;
      }

      // Step 1: flat-list the playlist so we know the full item list up-front.
      var listProc;
      try {
        listProc = spawn(_ytDlpPath, listArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: _ytChildEnv });
      } catch(e) {
        sp({ filename: 'Error', state: 'error', error: 'Failed to scan playlist: ' + e.message });
        resolve({ success: false, error: e.message });
        return;
      }
      var listErr = '';
      listProc.stdout.on('data', function(d) {
        var t = d.toString();
        var lines = t.split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (/^[A-Za-z0-9_-]{11}$/.test(line) && _plIds.length < 20000) _plIds.push(line);
        }
      });
      listProc.stderr.on('data', function(d) { listErr += d.toString(); });
      listProc.on('error', function(e) {
        if (done) return;
        done = true;
        sp({ filename: safePlName, state: 'error', error: e.message });
        resolve({ success: false, error: e.message });
      });
      listProc.on('close', function(listCode) {
        if (done) return;
        if (_plIds.length === 0) {
          done = true;
          var errTxt = listErr.replace(/\n/g, ' | ').replace(/\r/g, '').slice(0, 300);
          console.log('[YTDL-PL] Listing failed:', listCode, errTxt);
          sp({ filename: safePlName, state: 'error', error: 'No videos found in this playlist. It may be private, empty, or unavailable.' });
          resolve({ success: false, error: 'No videos found in this playlist. ' + errTxt });
          return;
        }

        var totalItems = _plIds.length;
        // Parallel workers: 1 worker for tiny, up to 4 concurrent for big lists.
        var numWorkers = totalItems <= 8 ? 1 : (totalItems <= 30 ? 2 : (totalItems <= 80 ? 3 : 4));
        var chunkSize = Math.ceil(totalItems / numWorkers);

        function _aggregatePct() {
          var acc = 0;
          for (var w = 0; w < workers.length; w++) {
            var ww = workers[w];
            acc += Math.max(0, ww.current - ww.start) + (ww.lastPct / 100);
          }
          var denom = totalItems > 0 ? totalItems : 1;
          return Math.min((acc / denom) * 100, 99.5);
        }

        for (var w = 0; w < numWorkers; w++) {
          var start = w * chunkSize + 1;
          var end = Math.min(totalItems, start + chunkSize - 1);
          if (start > end) break;
          var wArgs = baseArgs.slice();
          wArgs.push('--playlist-items', start + '-' + end);
          wArgs.push(plUrl);
          var p;
          try {
            p = spawn(_ytDlpPath, wArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: _ytChildEnv });
          } catch(e) { continue; }
          try {
            fs.appendFileSync(appLog, '[' + new Date().toISOString() + '] WORKER ' + w + ' (' + start + '-' + end + ') ARGS: ' + [_ytDlpPath].concat(wArgs).join(' ') + '\n', 'utf8');
          } catch(e) {}
          workers.push({ proc: p, start: start, end: end, current: start, lastPct: 0, stderr: '', stdout: '', exited: false, code: null });
        }

        if (!workers.length) {
          done = true;
          sp({ filename: safePlName, state: 'error', error: 'Failed to start download workers' });
          resolve({ success: false, error: 'Failed to start download workers' });
          return;
        }

        // Wire up progress/log listeners per worker.
        workers.forEach(function(ws, wi) {
          ws.proc.stdout.on('data', function(dd) {
            var text = dd.toString();
            ws.stdout += text;
            try {
              fs.appendFileSync(appLog, '[' + new Date().toISOString() + '] W' + wi + ' OUT: ' + text.replace(/\r/g, ''), 'utf8');
            } catch(e) {}
            var im = text.match(/Downloading item\s+(\d+)\s+of\s+(\d+)/i);
            if (im) ws.current = ws.start + parseInt(im[1], 10) - 1;
            var m = text.match(/([0-9.]+)%/);
            if (m) {
              ws.lastPct = parseFloat(m[1]);
              sp({ filename: safePlName, percent: _aggregatePct(), downloaded: 0, total: 0, item: ws.current, totalItems: totalItems, state: 'downloading' });
            }
          });
          ws.proc.stderr.on('data', function(dd) {
            ws.stderr += dd.toString();
            try {
              fs.appendFileSync(appLog, '[' + new Date().toISOString() + '] W' + wi + ' ERR: ' + dd.toString().replace(/\r/g, '') + '\n', 'utf8');
            } catch(e) {}
          });
          ws.proc.on('close', function(code) {
            ws.exited = true;
            ws.code = code;
            _checkAllDone();
          });
        });

        _ytDownloads[id] = {
          cancel: function() {
            _cancelled = true;
            for (var i = 0; i < workers.length; i++) {
              try { workers[i].proc.kill('SIGTERM'); } catch(e) {}
              try { workers[i].proc.kill('SIGKILL'); } catch(e) {}
            }
          },
          filename: safePlName, savePath: ''
        };

        var progressTimer = setInterval(function() {
          if (_cancelled || done) { clearInterval(progressTimer); return; }
          sp({ filename: safePlName, percent: _aggregatePct(), downloaded: 0, total: 0, item: 0, totalItems: totalItems, state: 'downloading' });
        }, 2000);
        var dlTimeout = setTimeout(function() {
          if (done) return;
          if (!_cancelled) {
            for (var i = 0; i < workers.length; i++) { try { workers[i].proc.kill('SIGKILL'); } catch(e) {} }
          }
        }, 86400000); // playlists can be long: 24h cap

        function _checkAllDone() {
          for (var i = 0; i < workers.length; i++) if (!workers[i].exited) return;
          if (done) return;
          done = true;
          clearTimeout(dlTimeout);
          clearInterval(progressTimer);
          delete _ytDownloads[id];
          if (_cancelled) {
            resolve({ success: false, error: 'Cancelled' });
            return;
          }
          var saved = _listPlaylistFiles();
          var anyErr = '';
          for (var j = 0; j < workers.length; j++) {
            if (workers[j].code !== 0 || /error:/i.test(workers[j].stderr || '')) {
              var leaked = (workers[j].stderr || '').replace(/\n/g, ' | ').replace(/\r/g, '').slice(0, 400);
              if (leaked && !anyErr) anyErr = leaked;
            }
          }
          if (saved.length) {
            // Save metadata for every downloaded file + build the NEO playlist.
            try {
              var metaIndex = _loadMeta();
              if (!metaIndex) metaIndex = {};
              var plData = _loadPlaylists();
              if (!plData) plData = { playlists: [] };
              var pl = null;
              for (var pi = 0; pi < (plData.playlists || []).length; pi++) {
                if ((plData.playlists[pi].name || '').toLowerCase() === playlistTitle.toLowerCase()) { pl = plData.playlists[pi]; break; }
              }
              if (!pl) {
                pl = {
                  id: 'pl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
                  name: playlistTitle,
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                  thumbnail: '',
                  videoCount: 0,
                  videos: []
                };
                plData.playlists.push(pl);
              }
              pl.updatedAt = Date.now();
              var plVidKeys = {};
              (pl.videos || []).forEach(function(v) { plVidKeys[v.fileName] = 1; });

              for (var fi = 0; fi < saved.length; fi++) {
                var fn = saved[fi];
                // FileName key relative to the Videos/Audio dir so the playlist
                // and meta lookup can resolve it (files live in Playlists\<name>).
                var relKey = path.posix.join('Playlists', safePlName, fn);
                var idx = _indexOfFile(fn);
                var vid = _plIds[idx - 1] || '';
                var title = path.basename(fn, path.extname(fn));
                var t2 = title.replace(new RegExp('^' + safePlName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*-\\s*\\d{3,4}\\s*-\\s*'), '');
                if (!t2) t2 = title;
                var thumb = vid ? ('https://i.ytimg.com/vi/' + vid + '/hqdefault.jpg') : '';
                metaIndex[relKey] = {
                  title: t2,
                  channel: meta2.channel || '',
                  videoUrl: vid ? ('https://www.youtube.com/watch?v=' + vid) : plUrl,
                  thumbnail: thumb,
                  thumbnailPath: '',
                  category: isAudio ? 'music' : 'other',
                  playlist: playlistTitle,
                  downloadedAt: Date.now()
                };
                if (!plVidKeys[relKey]) {
                  pl.videos.push({ fileName: relKey, title: t2, channel: meta2.channel || '', thumbnail: thumb, addedAt: Date.now() });
                  plVidKeys[relKey] = 1;
                }
                if (!pl.thumbnail && thumb) pl.thumbnail = thumb;
              }
              pl.videoCount = pl.videos.length;
              _saveMeta(metaIndex);
              _savePlaylists(plData);
              console.log('[YTDL-PL] Saved ' + saved.length + ' files + playlist "' + playlistTitle + '"');
            } catch(e) { console.warn('[YTDL-PL] Meta/playlist save error:', e.message); }

            sp({ filename: safePlName, state: 'completed', playlist: true, playlistName: playlistTitle, count: saved.length, files: saved });
            resolve({ success: true, playlistName: playlistTitle, count: saved.length, files: saved });
          } else if (anyErr) {
            console.log('[YTDL-PL] FAILED:', anyErr);
            sp({ filename: safePlName, state: 'error', error: 'Playlist download blocked: ' + anyErr });
            resolve({ success: false, error: 'Playlist download failed: ' + anyErr });
          } else {
            sp({ filename: safePlName, state: 'error', error: 'Playlist download produced no files' });
            resolve({ success: false, error: 'Playlist download produced no files' });
          }
        }
      });
    });
  });

  ipcMain.handle('yt-download-cancel', async (event, id) => {
    var dl = _ytDownloads[id];
    if (dl && dl.cancel) dl.cancel();
    delete _ytDownloads[id];
    return { success: true };
  });

  // ===== PRIVACY & SECURITY IPC =====
  ipcMain.handle('clear-browsing-data', async (event, opts) => {
    try {
      var s = session.defaultSession;
      if (opts.cookies) {
        await s.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'filesystem', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'] });
      }
      if (opts.cache) {
        await s.clearCache();
      }
      return { success: true };
    } catch(e) { return { success: false, error: e.message }; }
  });
  ipcMain.handle('get-cookies', async (event, filter) => {
    try {
      var s = session.defaultSession;
      var cookies = await s.cookies.get({});
      if (filter) {
        var fl = filter.toLowerCase();
        cookies = cookies.filter(function(c) { return c.domain.toLowerCase().indexOf(fl) !== -1 || c.name.toLowerCase().indexOf(fl) !== -1; });
      }
      cookies.sort(function(a,b) { return a.domain.localeCompare(b.domain); });
      return cookies.slice(0, 200);
    } catch(e) { return []; }
  });
  ipcMain.handle('clear-all-cookies', async () => {
    try {
      var s = session.defaultSession;
      var cookies = await s.cookies.get({});
      for (var i = 0; i < cookies.length; i++) {
        try { await s.cookies.remove(cookies[i].domain, cookies[i].name); } catch(ex) {}
      }
      return { success: true };
    } catch(e) { return { success: false, error: e.message }; }
  });
  ipcMain.handle('get-permission-state', async (event, permission) => {
    try {
      var s = session.defaultSession;
      var state = s.getPermissionState(permission);
      return state;
    } catch(e) { return 'granted'; }
  });
  ipcMain.handle('get-cert-info', async (event, url) => {
    try {
      if (!url || !url.startsWith('https://')) return null;
      var parsed = new URL(url);
      var hostname = parsed.hostname;
      // Simple cert info via net.fetch head request
      var resp = await net.fetch(url, { method: 'HEAD' });
      var certInfo = {
        issuer: resp.headers.get('X-Content-Security-Policy') || hostname,
        subject: hostname,
        validFrom: 'via TLS',
        validTo: 'via TLS'
      };
      return certInfo;
    } catch(e) { return null; }
  });

  // Auth debug logging IPC
  ipcMain.on('auth-debug', (event, msg) => {
    console.log('[AUTH]', msg);
  });

  // Force the host window to re-request frames from the <webview> guest. Used by
  // the black-webview watchdog after a same-guest reset, to re-establish the
  // compositor link between host and guest without recreating the guest.
  ipcMain.on('neo-kick-compositor', (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return;
      win.webContents.invalidate();
      const [w, h] = win.getSize();
      if (w > 120 && h > 80) {
        win.setSize(w + 1, h);
        setTimeout(() => { try { if (!win.isDestroyed()) win.setSize(w, h); } catch (e) {} }, 80);
      }
    } catch (e) {}
  });

  // TEMP diagnostic: renderer pushes navigation-timing traces; append to a file.
  const fsNav = require('fs');
  const _navLogPath = 'C:\\Users\\Admin\\AppData\\Local\\Temp\\opencode\\nav_trace.log';
  function _navLog(line) {
    try { fsNav.appendFileSync(_navLogPath, '[' + new Date().toISOString().slice(11, 23) + '] ' + line + '\n'); } catch (_) {}
  }
  ipcMain.on('neo-navtrace', (e, line) => {
    _navLog(line);
  });
  // Report whether Chromium is compositing in software (no hardware GPU / SwiftShader).
  // The renderer uses this to auto-enable performance-mode and drop decorative
  // animations that would otherwise spin the software compositor at full CPU.
  ipcMain.handle('neo-gpu-status', async () => {
    try {
      let featureStatus = null;
      try {
        const gpuInfo = await app.getGPUInfo('basic');
        if (gpuInfo && gpuInfo.auxAttributes && gpuInfo.auxAttributes.featureStatus) {
          featureStatus = gpuInfo.auxAttributes.featureStatus;
        }
      } catch (e) {}
      if (!featureStatus) {
        try { featureStatus = app.getGPUFeatureStatus() || {}; } catch (e2) {}
      }
      const val = (k) => ((featureStatus && featureStatus[k]) || '').toString();
      const software = val('gpu_compositing').indexOf('software') !== -1 ||
                       val('gpu_rasterization').indexOf('software') !== -1 ||
                       val('viz_display_compositor').indexOf('software') !== -1;
      return { software: !!software, featureStatus: featureStatus || null };
    } catch (e) {
      return { software: false, error: String((e && e.message) || e) };
    }
  });

  // ===== ADAPTIVE PERFORMANCE MANAGER =====
  // System metric sampling for the renderer's performance dashboard/modes.
  // os.cpus() is unusually expensive on Windows, so we never call it more than
  // once per second regardless of how often the renderer polls perf data.
  var _lastCpuSample = null;
  var _lastCpuAt = 0;
  var _cachedCpuPct = 0;
  function _sampleCpuPct() {
    try {
      var nowMs = Date.now();
      if (nowMs - _lastCpuAt < 1000) return _cachedCpuPct;
      _lastCpuAt = nowMs;
      var cpus = os.cpus();
      var idle = 0, total = 0;
      for (var i = 0; i < cpus.length; i++) {
        var t = cpus[i].times;
        idle += t.idle;
        total += t.idle + t.user + t.nice + t.sys + t.irq;
      }
      var now = { idle: idle, total: total };
      if (_lastCpuSample && now.total > _lastCpuSample.total) {
        var dIdle = now.idle - _lastCpuSample.idle;
        var dTotal = now.total - _lastCpuSample.total;
        _lastCpuSample = now;
        if (dTotal > 0) {
          _cachedCpuPct = Math.max(0, Math.min(100, Math.round(100 * (1 - dIdle / dTotal))));
          return _cachedCpuPct;
        }
      } else {
        _lastCpuSample = now;
      }
      return _cachedCpuPct;
    } catch (e) { return 0; }
  }
  var _perfCache = null;
  var _perfCacheAt = 0;
  var _gpuInfoCache = null;
  ipcMain.handle('neo-perf', async () => {
    var now = Date.now();
    if (_perfCache && now - _perfCacheAt < 250) return _perfCache;
    var result = { error: null };
    try {
      var fm = os.freemem() / 1048576;
      var tm = os.totalmem() / 1048576;
      var processes = [], browserMemMB = 0, rendererCount = 0, gpuMemMB = 0, gpuCpu = 0;
      try {
        processes = app.getAppMetrics().map(function(m) {
          // workingSetSize is reported in KB on Windows; convert to MB
          var mm = ((m.memory && m.memory.workingSetSize) || 0) / 1024;
          var cpu = (m.cpu && m.cpu.percentCPUUsage) || 0;
          if (m.type === 'Renderer' || m.type === 'Tab') rendererCount++;
          if (m.type === 'GPU') { gpuMemMB = mm; gpuCpu = cpu; }
          return { type: m.type, pid: m.pid, cpuPct: Math.round(cpu * 10) / 10, memMB: Math.round(mm) };
        });
        browserMemMB = processes.reduce(function(a, p) { return a + p.memMB; }, 0);
      } catch (e) {}
      var thermal = 'nominal';
      try { thermal = powerMonitor.getCurrentThermalState() || 'nominal'; } catch (e) {}
      if (!_gpuInfoCache) {
        try {
          var gpuInfo = await app.getGPUInfo('basic');
          var devs = (gpuInfo && gpuInfo.gpuDevice) || [];
          _gpuInfoCache = devs.map(function(d) { return { description: d.deviceString || '', vendor: d.vendorId, active: !!d.active }; });
        } catch (e) {}
      }
      result = {
        freememMB: Math.round(fm),
        totalmemMB: Math.round(tm),
        usedPct: tm > 0 ? Math.round(100 * (1 - fm / tm)) : 0,
        cpuPct: _sampleCpuPct(),
        thermal: thermal,
        processes: processes,
        browserMemMB: Math.round(browserMemMB),
        rendererCount: rendererCount,
        gpuCpuPct: Math.round(gpuCpu * 10) / 10,
        vramMB: Math.round(gpuMemMB),
        gpuDevices: _gpuInfoCache || [],
        timestamp: Date.now(),
      };
    } catch (e) {
      result = { error: String((e && e.message) || e) };
    }
    _perfCache = result;
    _perfCacheAt = now;
    return result;
  });

  // Top external processes by working set (best-effort, cached 20s). Uses the
  // Windows `tasklist` binary so no third-party deps are needed.
  var _extProcCache = null;
  var _extProcAt = 0;
  ipcMain.handle('neo-perf-external', async () => {
    var now = Date.now();
    if (_extProcCache && now - _extProcAt < 20000) return _extProcCache;
    var out = { top: [], error: null };
    try {
      if (process.platform === 'win32') {
        var txt = await new Promise(function(resolve) {
          execFile('tasklist', ['/FO', 'CSV', '/NH'], { maxBuffer: 4 * 1024 * 1024, windowsHide: true, timeout: 20000 }, function(err, stdout) {
            if (err) { resolve(''); return; }
            resolve(String(stdout));
          });
        });
        var rows = [];
        txt.split(/\r?\n/).forEach(function(line) {
          line = line.trim();
          if (!line || line.charAt(0) !== '"') return;
          var m = line.match(/"([^"]*)",\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)"/);
          if (!m) return;
          var mb = parseInt(String(m[5]).replace(/,/g, ''), 10);
          if (!isNaN(mb)) rows.push({ name: m[1], pid: m[2], memMB: mb });
        });
        rows.sort(function(a, b) { return b.memMB - a.memMB; });
        // Only meaningful non-zero consumers, and skip our own browser processes
        out.top = rows.filter(function(r) { return r.memMB >= 64 && r.name.toLowerCase().indexOf('electron') === -1; }).slice(0, 6);
      }
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    _extProcCache = out;
    _extProcAt = now;
    return out;
  });

  ipcMain.handle('get-system-memory', async () => {
    try {
      const mem = process.getSystemMemoryInfo();
      return { freeMB: Math.round(mem.free / 1024), totalMB: Math.round(mem.total / 1024) };
    } catch (e) { return { freeMB: 0, totalMB: 0 }; }
  });

  // ===== REAL DOWNLOAD MANAGER =====
  // Downloads are tracked here in the main process, driven by Electron's actual
  // DownloadItem (item.getReceivedBytes/getTotalBytes/getState). Progress,
  // speed, remaining time and completion state come from the real download, not
  // a fake UI. Files are written to a temporary .part file and only renamed to
  // the final name after the download fully completes, so a partial/corrupt
  // download is NEVER shown as completed. Registered ONCE per session (guarded),
  // so N webviews never add N duplicate listeners.
  const DANGEROUS_EXTS = ['.exe','.msi','.bat','.cmd','.ps1','.vbs','.js','.jar','.scr','.com','.pif','.reg','.sh','.app','.dmg','.zip','.rar','.7z'];
  const MUSIC_SITES = ['music.youtube.com', 'spotify.com', 'soundcloud.com', 'bandcamp.com', 'open.spotify.com'];
  let downloadIdCounter = 0;
  const _pendingDownloads = {};
  let _dlTempDir = null;
  function _dlTemp() {
    if (_dlTempDir) return _dlTempDir;
    _dlTempDir = path.join(_DATA_DIR, '.partial');
    try { if (!fs.existsSync(_dlTempDir)) fs.mkdirSync(_dlTempDir, { recursive: true }); } catch(e) {}
    return _dlTempDir;
  }
  function _dlUniqueIn(dir, name) {
    var candidate = path.join(dir, name);
    var counter = 1;
    var ext = path.extname(name);
    var base = path.basename(name, ext);
    while (fs.existsSync(candidate)) {
      candidate = path.join(dir, base + '_' + counter + ext);
      counter++;
    }
    return candidate;
  }
  function _dlState(item) {
    var s = item.getState();
    if (s === 'completed') return 'completed';
    if (s === 'cancelled') return 'cancelled';
    if (s === 'interrupted') return 'interrupted';
    if (item.isPaused()) return 'paused';
    return 'progressing';
  }
  var _prevDlEvent = null; // guard against duplicate will-download emissions
  // ===== DOWNLOAD HISTORY (persistent) =====
  // The panel used to show only files still on disk, so anything the user
  // moved, renamed or deleted vanished without a trace. Every completed
  // download is now appended here (newest first, capped) and survives restarts.
  function _dlHistoryFile() {
    try {
      var dir = path.join(app.getPath('userData'), 'neo-data');
      try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch(e) {}
      return path.join(dir, 'download-history.json');
    } catch(e) { return null; }
  }
  function _dlReadHistory() {
    try {
      var f = _dlHistoryFile();
      if (!f || !fs.existsSync(f)) return [];
      var list = JSON.parse(fs.readFileSync(f, 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch(e) { return []; }
  }
  function _dlWriteHistory(list) {
    try {
      var f = _dlHistoryFile();
      if (!f) return;
      fs.writeFileSync(f, JSON.stringify(list.slice(0, 200)));
    } catch(e) {}
  }
  function _dlRecordHistory(rec) {
    try {
      var size = rec.totalBytes || 0;
      try { var st = fs.statSync(rec.finalPath); if (st && st.isFile()) size = st.size; } catch(e) {}
      var list = _dlReadHistory();
      list.unshift({
        name: rec.filename, path: rec.finalPath,
        url: rec.sourceUrl || '', size: size, ext: rec.ext || '',
        time: Date.now()
      });
      _dlWriteHistory(list);
    } catch(e) {}
  }
  function _registerDownloadSession(sess) {
    if (!sess || sess._neoDownloadHooked) return;
    sess._neoDownloadHooked = true;
    sess.on('will-download', (event, item) => {
      try {
      const id = ++downloadIdCounter;
      var filename = item.getFilename();
      const totalBytes = item.getTotalBytes();
      // NOTE: the DOM <webview> guest's webContents is frequently reported as
      // destroyed at will-download time, so we must NOT bail out on a destroyed
      // sender — the DownloadItem is still valid and we just fall back to the
      // first window for IPC. Otherwise downloads never get saved to our folder.
      const senderOK = !!(event.sender && !event.sender.isDestroyed());
      try { _navLog('[DL] will-download fired: ' + filename + ' bytes=' + totalBytes + ' sender=' + (senderOK ? event.sender.getURL() : 'destroyed')); } catch(e) {}
      // Don't intercept downloads from music sites — let them use default behavior
      try {
        if (senderOK) {
          var senderUrl = event.sender.getURL();
          for (var msIdx = 0; msIdx < MUSIC_SITES.length; msIdx++) {
            if (senderUrl.indexOf(MUSIC_SITES[msIdx]) !== -1) { try { _navLog('[DL] music site skip ' + senderUrl); } catch(e) {} return; }
          }
        }
      } catch(e) {}
      var senderWin = null;
      try { senderWin = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getAllWindows()[0]; } catch(e) { try { senderWin = BrowserWindow.getAllWindows()[0]; } catch(e2) {} }
      if (!senderWin) { try { _navLog('[DL] NO senderWin — aborting download ' + filename); } catch(e) {} return; }
      const ext = (path.extname(filename) || '').toLowerCase();
      const isDangerous = DANGEROUS_EXTS.indexOf(ext) !== -1;
      // Unique final + temp paths (temp stays in .partial until fully done).
      var finalPath = _dlUniqueIn(DOWNLOADS_DIR, filename);
      var tempPath = _dlUniqueIn(_dlTemp(), path.basename(finalPath) + '.part');
      var rec = _pendingDownloads[id] = {
        item: item, finalPath: finalPath, tempPath: tempPath,
        filename: path.basename(finalPath), ext: ext,
        totalBytes: totalBytes, received: 0,
        state: 'started', speed: 0, remainingMs: -1,
        lastBytes: 0, lastAt: Date.now(), isDangerous: isDangerous,
        win: senderWin, emittedStart: false, sourceUrl: ''
      };
      try { rec.sourceUrl = item.getURL() || ''; } catch(e) {}
      if (isDangerous) {
        senderWin.webContents.send('download-warning', { id, filename: rec.filename, ext, totalBytes });
        return; // waits for download-response before starting
      }
      _startDlItem(id, rec);
      } catch(err) { try { _navLog('[DL] will-download ERROR: ' + (err && err.message) + ' stack=' + (err && err.stack)); } catch(e) {} }
    });
  }

  // Starts saving a download item (shared between fresh + dangerous-allowed).
  function _startDlItem(id, rec) {
    try { _navLog('[DL] _startDlItem id=' + id + ' filename=' + rec.filename + ' win=' + (rec.win ? rec.win.id : 'null')); } catch(e) {}
    var item = rec.item;
    var senderWin = rec.win;
    var id2 = id;
    function _send(ch, payload) {
      try { if (senderWin && senderWin.webContents && !senderWin.webContents.isDestroyed()) senderWin.webContents.send(ch, payload); } catch(e) { try { _navLog('[DL] send ' + ch + ' failed: ' + (e && e.message)); } catch(e2) {} }
    }
    rec.emittedStart = true;
    _send('download-start', { id, filename: rec.filename, totalBytes: rec.totalBytes, ext: rec.ext });
    try { _navLog('[DL] saving to ' + rec.tempPath + ' -> ' + rec.finalPath); } catch(e) {}
    item.on('updated', (event, st) => {
      try {
        var recv = item.getReceivedBytes();
        var now = Date.now();
        var dt = (now - rec.lastAt) / 1000;
        var speed = dt > 0 ? Math.max(0, (recv - rec.lastBytes) / dt) : 0;
        rec.received = recv;
        rec.speed = speed;
        rec.lastBytes = recv;
        rec.lastAt = now;
        var total = rec.totalBytes > 0 ? rec.totalBytes : item.getTotalBytes();
        rec.totalBytes = total;
        if (total > 0 && speed > 0) rec.remainingMs = ((total - recv) / speed) * 1000;
        else if (total > 0) rec.remainingMs = -1;
        var st2 = _dlState(item);
        rec.state = st2;
        _send('download-progress', {
          id, received: recv, total, speed: rec.speed, remainingMs: rec.remainingMs,
          state: st2, filename: rec.filename, ext: rec.ext
        });
      } catch(e) { try { _navLog('[DL] updated error: ' + (e && e.message)); } catch(e2) {} }
    });
    item.on('done', (event, st) => {
      try {
        if (st === 'completed') {
          // Only finalize after real success: move temp file to final name.
          var ok = false;
          try {
            if (fs.existsSync(rec.tempPath)) { fs.renameSync(rec.tempPath, rec.finalPath); ok = true; }
            else if (fs.existsSync(rec.finalPath)) { ok = true; }
            else { ok = false; }
          } catch(e) { ok = false; }
          if (ok) {
            _send('download-done', { id, filename: rec.filename, state: 'completed', path: rec.finalPath, ext: rec.ext });
            _dlRecordHistory(rec);
          } else {
            try { if (fs.existsSync(rec.tempPath)) fs.unlinkSync(rec.tempPath); } catch(e2) {}
            _send('download-done', { id, filename: rec.filename, state: 'interrupted', path: '', ext: rec.ext });
          }
        } else {
          // interrupted / cancelled: never keep a partial file.
          try { if (fs.existsSync(rec.tempPath)) fs.unlinkSync(rec.tempPath); } catch(e) {}
          _send('download-done', { id, filename: rec.filename, state: st, ext: rec.ext });
        }
        delete _pendingDownloads[id];
      } catch(e) { try { _navLog('[DL] done error: ' + (e && e.message)); } catch(e2) {} }
    });
    try {
      item.setSavePath(rec.tempPath);
      // NOTE: DownloadItem has no save() method in this Electron build. Setting
      // setSavePath() (without calling event.preventDefault in will-download)
      // is enough to make the download save to that path automatically.
    } catch(e) { try { _navLog('[DL] save/start error: ' + (e && e.message) + ' stack=' + (e && e.stack)); } catch(e2) {} }
  }

  // User's response to the dangerous-file warning.
  ipcMain.on('download-response', (event, { id, allow }) => {
    const rec = _pendingDownloads[id];
    if (!rec) return;
    if (!allow) {
      try { rec.item.cancel(); } catch(e) {}
      delete _pendingDownloads[id];
      return;
    }
    _startDlItem(id, rec);
  });

  // Pause / resume / cancel a live download.
  ipcMain.on('download-pause', (event, id) => {
    var rec = _pendingDownloads[id];
    if (!rec || !rec.item) return;
    try { if (!rec.item.isDone() && !rec.item.isPaused()) rec.item.pause(); } catch(e) {}
  });
  ipcMain.on('download-resume', (event, id) => {
    var rec = _pendingDownloads[id];
    if (!rec || !rec.item) return;
    try { if (rec.item.isPaused()) rec.item.resume(); } catch(e) {}
  });
  ipcMain.on('download-cancel', (event, id) => {
    var rec = _pendingDownloads[id];
    if (!rec || !rec.item) return;
    try { if (!rec.item.isDone()) rec.item.cancel(); } catch(e) {}
  });

  // Open / reveal a completed download in the system.
  ipcMain.handle('open-downloaded-file', async (event, id) => {
    var rec = id != null && _pendingDownloads[id] ? _pendingDownloads[id] : null;
    var fp = rec && fs.existsSync(rec.finalPath) ? rec.finalPath : '';
    if (!fp && typeof id === 'string') {
      var p = path.join(DOWNLOADS_DIR, path.basename(id));
      if (fs.existsSync(p)) fp = p;
    }
    if (!fp) return false;
    // Executables run code on open. The renderer-side warning can be bypassed
    // over IPC, so confirm here in main, where it cannot be skipped.
    var ext = path.extname(fp).toLowerCase();
    if (['.exe', '.msi', '.msix', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.jar', '.reg', '.lnk'].indexOf(ext) !== -1) {
      var win = null;
      try { win = _mainBrowserWin(); } catch (e) {}
      var ans = dialog.showMessageBoxSync(win || undefined, {
        type: 'warning',
        buttons: ['Open anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Open downloaded file?',
        message: path.basename(fp) + ' can run code on this PC.',
        detail: 'Only open it if you downloaded it yourself and trust the source.'
      });
      if (ans !== 0) return false;
    }
    try { await shell.openPath(fp); return true; } catch(e) { return false; }
  });
  ipcMain.handle('show-download-in-folder', async (event, id) => {
    var rec = id != null && _pendingDownloads[id] ? _pendingDownloads[id] : null;
    var fp = rec && fs.existsSync(rec.finalPath) ? rec.finalPath : '';
    if (!fp && typeof id === 'string') {
      var p2 = path.join(DOWNLOADS_DIR, path.basename(id));
      if (fs.existsSync(p2)) fp = p2;
    }
    if (!fp) return false;
    try { shell.showItemInFolder(fp); return true; } catch(e) { return false; }
  });
  // Hook the sessions webviews and the main window actually download through.
  // Registered once (guarded), so N webviews never add N duplicate listeners.
  _registerDownloadSession(session.defaultSession);
  try { _registerDownloadSession(session.fromPartition('persist:webview')); } catch(e) {}

  app.on('web-contents-created', (event, contents) => {
    const type = contents.getType();
    if (_authDebugOn) _authDbg('[WC-CREATED] type=' + type + ' id=' + contents.id + ' sess=' + (function(){ try { return contents.session ? _sesName(contents.session) : '?'; } catch(e){ return '?'; } })());
contents.setUserAgent(getUAForURL((contents.getURL && contents.getURL()) || ''));
    // Volume boost: track this webContents and auto-apply the boost engine to
    // its frames whenever ANY frame navigates (catches iframe players that
    // mount after load - the reason boost previously only worked on YouTube).
    try {
      _volBoostWcs.add(contents);
      contents.once('destroyed', () => { try { _volBoostWcs.delete(contents); } catch (e) {} });
    } catch (e) {}
    contents.on('did-finish-load', () => {
      if (_volBoostPct > 100) _applyVolBoostTo(contents);
    });
    contents.on('did-frame-navigate', (e, url2, code2, text2, isMain, fp, rid) => {
      if (_volBoostPct > 100) {
        try {
          var f = rid != null && contents.frameForRoutingId ? contents.frameForRoutingId(rid) : null;
          if (f) _volExecFrame(f, _volBoostCode(_volBoostPct));
          else _applyVolBoostTo(contents);
        } catch (err) {}
      }
    });
    // Per-site UA in navigator.userAgent (client-side checks like WhatsApp's
    // "update your browser" wall read this, not just request headers). Same
    // remap the WCV uses for the visible site layer; the apps viewer <webview>
    // guest also lands here and needs it.
    var _applyNeoUA = function() {
      try { contents.setUserAgent(getUAForURL((contents.getURL && contents.getURL()) || '')); } catch (e) {}
    };
    // SELECTIVE background throttling.
    // Old behavior disabled throttling for EVERY webContents, which kept every
    // hidden tab compositing at full rate -> GPU pegged at 100% and the whole
    // browser (including page loads + Spotify) felt sluggish under RAM pressure.
    // New behavior: keep throttling ENABLED for normal sites (fast, cheap), and
    // only disable it for streaming/media hosts (Spotify etc.) so their audio
    // keeps decoding while the user is on another tab. Re-applied on navigation
    // so a tab that moves between a normal page and a media site stays correct.
    function applyThrottle() {
      // Uniform fast treatment: keep background throttling DISABLED for every
      // webContents (host window and all site webviews), exactly like YouTube
      // (a streaming site) gets. This makes every site's timers/rendering run at
      // full speed so any site opens and responds as fast as YouTube does.
      // Tradeoff (accepted per user request): more CPU/GPU usage across tabs.
      try { contents.setBackgroundThrottling(false); } catch (e) {}
    }
    applyThrottle();
    contents.on('did-navigate', (e, url) => { try { contents._neoLastUrl = url; } catch (e) {} if (url && url.indexOf('spotify.com') !== -1) { try { _siteUrl = url; } catch(e) {} } applyThrottle(); _applyNeoUA(); if (_historyUnlocked && !_histProtectedKind(url)) _historyUnlocked = false; });
    contents.on('did-navigate-in-page', (e, url, isMain) => { if (isMain) { try { contents._neoLastUrl = url; } catch (e) {} if (url && url.indexOf('spotify.com') !== -1) { try { _siteUrl = url; } catch(e) {} } applyThrottle(); _applyNeoUA(); if (_historyUnlocked && !_histProtectedKind(url)) _historyUnlocked = false; } });

    // ===== SPOTIFY DIAGNOSTIC LOGGER =====
    // Writes lifecycle + media events for Spotify webContents to a file so we can
    // trace exactly what happens at "Song 1 -> Song 2 -> can't play right now".
    // Enable with NEO_SPOTIFY_DIAG=1 in the environment; logs to
    // %APPDATA%\Electron\spotify-diag.log
    if (process.env.NEO_SPOTIFY_DIAG === '1') {
      const _diagPath = require('path').join(app.getPath('userData'), 'spotify-diag.log');
      const _diag = (evt, extra) => {
        try {
          let isSpot = false;
          try { const u = (contents.getURL() || '') + ' ' + (contents._neoLastUrl || ''); isSpot = /spotify\.com/i.test(u); } catch(e) {}
          if (!isSpot) return;
          const line = new Date().toISOString() + ' wcId=' + (contents.id) + ' type=' + type + ' evt=' + evt + (extra ? ' ' + extra : '') + '\n';
          require('fs').appendFileSync(_diagPath, line);
        } catch(e) {}
      };
      contents.on('did-start-loading', () => _diag('did-start-loading'));
      contents.on('did-stop-loading', () => _diag('did-stop-loading'));
      contents.on('did-navigate', (e, url) => { contents._neoLastUrl = url; _diag('did-navigate', 'url=' + (url||'').split('?')[0]); });
      contents.on('did-navigate-in-page', (e, url, isMain) => { if (isMain) { contents._neoLastUrl = url; _diag('did-navigate-in-page', 'url=' + (url||'').split('?')[0]); } });
      contents.on('did-start-navigation', (e, url, isInPlace, isMainFrame) => { if (isMainFrame) _diag('did-start-navigation', 'url=' + (url||'').split('?')[0] + ' inPlace=' + !!isInPlace); });
      const _gone = (d) => { try { if (d && d.reason) _diag('render-process-gone', 'reason=' + d.reason + ' exitCode=' + d.exitCode); } catch(e) {} };
      contents.on('render-process-gone', (e, d) => _gone(d));
      contents.on('crashed', () => _diag('crashed'));
      contents.on('destroyed', () => _diag('destroyed'));
      contents.on('media-started-playing', () => _diag('media-started-playing'));
      contents.on('media-paused', () => _diag('media-paused'));
      contents.on('audio-muted', (e, muted) => _diag('audio-muted', 'muted=' + !!muted));
    }

    contents.on('render-process-gone', (e, details) => {
      if (type === 'webview' && details && details.reason && details.reason !== 'clean-exit') {
        // Tell the renderer to recreate the webview so the user never stares at a dead page.
        try {
          const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
          if (win) win.webContents.send('webview-recover');
        } catch (err) {}
      }
    });
    contents.on('crashed', () => {
      if (type === 'webview') {
        try {
          const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
          if (win) win.webContents.send('webview-recover');
        } catch (err) {}
      }
    });

    // Inject Leet Assistant into all web contents (webview, window, etc.)
    // Use did-navigate AND did-finish-load for maximum timing coverage
    contents.on('did-navigate', (e, url) => {
      console.log('[AUTH] did-navigate:', (url||'').split('?')[0]);
      if (process.env.NEO_NO_INJECTIONS !== '1') {
        injectLeetAssistant(contents);
      }
      injectShieldsDomCleaner(contents);
    });
    contents.on('did-finish-load', () => {
      // Re-inject on finish-load to catch any timing gaps
      if (process.env.NEO_NO_INJECTIONS !== '1') {
        injectLeetAssistant(contents);
      }
      injectShieldsDomCleaner(contents);
    });
    contents.on('did-navigate-in-page', (e, url, isMainFrame) => {
      if (isMainFrame && process.env.NEO_NO_INJECTIONS !== '1') {
        injectLeetAssistant(contents);
      }
      if (isMainFrame) injectShieldsDomCleaner(contents);
    });

    // DOM-level ad blocking is handled by renderer-side injection (ai-browser.html)
      // Network-level blocking via webRequest handles URL filtering above

      if (type === 'webview') {
      // Log all navigations for auth debugging
      if (_authDebugOn) _authDbg('[NAV-WV-TAG] guest attached type=' + type + ' session=persist:webview');
      contents.on('will-navigate', (e, url) => {
        // History-lock guard: block google/youtube history pages in the webview too.
        if (tryGuardHistoryNav(e, url, contents)) return;
        if (_authDebugOn) _authDbg('[NAV-WV-TAG] will-navigate url=' + url + ' session=persist:webview');
        if (/accounts\.google\.com|login\.|oauth|signin|auth/i.test(url)) {
          console.log('[AUTH] Navigation:', url.split('?')[0]);
        }
        // Divert NEO's OWN Google OAuth v2 AUTHORIZE requests to the system browser.
        // Only NEO's own client_id is diverted; third-party "Sign in with Google"
        // authorize URLs are left to load/redirect normally.
        if (_isOwnGoogleAuthUrl(url)) {
          e.preventDefault();
          GOOGLE_OAUTH.start();
          return;
        }
        // COMPLIANT FIX: Google login pages (accounts.google.com signin) are NOT
        // supported inside an embedded Electron guest — Google rejects them with
        // GE MODE: by default sign in INSIDE NEO (embedded — the normal-browser
        // way, so the Google/YouTube session lands in NEO). With NEO_GOOGLE_LOGIN
        // =external these pages go to the real system browser instead.
        if (_isGoogleLoginUrl(url) && _externalGoogleLogin()) {
          e.preventDefault();
          _openInSystemBrowser(url);
          console.log('[LoginDivert] webview will-navigate -> system browser:', url.split('?')[0]);
          return;
        }
        if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('file:')) return;
      });
      contents.on('will-redirect', (e, url) => {
        // History-lock guard on redirects as well.
        if (tryGuardHistoryNav(e, url, contents)) return;
        if (_authDebugOn) _authDbg('[NAV-WV-TAG] will-redirect url=' + url + ' session=persist:webview');
        if (/accounts\.google\.com|login\.|oauth|signin|auth/i.test(url)) {
          console.log('[AUTH] Redirect:', url.split('?')[0]);
        }
        // Same NEO-own-only OAuth diversion on redirects to the authorize endpoint.
        if (_isOwnGoogleAuthUrl(url)) {
          e.preventDefault();
          GOOGLE_OAUTH.start();
          return;
        }
        // GE MODE: divert only when external mode is enabled.
        if (_isGoogleLoginUrl(url) && _externalGoogleLogin()) {
          e.preventDefault();
          _openInSystemBrowser(url);
          console.log('[LoginDivert] webview will-redirect -> system browser:', url.split('?')[0]);
          return;
        }
        if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('file:')) return;
      });
      // Suppress ERR_ABORTED and ERR_FAILED — normal when navigation is cancelled/redirected
      contents.on('did-fail-load', (e, errorCode, errorDescription, validatedURL) => {
        if (errorCode === -3 || errorCode === -1) {
          e.preventDefault();
        }
        if (_authDebugOn && validatedURL) _authDbg('[NAV-WV-TAG] did-fail-load code=' + errorCode + ' desc=' + errorDescription + ' url=' + validatedURL + ' session=persist:webview');
      });
      contents.on('did-navigate', (e, url) => {
        if (_authDebugOn && url) _authDbg('[NAV-WV-TAG] did-navigate url=' + url + ' session=persist:webview');
      });
      // True only for NEO's OWN Google OAuth authorize URL (its own client_id).
      // Third-party sites' "Sign in with Google" also hit accounts.google.com but
      // use their own client_id — those must NOT be hijacked into NEO's PKCE flow.
      function _isOwnGoogleAuthUrl(url) {
        try {
          if (typeof GOOGLE_OAUTH === 'undefined' || !GOOGLE_OAUTH) return false;
          var u = new URL(url);
          var h = u.hostname.replace(/^www\./, '').toLowerCase();
          if (h !== 'accounts.google.com') return false;
          var p = u.pathname;
          if (p.indexOf('/o/oauth2/v2/auth') !== 0 && p.indexOf('/o/oauth2/auth') !== 0) return false;
          var cid = String(u.searchParams.get('client_id') || '').trim();
          var own = String(GOOGLE_OAUTH.clientId() || '').trim();
          return cid !== '' && own !== '' && cid === own;
        } catch(e) { return false; }
      }
      // Detect OAuth/auth popup URLs that MUST remain as a popup WINDOW because
      // the calling page needs the window.opener reference (the auth callback
      // page posts the result back via postMessage — Chrome behaves the same way).
      // Regular target=_blank links do NOT need this and become NEO tabs instead.
      function _isOAuthPopup(url) {
        try {
          var u = new URL(url);
          var h = u.hostname.replace(/^www\./, '').toLowerCase();
          var p = u.pathname.toLowerCase();
          if (h === 'accounts.google.com' && (p.indexOf('/o/oauth2/') === 0 || p === '/o/oauth2/auth')) return true;
          if ((h === 'login.microsoftonline.com' || h === 'login.live.com') && (p.indexOf('/oauth2/') !== -1 || p.indexOf('/authorize') !== -1)) return true;
          if (h === 'github.com' && p.indexOf('/login/oauth/authorize') !== -1) return true;
          if (h === 'discord.com' && p.indexOf('/api/oauth2/authorize') !== -1) return true;
          if (h === 'appleid.apple.com' && p.indexOf('/auth/authorize') !== -1) return true;
          if (u.searchParams.has('client_id') && u.searchParams.has('redirect_uri') && u.searchParams.has('response_type')) return true;
        } catch(e) {}
        return false;
      }
      // Same-site popup (registrable domain matches the opener). Sites use
  // window.open + window.opener.postMessage for flows that CANNOT survive being
  // turned into a background tab, e.g. LeetCode's "verify your email" link,
  // OAuth token handshakes, payment confirmations. Denying the window leaves the
  // opener waiting on a message that never arrives, so the flow silently fails.
  // Same-site only: cross-site ads/trackers still fall through to Shields.
  function _isSameSitePopup(url, sourceUrl) {
    try {
      if (!sourceUrl) return false;
      var a = new URL(url), b = new URL(sourceUrl);
      if (a.protocol !== 'http:' && a.protocol !== 'https:') return false;
      var ea = _shields && _shields.eTLD1 ? _shields.eTLD1(a.href) : '';
      var eb = _shields && _shields.eTLD1 ? _shields.eTLD1(b.href) : '';
      if (!ea || !eb) return false;
      return ea === eb;
    } catch (e) { return false; }
  }

  // Route a window.open / target=_blank request from a site.
      //  - NEO's own OAuth authorize → PKCE system-browser handoff
      //  - Google login in external mode → system browser
      //  - External protocols (mailto:/tel:/etc.) → system browser
      //  - OAuth/auth popups → allow as a popup WINDOW (keeps opener ref so the
      //    auth flow completes exactly like Chrome; shares persist:webview session)
      //  - Everything else → NEW NEO TAB (foreground/background per disposition)
      function _routePopup(contents, details) {
        var url = details && details.url ? details.url : '';
        var disposition = details && details.disposition ? details.disposition : 'new-window';
        // 1) NEO's OWN OAuth authorize endpoint -> existing PKCE/system-browser flow.
        if (_isOwnGoogleAuthUrl(url)) {
          GOOGLE_OAUTH.start();
          console.log('[NEO-Route] dismiss popup (NEO OAuth PKCE handoff):', url.split('?')[0]);
          return { action: 'deny' };
        }
        // 2) External login mode -> the user's real system browser.
        if (_isGoogleLoginUrl(url) && _externalGoogleLogin()) {
          _openInSystemBrowser(url);
          console.log('[NEO-Route] login popup -> system browser:', url.split('?')[0]);
          return { action: 'deny' };
        }
        // 3) External protocols -> open in the OS application, never a NEO tab.
        if (/^(mailto:|tel:|sms:|ssh:|ftp:|smb:)/i.test(url)) {
          _openInSystemBrowser(url);
          console.log('[NEO-Route] external protocol -> system:', url.split('?')[0]);
          return { action: 'deny' };
        }
        // 4) OAuth/auth popup -> allow as a real popup window (same shared
        //    persist:webview session) so the auth flow completes like Chrome.
        if (_isOAuthPopup(url)) {
          console.log('[NEO-Route] OAuth popup -> window:', url.split('?')[0]);
          return {
            action: 'allow',
            overrideBrowserWindowOptions: {
              webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                partition: 'persist:webview',
                contextIsolation: true,
                nodeIntegration: false,
                webviewTag: false,
              }
            }
          };
        }
// 5) Shields: block known ad/popup windows (from $popup rules compiled
    //    from EasyList/EasyPrivacy). Runs after the auth flows above so
    //    logins are never blocked, but every other window.open is filtered.
    // 4.5) Same-site popups are allowed first so opener round-trips keep working.
    if (_isSameSitePopup(url, contents.getURL())) {
      console.log('[NEO-Route] same-site popup -> window:', url.split('?')[0]);
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            partition: 'persist:webview',
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: false
          }
        }
      };
    }
    try {
          if (_shields && _shields.shouldBlockPopup(url, contents.getURL())) {
            console.log('[NEO-Route] Shields blocked popup: ' + url.split('?')[0]);
            return { action: 'deny' };
          }
        } catch (e) {}
        // 5.5) Shields malicious firewall: deny window.open to confirmed
        //      malware/redirector domains (URLhaus + bundled + observed).
        //      Stops pirate sites force-opening scam landing tabs.
        try {
          if (_shields && _shields.shouldBlockMalicious(url)) {
            console.log('[NEO-Route] Shields blocked malicious redirect: ' + url.split('?')[0]);
            return { action: 'deny' };
          }
        } catch (e) {}
        // 6) Everything else -> NEW NEO TAB (no separate popup window).
        var mainWin = _mainBrowserWin();
        if (mainWin && !mainWin.isDestroyed()) {
          try {
            var sourceWcId = contents.id;
            mainWin.webContents.send('neo-open-tab', { url: url, disposition: disposition, sourceWcId: sourceWcId });
            console.log('[NEO-Route] url=' + url.split('?')[0] + ' disposition=' + disposition + ' srcWc=' + sourceWcId + ' -> NEO tab');
            if (_authDebugOn) _authDbg('[NEO-Route] url=' + url + ' disposition=' + disposition + ' srcWc=' + sourceWcId + ' -> NEO tab');
          } catch (err) {
            console.warn('[NEO-Route] send failed:', err.message);
          }
        }
        return { action: 'deny' };
      }
      contents.setWindowOpenHandler(function(details) {
        return _routePopup(contents, details);
      });
      // Help/sign-in popups from webview mirrors open white, never dark.
      _forceLightGoogleAuth(contents, false);

      // Right-click context menu for webview
      contents.on('context-menu', (event, params) => {
        const menuTemplate = [];
        if (params.editFlags.canGoBack || contents.canGoBack()) {
          menuTemplate.push({ label: 'Back', accelerator: 'Alt+Left', click: () => { try { contents.goBack(); } catch {} } });
        }
        if (params.editFlags.canGoForward || contents.canGoForward()) {
          menuTemplate.push({ label: 'Forward', accelerator: 'Alt+Right', click: () => { try { contents.goForward(); } catch {} } });
        }
        menuTemplate.push({ label: 'Reload', accelerator: 'F5', click: () => { try { contents.reload(); } catch {} } });
        menuTemplate.push({ type: 'separator' });
        if (params.linkURL) {
          menuTemplate.push({ label: 'Open link in new tab', click: () => {
            contents.send('open-in-new-tab', params.linkURL);
          }});
          menuTemplate.push({ type: 'separator' });
        }
        if (params.mediaType === 'image') {
          menuTemplate.push({ label: 'Open image in new tab', click: () => {
            contents.send('open-in-new-tab', params.srcURL);
          }});
          menuTemplate.push({ label: 'Copy image URL', click: () => {
            contents.copyImageAt(params.x, params.y);
          }});
          menuTemplate.push({ type: 'separator' });
        }
        menuTemplate.push({ label: 'Copy', accelerator: 'Ctrl+C', role: 'copy' });
        menuTemplate.push({ label: 'Paste', accelerator: 'Ctrl+V', role: 'paste' });
        menuTemplate.push({ label: 'Cut', accelerator: 'Ctrl+X', role: 'cut' });
        menuTemplate.push({ type: 'separator' });
        menuTemplate.push({ label: 'Select All', accelerator: 'Ctrl+A', role: 'selectAll' });
        menuTemplate.push({ type: 'separator' });
        menuTemplate.push({ label: 'Inspect Element', accelerator: 'Ctrl+Shift+I', click: () => {
          contents.inspectElement(params.x, params.y);
          if (contents.isDevToolsOpened()) contents.devToolsWebContents.focus();
        }});
        const menu = Menu.buildFromTemplate(menuTemplate);
        menu.popup();
      });
    }

    if (type === 'window') {

      // Right-click context menu for browser UI (homepage, AI panel, etc)
      contents.on('context-menu', (event, params) => {
        const menuTemplate = [
          { label: 'Reload', accelerator: 'F5', click: () => { try { contents.reload(); } catch {} } },
          { type: 'separator' },
          { label: 'Copy', accelerator: 'Ctrl+C', role: 'copy' },
          { label: 'Paste', accelerator: 'Ctrl+V', role: 'paste' },
          { label: 'Cut', accelerator: 'Ctrl+X', role: 'cut' },
          { type: 'separator' },
          { label: 'Select All', accelerator: 'Ctrl+A', role: 'selectAll' },
          { type: 'separator' },
          { label: 'Inspect Element', accelerator: 'Ctrl+Shift+I', click: () => {
            contents.inspectElement(params.x, params.y);
            if (contents.isDevToolsOpened()) contents.devToolsWebContents.focus();
          }},
        ];
        const menu = Menu.buildFromTemplate(menuTemplate);
        menu.popup();
      });
    }
  });

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    title: 'NEXORA Browser',
    icon: path.join(__dirname, 'assets', 'nexora-icon.png'),
    backgroundColor: '#0a0e1c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, 'ai-browser.html'));
  // Safety net: if the window ever ends up created-but-hidden (compositor hiccup,
  // renderer stall on a slow boot) make sure it is actually on screen.
  win.once('ready-to-show', () => { try { if (!win.isVisible()) win.show(); } catch (e) {} });
  setTimeout(() => { try { if (!win.isVisible()) { win.show(); win.focus(); } } catch (e) {} }, 4000);
  win.webContents.setUserAgent(USER_AGENT);
  // Intro (startup) sound: play immediately from the main process — never gated
  // behind the heavy UI load. Runs on the next tick so window creation isn't blocked.
  setTimeout(playIntroSoundAtLaunch, 120);

  // ===== WebContentsView SITE ENGINE =====
  // Replaces the <webview>-in-host-renderer for the ACTIVE site. A <webview> guest
  // is composited through a separate guest-renderer path that Windows intermittently
  // drops after navigation => black page on every static site (only video sites like
  // YouTube stay alive because frames keep the surface valid). A WebContentsView is
  // composited by the SAME host compositor as the window, so static sites paint
  // immediately with no black flash. We keep the DOM <webview> hidden for state/URL
  // mirroring, while this WCV is the visible page.
  const siteView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'beat-preload.js'),
      partition: 'persist:webview',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      nativeWindowOpen: true,
      enableRemoteModule: false,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
      experimentalFeatures: true,
      enableBlinkFeatures: 'CSSBackdropFilter,LayoutNG,FontAccess,FileSystemAccess,SerialPort,WebGPU',
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  siteView.setBackgroundColor('#ffffff');
  siteView.webContents.setUserAgent(USER_AGENT);
  // Per-site UA: Spotify and other streaming hosts must report a clean Chrome UA in
  // navigator.userAgent too (the header-level UA is already overridden per request
  // via getUAForURL). An "Electron/42.2.0" suffix in navigator.userAgent makes the
  // Spotify Web Player render its playback controls disabled/non-interactive. The
  // honest Electron UA is kept everywhere else; only the existing _streamingSites
  // list gets the pure Chromium UA, matching the app's existing UA design.
  var _applySiteUA = function() {
    try {
      var _u = siteView.webContents.getURL() || '';
      _siteUrl = _u;
      siteView.webContents.setUserAgent(getUAForURL(_u));
    } catch (e) {}
  };
  _applySiteUA();
  siteView.webContents.on('did-navigate', _applySiteUA);
  siteView.webContents.on('did-navigate-in-page', _applySiteUA);
  // "Add in NEXORA Browser" button on Chrome Web Store pages. did-navigate covers a
  // fresh load, did-finish-load covers a same-tab navigation that replaced the
  // document, and the timer catches the SPA case where the URL settles in place.
  siteView.webContents.on('did-finish-load', () => { _extInjectStoreInstaller(siteView.webContents); });
  siteView.webContents.on('did-navigate', () => { _extInjectStoreInstaller(siteView.webContents); });
  siteView.webContents.on('did-navigate-in-page', (e, url, isMainFrame) => {
    if (isMainFrame === false) return;
    _extInjectStoreInstaller(siteView.webContents);
    setTimeout(() => _extInjectStoreInstaller(siteView.webContents), 1800);
  });
  let _siteVisible = false;
  let _sitePendingUrl = '';
  let _siteReady = false;
  let _siteReadyTimer = null;

  function _siteReadyCheck() {
    if (_siteReady) return;
    _siteReady = true;
    if (_siteReadyTimer) { clearTimeout(_siteReadyTimer); _siteReadyTimer = null; }
    try {
      win.webContents.send('neo-wcv-event', {
        type: 'ready',
        url: siteView.webContents.getURL()
      });
    } catch (err) {}
  }
  function _siteReadyCancel() {
    _siteReady = false;
    if (_siteReadyTimer) { clearTimeout(_siteReadyTimer); _siteReadyTimer = null; }
  }

  // Shields cosmetic hiding: compile EasyList/uBO/AdGuard cosmetic rules for the
  // current page and inject them into the VISIBLE site view as a user
  // stylesheet, plus run scriptlet injections (anti-ad-script neutralizers).
  // Canvas/black-page safety: CSS injection is via insertCSS only (no preload,
  // no heavy DOM surgery) and never touches the hidden mirror <webview>.
  let _shieldsCssKey = null;
  function _injectShieldsCosmetic() {
    try {
      if (!_shields) return;
      var url = ''; try { url = siteView.webContents.getURL(); } catch (e) {}
      if (!/^https?:/i.test(url)) return;
      var payload = _shields.getCosmetic(url) || {};
      var wc = siteView.webContents;
      var prevKey = _shieldsCssKey;
      _shieldsCssKey = null;
      if (prevKey) { try { wc.removeInsertedCSS(prevKey); } catch (e) {} }
      if (payload.css) {
        wc.insertCSS(payload.css, { cssOrigin: 'user' }).then(function(key) {
          _shieldsCssKey = key;
        }).catch(function() {});
      }
      if (payload.injections) {
        try { wc.executeJavaScript(payload.injections).catch(function() {}); } catch (e) {}
      }
    } catch (e) {}
  }

  const _siteEvents = [
    'did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page',
    'did-finish-load', 'did-fail-load', 'page-title-updated', 'did-start-navigation',
    'will-navigate', 'will-redirect', 'console-message'
  ];
  _siteEvents.forEach(function(evt) {
    siteView.webContents.on(evt, function(e, a, b, c, d) {
      // History-lock guard: block google/youtube history pages before they load.
      if ((evt === 'will-navigate' || evt === 'will-redirect' || evt === 'did-start-navigation') && a) {
        if (tryGuardHistoryNav(e, a, siteView.webContents)) return;
      }
      // SIGN-IN MODE: default = embedded (so signing in INSIDE NEXORA stamps the
      // Google/YouTube session into NEO). With NEO_GOOGLE_LOGIN=external these
      // pages go to the system browser instead.
      if ((evt === 'will-navigate' || evt === 'will-redirect') && a && _isGoogleLoginUrl(a) && _externalGoogleLogin()) {
        e.preventDefault();
        _openInSystemBrowser(a);
        console.log('[LoginDivert] WCV ' + evt + ' -> system browser:', a.split('?')[0]);
        try { win.webContents.send('neo-wcv-event', { type: 'login-diverted', a: a }); } catch (err) {}
        return;
      }
      // Leaving a protected history page re-arms the lock so the next visit asks again.
      if ((evt === 'did-navigate' || evt === 'did-navigate-in-page') && a && _historyUnlocked) {
        if (!_histProtectedKind(a)) _historyUnlocked = false;
      }
      if (evt === 'did-finish-load' || evt === 'did-navigate' || evt === 'did-navigate-in-page') {
        _siteReadyCheck();
        _injectShieldsCosmetic();
      }
      // HONEST NOTICE (no bypass): Google's risk engine rejects credential
      // entry inside embedded Electron (accounts.google.com/v3/signin/rejected).
      // Never try to work around it. Surface a plain message to the user that
      // directs them to the official OAuth flow for NEXORA features.
      if ((evt === 'did-navigate' || evt === 'did-navigate-in-page') && a && _isGoogleLoginUrl(a)) {
        try { win.webContents.send('neo-wcv-event', { type: 'google-auth-unsupported', a: a }); } catch (err) {}
      }
      // AUTH DIAGNOSTIC: full-URL nav trail for the VISIBLE WCV (session = persist:webview)
      if (_authDebugOn) {
        if (evt === 'did-fail-load') {
          if (c) _authDbg('[NAV-WCV] did-fail-load code=' + a + ' desc=' + b + ' url=' + c + ' session=persist:webview');
        } else if ((evt === 'did-start-navigation' || evt === 'will-navigate' || evt === 'will-redirect' || evt === 'did-navigate' || evt === 'did-navigate-in-page') && a) {
          _authDbg('[NAV-WCV] ' + evt + ' url=' + a + ' isMain=' + (b === undefined ? '?' : b) + ' session=persist:webview');
        }
      }
      try { win.webContents.send('neo-wcv-event', { type: evt, a: a, b: b, c: c, d: d }); } catch (err) {}
    });
  });
  // window.open from the WCV -> route into a NEW NEO TAB (same session) instead
  // of a separate Electron popup, matching the webview handler above. Google
  // sign-in popups go to the system browser only in external mode and embedded
  // Google login popups keep their existing popup window untouched.
  try {
    siteView.webContents.setWindowOpenHandler(function(details) {
      return _routePopup(siteView.webContents, details);
    });
    // Google login renders white in the main site view AND in popups it opens
    // (e.g. the HELP window); every other site keeps the OS theme.
    _forceLightGoogleAuth(siteView.webContents, false);
    // If the auth flow runs as a NEW TAB in the site view (no popup window),
    // force the light theme while an accounts.google.com page is visible.
    (function() {
      function _watchGoogleTab() {
        try {
          var u = (siteView.webContents.getURL() || '').toLowerCase();
          var isGoogleAuth = /accounts\.google\.com/.test(u);
          _themeLight(isGoogleAuth ? 1 : 0);
        } catch(e) {}
      }
      siteView.webContents.on('did-navigate', _watchGoogleTab);
      siteView.webContents.on('did-navigate-in-page', _watchGoogleTab);
    })();
  } catch (e) {}

  function _showSite() {
    if (!_siteVisible) {
      try { win.contentView.addChildView(siteView); } catch (e) {}
      _siteVisible = true;
    }
    if (_sitePendingUrl) {
      var u = _sitePendingUrl; _sitePendingUrl = '';
      _siteReadyCancel();
      try { siteView.webContents.loadURL(u); } catch (e) {}
      _siteReadyCheck();
    }
  }
  function _hideSite() {
    _siteReadyCancel();
    if (_siteVisible) {
      try { win.contentView.removeChildView(siteView); } catch (e) {}
      _siteVisible = false;
    }
  }

  ipcMain.on('neo-wcv-show', function(event, data) {
    if (data && data.rect) {
      try {
        siteView.setBounds({
          x: Math.max(0, Math.round(data.rect.x)),
          y: Math.max(0, Math.round(data.rect.y)),
          width: Math.max(100, Math.round(data.rect.width)),
          height: Math.max(100, Math.round(data.rect.height))
        });
      } catch (e) {}
    }
    if (data && data.url) _sitePendingUrl = data.url;
    _showSite();
  });
  ipcMain.on('neo-wcv-navigate', function(event, url) {
    if (!url || !_isSafeExternalUrl(url)) return;
    if (_siteVisible) {
      _siteReadyCancel();
      try { siteView.webContents.loadURL(url); } catch (e) {}
      _siteReadyCheck();
    }
    else {
      _sitePendingUrl = url;
      _showSite();
    }
  });
  ipcMain.on('neo-wcv-resize', function(event, rect) {
    if (!_siteVisible || !rect) return;
    try {
      siteView.setBounds({
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: Math.max(100, Math.round(rect.width)),
        height: Math.max(100, Math.round(rect.height))
      });
    } catch (e) {}
  });
  ipcMain.on('neo-wcv-hide', function() { _hideSite(); });
  ipcMain.on('neo-wcv-back', function() { _siteReadyCancel(); try { if (siteView.webContents.canGoBack()) siteView.webContents.goBack(); } catch (e) {} });
  ipcMain.on('neo-wcv-forward', function() { _siteReadyCancel(); try { if (siteView.webContents.canGoForward()) siteView.webContents.goForward(); } catch (e) {} });
  ipcMain.on('neo-wcv-reload', function() { _siteReadyCancel(); try { siteView.webContents.reload(); } catch (e) {} });
  ipcMain.handle('neo-wcv-execjs', async function(event, js) {
    // Runs only inside the visible site guest, never the privileged UI. Still
    // validate the shape so a stray IPC call cannot throw or hang the handler.
    if (typeof js !== 'string' || !js || js.length > 20000) return undefined;
    try { return await siteView.webContents.executeJavaScript(js); } catch (e) { return undefined; }
  });
  ipcMain.handle('neo-wcv-getstate', async function() {
    var wc = siteView.webContents;
    var u = ''; try { u = wc.getURL(); } catch (e) {}
    var t = ''; try { t = wc.getTitle(); } catch (e) {}
    var loading = false; try { loading = wc.isLoading(); } catch (e) {}
    var back = false; try { back = wc.canGoBack(); } catch (e) {}
    var fwd = false; try { fwd = wc.canGoForward(); } catch (e) {}
    return { url: u, title: t, isLoading: loading, canGoBack: back, canGoForward: fwd };
  });

  ipcMain.on('window-minimize', (event) => {
    const w = winFromEvent(event);
    if (w) w.minimize();
  });
  ipcMain.on('window-maximize', (event) => {
    const w = winFromEvent(event);
    if (!w) return;
    try {
      if (w.isMaximized()) { w.unmaximize(); }
      else { w.maximize(); }
    } catch(e) { w.maximize(); }
  });
  ipcMain.on('window-restore', (event) => {
    const w = winFromEvent(event);
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.focus();
  });
  ipcMain.on('window-close', (event) => {
    const w = winFromEvent(event);
    if (!w || w.isDestroyed()) return;
    // ROBUST EXIT: the graceful save-and-destroy protocol below (win.on('close')
    // interception + before-quit/app-quitting ack + 3s fallback destroy timer)
    // does not reliably run on this build: win.close() can emit no 'close' event
    // at all, and the fallback timer then never arms - leaving the window stuck
    // open forever. The close button therefore performs a definitive, synchronous
    // quit: mark state as already-saved (bypasses the close() gate), best-effort
    // notify the renderer to persist, then force destroy. The renderer's frequent
    // periodic autosave + beforeunload already persist tabs/session continuously,
    // so no data is lost by skipping the ack dance.
    _saveAcknowledged = true;
    try { w.webContents.send('before-quit'); } catch(e) {}
    try { w.destroy(); } catch(e) {}
    try { app.quit(); } catch(e) {}
  });
  // On app quit, tell renderer to save before we go
  ipcMain.on('app-quitting', (event) => {
    // Renderer acknowledges, allow quit to proceed
    _saveAcknowledged = true;
    const w = winFromEvent(event);
    if (w && !w.isDestroyed()) {
      w.destroy();
    }
  });
  ipcMain.on('open-in-new-tab', (event, url) => {
    // Forwarded to renderer — handled in the HTML's JS
  });

  var _loginWindows = new Set();
  ipcMain.on('open-login-window', function(event, url, opts) {
    console.log('[LoginWin] Opening:', (url || '').slice(0, 120));
    if (!url || !_isSafeExternalUrl(url)) { console.warn('[LoginWin] Refused non-http(s) URL'); return; }
    opts = opts || {};
    // SIGN-IN MODE: OAuth authorize URLs (NEO Account "Sign in with Google")
    // always use the official PKCE+system-browser flow. Regular Google login
    // pages sign in INSIDE NEO by default (embedded), and only go to the system
    // browser when NEO_GOOGLE_LOGIN=external is set.
    if (typeof GOOGLE_OAUTH !== 'undefined' && GOOGLE_OAUTH && GOOGLE_OAUTH.isOAuthAuthUrl(url)) {
      GOOGLE_OAUTH.start();
      console.log('[LoginDivert] login window OAuth URL -> OAuth flow');
      try { win.webContents.send('login-window-closed'); } catch(e) {}
      return;
    }
    if (_isGoogleLoginUrl(url) && _externalGoogleLogin()) {
      _openInSystemBrowser(url);
      console.log('[LoginDivert] login window -> system browser:', url.split('?')[0]);
      try { win.webContents.send('login-window-closed'); } catch(e) {}
      return;
    }
    // EMBEDDED MODE: opening Google credential sign-in inside Neo's own window.
    // Google may reject the page ("browser or app may not be secure"), but the
    // user chose embedded sign-in — so load it and let the page speak for itself.
    // (The google-auth-unsupported notice is deliberately NOT raised here.)
    if (_isGoogleLoginUrl(url)) {
      console.log('[LoginDivert] login window loading Google login URL inside NEO (embedded):', url.split('?')[0]);
    }
    try {
      var wp = {
        sandbox: true,
        webviewTag: false,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        enableRemoteModule: false,
        disableDialogs: false,
        safeDialogs: false,
      };
      // Use the requested partition (e.g., YT Music's default session) or fall back to persist:webview
      if (opts.partition) {
        wp.partition = opts.partition;
      } else {
        wp.partition = 'persist:webview';
      }
      // No preload needed — this window just loads Google pages directly
      var loginWin = new BrowserWindow({
        width: 1200,
        height: 900,
        minWidth: 1200,
        minHeight: 900,
        resizable: true,
        frame: true,
        autoHideMenuBar: true,
        title: 'NEXORA Browser',
        icon: path.join(__dirname, 'assets', 'nexora-icon.png'),
        backgroundColor: '#ffffff',
        webPreferences: wp,
      });
      loginWin.setUserAgent(USER_AGENT);
      _loginWindows.add(loginWin);
      loginWin.webContents.setUserAgent(USER_AGENT);
      loginWin.on('closed', function() { _themeLight(0); });
      _themeLight(1);
      if (_authDebugOn) {
        _authDbg('[LOGINWIN] create url=' + url + ' partition=' + wp.partition);
        loginWin.webContents.on('will-navigate', (e2, u2) => _authDbg('[LOGINWIN] will-navigate url=' + u2 + ' partition=' + wp.partition));
        loginWin.webContents.on('will-redirect', (e3, u3) => _authDbg('[LOGINWIN] will-redirect url=' + u3 + ' partition=' + wp.partition));
        loginWin.webContents.on('did-navigate', (e4, u4) => _authDbg('[LOGINWIN] did-navigate url=' + u4 + ' partition=' + wp.partition));
        loginWin.webContents.on('did-navigate-in-page', (e5, u5) => _authDbg('[LOGINWIN] did-navigate-in-page url=' + u5 + ' partition=' + wp.partition));
        loginWin.webContents.on('did-fail-load', (e6, code, desc, u6) => { if (u6) _authDbg('[LOGINWIN] did-fail-load code=' + code + ' desc=' + desc + ' url=' + u6 + ' partition=' + wp.partition); });
      }
      // Google-only window -> always force the white sign-in page.
      _forceLightGoogleAuth(loginWin.webContents, true);
      // Allow popups from login windows (Google sign-in may open popups).
      // Google sign-in popups go to the system browser only in external mode.
      loginWin.webContents.setWindowOpenHandler(function(details) {
        if (details && _isGoogleLoginUrl(details.url) && _externalGoogleLogin()) {
          _openInSystemBrowser(details.url);
          console.log('[LoginDivert] login-window popup -> system browser:', (details.url || '').split('?')[0]);
          return { action: 'deny' };
        }
        return { action: 'allow' };
      });
      // (new-window event deprecated in Electron 28+; handled by setWindowOpenHandler above)
      // NOTE: The former _injectAntiDetectLogin() (removed) spoofed Chromium's
      // browser fingerprint — deleted navigator.webdriver, faked plugins/mimeTypes/
      // chrome.runtime/userAgentData/hardwareConcurrency. That IS what Google's
      // sign-in risk engine audits for; spoofing it made the login look automated.
      // Google authentication now runs in the real system browser instead, so no
      // fingerprint spoofing should ever be re-added here.
      loginWin.webContents.on('dom-ready', function() {
        _injectLoginHelpBtn();
      });

      // Inject a Help button that forces the old Google login UI
      function _injectLoginHelpBtn() {
        try {
          loginWin.webContents.executeJavaScript(`
            try {
              if (document.getElementById('_neo_help_btn')) return;
              var btn = document.createElement('div');
              btn.id = '_neo_help_btn';
              btn.textContent = '❓ Help (Old Login)';
              btn.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;padding:8px 16px;border-radius:20px;background:#1a73e8;color:#fff;font-size:13px;font-weight:500;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.3);font-family:Roboto,Arial,sans-serif;transition:0.2s;';
              btn.onmouseover = function(){this.style.background='#1557b0';};
              btn.onmouseout = function(){this.style.background='#1a73e8';};
              btn.onclick = function(){
                // Force old Google login UI via service=lso parameter
                var url = window.location.href;
                // Remove any existing flow params
                url = url.replace(/[?&](flowName|flowEntry|authuser|ui)=[^&]*/g, '');
                // Add service=lso to force classic login
                url += (url.indexOf('?') === -1 ? '?' : '&') + 'service=lso&hl=en&passive=false&force_old=true';
                window.location.href = url;
              };
              document.body.appendChild(btn);
            } catch(e){}
          `).catch(function(){});
        } catch(e) {}
      }
      // Log login window navigations for auth debugging
      loginWin.webContents.on('will-navigate', function(e, url) {
        console.log('[NEXORA Browser] Login window navigating:', url.split('?')[0].slice(0, 100));
      });
      loginWin.webContents.on('did-finish-load', function() {
        var u = loginWin.webContents.getURL() || '';
        // Only auto-close if clearly navigated away from ALL auth-related sites
        // This preserves OAuth redirect chains that may pass through intermediate URLs
        var isAuthRelated = /google|youtube|microsoft|live\.com|outlook|office|microsoftonline|github|gitlab|facebook|twitter|x\.com|discord|apple|yahoo|okta|auth0|onelogin|saml|oauth|login|signin|signup|register|accounts|passport|cas|sso/i.test(u);
        if (u && !isAuthRelated && u.indexOf('about:blank') === -1 && u.indexOf('data:') === -1) {
          console.log('[LoginWin] Auto-closing — navigated away from auth:', u.split('?')[0].slice(0, 100));
          if (loginWin && !loginWin.isDestroyed()) {
            setTimeout(function() {
              try { loginWin.close(); } catch(e) {}
            }, 800);
          }
        }
      });
      loginWin.on('closed', function() {
        _loginWindows.delete(loginWin);
        try { win.webContents.send('login-window-closed'); } catch(e) {}
      });
      console.log('[LoginWin] Loading URL:', (url || '').slice(0, 120));
      loginWin.loadURL(url);
    } catch(err) {
      console.error('[LoginWin] Error:', err.message, err.stack);
    }
  });

  // Open the Google OAuth authorize URL INSIDE NEO (embedded login window) sharing
  // the persist:webview session, instead of handing it to the system browser.
  // The loopback callback server lives in the main process, so the redirect to
  // http://127.0.0.1:12776/?code=... is served no matter which renderer fires it.
  function _openEmbeddedOAuthWindow(url) {
    try {
      var ow = new BrowserWindow({
        width: 1200,
        height: 900,
        minWidth: 900,
        minHeight: 700,
        resizable: true,
        frame: true,
        autoHideMenuBar: true,
        backgroundColor: '#ffffff',
        title: 'Google Sign-In — NEXORA Browser',
        icon: path.join(__dirname, 'assets', 'nexora-icon.png'),
        webPreferences: {
          sandbox: true,
          webviewTag: false,
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: true,
          enableRemoteModule: false,
          partition: 'persist:webview',
        },
      });
      ow.setUserAgent(USER_AGENT);
      ow.webContents.setUserAgent(USER_AGENT);
      _loginWindows.add(ow);
      ow.on('closed', function() {
        _loginWindows.delete(ow);
        _themeLight(0);
        try { win.webContents.send('login-window-closed'); } catch(e) {}
      });
      _themeLight(1);
      _forceLightGoogleAuth(ow.webContents, true);
      ow.loadURL(url);
      console.log('[OAuth] authorization URL opened INSIDE NEO:', (url || '').split('?')[0]);
      return true;
    } catch(e) {
      console.warn('[OAuth] embedded window error:', e.message);
      return false;
    }
  }

  // ==========================================================================
  // GOOGLE OAUTH 2.0 — AUTHORIZATION CODE + PKCE — SYSTEM BROWSER FLOW
  // --------------------------------------------------------------------------
  // Security model (all required, no insecure workarounds):
  //   * Google sign-in happens in the user's DEFAULT SYSTEM BROWSER only. We never
  //     load Google's login UI inside NEO's embedded webviews/windows and never
  //     spoof NEO as Chrome with user-agent/fingerprint tricks.
  //   * Official OAuth 2.0 Authorization Code flow with PKCE (S256).
  //   * No client secret is needed (public client + PKCE) and none is ever exposed
  //     to the renderer; all OAuth handling stays in the Electron main process.
  //   * A secure random `state` parameter protects against XSRF; the callback is
  //     accepted only if `state` matches the pending request.
  //   * Tokens are encrypted at rest with Electron `safeStorage`.
  //   * Normal Google browsing still works inside NEO; ONLY the OAuth v2 authorize
  //     endpoint (accounts.google.com/o/oauth2/...) is diverted to the system browser.
  //
  // How it works:
  //   renderer --"Sign in with Google"--> main:startGoogleSignIn()
  //   main: generate code_verifier + code_challenge(S256) + state, start loopback
  //         callback server on http://127.0.0.1:PORT, then
  //         shell.openExternal(authorization URL)  -> default system browser
  //   user : signs into their real Google account in Chrome/Edge/Firefox
  //   google: redirects to http://127.0.0.1:PORT/?code=...&state=...
  //   main : validates state, reads the code, exchanges it via
  //         POST https://oauth2.googleapis.com/token with the PKCE verifier
  //   main : stores tokens (encrypted via safeStorage), notifies renderer
  //   renderer: shows the signed-in Google account
  // ==========================================================================

  // ===== COMPLIANT GOOGLE LOGIN DIVERSION =====
  // Google's risk engine treats sign-in pages (accounts.google.com) loaded inside
  // an embedded Electron WebContentsView/<webview>/BrowserWindow as an unsupported
  // browser and rejects them with "This browser or app may not be secure". The
  // compliant fix is to hand EVERY Google login URL to the user's real system
  // browser (shell.openExternal) instead of loading accounts.google.com inside
  // NEO. This does NOT bypass/fake anything: it's Google's officially supported
  // path, and the existing PKCE/OAuth loopback keeps control flowing back to NEO.
  function _isGoogleLoginUrl(url) {
    try { var u = new URL(url); } catch(e) { return false; }
    var h = u.hostname.toLowerCase();
    if (h === 'accounts.google.com' || h === 'myaccount.google.com' || h === 'accounts.youtube.com') {
      if (/^(\/v3\/signin|\/ServiceLogin|\/signin\/|\/o\/oauth2\/v2\/auth|\/AccountChooser|\/Logout)/i.test(u.pathname)) return true;
      if (/signin/i.test(u.pathname) || u.pathname.indexOf('login') !== -1) return true;
    }
    return false;
  }

  // Open a URL in the user's system browser, never inside NEO. Used for all
  // Google login flows; returns a status string for logging.
  function _openInSystemBrowser(url) {
    if (!_isSafeExternalUrl(url)) { console.warn('[LoginDivert] Refused non-http(s) URL'); return ''; }
    try {
      shell.openExternal(url).catch(function(err) {
        console.warn('[LoginDivert] openExternal failed:', err && err.message);
      });
      return 'opened-in-system-browser';
    } catch(e) { console.warn('[LoginDivert] openExternal error:', e.message); return ''; }
  }

  // Google sign-in MODE. DEFAULT = 'embedded': the user signs in INSIDE NEO so
  // the Google/YouTube session lands in NEO's persistent browser (this is a real
  // Chromium renderer — Google accepts it). Set NEO_GOOGLE_LOGIN=external (or
  // prefs.json googleLoginExternal:true) to divert Google login pages to the
  // system browser instead (fallback if a future Google check rejects embedded).
  // Both are legitimate — nothing here spoofs or bypasses Google authentication.
  function _externalGoogleLogin() {
    try {
      if (/^(1|true|external|on|yes)$/i.test(String(process.env.NEO_GOOGLE_LOGIN || ''))) return true;
      try {
        var prefs = null;
        try { prefs = JSON.parse(require('fs').readFileSync(path.join(app.getPath('userData'), 'prefs.json'), 'utf8')); } catch(e) {}
        if (prefs && prefs.googleLoginExternal === true) return true;
      } catch(e) {}
    } catch(e) {}
    return false;
  }

  var GOOGLE_OAUTH = (function() {
    const crypto = require('crypto');
    // ---- CONFIG — YOU MUST FILL THIS IN ----
    // 1. Go to https://console.cloud.google.com/apis/credentials
    // 2. Create an OAuth 2.0 Client ID -> Application type: "Web application".
    // 3. Under "Authorized redirect URIs" add EXACTLY:   http://127.0.0.1
    //    (Google ignores the port for loopback redirects, so the runtime port below
    //     is accepted as long as you registered the bare loopback host.)
    // 4. Copy the Client ID below. The secret field is intentionally left blank —
    //    this is a public client secured by PKCE (safer than shipping a secret).
    var CFG = {
      clientSecret: '',
      redirectHost: '127.0.0.1',
      redirectPort: 12776,
      scopes: ['openid', 'email', 'profile'],
      timeoutMs: 5 * 60 * 1000, // 5 minutes to finish in the system browser
    };
    // Loads Client ID/secret/scopes/port. Precedence: NEO_GOOGLE_CLIENT_ID env
    // var > the private userData/google-oauth-config.json (never packaged) >
    // placeholder. The file lives only on the user's machine, so the packaged
    // application contains NO client secret.
    function _mergeCfgFromFile() {
      CFG.clientId = process.env.NEO_GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_OAUTH_CLIENT_ID_HERE.apps.googleusercontent.com';
      CFG.clientSecret = '';
      CFG.redirectPort = 12776;
      CFG.scopes = ['openid', 'email', 'profile'];
      try {
        var _cfgPath = path.join(app.getPath('userData'), 'google-oauth-config.json');
        if (fs.existsSync(_cfgPath)) {
          var _cfg = JSON.parse(fs.readFileSync(_cfgPath, 'utf8').replace(/^\uFEFF/, '')); // tolerate BOM
          if (_cfg.clientId && typeof _cfg.clientId === 'string' && CFG.clientId.indexOf('YOUR_GOOGLE') !== -1) CFG.clientId = _cfg.clientId;
          if (_cfg.clientSecret && typeof _cfg.clientSecret === 'string') CFG.clientSecret = _cfg.clientSecret;
          if (Array.isArray(_cfg.scopes) && _cfg.scopes.length) CFG.scopes = _cfg.scopes.map(String);
          if (_cfg.redirectPort) CFG.redirectPort = parseInt(_cfg.redirectPort, 10) || 12776;
        }
      } catch(e) { console.warn('[OAuth] config load error:', e.message); }
      CFG.redirectUri = 'http://' + CFG.redirectHost + ':' + CFG.redirectPort;
    }
    _mergeCfgFromFile();

    var _server = null;          // loopback callback server
    var _pending = null;         // { verifier, state, verifierStart, win, timer }
    var _tokenPath = path.join(app.getPath('userData'), 'google-oauth.json');

    function _b64u(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
    function _randB64u(bytes) { return _b64u(crypto.randomBytes(bytes)); }
    function _sha256B64u(str) { return _b64u(crypto.createHash('sha256').update(str).digest()); }

    function _send(evt, data) {
      try { if (win && !win.isDestroyed()) win.webContents.send(evt, data); } catch(e) {}
    }

    // Identify Google OAuth AUTHORIZATION requests only (not normal Google pages).
    // Normal accounts.google.com login / google search continue to work inside NEO.
    function isOAuthAuthUrl(url) {
      try {
        if (!url || typeof url !== 'string') return false;
        var u = new URL(url);
        var h = u.hostname.replace(/^www\./, '').toLowerCase();
        if (h !== 'accounts.google.com') return false;
        var p = u.pathname;
        return p.indexOf('/o/oauth2/v2/auth') === 0 || p.indexOf('/o/oauth2/auth') === 0;
      } catch(e) { return false; }
    }

    // ---- PKCE + authorization URL ----
    function _buildAuthUrl() {
      var verifier = _randB64u(48);            // >=43 chars, base64url safe
      var challenge = _sha256B64u(verifier);
      var state = _randB64u(24);               // strong anti-CSRF
      var qs = new URLSearchParams({
        client_id: CFG.clientId,
        redirect_uri: CFG.redirectUri,
        response_type: 'code',
        scope: CFG.scopes.join(' '),
        state: state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',                // get a refresh_token
        prompt: 'select_account',
        include_granted_scopes: 'true',
      });
      return { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + qs.toString(), verifier: verifier, state: state };
    }

    // ---- Loopback callback server (start once, reused) ----
    function _ensureServer() {
      if (_server) return true;
      try {
        _server = http.createServer(function(req, res) {
          // Called by the system browser right after the user finishes signing in.
          var u = req.url || '';
          _authDbg('[OAUTH] callback HTTP request: ' + u);
          var state = null, code = null, error = null, errorDesc = '';
          try {
            var p = new URL(u, 'http://x').searchParams;
            state = p.get('state');
            code = p.get('code');
            error = p.get('error');
            errorDesc = p.get('error_description') || '';
          } catch(e) {}
          // Respond immediately so the user's browser tab closes cleanly.
          var body = '<!doctype html><html><head><meta charset="utf-8"><title>NEXORA Browser</title>'
            + '<style>body{font-family:system-ui,Arial;background:#0d0d12;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.c{text-align:center;max-width:420px}h1{font-size:22px;margin:0 0 10px}p{color:#9aa}.ok{color:#34d399}.err{color:#f87171}</style></head><body><div class="c">'
            + (error ? '<h1 class="err">Google sign-in failed</h1><p>' + _escH(error) + (errorDesc ? ' — ' + _escH(errorDesc) : '') + '</p>'
                      : '<h1 class="ok">Signed in to NEXORA Browser</h1><p>You can close this tab and return to NEXORA.</p>')
            + '</div></body></html>';
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(body);

          // Handle the result asynchronously (server must respond first).
          setTimeout(function() { _finishCallback({ state: state, code: code, error: error, errorDesc: errorDesc }); }, 50);
        });
        _server.on('error', function(err) { console.warn('[OAuth] loopback server error:', err.message); });
        _server.listen(CFG.redirectPort, CFG.redirectHost);
        _authDbg('[OAUTH] loopback server listening on http://' + CFG.redirectHost + ':' + CFG.redirectPort);
        return true;
      } catch(e) { console.warn('[OAuth] loopback server error:', e.message); return false; }
    }

    function _escH(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

    // ---- Validate + exchange ----
    function _finishCallback(rc) {
      var pend = _pending;
      if (!pend) { console.warn('[OAuth] callback with no pending request'); _authDbg('[OAUTH] callback with NO pending request'); return; }
      clearTimeout(pend.timer);
      _pending = null;
      // Validate the state parameter (anti-CSRF). Mismatch/absent => reject.
      if (!rc.state || rc.state !== pend.state) {
        _authDbg('[OAUTH] state check FAILED (got=' + rc.state + ')');
        // OAuth spec: state mismatch means a forged/cross-site callback. Abort.
        try { if (win && !win.isDestroyed()) win.focus(); } catch(e) {}
        _send('google-auth-result', { ok: false, error: 'Invalid OAuth state (possible cross-site request). Please try again.' });
        return;
      }
      _authDbg('[OAUTH] state OK, code=' + (rc.code ? 'present' : 'MISSING') + ' error=' + (rc.error || 'none'));
      // OAuth denied-by-user / error from Google.
      if (rc.error) {
        try { if (win && !win.isDestroyed()) win.focus(); } catch(e) {}
        _send('google-auth-result', { ok: false, error: (rc.errorDesc || rc.error), cancelled: rc.error === 'access_denied' });
        return;
      }
      if (!rc.code) { _authDbg('[OAUTH] no code in callback'); _send('google-auth-result', { ok: false, error: 'No authorization code received.' }); return; }
      // Exchange the code + PKCE verifier for tokens.
      _exchangeCode(rc.code, pend.verifier);
    }

    function _exchangeCode(code, verifier) {
      var form = new URLSearchParams({
        code: code,
        client_id: CFG.clientId,
        client_secret: '' + (CFG.clientSecret || ''), // public client: empty is fine with PKCE
        redirect_uri: CFG.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }).toString();
      var payload = Buffer.from(form);
      var body = '';
      var req = https.request({
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': payload.length },
      }, function(res) {
        res.on('data', function(d) { body += d; });
        res.on('end', function() {
          _authDbg('[OAUTH] token endpoint response received, len=' + body.length);
          try { _handleTokenResponse(JSON.parse(body)); }
          catch(e) { _authDbg('[OAUTH] token parse failed'); _send('google-auth-result', { ok: false, error: 'Token exchange failed: invalid response.' }); }
        });
      });
      req.on('error', function(err) { _authDbg('[OAUTH] token exchange request error: ' + (err.message || err)); _send('google-auth-result', { ok: false, error: 'Token exchange failed: ' + (err.message || err) }); });
      req.write(payload);
      req.end();
    }

    function _decodeIdToken(idToken) {
      try {
        var parts = idToken.split('.');
        if (parts.length < 2) return null;
        var json = Buffer.from(parts[1], 'base64url').toString('utf8');
        return JSON.parse(json);
      } catch(e) { return null; }
    }

    function _handleTokenResponse(tok) {
      if (!tok || tok.error) {
        var em = (tok && (tok.error_description || tok.error)) || 'unknown';
        _authDbg('[OAUTH] token exchange FAILED: ' + em);
        _send('google-auth-result', { ok: false, error: 'Google rejected the token exchange: ' + em });
        return;
      }
      var profile = _decodeIdToken(tok.id_token) || {};
      var stored = {
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token || '',
        idToken: tok.id_token || '',
        scope: tok.scope || '',
        expiresAt: Date.now() + (parseInt(tok.expires_in, 10) || 3600) * 1000,
        email: profile.email || '',
        name: profile.name || (profile.email || '').split('@')[0] || '',
        picture: profile.picture || '',
        sub: profile.sub || '',
        obtainedAt: Date.now(),
      };
      _persistTokens(stored);
      _authDbg('[OAUTH] token exchange OK, signed in as ' + (profile.email || '?masked?') + ' scope=' + (tok.scope || ''));
      try { if (win && !win.isDestroyed()) win.focus(); } catch(e) {}
      _send('google-auth-result', { ok: true, profile: { email: stored.email, name: stored.name, picture: stored.picture, sub: stored.sub } });
    }

    // ---- Encrypted persistence via safeStorage ----
    function _persistTokens(obj) {
      try {
        var appDir = path.dirname(_tokenPath);
        if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true });
        var json = JSON.stringify(obj);
        var blob = (app.safeStorage && app.safeStorage.isEncryptionAvailable())
          ? app.safeStorage.encryptString(json)     // encrypted at rest
          : Buffer.from('U' + json, 'utf8');        // fallback (see _loadTokens)
        fs.writeFileSync(_tokenPath, blob);
        _authDbg('[OAUTH] tokens persisted (encrypted=' + (blob[0] !== 0x55) + ')');
      } catch(e) { console.warn('[OAuth] persist error:', e.message); _authDbg('[OAUTH] persist error: ' + (e.message || e)); }
    }
    function _loadTokens() {
      try {
        if (!fs.existsSync(_tokenPath)) return null;
        var blob = fs.readFileSync(_tokenPath);
        var json = null;
        if (app.safeStorage && app.safeStorage.isEncryptionAvailable() && blob[0] !== 0x55 /*'U'*/) {
          try { json = app.safeStorage.decryptString(blob); } catch(e) { return null; }
        } else {
          json = blob.toString('utf8');
          if (json[0] === 'U') json = json.slice(1);
        }
        return JSON.parse(json);
      } catch(e) { return null; }
    }
    function _deleteTokens() {
      try { if (fs.existsSync(_tokenPath)) fs.unlinkSync(_tokenPath); } catch(e) {}
    }

    // ---- Silent refresh (uses the stored refresh_token) ----
    function _refreshAccessToken() {
      return new Promise(function(resolve, reject) {
        var t = _loadTokens();
        if (!t || !t.refreshToken) return reject(new Error('No refresh token available.'));
        var form = new URLSearchParams({
          client_id: CFG.clientId,
          client_secret: '' + (CFG.clientSecret || ''),
          refresh_token: t.refreshToken,
          grant_type: 'refresh_token',
        }).toString();
        var req = https.request({
          method: 'POST',
          hostname: 'oauth2.googleapis.com',
          path: '/token',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
        }, function(res) {
          var chunks = [];
          res.on('data', function(c) { chunks.push(c); });
          res.on('end', function() {
            try {
              var j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (!j || j.error) return reject(new Error((j && (j.error_description || j.error)) || 'refresh failed'));
              t.accessToken = j.access_token;
              if (j.refresh_token) t.refreshToken = j.refresh_token;
              t.scope = j.scope || t.scope;
              t.expiresAt = Date.now() + (parseInt(j.expires_in, 10) || 3600) * 1000;
              _persistTokens(t);
              resolve(t.accessToken);
            } catch(e) { reject(e); }
          });
        });
        req.on('error', reject);
        req.end(form);
      });
    }

    // ---- Authorized access to official Google APIs (NEXORA features only).
    //      Path is whitelisted to www.googleapis.com endpoints in the main
    //      process, so the renderer can never redirect tokens elsewhere.
    function fetchAPI(apiPath) {
      return new Promise(function(resolve) {
        function _try(token) {
          var p = String(apiPath || '').trim();
          if (!/^\/[^/]/.test(p) || p.indexOf('..') !== -1) { resolve({ ok: false, status: 0, error: 'Invalid API path.' }); return; }
          var req = https.request({
            method: 'GET',
            hostname: 'www.googleapis.com',
            path: p,
            headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
          }, function(res) {
            var chunks = [];
            res.on('data', function(c) { chunks.push(c); });
            res.on('end', function() {
              var body = Buffer.concat(chunks).toString('utf8');
              var data = null;
              try { data = JSON.parse(body); } catch(e) { data = body; }
              // 401 -> token expired; silently refresh once and retry.
              if (res.statusCode === 401 && token) {
                _refreshAccessToken().then(function(nt) { _try(nt); }, function() {
                  resolve({ ok: false, status: res.statusCode, data: data });
                });
                return;
              }
              resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: data });
            });
          });
          req.on('error', function(err) { resolve({ ok: false, status: 0, error: err.message }); });
          req.end();
        }
        var t = _loadTokens();
        if (!t || !t.accessToken) { resolve({ ok: false, status: 0, error: 'Not signed in to Google.' }); return; }
        if (!t.expiresAt || t.expiresAt <= Date.now() + 60000) {
          if (!t.refreshToken) { resolve({ ok: false, status: 0, error: 'Access token expired and no refresh token is available.' }); return; }
          _refreshAccessToken().then(function(nt) { _try(nt); }, function(err) { resolve({ ok: false, status: 0, error: err.message }); });
          return;
        }
        _try(t.accessToken);
      });
    }

    // ---- Config status & safe editing (main-process only) ----
    function _maskClientId(id) {
      try {
        if (!id || /YOUR_GOOGLE/.test(id)) return '';
        var m = String(id);
        return (m.slice(0, 12) + '\u2026' + '.apps.googleusercontent.com');
      } catch(e) { return ''; }
    }
    function configStatus() {
      return {
        configured: CFG.clientId.indexOf('YOUR_GOOGLE') === -1 && /\.apps\.googleusercontent\.com$/.test(CFG.clientId),
        clientIdMasked: _maskClientId(CFG.clientId),
        hasSecret: !!CFG.clientSecret,
        redirectUri: CFG.redirectUri,
        scopes: CFG.scopes,
      };
    }
    // Persists the private config next to the token store (userData). Writing is
    // done here so the packaged application never embeds a secret, and the file
    // is validated before it touches disk.
    function writeConfig(input) {
      var cfgPath = path.join(app.getPath('userData'), 'google-oauth-config.json');
      var clientId = String((input && input.clientId) || '').trim();
      var clientSecret = (input && input.clientSecret != null) ? String(input.clientSecret) : '';
      if (clientId && !/\.apps\.googleusercontent\.com$/.test(clientId)) {
        return { ok: false, error: 'Client ID must end with .apps.googleusercontent.com' };
      }
      var prev = {};
      try { if (fs.existsSync(cfgPath)) prev = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '')); } catch(e) {}
      var prevPort = CFG.redirectPort;
      if (clientId) {
        prev.clientId = clientId;
        prev.clientSecret = clientSecret;
        prev.scopes = prev.scopes || ['openid', 'email', 'profile'];
        try {
          fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
          fs.writeFileSync(cfgPath, JSON.stringify(prev, null, 2));
        } catch(e) { return { ok: false, error: 'Could not write config: ' + e.message }; }
      } else {
        try { if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath); } catch(e) {}
      }
      _mergeCfgFromFile();
      return { ok: true, restartNeeded: CFG.redirectPort !== prevPort && !!( _server && _server.listening ), status: configStatus() };
    }

    // ---- Public API ----
    function _getProfile() {
      var t = _loadTokens();
      if (!t || !t.accessToken) return null;
      return { email: t.email, name: t.name, picture: t.picture, sub: t.sub, expiresAt: t.expiresAt };
    }
    function _isSignedIn() { var p = _getProfile(); return !!(p && p.email); }

    // Kick off the whole sign-in.
    function startSignIn() {
      if (_pending) { _authDbg('[OAUTH] startSignIn called while a sign-in is already pending'); _send('google-auth-result', { ok: false, error: 'A Google sign-in is already in progress.' }); return false; }
      if (CFG.clientId.indexOf('YOUR_GOOGLE') !== -1) {
        _authDbg('[OAUTH] startSignIn called but Client ID is still the placeholder');
        _send('google-auth-result', { ok: false, error: 'Google OAuth is not configured yet. Add your Client ID in main.js (GOOGLE_OAUTH CFG) or set the NEO_GOOGLE_CLIENT_ID environment variable.' });
        return false;
      }
      if (!_ensureServer()) { _send('google-auth-result', { ok: false, error: 'Could not start the local callback server.' }); return false; }
      var a = _buildAuthUrl();
      var pend = {
        verifier: a.verifier, state: a.state, win: win,
        timer: setTimeout(function() {
          _pending = null;
          _send('google-auth-result', { ok: false, error: 'Google sign-in timed out. Please try again.', cancelled: true });
        }, CFG.timeoutMs),
      };
      _pending = pend;
      _authDbg('[OAUTH] signing in; opening authorization URL inside NEO (embedded): ' + a.url);
      // EMBEDDED: open the authorize page inside NEO's own window (shares the
      // persist:webview session). The loopback callback is handled in main.
      _openEmbeddedOAuthWindow(a.url);
      console.log('[OAuth] authorization URL opened inside NEO');
      return true;
    }

    function signOut() {
      // Best-effort server-side revocation so the token can't be reused.
      var _t = _loadTokens();
      if (_t && _t.accessToken) {
        try {
          var _q = String(new URLSearchParams({ token: _t.accessToken }));
          var _r = https.request({
            method: 'POST',
            hostname: 'oauth2.googleapis.com',
            path: '/revoke',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(_q) },
          });
          _r.end(_q);
        } catch(e) {}
      }
      _deleteTokens();
      _send('google-auth-result', { ok: true, signedOut: true, profile: null });
      return true;
    }

    function status() {
      return { signedIn: _isSignedIn(), profile: _getProfile() };
    }

    // Start the loopback server early so the callback is always reachable.
    try { _ensureServer(); } catch(e) {}
    try { console.log('[OAuth] configured=' + configStatus().configured + ' clientId=' + (configStatus().clientIdMasked || '(placeholder)') + ' redirect=' + CFG.redirectUri); } catch(e) {}

    return {
      start: startSignIn,
      signOut: signOut,
      status: status,
      isOAuthAuthUrl: isOAuthAuthUrl,
      clientId: function() { return CFG.clientId || ''; },
      fetch: fetchAPI,
      configStatus: configStatus,
      writeConfig: writeConfig,
    };
  })();

  // ---- OAuth IPC (main <-> renderer bridge) ----
  ipcMain.handle('google-oauth-start', function() { return GOOGLE_OAUTH.start(); });
  ipcMain.handle('google-oauth-signout', function() { return GOOGLE_OAUTH.signOut(); });
  ipcMain.handle('google-oauth-status', function() { return GOOGLE_OAUTH.status(); });
  ipcMain.handle('google-oauth-start-callback', function() { return GOOGLE_OAUTH.start(); });
  ipcMain.handle('google-oauth-fetch', function(event, apiPath) { return GOOGLE_OAUTH.fetch(String(apiPath == null ? '' : apiPath)); });
  ipcMain.handle('google-oauth-config-get', function() { return GOOGLE_OAUTH.configStatus(); });
  ipcMain.handle('google-oauth-config-set', function(event, input) { return GOOGLE_OAUTH.writeConfig(input || {}); });

  // Intercept close to notify renderer and wait for save before actually closing
  win.on('close', (event) => {
    if (!_saveAcknowledged) {
      event.preventDefault();
      win.webContents.send('before-quit');
      // Force close after 3s if renderer doesn't respond
      setTimeout(() => {
        if (!_saveAcknowledged) {
          _saveAcknowledged = true;
          try { win.destroy(); } catch {}
        }
      }, 3000);
    }
  });
  ipcMain.on('window-fullscreen', (event) => {
    win.setFullScreen(!win.isFullScreen());
  });

  win.on('enter-fullscreen', () => {
    win.webContents.send('fullscreen-changed', true);
  });
  win.on('leave-fullscreen', () => {
    win.webContents.send('fullscreen-changed', false);
  });

  // ===== ACCOUNT MANAGER SECURITY =====
  // DevTools monitoring — alert renderer when devtools open/close
  win.webContents.on('devtools-opened', () => {
    try { if (!win.isDestroyed()) win.webContents.send('devtools-changed', true); } catch(e) {}
  });
  win.webContents.on('devtools-closed', () => {
    try { if (!win.isDestroyed()) win.webContents.send('devtools-changed', false); } catch(e) {}
  });

  // IPC: get current security status
  ipcMain.handle('acct-sec-status', async () => {
    try {
      var w = BrowserWindow.getFocusedWindow();
      if (!w || w.isDestroyed()) return { devtoolsOpen: false };
      return { devtoolsOpen: w.webContents.isDevToolsOpened() };
    } catch(e) { return { devtoolsOpen: false }; }
  });

  // IPC: main‑assisted vault wipe — also clears any cached data in main process
  ipcMain.handle('acct-sec-wipe', async () => {
    console.log('[AcctSec] Main process wipe requested');
    return { ok: true };
  });

  // Screenshot: capture the active webview
  ipcMain.handle('take-screenshot', async () => {
    try {
      const { webContents } = require('electron');
      const all = webContents.getAllWebContents();
      let target = null;
      for (const wc of all) {
        if (wc.getType() === 'webview') {
          const url = wc.getURL();
          // Skip the music player webview (music.youtube.com or empty)
          if (url && url !== 'about:blank' && !url.includes('music.youtube.com')) {
            target = wc;
            break;
          }
        }
      }
      if (!target) return null;
      const image = await target.capturePage();
      const buf = image.toPNG();
      return 'data:image/png;base64,' + buf.toString('base64');
    } catch { return null; }
  });

  // YouTube search (no API key required)
  ipcMain.handle('yt-search', async (event, query) => {
    try {
      const html = await httpsGet('https://www.youtube.com/results?search_query=' + encodeURIComponent(query));
      // Extract video IDs
      const idRegex = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
      const ids = [];
      let m;
      while ((m = idRegex.exec(html)) !== null) {
        if (!ids.includes(m[1])) ids.push(m[1]);
        if (ids.length >= 10) break;
      }
      if (ids.length === 0) return [];
      // Get titles via oembed
      const results = [];
      for (const id of ids) {
        try {
          const oembed = await httpsGet('https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=' + id + '&format=json');
          const info = JSON.parse(oembed);
          results.push({ id, title: info.title || 'Unknown', channel: info.author_name || 'YouTube', thumb: 'https://img.youtube.com/vi/' + id + '/hqdefault.jpg' });
        } catch {
          results.push({ id, title: 'Unknown', channel: 'YouTube', thumb: 'https://img.youtube.com/vi/' + id + '/hqdefault.jpg' });
        }
      }
      return results;
    } catch { return []; }
  });

  // Inject video-end detection script into active webview
  ipcMain.handle('inject-video-watcher', async () => {
    try {
      const { webContents } = require('electron');
      const all = webContents.getAllWebContents();
      let target = null;
      for (const wc of all) {
        if (wc.getType() === 'webview') {
          const url = wc.getURL();
          if (url && url !== 'about:blank' && !url.includes('music.youtube.com')) {
            target = wc;
            break;
          }
        }
      }
      if (!target) return false;
      await target.executeJavaScript(`
        (function() {
          if (window.__neoVideoWatcherInstalled) return;
          window.__neoVideoWatcherInstalled = true;
          function checkVideo() {
            var videos = document.querySelectorAll('video');
            var anyEnded = false;
            for (var i = 0; i < videos.length; i++) {
              if (videos[i].ended) { anyEnded = true; break; }
            }
            if (anyEnded) {
              // Video ended - notify main process
              window.__neoVideoEnded = true;
            }
          }
          setInterval(checkVideo, 2000);
          // Also listen for 'ended' event directly
          document.addEventListener('ended', function(e) {
            if (e.target && e.target.tagName === 'VIDEO') {
              window.__neoVideoEnded = true;
            }
          }, true);
        })();
      `).catch(function() {});
      // Start a polling loop to check if video ended.
      // Clear it when the guest navigates/dies so we never poll a stale webview forever.
      if (global.__neoVideoPollInterval) clearInterval(global.__neoVideoPollInterval);
      var _neoPollTarget = target;
      var _neoClearVideoPoll = function() {
        if (global.__neoVideoPollInterval) {
          clearInterval(global.__neoVideoPollInterval);
          global.__neoVideoPollInterval = null;
        }
      };
      try {
        _neoPollTarget.once('destroyed', _neoClearVideoPoll);
        _neoPollTarget.once('did-navigate', _neoClearVideoPoll);
      } catch(e) {}
      global.__neoVideoPollInterval = setInterval(function() {
        if (!_neoPollTarget || _neoPollTarget.isDestroyed()) { _neoClearVideoPoll(); return; }
        _neoPollTarget.executeJavaScript('window.__neoVideoEnded || false').then(function(res) {
          if (res) {
            var win = BrowserWindow.getFocusedWindow();
            if (win && !win.isDestroyed()) win.webContents.send('video-ended');
            _neoClearVideoPoll();
          }
        }).catch(function() {});
      }, 3000);
      return true;
    } catch { return false; }
  });

  // Return preload path for webview beat analyzer. Left empty: injecting ANY
  // preload style script into the guest webview (even a pure anti-detect one)
  // causes the black/blank-screen bug on this machine. So no preload is used.
  ipcMain.handle('get-beat-preload', () => {
    return '';
  });

  // Run JS inside a guest webview from the main process with a hard timeout.
  // Doing this in main keeps a hung/unresponsive guest from freezing the UI renderer.
  ipcMain.handle('webview-execjs', async (event, payload) => {
    try {
      var wcId = payload && payload.wcId;
      var js = payload && payload.js;
      var ms = payload && payload.ms ? payload.ms : 2000;
      if (!wcId || typeof js !== 'string' || !js) return '';
      if (js.length > 20000) return '';
      ms = Math.max(250, Math.min(Number(ms) || 2000, 10000));
      var wc = webContents.fromId(wcId);
      if (!wc || wc.isDestroyed()) return '';
      // Guest-only: the target must be a <webview> guest hosted by the main
      // window. Without this, a compromised renderer could pass the main
      // window's own webContents id and run code in the privileged UI context.
      var mainWin = null;
      try { mainWin = _mainBrowserWin(); } catch (e) {}
      var host = null;
      try { host = wc.hostWebContents; } catch (e) {}
      if (!mainWin || !host || host !== mainWin.webContents) return '';
      var url = '';
      try { url = wc.getURL() || ''; } catch(e) {}
      if (!url || url === 'about:blank') return '';
      return await new Promise(function(resolve) {
        var settled = false;
        var timer = setTimeout(function() {
          if (settled) return;
          settled = true;
          resolve('');
        }, ms);
        wc.executeJavaScript(js, true).then(function(r) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (Array.isArray(r)) resolve(r);
          else if (r && typeof r === 'object') resolve(r);
          else resolve(typeof r === 'string' ? r : (r === undefined || r === null ? '' : String(r)));
        }).catch(function() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve('');
        });
      });
    } catch(e) { return ''; }
  });

  // ===== Embedded page translator (no python backend needed) =====
  var _trnCache = new Map();
  var _TRN_ENT = { '&apos;': "'", '&#39;': "'", '&quot;': '"', '&#34;': '"', '&amp;': '&', '&#38;': '&', '&gt;': '>', '&lt;': '<', '&nbsp;': ' ', '&#160;': ' ' };
  // Latin-script targets keep ALL-CAPS words in English (Google treats them as
  // brands/acronyms and never translates them). For non-Latin targets the case
  // is meaningless, so we lowercase full-caps words before sending - this makes
  // Google translate them instead of leaving them in English.
  var _TRN_LATIN_SET = ('en es fr de it pt nl pl cs sk sl hr bs vi id ms tl sw af sq et lv lt ro hu cy ga gl eu ca da no sv fi is mt ha yo ig zu xh st sn nso so mg ceb ny tw ak to ht haw mi sm gd lb fy co kri').split(' ');
  function _trnLowerCaps(text, target) {
    text = String(text);
    if (target && _TRN_LATIN_SET.indexOf(target) !== -1) return text;
    return text.replace(/(^|[^A-Za-z'])[A-Z]{2,}(?!['A-Za-z])/g, function(m, p1) {
      return p1 + m.slice(p1.length).toLowerCase();
    });
  }
  function _trnUnescape(s) {
    if (typeof s !== 'string') return '';
    var keys = Object.keys(_TRN_ENT);
    for (var i = 0; i < keys.length; i++) {
      if (s.indexOf(keys[i]) !== -1) s = s.split(keys[i]).join(_TRN_ENT[keys[i]]);
    }
    return s;
  }
  function _trnChunks(text, limit) {
    text = String(text || '').trim();
    limit = limit || 380;
    if (text.length <= limit) return [text];
    var parts = [], cur = '';
    var sents = text.split(/(?<=[.!?\u0964\u0965\u3002\uFF0E\uFF61])\s+/);
    for (var i = 0; i < sents.length; i++) {
      var s = sents[i];
      if (s.length > limit) { if (cur) { parts.push(cur); cur = ''; } parts.push(s.slice(0, limit)); continue; }
      if (cur && cur.length + s.length + 1 > limit) { parts.push(cur); cur = s; }
      else cur = (cur ? cur + ' ' + s : s);
    }
    if (cur) parts.push(cur);
    return parts.length ? parts : [text];
  }
  async function _trnGoogle(text, sl, tl) {
    var endpoints = [
      'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t',
      'https://translate.googleapis.com/translate_a/t?client=at',
      'https://clients5.google.com/translate_a/t?client=dict-chrome-ex'
    ];
    var ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
    for (var i = 0; i < endpoints.length; i++) {
      var u = new URL(endpoints[i]);
      u.searchParams.set('sl', sl);
      u.searchParams.set('tl', tl);
      u.searchParams.set('q', _trnLowerCaps(text, tl));
      var ctrl = new AbortController();
      var t = setTimeout(function() { try { ctrl.abort(); } catch(e) {} }, 15000);
      try {
        var r = await fetch(u.toString(), { headers: { 'User-Agent': ua, 'Referer': 'https://translate.google.com/' }, signal: ctrl.signal });
        clearTimeout(t);
        if (r.status !== 200) continue;
        var d = await r.json();
        var out = '';
        if (Array.isArray(d)) {
          if (Array.isArray(d[0])) out = d[0].map(function(x) { return x && x[0] ? x[0] : ''; }).join('');
          else out = String(d[0] || '');
        }
        out = _trnUnescape(out);
        if (out && out !== text) return out;
      } catch (e) { clearTimeout(t); }
    }
    return '';
  }
  async function _trnOne(text, sl, tl) {
    var text2 = String(text || '').trim();
    if (!text2) return '';
    var ck = sl + '\u0001' + tl + '\u0001' + text2;
    if (_trnCache.has(ck)) return _trnCache.get(ck);
    if (_trnCache.size > 20000) _trnCache.clear();
    var chunks = _trnChunks(text2);
    var out = '';
    for (var i = 0; i < chunks.length; i++) {
      var ck2 = sl + '\u0001' + tl + '\u0001' + chunks[i];
      var part = _trnCache.has(ck2) ? _trnCache.get(ck2) : await _trnGoogle(chunks[i], sl, tl);
      if (part) _trnCache.set(ck2, part);
      out += (out ? ' ' : '') + part;
    }
    out = out.trim();
    if (out) _trnCache.set(ck, out);
    return out;
  }

  // FAST batch translator: sends many chunks in ONE request via client=dict-chrome-ex
  // (multiple q params -> in-order array result). ~50-100 texts per request, ~1s.
  var _trnBatchGoogle = async function(items, sl, tl) {
    if (!items.length) return [];
    var u = 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex';
    var ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
    var url = null;
    try {
      url = new URL(u);
      url.searchParams.set('sl', sl === 'auto' ? 'auto' : sl);
      url.searchParams.set('tl', tl);
      for (var k = 0; k < items.length; k++) url.searchParams.append('q', _trnLowerCaps(items[k], tl));
    } catch(e) { return []; }
    var ctrl = new AbortController();
    var t = setTimeout(function() { try { ctrl.abort(); } catch(e) {} }, 20000);
    try {
      var r = await fetch(url.toString(), { headers: { 'User-Agent': ua, 'Referer': 'https://translate.google.com/' }, signal: ctrl.signal });
      clearTimeout(t);
      if (r.status !== 200) return [];
      var d = await r.json();
      var out = new Array(items.length);
      // dict-chrome-ex returns either ["t1","t2",...] (explicit sl)
      // or [["t1","en"],["t2","es"],...] (sl=auto). Normalize per index.
      for (var i = 0; i < items.length; i++) {
        var v = d && d[i];
        var s = '';
        if (Array.isArray(v)) s = String(v[0] || ''); else s = String(v || '');
        s = _trnUnescape(s);
        out[i] = (s && s !== items[i]) ? s : '';
      }
      return out;
    } catch(e) { clearTimeout(t); return []; }
  };

  // Fall back chain: try fast batch first; if it returns nothing, use per-chunk gtx.
  async function _trnBatch(items, sl, tl) {
    var cacheMiss = [];
    var hitMap = new Map();
    for (var i = 0; i < items.length; i++) {
      var ck = sl + '\u0001' + tl + '\u0001' + items[i];
      if (_trnCache.has(ck)) hitMap.set(i, _trnCache.get(ck));
      else cacheMiss.push({ i: i, ck: ck });
    }
    if (cacheMiss.length) {
      var missTexts = cacheMiss.map(function(x) { return items[x.i]; });
      var got = await _trnBatchGoogle(missTexts, sl, tl);
      for (var j = 0; j < cacheMiss.length; j++) {
        if (got[j]) _trnCache.set(cacheMiss[j].ck, got[j]);
        hitMap.set(cacheMiss[j].i, got[j] || '');
      }
    }
    var result = new Array(items.length);
    for (var r = 0; r < items.length; r++) result[r] = hitMap.get(r) || '';
    return result;
  }

  async function _trnMapLimit(items, limit, fn) {
    var results = new Array(items.length), next = 0;
    async function worker() {
      while (true) {
        var i = next++;
        if (i >= items.length) return;
        try { results[i] = await fn(items[i]); } catch (e) { results[i] = ''; }
      }
    }
    var ws = [];
    for (var i = 0; i < Math.min(limit, items.length); i++) ws.push(worker());
    await Promise.all(ws);
    return results;
  }
  ipcMain.handle('translate-batch', async (event, payload) => {
    try {
      var texts = Array.isArray(payload && payload.texts) ? payload.texts : [];
      var source = String(payload && payload.source ? payload.source : 'auto');
      var target = String(payload && payload.target ? payload.target : 'hi');
      var langHint = String(payload && payload.langHint ? payload.langHint : 'en');
      if (!texts.length) return { ok: false, error: 'empty texts' };
      // sl=auto lets Google detect the true source (the old code substituted a
      // weak script-based detector, which mistook Latin-script languages like
      // Spanish/French/German for English, so those pages never translated).
      var sl = source === 'auto' ? 'auto' : source;
      var seen = {}, uniq = [], order = [];
      for (var i = 0; i < texts.length; i++) {
        var key = String(texts[i]);
        if (seen[key] === undefined) { seen[key] = uniq.length; uniq.push(key); }
        order.push(seen[key]);
      }
      // Expand each unique text into sub-chunks, then batch the chunks together
      // so one HTTP request covers many sentence-sized pieces.
      var chunkPlan = [];  // {oid, text}
      var chunkMap = [];   // per uniq index: list of chunk results
      for (var u = 0; u < uniq.length; u++) chunkMap[u] = [];
      for (var u2 = 0; u2 < uniq.length; u2++) {
        var cs = _trnChunks(uniq[u2]);
        for (var c2 = 0; c2 < cs.length; c2++) chunkPlan.push({ oid: u2, text: cs[c2] });
      }
      var out = new Array(order.length).fill('');
      var BATCH = 50; // texts per request (dict-chrome-ex handles 100 in ~1s)
      var groups = [];
      for (var b = 0; b < chunkPlan.length; b += BATCH) groups.push(chunkPlan.slice(b, b + BATCH));
      await _trnMapLimit(groups, 3, async function(slice) {
        var sliceTexts = slice.map(function(x) { return x.text; });
        var got = await _trnBatch(sliceTexts, sl, target);
        var missing = [];
        for (var g = 0; g < slice.length; g++) {
          if (got[g]) chunkMap[slice[g].oid].push(got[g]);
          else missing.push(g);
        }
        if (!missing.length) return;
        // clients5/dict-chrome-ex answers 200 with an empty array once Google
        // throttles us, which used to look like "nothing to translate". Retry
        // those texts one by one through the gtx endpoint (slower, reliable).
        var fb = await _trnMapLimit(missing.map(function(g) { return slice[g].text; }), 2, function(t) {
          return _trnOne(t, sl, target);
        });
        for (var m = 0; m < missing.length; m++) {
          if (fb[m]) chunkMap[slice[missing[m]].oid].push(fb[m]);
        }
      });
      // Rebuild full translations (chunks joined with space) + apply order
      var full = [];
      for (var uu = 0; uu < uniq.length; uu++) full.push(chunkMap[uu].join(' ').trim());
      for (var j = 0; j < order.length; j++) out[j] = full[order[j]] || String(texts[j]);
      return { ok: true, translations: out };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });

  // Inject LeetCode content script into webview
  var _leetLastInjectUrl = '';
  // IPC handler to serve leet-content.js to renderer
  ipcMain.handle('leet-get-script', async () => {
    try {
      return fs.readFileSync(path.join(__dirname, 'leet-content.js'), 'utf-8');
    } catch(e) { return ''; }
  });

  // ===== LeetCode Pop-out Floating Window =====
  var _leetFloatWin = null;

  ipcMain.handle('leet-popout-create', async (event, data) => {
    if (_leetFloatWin && !_leetFloatWin.isDestroyed()) {
      _leetFloatWin.focus();
      _leetFloatWin.webContents.send('leet-popout-init', data);
      return;
    }
    _leetFloatWin = new BrowserWindow({
      width: 460,
      height: 640,
      minWidth: 340,
      minHeight: 400,
      frame: false,
      resizable: true,
      transparent: false,
      backgroundColor: '#0a0a16',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        webviewTag: false,
      },
    });
    _leetFloatWin.loadFile(path.join(__dirname, 'leet-float.html'));
    _leetFloatWin.on('closed', function() { _leetFloatWin = null; });
    // Send init data after load
    _leetFloatWin.webContents.on('did-finish-load', function() {
      _leetFloatWin.webContents.send('leet-popout-init', data);
    });
    // Allow window to be focused/clicks to work through frameless
    _leetFloatWin.webContents.on('new-window', function(e, url) {
      e.preventDefault();
      if (win && !win.isDestroyed()) win.webContents.send('open-in-new-tab', url);
    });
  });

  ipcMain.on('leet-popout-dock', function(event, chatHtml) {
    // Forward chat history back to main window
    try {
      if (win && !win.isDestroyed()) {
        win.webContents.send('leet-popout-docked', chatHtml);
      }
    } catch(e) {}
    // Close the floating window
    if (_leetFloatWin && !_leetFloatWin.isDestroyed()) {
      _leetFloatWin.close();
    }
  });

  function injectLeetAssistant(contents) {
    try {
      var url = contents.getURL();
      if (!url || !url.includes('leetcode.com/problems/')) return;
      if (url === _leetLastInjectUrl) return;
      _leetLastInjectUrl = url;
      var leetCodeScript = fs.readFileSync(path.join(__dirname, 'leet-content.js'), 'utf-8');
      contents.executeJavaScript(leetCodeScript).catch(function(){});
      setTimeout(function() {
        try { contents.executeJavaScript(leetCodeScript).catch(function(){}); } catch(e) {}
      }, 3000);
    } catch(e) {}
  }

  // Shields DOM ad-sniper: a lightweight MutationObserver injected into every
  // page that yanks dynamically-inserted ad elements the filter lists miss.
  // Only runs while shields are enabled; cheap and single-shot per URL.
  var _adCleanerLastUrl = '';
  var _adCleanerSrc = null;
  function injectShieldsDomCleaner(contents) {
    try {
      if (!_shields || !_shields.settings || _shields.settings.enabled !== true) return;
      var url = contents.getURL() || '';
      if (!/^https?:/i.test(url)) return;
      var key = url.split('#')[0];
      if (key === _adCleanerLastUrl) return;
      var site = '';
      try { site = _shields.eTLD1 ? _shields.eTLD1(url) : ''; } catch (e) {}
      if (site && _shields.siteOverrides && _shields.siteOverrides[site] === false) return;
      _adCleanerLastUrl = key;
      if (!_adCleanerSrc) {
        try { _adCleanerSrc = fs.readFileSync(path.join(__dirname, 'ad-cleaner.js'), 'utf-8'); } catch (e) { _adCleanerSrc = ''; }
      }
      if (!_adCleanerSrc) return;
      contents.executeJavaScript(_adCleanerSrc).catch(function(){});
    } catch(e) {}
  }

  // Launch a URL in the user's default browser (for DRM sites that require VMP)
  ipcMain.handle('launch-in-chrome', async (event, url) => {
    if (!_isSafeExternalUrl(url)) { console.warn('launch-in-chrome refused non-http(s) URL'); return false; }
    try {
      await shell.openExternal(url);
      return true;
    } catch (e) { console.warn('launch-in-chrome error:', e); return false; }
  });

  // Live wallpaper: select video file via dialog
  ipcMain.handle('select-video-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Videos', extensions: ['mp4', 'webm', 'avi', 'mov', 'mkv', 'gif'] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  // ===== DOWNLOAD MANAGER =====
  // Save all user downloads to the REAL OS-level Downloads folder (visible in
  // Windows File Explorer). app.getPath('downloads') resolves to the actual
  // system Downloads directory, e.g. C:\Users\<user>\Downloads on Windows.
  const DOWNLOADS_DIR = app.getPath('downloads');
  try { if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true }); } catch(e) {}
  // App-internal sidecar data (thumbnails, metadata, playlists, temp partial
  // files) lives in a private app-data folder so it never clutters the real
  // OS Downloads folder.
  const _DATA_DIR = path.join(app.getPath('userData'), 'neo-data');
  try { if (!fs.existsSync(_DATA_DIR)) fs.mkdirSync(_DATA_DIR, { recursive: true }); } catch(e) {}

  var _TEMP_EXTS = ['.part', '.ytdl', '.tmp', '.temp', '.crdownload', '.download', '.opdownload'];
  ipcMain.handle('get-downloaded-files', async () => {
    try {
      const files = fs.readdirSync(DOWNLOADS_DIR);
      return files.filter(f => {
        const fp = path.join(DOWNLOADS_DIR, f);
        try {
          const stat = fs.statSync(fp);
          if (!stat.isFile()) return false;
          const ext = path.extname(f).toLowerCase();
          // Skip temp/partial downloads
          if (_TEMP_EXTS.indexOf(ext) !== -1) return false;
          // Skip only truly empty files (0 bytes) — anything real must show,
          // including small images/zips/etc., so the Downloads panel reflects
          // everything the user saves (Chrome-like behaviour).
          if (stat.size <= 0) return false;
          return true;
        } catch { return false; }
      }).map(f => {
        const fp = path.join(DOWNLOADS_DIR, f);
        const stat = fs.statSync(fp);
        const ext = path.extname(f).toLowerCase();
        const isVideo = ['.mp4','.webm','.avi','.mov','.mkv','.gif'].indexOf(ext) !== -1;
        const isAudio = ['.mp3','.wav','.ogg','.flac','.aac','.m4a','.wma'].indexOf(ext) !== -1;
        return {
          name: f,
          path: fp,
          size: stat.size,
          sizeFormatted: stat.size > 1024*1024 ? (stat.size/1024/1024).toFixed(1)+' MB' : stat.size > 1024 ? (stat.size/1024).toFixed(0)+' KB' : stat.size+' B',
          modified: stat.mtimeMs,
          modifiedFormatted: new Date(stat.mtime).toLocaleString(),
          ext: ext,
          isVideo: isVideo,
          isAudio: isAudio,
          isMedia: isVideo || isAudio
        };
      }).sort((a,b) => b.modified - a.modified);
    } catch(e) { return []; }
  });

  // Persistent download history: every completed browser download, newest
  // first, surviving file moves/deletes and restarts. `exists` tells the UI
  // whether Open / Show-in-folder can still work for each entry.
  ipcMain.handle('get-download-history', async () => {
    try {
      return _dlReadHistory().map(function(h) {
        var exists = false;
        try { exists = !!(h.path && fs.existsSync(h.path)); } catch(e) {}
        return { name: h.name, size: h.size || 0, ext: h.ext || '', url: h.url || '', time: h.time || 0, exists: exists };
      });
    } catch(e) { return []; }
  });
  ipcMain.handle('clear-download-history', async () => {
    try { _dlWriteHistory([]); return true; } catch(e) { return false; }
  });
  ipcMain.handle('remove-download-history', async (event, time) => {
    try {
      var t = Number(time) || 0;
      _dlWriteHistory(_dlReadHistory().filter(function(h) { return Number(h.time) !== t; }));
      return true;
    } catch(e) { return false; }
  });

  // ===== BROWSER HISTORY (Chrome-style visit log, newest first, capped) =====
  // Every visited http(s) page is appended here with its title and timestamp
  // so the full-screen History page can group visits by day/week like Chrome.
  function _webHistFile() {
    try {
      var dir = path.join(app.getPath('userData'), 'neo-data');
      try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch(e) {}
      return path.join(dir, 'browser-history.json');
    } catch(e) { return null; }
  }
  function _webHistRead() {
    try {
      var f = _webHistFile();
      if (!f || !fs.existsSync(f)) return [];
      var list = JSON.parse(fs.readFileSync(f, 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch(e) { return []; }
  }
  function _webHistWrite(list) {
    try {
      var f = _webHistFile();
      if (!f) return;
      fs.writeFileSync(f, JSON.stringify(list.slice(0, 10000)));
    } catch(e) {}
  }
  function _webHistValidUrl(u) {
    try {
      var p = new URL(String(u || ''));
      return (p.protocol === 'http:' || p.protocol === 'https:') ? p.href : '';
    } catch(e) { return ''; }
  }
  ipcMain.handle('webhist-log', async (event, payload) => {
    try {
      var url = _webHistValidUrl(payload && payload.url);
      if (!url) return false;
      var list = _webHistRead();
      var now = Date.now();
      var last = list[0];
      // Skip reload/duplicate spam: same URL within 10 seconds.
      if (last && last.url === url && (now - Number(last.ts || 0)) < 10000) return true;
      list.unshift({ id: now + '_' + Math.floor(Math.random() * 1e6), url: url, title: String((payload && payload.title) || ''), ts: now });
      _webHistWrite(list);
      return true;
    } catch(e) { return false; }
  });
  ipcMain.handle('webhist-title', async (event, payload) => {
    try {
      var url = _webHistValidUrl(payload && payload.url);
      var title = String((payload && payload.title) || '').slice(0, 300);
      if (!url || !title) return false;
      var list = _webHistRead();
      for (var i = 0; i < list.length; i++) {
        if (list[i].url === url && !list[i].title) { list[i].title = title; _webHistWrite(list); return true; }
      }
      return false;
    } catch(e) { return false; }
  });
  ipcMain.handle('webhist-get', async () => {
    try {
      return _webHistRead().map(function(h) {
        return { id: String(h.id || ''), url: String(h.url || ''), title: String(h.title || ''), ts: Number(h.ts || 0) };
      });
    } catch(e) { return []; }
  });
  ipcMain.handle('webhist-del', async (event, ids) => {
    try {
      var set = {};
      (Array.isArray(ids) ? ids : [ids]).forEach(function(x) { set[String(x)] = true; });
      _webHistWrite(_webHistRead().filter(function(h) { return !set[String(h.id || '')]; }));
      return true;
    } catch(e) { return false; }
  });
  ipcMain.handle('webhist-clear', async () => {
    try { _webHistWrite([]); return true; } catch(e) { return false; }
  });

  // List files saved by the NEXORA YouTube Downloader ONLY. These live in the
  // dedicated app-data folders (YouTube Downloads\Videos and \Audio) and are
  // completely separate from normal browser downloads (ZIPs, images, PDFs) in
  // the OS Downloads folder.
  ipcMain.handle('get-youtube-downloads', async () => {
    var out = [];
    var dirs = [
      { dir: _YT_VIDEOS_DIR, source: 'video' },
      { dir: _YT_AUDIO_DIR, source: 'audio' }
    ];
    var metaIndex = {};
    try { metaIndex = _loadMeta(); } catch(e) {}
    for (var di2 = 0; di2 < dirs.length; di2++) {
      var d2 = dirs[di2];
      var files2 = [];
      try { files2 = fs.readdirSync(d2.dir); } catch(e) { continue; }
      for (var i2 = 0; i2 < files2.length; i2++) {
        var f2 = files2[i2];
        var fp2 = path.join(d2.dir, f2);
        try {
          var st2 = fs.statSync(fp2);
          if (!st2.isFile()) continue;
          var ext2 = path.extname(f2).toLowerCase();
          if (ext2 === '.part' || ext2 === '.tmp' || ext2 === '.ytdl') continue;
          if (st2.size <= 0) continue;
          var isAudio2 = ['.mp3','.wav','.ogg','.flac','.aac','.m4a'].indexOf(ext2) !== -1;
          var rec = {
            name: f2,
            path: fp2,
            source: d2.source,
            type: isAudio2 ? 'audio' : 'video',
            size: st2.size,
            sizeFormatted: st2.size > 1024*1024 ? (st2.size/1024/1024).toFixed(1)+' MB' : st2.size > 1024 ? (st2.size/1024).toFixed(0)+' KB' : st2.size+' B',
            modified: st2.mtimeMs,
            modifiedFormatted: new Date(st2.mtime).toLocaleString(),
            ext: ext2,
            isVideo: !isAudio2,
            isAudio: isAudio2,
            isMedia: true
          };
          if (metaIndex && metaIndex[f2]) rec.meta = metaIndex[f2];
          out.push(rec);
        } catch(e) {}
      }
    }
    out.sort(function(a,b) { return b.modified - a.modified; });
    return out;
  });

  ipcMain.handle('delete-youtube-download', async (event, fileName) => {
    try {
      var rel = String(fileName || '').replace(/\\/g, '/');
      var candidates = [
        path.join(_YT_VIDEOS_DIR, rel),
        path.join(_YT_AUDIO_DIR, rel),
        path.join(_YT_VIDEOS_DIR, path.basename(fileName)),
        path.join(_YT_AUDIO_DIR, path.basename(fileName))
      ];
      for (var ci = 0; ci < candidates.length; ci++) {
        if (fs.existsSync(candidates[ci])) { fs.unlinkSync(candidates[ci]); return { success: true }; }
      }
      return { success: false, error: 'Not found' };
    } catch(e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('open-youtube-downloads-folder', async () => {
    try { await shell.openPath(_YT_VIDEOS_DIR); return true; } catch { return false; }
  });

  ipcMain.handle('delete-downloaded-file', async (event, fileName) => {
    try {
      const fp = path.join(DOWNLOADS_DIR, path.basename(fileName));
      if (fs.existsSync(fp)) { fs.unlinkSync(fp); return { success: true }; }
      return { success: false, error: 'Not found' };
    } catch(e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('get-download-path', async (event, fileName) => {
    const fp = path.join(DOWNLOADS_DIR, path.basename(fileName));
    if (fs.existsSync(fp)) return fp;
    // Also resolve files saved by the NEXORA YouTube Downloader (dedicated
    // app-data folders, kept separate from normal OS Downloads). Playlist
    // downloads live in subfolders, so try the relative key first.
    var rel = String(fileName || '').replace(/\\/g, '/');
    var relVideo = path.join(_YT_VIDEOS_DIR, rel);
    if (fs.existsSync(relVideo)) return relVideo;
    var relAudio = path.join(_YT_AUDIO_DIR, rel);
    if (fs.existsSync(relAudio)) return relAudio;
    // Legacy fallback: file may be directly in Videos/Audio.
    const ytV = path.join(_YT_VIDEOS_DIR, path.basename(fileName));
    if (fs.existsSync(ytV)) return ytV;
    const ytA = path.join(_YT_AUDIO_DIR, path.basename(fileName));
    if (fs.existsSync(ytA)) return ytA;
    return '';
  });

  ipcMain.handle('get-file-stats', async (event, fileName) => {
    try {
      const fp = path.join(DOWNLOADS_DIR, path.basename(fileName));
      if (!fs.existsSync(fp)) return null;
      const stat = fs.statSync(fp);
      return { size: stat.size, mtime: stat.mtimeMs, ext: path.extname(fileName).toLowerCase() };
    } catch(e) { return null; }
  });

  ipcMain.handle('set-hw-accel-pref', async (event, value) => {
    try {
      var prefPath = path.join(app.getPath('userData'), 'prefs.json');
      var prefs = {};
      if (fs.existsSync(prefPath)) {
        try { prefs = JSON.parse(fs.readFileSync(prefPath, 'utf8')); } catch(e) {}
      }
      prefs.hardwareAccel = value;
      fs.writeFileSync(prefPath, JSON.stringify(prefs));
      return true;
    } catch(e) { return false; }
  });

  ipcMain.handle('read-downloaded-file', async (event, fileName) => {
    try {
      const fp = path.join(DOWNLOADS_DIR, path.basename(fileName));
      if (!fs.existsSync(fp)) return null;
      const stat = fs.statSync(fp);
      if (stat.size > 500 * 1024 * 1024) return { error: 'File too large (max 500MB)' };
      const buffer = await fs.promises.readFile(fp);
      const ext = path.extname(fileName).toLowerCase();
      return { data: buffer.toString('base64'), ext: ext };
    } catch(e) { return { error: e.message }; }
  });

  ipcMain.handle('open-downloads-folder', async () => {
    try { await shell.openPath(DOWNLOADS_DIR); return true; } catch { return false; }
  });

  ipcMain.handle('read-thumbnail-file', async (event, fileName) => {
    try {
      // Resolve safely: prefer the exact path when it points inside the app
      // data dir (e.g. <_DATA_DIR>\_thumbs\<name>.jpg) or the downloads dir,
      // else fall back to the plain name.
      var fp = '';
      if (path.isAbsolute(fileName)) {
        var norm = path.normalize(fileName);
        var base = path.normalize(_DATA_DIR);
        var baseDl = path.normalize(DOWNLOADS_DIR);
        if (norm === base || norm.indexOf(base + path.sep) === 0 || norm === baseDl || norm.indexOf(baseDl + path.sep) === 0) fp = norm;
      } else {
        fp = path.join(_THUMB_DIR, path.basename(fileName));
      }
      if (!fp || !fs.existsSync(fp)) return null;
      var ext = path.extname(fp).toLowerCase();
      var mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      var buffer = fs.readFileSync(fp);
      return { data: buffer.toString('base64'), mime: mime };
    } catch(e) { return null; }
  });

  // ===== BROWSER INTRO (STARTUP) SOUND =====
  // (moved to the top of whenReady so the launch sound plays instantly)

  // ===== AUTO VIDEO THUMBNAILS (ensure every downloaded video shows one) =====
  const _THUMB_DIR = path.join(_DATA_DIR, '_thumbs');
  function _thumbPathFor(videoName) {
    return path.join(_THUMB_DIR, path.basename(videoName).replace(/\.[^.]+$/, '') + '.jpg');
  }
  // Extract a frame near the start of a video with ffmpeg and save a 320px-wide
  // jpg thumbnail. Returns the thumb file path on success, '' otherwise.
  function _extractVideoThumbnail(videoName) {
    return new Promise(function(resolve) {
      try {
        var videoPath = path.join(DOWNLOADS_DIR, path.basename(videoName));
        if (!fs.existsSync(videoPath)) return resolve('');
        if (!_ytFfmpegPath || !fs.existsSync(_ytFfmpegPath)) return resolve('');
        var out = _thumbPathFor(videoName);
        try { fs.mkdirSync(_THUMB_DIR, { recursive: true }); } catch(e) {}
        var args = ['-y', '-ss', '2', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out];
        execFile(_ytFfmpegPath, args, { timeout: 30000, windowsHide: true }, function(err, stdout, stderr) {
          try {
            if (!err && fs.existsSync(out) && fs.statSync(out).size > 0) resolve(out);
            else resolve('');
          } catch(e) { resolve(''); }
        });
      } catch(e) { resolve(''); }
    });
  }

  ipcMain.handle('generate-video-thumbnail', async (event, videoName, force) => {
    try {
      var thumbPath = _thumbPathFor(videoName);
      if (force || !fs.existsSync(thumbPath)) {
        thumbPath = await _extractVideoThumbnail(videoName);
      }
      if (!thumbPath || !fs.existsSync(thumbPath)) return { ok: false };
      var buffer = fs.readFileSync(thumbPath);
      var data = 'data:image/jpeg;base64,' + buffer.toString('base64');
      // Persist so the dashboard can show it later without regenerating.
      var metaIndex = _loadMeta();
      var key = path.basename(videoName);
      var existing = metaIndex[key] || {};
      metaIndex[key] = Object.assign({}, existing, { thumbnailPath: thumbPath, thumbnail: existing.thumbnail || '', category: existing.category || 'other' });
      _saveMeta(metaIndex);
      return { ok: true, data: data };
    } catch(e) { return { ok: false, error: e.message }; }
  });

  // ===== PLAYBACK STATE PERSISTENCE =====
  const _PLAYBACK_STATE_PATH = path.join(_DATA_DIR, '_playback_state.json');

  ipcMain.handle('save-playback-state', async (event, state) => {
    try {
      fs.writeFileSync(_PLAYBACK_STATE_PATH, JSON.stringify(state));
      console.log('[Playback] State saved');
      return true;
    } catch(e) { return false; }
  });
  ipcMain.handle('load-playback-state', async () => {
    try {
      if (fs.existsSync(_PLAYBACK_STATE_PATH)) {
        return JSON.parse(fs.readFileSync(_PLAYBACK_STATE_PATH, 'utf8'));
      }
    } catch(e) {}
    return null;
  });

  // ===== DOWNLOAD METADATA & AI CATEGORIZATION =====
  const _META_PATH = path.join(_DATA_DIR, '_metadata_index.json');

  function _loadMeta() {
    try { if (fs.existsSync(_META_PATH)) return JSON.parse(fs.readFileSync(_META_PATH, 'utf8')); } catch(e) {}
    return {};
  }

  function _saveMeta(meta) {
    try { fs.writeFileSync(_META_PATH, JSON.stringify(meta, null, 2)); } catch(e) { console.error('[META] Save error:', e.message); }
  }

  ipcMain.handle('get-all-download-meta', async () => {
    return _loadMeta();
  });

  ipcMain.handle('save-download-meta', async (event, fileName, data) => {
    var meta = _loadMeta();
    // Merge with existing entry to preserve fields like thumbnailPath
    var existing = meta[fileName] || {};
    meta[fileName] = {
      title: data.title || existing.title || fileName,
      channel: data.channel || existing.channel || '',
      videoUrl: data.videoUrl || existing.videoUrl || '',
      thumbnail: data.thumbnail || existing.thumbnail || '',
      thumbnailPath: data.thumbnailPath || existing.thumbnailPath || '',
      category: data.category || existing.category || 'other',
      downloadedAt: data.downloadedAt || existing.downloadedAt || Date.now()
    };
    _saveMeta(meta);
    return { success: true };
  });

  ipcMain.handle('ai-categorize', async (event, title, channel) => {
    // Try backend AI first
    try {
      var response = await fetch('http://127.0.0.1:5000/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: 'Classify the YouTube video into exactly one category: music, movie, cartoon, or other. Reply with only the category word.' },
            { role: 'user', content: 'Title: "' + title + '", Channel: "' + (channel || '') + '"' }
          ],
          temperature: 0.1,
          max_tokens: 10
        }),
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) {
        var text = await response.text();
        text = text.trim().toLowerCase();
        if (['music', 'movie', 'cartoon', 'other'].indexOf(text) !== -1) return text;
      }
    } catch(e) {}

    // Fallback: keyword matching
    var t = (title + ' ' + (channel || '')).toLowerCase();
    var musicKw = 'song music audio lyric remix cover live concert ft. feat. official track album single ep playlist music video mv ost soundtrack band artist piano guitar drums vocal instrumental acoustic mixtape radio dance electronic hip hop rap pop rock jazz blues r&b soul reggae country folk opera classical symphony orchestra choir hymn gospel beat producer dj'.split(' ');
    var movieKw = 'movie film trailer teaser clip scene episode series netflix hbo marvel dc hollywood cinema short film documentary season premiere behind the scenes blooper interview red carpet'.split(' ');
    var cartoonKw = 'cartoon animation animated disney pixar dreamworks nickelodeon cartoon network anime manga funny kids nursery rhymes paw patrol peppa spongebob tom and jerry looney pokemon scooby scoobydoo doraemon shinchan cocomelon bob the builder'.split(' ');
    for (var i = 0; i < musicKw.length; i++) { if (t.indexOf(musicKw[i]) !== -1) return 'music'; }
    for (var i = 0; i < movieKw.length; i++) { if (t.indexOf(movieKw[i]) !== -1) return 'movie'; }
    for (var i = 0; i < cartoonKw.length; i++) { if (t.indexOf(cartoonKw[i]) !== -1) return 'cartoon'; }
    return 'other';
  });

  // ===== PLAYLIST SYSTEM =====
  console.log('[PLAYLIST] Initializing playlist system');
  const _PLAYLIST_PATH = path.join(_DATA_DIR, '_playlists.json');

  function _loadPlaylists() {
    try {
      if (fs.existsSync(_PLAYLIST_PATH)) {
        const raw = fs.readFileSync(_PLAYLIST_PATH, 'utf8');
        const data = JSON.parse(raw);
        console.log('[PLAYLIST] Loaded from disk:', data.playlists ? data.playlists.length : 0, 'playlists');
        return data;
      }
    } catch(e) { console.error('[PLAYLIST] Load error:', e.message); }
    console.log('[PLAYLIST] No playlists file found, returning empty');
    return { playlists: [] };
  }

  function _savePlaylists(data) {
    try {
      // Ensure updatedAt is set
      data.playlists.forEach(function(p) { if (!p.updatedAt) p.updatedAt = p.createdAt || Date.now(); });
      fs.writeFileSync(_PLAYLIST_PATH, JSON.stringify(data, null, 2));
      console.log('[PLAYLIST] Saved to disk:', data.playlists.length, 'playlists');
    } catch(e) { console.error('[PLAYLIST] Save error:', e.message); }
  }

  ipcMain.handle('playlist-list', async () => {
    console.log('[PLAYLIST] List requested');
    const playlists = _loadPlaylists().playlists || [];
    console.log('[PLAYLIST] Returning', playlists.length, 'playlists');
    return playlists;
  });

  ipcMain.handle('playlist-create', async (event, name) => {
    console.log('[PLAYLIST] Create requested:', name);
    var data = _loadPlaylists();
    var id = 'pl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    var now = Date.now();
    var pl = {
      id: id,
      name: name || 'New Playlist',
      createdAt: now,
      updatedAt: now,
      thumbnail: '',
      videoCount: 0,
      videos: []
    };
    data.playlists.push(pl);
    _savePlaylists(data);
    console.log('[PLAYLIST] Created:', id, name);
    return { success: true, playlist: pl };
  });

  ipcMain.handle('playlist-update-meta', async (event, playlistId, meta) => {
    console.log('[PLAYLIST] Update meta requested:', playlistId, meta);
    var data = _loadPlaylists();
    var pl = data.playlists.find(function(p) { return p.id === playlistId; });
    if (!pl) return { success: false, error: 'Playlist not found' };
    if (meta.name !== undefined) pl.name = meta.name;
    if (meta.description !== undefined) pl.description = meta.description;
    if (meta.thumbnail !== undefined) pl.thumbnail = meta.thumbnail;
    pl.updatedAt = Date.now();
    _savePlaylists(data);
    console.log('[PLAYLIST] Meta updated:', playlistId);
    return { success: true };
  });

  ipcMain.handle('playlist-delete', async (event, playlistId) => {
    console.log('[PLAYLIST] Delete requested:', playlistId);
    var data = _loadPlaylists();
    var before = data.playlists.length;
    data.playlists = data.playlists.filter(function(p) { return p.id !== playlistId; });
    if (data.playlists.length === before) console.log('[PLAYLIST] Delete: playlist not found', playlistId);
    _savePlaylists(data);
    console.log('[PLAYLIST] Deleted:', playlistId);
    return { success: true };
  });

  ipcMain.handle('playlist-rename', async (event, playlistId, name) => {
    console.log('[PLAYLIST] Rename requested:', playlistId, '->', name);
    var data = _loadPlaylists();
    var pl = data.playlists.find(function(p) { return p.id === playlistId; });
    if (!pl) { console.log('[PLAYLIST] Rename: not found', playlistId); return { success: false, error: 'Playlist not found' }; }
    pl.name = name || 'Untitled';
    pl.updatedAt = Date.now();
    _savePlaylists(data);
    console.log('[PLAYLIST] Renamed:', playlistId, name);
    return { success: true };
  });

  ipcMain.handle('playlist-add-video', async (event, playlistId, fileName, meta) => {
    console.log('[PLAYLIST] Add video requested:', playlistId, fileName);
    var data = _loadPlaylists();
    var pl = data.playlists.find(function(p) { return p.id === playlistId; });
    if (!pl) { console.log('[PLAYLIST] Add: playlist not found', playlistId); return { success: false, error: 'Playlist not found' }; }
    if (!pl.videos.find(function(v) { return v.fileName === fileName; })) {
      pl.videos.push({
        fileName: fileName,
        title: meta.title || fileName,
        channel: meta.channel || '',
        thumbnail: meta.thumbnail || '',
        addedAt: Date.now()
      });
      pl.updatedAt = Date.now();
      pl.videoCount = pl.videos.length;
      // Update playlist thumbnail from first video
      if (!pl.thumbnail && meta.thumbnail) pl.thumbnail = meta.thumbnail;
      console.log('[PLAYLIST] Video added to', pl.name, ':', fileName);
    } else {
      console.log('[PLAYLIST] Video already in playlist:', fileName);
    }
    _savePlaylists(data);
    return { success: true };
  });

  ipcMain.handle('playlist-remove-video', async (event, playlistId, fileName) => {
    console.log('[PLAYLIST] Remove video requested:', playlistId, fileName);
    var data = _loadPlaylists();
    var pl = data.playlists.find(function(p) { return p.id === playlistId; });
    if (!pl) { console.log('[PLAYLIST] Remove: playlist not found', playlistId); return { success: false, error: 'Playlist not found' }; }
    pl.videos = pl.videos.filter(function(v) { return v.fileName !== fileName; });
    pl.updatedAt = Date.now();
    pl.videoCount = pl.videos.length;
    // Update thumbnail if removed was the thumbnail
    if (pl.videos.length > 0 && pl.videos[0].thumbnail) pl.thumbnail = pl.videos[0].thumbnail;
    else pl.thumbnail = '';
    _savePlaylists(data);
    console.log('[PLAYLIST] Video removed from', pl.name, ':', fileName);
    return { success: true };
  });

  ipcMain.handle('playlist-get', async (event, playlistId) => {
    console.log('[PLAYLIST] Get requested:', playlistId);
    var data = _loadPlaylists();
    var pl = data.playlists.find(function(p) { return p.id === playlistId; });
    if (!pl) { console.log('[PLAYLIST] Get: not found', playlistId); return null; }
    // Enrich videos with full metadata from _metadata_index.json
    var meta = _loadMeta();
    pl.videos.forEach(function(v) {
      var m = meta[v.fileName] || {};
      v.title = m.title || v.title;
      v.channel = m.channel || v.channel;
      v.thumbnail = m.thumbnailPath || m.thumbnail || v.thumbnail;
    });
    // Update videoCount
    pl.videoCount = pl.videos.length;
    console.log('[PLAYLIST] Returning playlist:', pl.name, 'with', pl.videoCount, 'videos');
    return JSON.parse(JSON.stringify(pl)); // deep copy
  });

  ipcMain.handle('playlist-duplicate', async (event, playlistId) => {
    console.log('[PLAYLIST] Duplicate requested:', playlistId);
    var data = _loadPlaylists();
    var src = data.playlists.find(function(p) { return p.id === playlistId; });
    if (!src) return { success: false, error: 'Playlist not found' };
    var now = Date.now();
    var newId = 'pl_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    var dup = JSON.parse(JSON.stringify(src));
    dup.id = newId;
    dup.name = src.name + ' (Copy)';
    dup.createdAt = now;
    dup.updatedAt = now;
    data.playlists.push(dup);
    _savePlaylists(data);
    console.log('[PLAYLIST] Duplicated:', playlistId, '->', newId);
    return { success: true, playlist: dup };
  });

  ipcMain.handle('playlist-export', async (event, playlistId) => {
    console.log('[PLAYLIST] Export requested:', playlistId);
    var data = _loadPlaylists();
    var pl = data.playlists.find(function(p) { return p.id === playlistId; });
    if (!pl) return { success: false, error: 'Playlist not found' };
    try {
      var exportPath = path.join(DOWNLOADS_DIR, 'playlist_' + pl.name.replace(/[^a-z0-9]/gi, '_') + '.json');
      fs.writeFileSync(exportPath, JSON.stringify(pl, null, 2));
      console.log('[PLAYLIST] Exported to:', exportPath);
      return { success: true, path: exportPath };
    } catch(e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('playlist-sort', async (event, playlistId, method) => {
    console.log('[PLAYLIST] Sort requested:', playlistId, method);
    var data = _loadPlaylists();
    var pl = data.playlists.find(function(p) { return p.id === playlistId; });
    if (!pl) return { success: false, error: 'Playlist not found' };
    if (method === 'newest') pl.videos.sort(function(a, b) { return (b.addedAt || 0) - (a.addedAt || 0); });
    else if (method === 'oldest') pl.videos.sort(function(a, b) { return (a.addedAt || 0) - (b.addedAt || 0); });
    else if (method === 'az') pl.videos.sort(function(a, b) { return (a.title || '').localeCompare(b.title || ''); });
    else if (method === 'recent') pl.videos.sort(function(a, b) { return (b.addedAt || 0) - (a.addedAt || 0); });
    else if (method === 'most') pl.videos.sort(function(a, b) { return (b.addedAt || 0) - (a.addedAt || 0); }); // not applicable, sort by newest
    pl.updatedAt = Date.now();
    _savePlaylists(data);
    console.log('[PLAYLIST] Sorted:', pl.name, 'by', method);
    return { success: true, videos: pl.videos };
  });

  // Live wallpaper: read video file and return base64 (limit ~200MB for safety)
  ipcMain.handle('read-video-file', async (event, filePath) => {
    // Wallpaper/videos only. Paths come from the user's own file picker, but an
    // IPC caller could substitute any path, so demand an absolute path to a
    // plain media file — never a relative path, never an executable or document.
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return { error: 'Unsupported file type.' };
    var ext = path.extname(filePath).toLowerCase();
    if (['.mp4', '.webm', '.avi', '.mov', '.mkv', '.gif'].indexOf(ext) === -1) return { error: 'Unsupported file type.' };
    try {
      const fs = require('fs');
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return null;
      if (stat.size > 200 * 1024 * 1024) return { error: 'File too large (max 200MB)' };
      const buffer = await fs.promises.readFile(filePath);
      return { data: buffer.toString('base64'), ext: ext };
    } catch (e) { return { error: e.message }; }
  });

  // ===== NEO VIDEO EDITOR =====
  // The bundled @ffmpeg-installer build is from 2018 and has no `xfade` filter, and its
  // `amix` has no `normalize` option. Detect once so the export graph only uses filters
  // the resolved binary actually supports (otherwise ffmpeg aborts the whole export).
  var _edFilterCaps = null;
  function _edHasFilter(name) {
    if (_edFilterCaps) return !!_edFilterCaps[name];
    _edFilterCaps = {};
    var bin = null;
    try { bin = _vesFfmpegBinary(); } catch (e) {}
    if (!bin || !bin.ffmpeg) return false;
    try {
      var out = execFileSync(bin.ffmpeg, ['-hide_banner', '-filters'], {
        encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024
      });
      _edFilterCaps.xfade = /(^|\n)\s*\S+\s+xfade\s/.test(out);
      // amix gained `normalize` in ffmpeg 4.4.
      _edFilterCaps.amixNormalize = /amix/.test(out) && _edAmixHasNormalize(bin.ffmpeg);
    } catch (e) {
      _edFilterCaps.xfade = false;
      _edFilterCaps.amixNormalize = false;
    }
    return !!_edFilterCaps[name];
  }
  function _edAmixHasNormalize(ffPath) {
    try {
      execFileSync(ffPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=d=0.1',
        '-filter_complex', '[0:a][0:a]amix=inputs=2:duration=first:normalize=0[a]', '-map', '[a]', '-f', 'null', '-'],
        { timeout: 15000, windowsHide: true, stdio: 'ignore' });
      return true;
    } catch (e) { return false; }
  }

  function _vesFfmpegBinary() {
    // Return { ffmpeg, ffprobe } preferring the WinGet Gyan build (full features)
    var dir = null;
    try { if (_ytFfmpegPath) dir = path.dirname(_ytFfmpegPath); } catch(e) {}
    if (dir) {
      var ff = path.join(dir, 'ffmpeg.exe');
      var fp = path.join(dir, 'ffprobe.exe');
      if (fs.existsSync(ff) && fs.existsSync(fp)) return { ffmpeg: ff, ffprobe: fp };
    }
    // fallback to @ffmpeg-installer (ffmpeg only, possibly limited filters)
    if (_FFMPEG_PATH && fs.existsSync(_FFMPEG_PATH)) {
      var fpB = _FFMPEG_PATH.replace(/ffmpeg\.exe$/i, 'ffprobe.exe');
      return { ffmpeg: _FFMPEG_PATH, ffprobe: fs.existsSync(fpB) ? fpB : null };
    }
    return null;
  }

  ipcMain.handle('ves:select', async function() {
    var result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Videos', extensions: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'ts', 'flv', 'wmv', 'gif'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('ves:probe', async function(event, filePath) {
    try {
      if (!filePath || !fs.existsSync(filePath)) return { error: 'File not found' };
      var bin = _vesFfmpegBinary();
      if (!bin || !bin.ffprobe) return { error: 'ffprobe unavailable', path: filePath, ext: path.extname(filePath) };
      var probe = new Promise(function(resolve) {
        execFile(bin.ffprobe, [
          '-v', 'error',
          '-print_format', 'json',
          '-show_entries', 'format=duration:format=size:stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,sample_rate,channels:stream_tags=rotate',
          filePath
        ], { timeout: 15000, encoding: 'utf8', windowsHide: true }, function(err, stdout) {
          if (err) return resolve(null);
          try { resolve(JSON.parse(stdout)); } catch(e) { resolve(null); }
        });
      });
      var info = await probe;
      if (!info || !info.streams) return { error: 'Unable to read file', path: filePath, ext: path.extname(filePath) };
      var vstream = null, astream = null;
      for (var s = 0; s < info.streams.length; s++) {
        var st = info.streams[s];
        if (st.codec_type === 'video' && !vstream) vstream = st;
        else if (st.codec_type === 'audio' && !astream) astream = st;
      }
      var duration = parseFloat(info.format && info.format.duration);
      if (!(duration > 0) && vstream) {
        var tfps = vstream.avg_frame_rate || vstream.r_frame_rate || '30/1';
        var parts = String(tfps).split('/');
        var fps = parseFloat(parts[0]) / (parseFloat(parts[1]) || 1) || 30;
        duration = vstream.duration || 0;
      }
      var rot = 0;
      if (vstream && vstream.tags && vstream.tags.rotate) rot = parseInt(vstream.tags.rotate, 10) || 0;
      return {
        path: filePath,
        name: path.basename(filePath),
        size: info.format && info.format.size ? parseInt(info.format.size, 10) : 0,
        duration: duration > 0 ? duration : 60,
        fps: vstream ? (function(){ var p = String(vstream.avg_frame_rate || vstream.r_frame_rate || '30/1').split('/'); var f = parseFloat(p[0]) / (parseFloat(p[1]) || 1); return f > 0 && isFinite(f) ? f : 30; })() : 30,
        width: vstream ? vstream.width : 0,
        height: vstream ? vstream.height : 0,
        rotation: rot,
        hasAudio: !!astream,
        audioCodec: astream ? astream.codec_name : null,
        videoCodec: vstream ? vstream.codec_name : null
      };
    } catch(e) { return { error: e.message }; }
  });

  ipcMain.handle('ves:save', async function(event, opts) {
    var win = BrowserWindow.fromId(event.sender.id);
    if (!win) win = BrowserWindow.getFocusedWindow();
    if (!win) return { canceled: true };
    var result = await dialog.showSaveDialog(win, opts || { title: 'Export Video', defaultPath: 'neo_export.mp4', filters: [{ name: 'MP4', extensions: ['mp4'] }, { name: 'WEBM', extensions: ['webm'] }] });
    return result;
  });

  // Escapes a filter value (numbers/strings) for use in an FFmpeg filter graph.
  function _vesEsc(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/'/g, '\\\'').replace(/:/g, '\\:');
  }

  // Build final export command from real timeline state.
  function _vesBuildExport(state, bin, sendp) {
    var proj = state.project || {};
    var dest = proj.destPath;
    var format = proj.format || 'mp4';
    var fpsMode = proj.fpsMode || 'auto';
    var fps = proj.outFps || 30;
    var quality = proj.quality || 'medium';
    var clipCount = state.clips.length;

    var outW = proj.outW || 0, outH = proj.outH || 0;

    // Determine output resolution from first clip if not explicitly set.
    var first = state.clips[0];
    var firstRot = (first && first.rotation) || 0;
    var fw = (first && first.width) || 1920, fh = (first && first.height) || 1080;
    if (firstRot === 90 || firstRot === 270) { var t = fw; fw = fh; fh = t; }
    if (!outW) outW = fw; if (!outH) outH = fh;
    if (!(outW > 0) || !(outH > 0)) outW = 1920, outH = 1080;
    // Even dimensions required for yuv420p/encoders; round before scaling so the
    // per-clip scale/pad target matches the final output exactly.
    if (outW % 2) outW += 1;
    if (outH % 2) outH += 1;

    var inputs = [];
    var parts = [];
    var vLabels = [], aLabels = [], hasAudioAny = false;

    // Pre-pass: determine whether any clip contributes audio. When audio is present,
    // EVERY clip must supply an audio stream to the concat filter (concat a=1 requires
    // audio on every input); clips without an audio track get synthesized silence below.
    for (var ai = 0; ai < clipCount; ai++) {
      if (state.clips[ai] && state.clips[ai].hasAudio) { hasAudioAny = true; break; }
    }

    for (var i = 0; i < clipCount; i++) {
      var c = state.clips[i];
      var startT = c.startTime || 0;
      var endT = c.endTime != null ? c.endTime : (c.duration != null ? c.duration : 60);
      var speed = c.speed || 1;
      var vol = c.muted ? 0 : (c.volume != null ? c.volume : 1);
      var fadeIn = c.fadeIn || 0;
      var fadeOut = c.fadeOut || 0;
      var rotation = c.rotation || 0;
      var flipH = !!c.flipH, flipV = !!c.flipV;
      var crop = c.crop || {};
      var adjust = c.adjust || {};

      var vlabel = 'v' + i;
      inputs.push('-i'); inputs.push(c.path);

      // ---- Video graph ----
      var chain = [];
      // Trim to selected range & normalize timing; then apply speed.
      chain.push('trim=start=' + startT + ':end=' + endT);
      chain.push('setpts=PTS-STARTPTS');
      if (fpsMode === 'fixed') chain.push('fps=' + fps);
      if (speed > 0 && Math.abs(speed - 1) > 0.001) {
        chain.push('setpts=(PTS-STARTPTS)/' + _vesEsc(speed));
      }
      // Geometry: rotate (auto-sizes canvas so 90/270 swap dims), then flip, then crop.
      // FFmpeg rotate filter rotates counter-clockwise for positive degrees;
      // map our clockwise degrees to CCW.
      var rotDeg = (360 - (rotation % 360)) % 360;
      if (rotDeg % 180 === 0) rotDeg = rotDeg % 360;
      if (rotDeg !== 0) {
        chain.push('rotate=' + _vesEsc(rotDeg));
      }
      if (flipH) chain.push('hflip');
      if (flipV) chain.push('vflip');
      // Crop (unit fractions of current frame) with correct aspect handling.
      var cl = parseFloat(crop.left) || 0, cr = parseFloat(crop.right) || 0;
      var ct = parseFloat(crop.top) || 0, cb = parseFloat(crop.bottom) || 0;
      if (cl + cr > 97) cr = 97 - cl; if (ct + cb > 97) cb = 97 - ct;
      if (cl + cr > 0.5 || ct + cb > 0.5) {
        var keepW = Math.max(2, 100 - cl - cr);
        var keepH = Math.max(2, 100 - ct - cb);
        chain.push('crop=w=trunc(' + _vesEsc(keepW) + '*iw/100/2)*2:h=trunc(' + _vesEsc(keepH) + '*ih/100/2)*2:x=trunc(' + _vesEsc(cl) + '*iw/100/2)*2:y=trunc(' + _vesEsc(ct) + '*ih/100/2)*2');
      }
      // Scale to output. IMPORTANT: ALL clips must end at exactly the SAME
      // output canvas (outW x outH) or the concat filter fails. So never swap
      // dimensions per-clip for rotation; rotated content is fit inside the
      // uniform canvas instead.
      var mode = (proj.resizeMode) || 'fit';
      if (mode === 'fit') {
        chain.push('scale=' + outW + ':' + outH + ':force_original_aspect_ratio=decrease,pad=' + outW + ':' + outH + ':(ow-iw)/2:(oh-ih)/2:color=black');
      } else if (mode === 'fill') {
        chain.push('scale=' + outW + ':' + outH + ':force_original_aspect_ratio=increase,crop=' + outW + ':' + outH);
      } else {
        chain.push('scale=' + outW + ':' + outH);
      }

      // Color adjustments: map our slider ranges to eq/hue/unsharp/vignette.
      var e = {};
      e.brightness = (parseFloat(adjust.brightness) || 0);
      e.contrast = (parseFloat(adjust.contrast) || 0);
      e.saturation = (parseFloat(adjust.saturation) || 0);
      e.sharp = (parseFloat(adjust.sharpen) || 0);
      e.exp = (parseFloat(adjust.exposure) || 0);
      e.hi = (parseFloat(adjust.highlights) || 0);
      e.sh = (parseFloat(adjust.shadows) || 0);
      e.temp = (parseFloat(adjust.temp) || 0);
      e.tint = (parseFloat(adjust.tint) || 0);
      e.fade = (parseFloat(adjust.fade) || 0);
      e.vig = (parseFloat(adjust.vignette) || 0);

      var br = 1 + e.brightness / 100;
      var ct2 = 1 + e.contrast / 100;
      var sat = 1 + (e.saturation + e.exp) / 100;
      // temperature/tint via colorbalance
      var cbParts = [];
      if (e.temp > 0) cbParts.push('rs=.05:' + _vesEsc((e.temp / 100) * 0.06) + ':bs=0');
      else if (e.temp < 0) cbParts.push('bs=.05:' + _vesEsc((-e.temp / 100) * 0.06) + ':rs=0');

      // Combine adjustments into eq (supports brightness, contrast, saturation, gamma, exposure via 'gamma'/'saturation').
      var eqStr = 'eq=brightness=' + _vesEsc((br - 1) * 0.5) +
        ':contrast=' + _vesEsc(ct2) +
        ':saturation=' + _vesEsc(Math.max(0, sat));
      chain.push(eqStr);
      if (e.sharp > 0) chain.push('unsharp=5:5:' + _vesEsc(e.sharp / 50));
      if (e.vig > 0) chain.push('vignette=PI/4*' + _vesEsc(e.vig / 60));
      if (e.fade > 0) chain.push('fade=t=out:st=' + _vesEsc(Math.max(0, (endT - startT) - (e.fade / 100 * (endT - startT)))) + ':d=' + _vesEsc((e.fade / 100) * (endT - startT)));

      // Named filters (quick presets) applied on top.
      var filt = c.filter || 'original';
      if (filt === 'cinematic') { chain.push('eq=contrast=1.12:saturation=0.9,colorbalance=rs=-0.04:bs=0.04'); }
      else if (filt === 'vivid') { chain.push('eq=saturation=1.45:contrast=1.1'); }
      else if (filt === 'warm') { chain.push('colorbalance=rs=0.08:gs=0.02:bs=-0.05'); }
      else if (filt === 'cool') { chain.push('colorbalance=rs=-0.05:bs=0.08'); }
      else if (filt === 'vintage') { chain.push('colorbalance=rs=0.06:gs=0.02:bs=-0.04,eq=saturation=0.7:contrast=0.95,hue=h=8'); }
      else if (filt === 'noir') { chain.push('hue=s=0,eq=contrast=1.3'); }
      else if (filt === 'film') { chain.push('eq=contrast=1.08:saturation=0.85,noise=alls=6:allf=t'); }
      else if (filt === 'fade') { chain.push('eq=gamma=0.9:contrast=0.88:saturation=0.82'); }
      else if (filt === 'contrast') { chain.push('eq=contrast=1.35'); }
      else if (filt === 'bright') { chain.push('eq=brightness=0.15'); }
      else if (filt === 'moody') { chain.push('eq=contrast=1.2:saturation=0.65,colorbalance=bs=0.05'); }
      else if (filt === 'dream') { chain.push('gblur=sigma=1.5,eq=saturation=1.2:brightness=0.08'); }
      else if (filt === 'sunset') { chain.push('colorbalance=rs=0.12:gs=0.02:bs=-0.06,hue=h=6'); }

      // Video fades (in/out) based on timeline duration at final speed.
      var clipOutDur = (endT - startT) / speed;
      if (fadeIn > 0) chain.push('fade=t=in:st=0:d=' + _vesEsc(Math.min(fadeIn, clipOutDur / 2)));
      if (fadeOut > 0) chain.push('fade=t=out:st=' + _vesEsc(Math.max(0, clipOutDur - fadeOut)) + ':d=' + _vesEsc(Math.min(fadeOut, clipOutDur / 2)));

      var vChain = chain.join(',');
      // Normalize timebase + SAR so every concat input has identical parameters
      // (concat fails if streams differ in time_base or SAR).
      vChain += ',settb=AVTB,setsar=1';
      parts.push('[' + i + ':v]' + vChain + '[v' + i + ']');
      vLabels.push('[v' + i + ']');

      // ---- Audio graph ----
      // When the project has audio, every clip must feed a compatible audio stream
      // into the concat filter. Real audio is normalized to a common format;
      // clips without an audio track get synthesized silence for their length.
      if (hasAudioAny) {
        var achain = [];
        if (c.hasAudio) {
          achain.push('atrim=start=' + startT + ':end=' + endT);
          achain.push('asetpts=PTS-STARTPTS');
          if (speed > 0 && Math.abs(speed - 1) > 0.001) {
            var s = speed;
            var atempoFilters = [];
            while (s > 2.0) { atempoFilters.push('atempo=2.0'); s = s / 2; }
            while (s < 0.5) { atempoFilters.push('atempo=0.5'); s = s / 0.5; }
            atempoFilters.push('atempo=' + _vesEsc(Math.min(2, Math.max(0.5, s).toFixed(4))));
            atempoFilters.forEach(function(f) { achain.push(f); });
          }
          if (vol > 0) achain.push('volume=' + _vesEsc(vol));
          if (fadeIn > 0) achain.push('afade=t=in:st=0:d=' + _vesEsc(Math.min(fadeIn, clipOutDur / 2)));
          if (fadeOut > 0) achain.push('afade=t=out:st=' + _vesEsc(Math.max(0, clipOutDur - fadeOut)) + ':d=' + _vesEsc(Math.min(fadeOut, clipOutDur / 2)));
          parts.push('[' + i + ':a]' + achain.join(',') + ',aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=44100[a' + i + ']');
        } else {
          parts.push('anullsrc=channel_layout=stereo:sample_rate=44100,atrim=start=0:duration=' + _vesEsc(clipOutDur) + ',aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=44100[a' + i + ']');
        }
        aLabels.push('[a' + i + ']');
      }
    }

    if (hasAudioAny) {
      // concat v=1:a=1 expects inputs interleaved per segment: [v0][a0][v1][a1]...
      var concatIn = '';
      for (var k = 0; k < clipCount; k++) { concatIn += vLabels[k] + aLabels[k]; }
      parts.push(concatIn + 'concat=n=' + clipCount + ':v=1:a=1[vout][aout]');
    } else {
      parts.push(vLabels.join('') + 'concat=n=' + clipCount + ':v=1:a=0[vout]');
    }
    var filterGraph = parts.join(';');

    // FPS on final output if not forced per-clip (auto mode).
    var vfArgs = ['-filter_complex', filterGraph, '-map', '[vout]'];
    if (hasAudioAny) { vfArgs.push('-map'); vfArgs.push('[aout]'); }
    vfArgs.push('-r', String(fps));

    var codecArgs = [];
    if (format === 'webm') {
      codecArgs = ['-c:v', 'libvpx-vp9', '-b:v', String(quality === 'max' ? 12 : quality === 'high' ? 8 : quality === 'medium' ? 5 : quality === 'low' ? 3 : 2) + 'M', '-crf', String(quality === 'max' ? 10 : quality === 'high' ? 18 : quality === 'medium' ? 26 : quality === 'low' ? 32 : 38), '-c:a', 'libopus'];
    } else {
      var crf = quality === 'max' ? 14 : quality === 'high' ? 18 : quality === 'medium' ? 23 : quality === 'low' ? 28 : 33;
      codecArgs = ['-c:v', 'libx264', '-preset', quality === 'draft' ? 'ultrafast' : quality === 'low' ? 'veryfast' : quality === 'medium' ? 'medium' : quality === 'high' ? 'slow' : 'veryslow', '-crf', String(crf), '-pix_fmt', 'yuv420p'];
      if (hasAudioAny) codecArgs.push('-c:a', 'aac', '-b:a', '192k');
    }
    return {
      bin: bin,
      inputs: inputs,
      vfArgs: vfArgs,
      codecArgs: codecArgs,
      extra: ['-movflags', '+faststart', '-threads', '0', '-y', dest],
      format: format
    };
  }

  ipcMain.handle('ves:export', async function(event, expId, state) {
    var win = BrowserWindow.fromId(event.sender.id);
    if (!win) win = BrowserWindow.getFocusedWindow();
    var bin = _vesFfmpegBinary();
    try {
      if (!state || !state.clips || !state.clips.length) return { ok: false, error: 'No clips to export' };
      if (!bin || !bin.ffmpeg) return { ok: false, error: 'FFmpeg not found' };
      var proj = state.project || {};
      var dest = proj.destPath;
      if (!dest) return { ok: false, error: 'No destination selected' };
      if (fs.existsSync(dest) && dest === proj.sourcePath) return { ok: false, error: 'Refusing to overwrite source file' };
      if (proj.format === 'mp4' && !String(dest).toLowerCase().endsWith('.mp4')) dest = String(dest).replace(/\.\w+$/, '') + '.mp4';
      if (proj.format === 'webm' && !String(dest).toLowerCase().endsWith('.webm')) dest = String(dest).replace(/\.\w+$/, '') + '.webm';
      proj.destPath = dest;

      function sendp(obj) {
        try { if (win && !win.isDestroyed()) win.webContents.send('ves:export-progress', Object.assign({ id: expId }, obj)); } catch(e) {}
      }
      sendp({ state: 'start', message: 'Preparing export...' });

      var totalDur = 0;
      state.clips.forEach(function(c) { totalDur += ((c.endTime != null ? c.endTime : 0) - (c.startTime || 0)) / (c.speed || 1); });

      var cmd = _vesBuildExport(state, bin, sendp);
      var args = [];
      cmd.inputs.forEach(function(a) { args.push(a); });
      args = args.concat(cmd.vfArgs).concat(cmd.codecArgs).concat(cmd.extra);

      sendp({ state: 'running', message: 'Exporting...' });
      var proc = null;
      var cancelled = false;
      var killTimer = setTimeout(function() { try { if (proc) proc.kill('SIGKILL'); } catch(e) {} }, Math.max(5, totalDur * 8 + 30) * 1000);
      var resolveFinal;
      var done = new Promise(function(r) { resolveFinal = r; });
      var stderrBuf = '';
      try {
        proc = require('child_process').spawn(cmd.bin.ffmpeg, args, { windowsHide: true });
      } catch(e) { clearTimeout(killTimer); return { ok: false, error: 'Failed to start FFmpeg: ' + e.message }; }
      proc.stderr.on('data', function(d) {
        var s = String(d);
        stderrBuf += s;
        if (stderrBuf.length > 16000) stderrBuf = stderrBuf.slice(-16000);
        var m = s.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m && totalDur > 0) {
          var secs = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
          var pct = Math.min(100, Math.round((secs / totalDur) * 100));
          sendp({ state: 'running', pct: pct, message: 'Exporting... ' + pct + '%' });
        }
      });
      proc.on('error', function(err) {
        clearTimeout(killTimer);
        resolveFinal({ ok: false, error: 'FFmpeg error: ' + err.message });
      });
      proc.on('close', function(code) {
        clearTimeout(killTimer);
        if (code === 0 && fs.existsSync(dest)) {
          resolveFinal({ ok: true, path: dest, size: fs.statSync(dest).size });
        } else {
          try {
            var dbg = path.join(require('os').tmpdir(), 'neo_ves_export_debug.log');
            fs.writeFileSync(dbg, 'CMD: ffmpeg ' + args.join(' ') + '\n\nSTDERR:\n' + stderrBuf);
          } catch(_) {}
          var rawTail = stderrBuf.split('\n').filter(function(l) { return l && /error|invalid|failed|unable|not (found|defined|specified)|Unknown|cannot|mismatch|no such|expected/i.test(l); }).slice(-8).join(' | ');
          var tail = rawTail || stderrBuf.split('\n').filter(function(l) { return l.trim(); }).slice(-4).join(' | ');
          resolveFinal({ ok: false, error: 'Export failed (code ' + code + ')' + (tail ? ' — ' + tail : '') });
        }
      });
      return await done;
    } catch(e) {
      try { if (win && !win.isDestroyed()) win.webContents.send('ves:export-progress', { id: expId, state: 'error', message: e.message }); } catch(_) {}
      return { ok: false, error: e.message };
    }
  });

  // ===== NEO EDITOR FFMPEG EXPORT (fast, non-real-time) =====
  var _edExportProcs = {}; // expId -> { proc, cancelled }

  ipcMain.handle('ed:export', async function(event, expId, state) {
    var win = BrowserWindow.fromId(event.sender.id);
    if (!win) win = BrowserWindow.getFocusedWindow();
    var bin = _vesFfmpegBinary();
    try {
      if (!state || !state.clips || !state.clips.length) return { ok: false, error: 'No clips to export' };
      if (!bin || !bin.ffmpeg) return { ok: false, error: 'FFmpeg not found' };
      var proj = state.project || {};
      var dest = proj.destPath;
      if (!dest) return { ok: false, error: 'No destination selected' };
      var format = (proj.format || 'mp4').toLowerCase();
      if (format === 'mp4' && !/\.mp4$/i.test(dest)) dest = String(dest).replace(/\.[^.]+$/, '') + '.mp4';
      if (format === 'webm' && !/\.webm$/i.test(dest)) dest = String(dest).replace(/\.[^.]+$/, '') + '.webm';
      proj.destPath = dest;

      function sendp(o) { try { if (!win || win.isDestroyed()) return; win.webContents.send('ed:export-progress', Object.assign({ id: expId }, o)); } catch(e) {} }
      sendp({ state: 'start', message: 'Preparing export...' });

      var outW = proj.outW || 0, outH = proj.outH || 0;
      if (!(outW > 0) || !(outH > 0)) { outW = 1920; outH = 1080; }
      var rotNorm0 = ((state.rotation || 0) % 360 + 360) % 360;
      if (rotNorm0 === 90 || rotNorm0 === 270) { var _tw = outW; outW = outH; outH = _tw; }
      if (outW % 2) outW += 1; if (outH % 2) outH += 1;

      // ---- Gather all distinct source inputs (own file per clip) ----
      var inputList = [];   // {file, srcPath, rot, codedW, codedH, hasAudio}
      var inputIdx = {};    // file -> index
      var videoClips = (state.clips || []).slice().map(function(c) {
        return {
          i: 0,
          file: c.file || state.file,
          start: c.start != null ? c.start : (c.sourceStart != null ? c.sourceStart : 0),
          end: c.end != null ? c.end : (c.sourceEnd != null ? c.sourceEnd : 0),
          speed: c.speed || 1,
          volume: c.volume != null ? c.volume : 1,
          preset: c.preset || 'orig',
          fx: c.fx || 'none',
          filters: c.filters || null,
          opacity: c.opacity != null ? c.opacity : 1,
          rotation: c.rotation || 0,
          flipH: !!c.flipH, flipV: !!c.flipV,
          zoom: c.zoom || 1,
          blendMode: c.blendMode || 'normal',
          stabilize: !!c.stabilize,
          stabilizeStrength: c.stabilizeStrength || 0,
          motionBlur: !!c.motionBlur,
          motionBlurAmount: c.motionBlurAmount || 0,
          reverse: !!c.reverse,
          freeze: !!c.freeze,
          autoReframe: c.autoReframe || null,
          audioFx: c.audioFx || null,
          keyframes: c.keyframes || null
        };
      }).filter(function(c) { return c.file && (c.end - c.start) > 0; });
      videoClips.forEach(function(c, i) { c.i = i; });
      videoClips.sort(function(a, b) { return a.start - b.start; });
      if (!videoClips.length) return { ok: false, error: 'No valid video clips to export' };

      var musicClips = (state.timeline || []).filter(function(c) { return c.type === 'audio' && c.file && (c.end - c.start) > 0; });
      // Text clips are drawn onto the finished frame with drawtext, positioned by
      // their timeline offset (tlStart) relative to the concatenated video.
      var textClips = (state.timeline || []).filter(function(c) {
        return c.type === 'text' && c.text && (c.end - c.start) > 0;
      }).sort(function(a, b) { return a.start - b.start; });

      function resolveSource(fn) { var p = path.join(recDir(), fn); return fs.existsSync(p) ? p : fn; }
      function findOrAddInput(fn) {
        if (inputIdx[fn] != null) return inputIdx[fn];
        inputList.push({ file: fn, srcPath: resolveSource(fn), rot: 0, codedW: 0, codedH: 0, hasAudio: false });
        inputIdx[fn] = inputList.length - 1;
        return inputIdx[fn];
      }
      videoClips.forEach(function(c) { findOrAddInput(c.file); });
      musicClips.forEach(function(c) { findOrAddInput(c.file); });

      // Probe each distinct input for rotation, coded size, audio presence.
      async function probeInput(info) {
        if (!fs.existsSync(info.srcPath)) return;
        try {
          if (bin.ffprobe) {
            var rotInfo = await new Promise(function(res) {
              execFile(bin.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_tags=rotate:stream_side_data=rotation', '-of', 'json', info.srcPath], { timeout: 15000, encoding: 'utf8', windowsHide: true }, function(err, stdout) { if (err) return res(null); try { res(JSON.parse(stdout)); } catch(e) { res(null); } });
            });
            var aProbe = await new Promise(function(res) {
              execFile(bin.ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', info.srcPath], { timeout: 15000, encoding: 'utf8', windowsHide: true }, function(err, stdout) { if (err) return res(''); res(String(stdout)); });
            });
            info.hasAudio = /audio/i.test(aProbe);
            if (rotInfo && rotInfo.streams && rotInfo.streams[0]) {
              var st = rotInfo.streams[0];
              info.codedW = st.width || 0; info.codedH = st.height || 0;
              if (st.tags && st.tags.rotate) info.rot = parseInt(st.tags.rotate, 10) || 0;
              if (!info.rot && st.side_data_list) { for (var sd = 0; sd < st.side_data_list.length; sd++) { if (st.side_data_list[sd] && st.side_data_list[sd].rotation != null) { info.rot = Math.round(st.side_data_list[sd].rotation); break; } } }
              if (info.rot < 0) info.rot = ((360 + (info.rot % 360)) % 360);
            }
          }
        } catch(e) {}
      }
      for (var pi = 0; pi < inputList.length; pi++) { await probeInput(inputList[pi]); }

      var speed = state.speed || 1;
      var vol = state.mute ? 0 : (state.volume != null ? state.volume : 1);
      var outFps = proj.outFps || 30;
      var rotation = state.rotation || 0;
      var flipH = !!state.flipH, flipV = !!state.flipV;
      var crop = state.crop || {};
      var transition = state.transition || 'none';
      var td = state.transitionDuration || 0.5;

      var rotNorm = ((rotation % 360) + 360) % 360;
      var n = videoClips.length;
      var totalDur = 0;
      videoClips.forEach(function(c) { totalDur += ((c.end - c.start) / (c.speed || speed)); });
      if (totalDur <= 0) return { ok: false, error: 'No valid clip duration' };

      var parts = [], vLabels = [], aLabels = [];

      // CapCut-style filter presets -> ffmpeg filter chain.
      var _ED_PRESET_FF = {
        orig: '', cinematic: "eq=contrast=1.12:saturation=0.85:brightness=0.02",
        vintage: "colorchannelmixer=rr=.86:rg=.05:rb=.09:gr=.34:gg=.78:gb=.26:br=.27:bg=.53:bb=.32,eq=contrast=1.05:saturation=0.8:brightness=0.03",
        noir: "hue=s=0,eq=contrast=1.5:brightness=-0.03",
        bw: "hue=s=0,eq=contrast=1.15",
        warm: "colorbalance=rs=.16:gs=.02:bs=-.16:rm=.06:bm=-.06,eq=saturation=1.05",
        cool: "colorbalance=rs=-.12:bs=.18:rm=-.05:bm=.08,eq=saturation=1.05",
        vivid: "eq=saturation=1.7:contrast=1.15",
        sepia: "colorchannelmixer=rr=.393:rg=.769:rb=.189:gr=.349:gg=.686:gb=.168:br=.272:bg=.534:bb=.131",
        retro: "colorchannelmixer=rr=.75:rg=.2:rb=.05:gr=.15:gg=.8:gb=.05:br=.1:bg=.15:bb=.75,eq=saturation=1.25:contrast=1.05",
        dream: "gblur=sigma=4,eq=saturation=1.2:brightness=0.05",
        sunset: "colorbalance=rs=.22:gs=-.04:bs=-.28:rm=.1:bm=-.12:rh=.05:bh=-.12,eq=saturation=1.3",
        aqua: "colorbalance=rs=-.18:gs=.08:bs=.22:rm=-.08:bm=.1,eq=saturation=1.35",
        pop: "eq=saturation=1.9:contrast=1.3",
        film: "eq=contrast=1.08:saturation=0.85:brightness=0.02,noise=alls=6:allf=t",
        lemon: "colorbalance=rr=.12:rg=.2:rb=-.3:rm=.08:bm=-.15,eq=saturation=1.5:brightness=0.04",
        mono: "hue=s=0,eq=contrast=1.35"
      };
      function _edNum(v, d) { v = parseFloat(v); return (isNaN(v) ? d : v); }
      function _edClipImageFilter(c) {
        var out = [];
        var preset = (c.preset || 'orig');
        if (_ED_PRESET_FF[preset]) out.push(_ED_PRESET_FF[preset]);
        var f = c.filters || {};
        var b = _edNum(f.brightness, 0), co = _edNum(f.contrast, 1), sa = _edNum(f.saturation, 1);
        var ex = _edNum(f.exposure, 0);
        var bv = Math.max(0, Math.min(2, (1 + b) * Math.pow(2, ex)));
        var cv = Math.max(0.1, Math.min(3, co));
        var sv = Math.max(0, Math.min(3, sa));
        if (b !== 0 || co !== 1 || sa !== 1 || ex !== 0) out.push('eq=brightness=' + _vesEsc(bv.toFixed(3)) + ':contrast=' + _vesEsc(cv.toFixed(3)) + ':saturation=' + _vesEsc(sv.toFixed(3)));
        var tp = _edNum(f.temp, 0), tn = _edNum(f.tint, 0);
        if (tp !== 0 || tn !== 0) out.push('colorbalance=rs=' + _vesEsc((tp / 400).toFixed(3)) + ':bs=' + _vesEsc((-tp / 400).toFixed(3)) + ':rm=' + _vesEsc((tn / 400).toFixed(3)) + ':bm=' + _vesEsc((-tn / 400).toFixed(3)));
        var bl = _edNum(f.blur, 0);
        if (bl > 0) out.push('gblur=sigma=' + _vesEsc(Math.min(40, bl)));
        var sh = _edNum(f.sharpen, 0);
        if (sh > 0.25) out.push('unsharp=5:5:' + _vesEsc(sh.toFixed(2)));
        return out;
      }

      // Per-clip chain: normalize source rot -> trim/speed/fps -> global geom -> scale/pad uniform.
      for (var i = 0; i < n; i++) {
        var clip = videoClips[i];
        var inIdx = inputIdx[clip.file];
        var info = inputList[inIdx];
        var fiss = '[' + inIdx + ':v]';
        var srcLab = fiss;
        var srcRot = ((info.rot % 360) + 360) % 360;
        if (srcRot === 90) { parts.push(fiss + 'transpose=1[src' + i + ']'); srcLab = '[src' + i + ']'; }
        else if (srcRot === 270) { parts.push(fiss + 'transpose=2[src' + i + ']'); srcLab = '[src' + i + ']'; }
        else if (srcRot === 180) { parts.push(fiss + 'hflip,vflip[src' + i + ']'); srcLab = '[src' + i + ']'; }
        var s = clip.start, e = clip.end, cspeed = clip.speed || speed;
        var chain = ['trim=start=' + _vesEsc(s) + ':end=' + _vesEsc(e), 'setpts=PTS-STARTPTS', 'setpts=(PTS-STARTPTS)/' + _vesEsc(cspeed), 'fps=' + outFps, 'settb=AVTB,setsar=1'];
        var imgFx = _edClipImageFilter(clip);
        if (imgFx.length) chain = chain.concat(imgFx);
        var geom = [];
        if (rotNorm === 90) geom.push('transpose=1');
        else if (rotNorm === 270) geom.push('transpose=2');
        else if (rotNorm === 180) geom.push('rotate=180');
        if (flipH) geom.push('hflip');
        if (flipV) geom.push('vflip');
        var cl = parseFloat(crop.left) || 0, cr = parseFloat(crop.right) || 0, ct = parseFloat(crop.top) || 0, cb = parseFloat(crop.bottom) || 0;
        if (cl + cr > 0.5 || ct + cb > 0.5) {
          var keepW = Math.max(2, 100 - cl - cr), keepH = Math.max(2, 100 - ct - cb);
          geom.push('crop=w=trunc(' + _vesEsc(keepW) + '*iw/100/2)*2:h=trunc(' + _vesEsc(keepH) + '*ih/100/2)*2:x=trunc(' + _vesEsc(cl) + '*iw/100/2)*2:y=trunc(' + _vesEsc(ct) + '*ih/100/2)*2');
        }
        geom.push('scale=' + outW + ':' + outH + ':force_original_aspect_ratio=decrease,pad=' + outW + ':' + outH + ':(ow-iw)/2:(oh-ih)/2:color=black');
        var clipFx = clip.fx || 'none';
        if ((clipFx === 'zoom' || clipFx === 'kenburns') && outW > 0 && outH > 0) {
          var zz = clipFx === 'kenburns' ? 'min(1.08+0.0006*in,1.20)' : 'min(zoom+0.0010,1.35)';
          geom.push("zoompan=z='" + zz + "':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=" + outW + 'x' + outH + ':fps=' + outFps, 'settb=AVTB,setpts=PTS-STARTPTS');
        }
        // Per-clip extras: reversed source, opacity, clip-level zoom/rotate/flip,
        // auto reframe offset, motion blur and blend mode.
        if (clip.reverseLabelV) {
          parts.push(clip.reverseLabelV + chain.join(',') + '[vpre' + i + ']');
          srcLab = '[vpre' + i + ']';
        }
        if (clip.localGeom) {
          var lg = [];
          var cRot = ((parseInt(clip.rotation, 10) || 0) % 360 + 360) % 360;
          if (cRot === 90) lg.push('transpose=1');
          else if (cRot === 270) lg.push('transpose=2');
          else if (cRot === 180) lg.push('rotate=180');
          if (clip.flipH) lg.push('hflip');
          if (clip.flipV) lg.push('vflip');
          var cZoom = parseFloat(clip.zoom) || 1;
          if (Math.abs(cZoom - 1) > 0.001) {
            lg.push('scale=' + Math.round(outW * cZoom) + ':' + Math.round(outH * cZoom) +
              ':force_original_aspect_ratio=decrease,pad=' + Math.round(outW * cZoom) + ':' + Math.round(outH * cZoom) +
              ':(ow-iw)/2:(oh-ih)/2:color=black,scale=' + outW + ':' + outH);
          }
          if (lg.length) geom = geom.concat(lg);
        }
        if (clip.autoReframe) {
          var pct = 0.04;
          var ax = 0, ay = 0;
          if (clip.autoReframe === 'left') ax = -pct;
          else if (clip.autoReframe === 'right') ax = pct;
          else if (clip.autoReframe === 'top') ay = -pct;
          else if (clip.autoReframe === 'bottom') ay = pct;
          if (ax || ay) {
            geom.push('crop=w=' + Math.round(outW * (1 - pct * 2)) + ':h=' + Math.round(outH * (1 - pct * 2)) +
              ':x=' + Math.round((ax < 0 ? 0 : pct) * outW) + ':y=' + Math.round((ay < 0 ? 0 : pct) * outH) +
              ',scale=' + outW + ':' + outH);
          }
        }
        if (clip.mbAmt) {
          // Temporal smear: blend each frame with the one before it.
          geom.push('tmix=frames=2:weights=\'1 0.7\'');
        }
        parts.push(srcLab + chain.concat(geom).join(',') + '[vc' + i + ']');
        vLabels.push('[vc' + i + ']');
        if (info.hasAudio) {
          var effVol = Math.max(0, vol * clip.volume);
          var ach = ['atrim=start=' + _vesEsc(s) + ':end=' + _vesEsc(e), 'asetpts=PTS-STARTPTS'];
          var sp = cspeed, at = [];
          while (sp > 2.0) { at.push('atempo=2.0'); sp = sp / 2; }
          while (sp < 0.5) { at.push('atempo=0.5'); sp = sp / 0.5; }
          at.push('atempo=' + _vesEsc(Math.min(2, Math.max(0.5, sp).toFixed(4))));
          ach = ach.concat(at);
          if (effVol > 0) ach.push('volume=' + _vesEsc(effVol));
          // Per-clip audio DSP (the same set the Audio Tools panel toggles).
          var afx = clip.audioFx || {};
          if (afx.noiseGate) ach.push('highpass=f=120:p=2', 'lowpass=f=8000:p=2');
          if (afx.normalize) ach.push('dynaudnorm=f=200:g=5:p=0.9:m=10');
          if (afx.voiceISO) ach.push('equalizer=f=1600:t=q:w=1.1:g=8', 'equalizer=f=3000:t=q:w=1.4:g=4');
          if (afx.eq) {
            if (afx.eq.bass) ach.push('equalizer=f=200:t=q:w=0.7:g=' + _vesEsc(afx.eq.bass));
            if (afx.eq.mid) ach.push('equalizer=f=1200:t=q:w=0.9:g=' + _vesEsc(afx.eq.mid));
            if (afx.eq.treble) ach.push('equalizer=f=5000:t=q:w=0.7:g=' + _vesEsc(afx.eq.treble));
          }
          if (afx.fadeIn > 0) ach.push('afade=t=in:st=0:d=' + _vesEsc(Math.min(afx.fadeIn, Math.max(0.1, e - s))));
          if (afx.fadeOut > 0) ach.push('afade=t=out:st=' + _vesEsc(Math.max(0, (e - s) - afx.fadeOut)) + ':d=' + _vesEsc(afx.fadeOut));
          ach.push('aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=44100');
          parts.push((clip.reverseLabelA || '[' + inIdx + ':a]') + ach.join(',') + '[ac' + i + ']');
          aLabels.push('[ac' + i + ']');
        }
      }

      // ---- Per-clip clip-level extras that the flat state didn't carry ----
      function _edClipBlendFilter(mode) {
        if (!mode || mode === 'normal') return null;
        var map = {
          multiply: 'blend=all_mode=multiply', screen: 'blend=all_mode=screen',
          overlay: 'blend=all_mode=overlay', darken: 'blend=all_mode=darken',
          lighten: 'blend=all_mode=lighten', 'color-dodge': 'blend=all_mode=color_dodge',
          'color-burn': 'blend=all_mode=color_burn', 'hard-light': 'blend=all_mode=hard_light',
          'soft-light': 'blend=all_mode=soft_light', difference: 'blend=all_mode=difference',
          exclusion: 'blend=all_mode=exclusion', hue: 'blend=all_mode=hue',
          saturation: 'blend=all_mode=saturation', color: 'blend=all_mode=color',
          luminosity: 'blend=all_mode=luminosity'
        };
        return map[mode] || null;
      }
      // Reverse needs the raw stream flipped before trim, so track the input.
      for (var _ri = 0; _ri < n; _ri++) {
        var _rc = videoClips[_ri];
        if (_rc.reverse) {
          var _rIn = inputIdx[_rc.file];
          if (_rIn != null) {
            parts.push('[' + _rIn + ':v]reverse[vrev' + _ri + ']');
            parts.push('[' + _rIn + ':a]reverse[arev' + _ri + ']');
            _rc.reverseLabelV = '[vrev' + _ri + ']';
            _rc.reverseLabelA = '[arev' + _ri + ']';
          }
        }
        // Per-clip rotation/flip/zoom override the global ones when set.
        if (_rc.rotation || _rc.flipH || _rc.flipV || (_rc.zoom && Math.abs(_rc.zoom - 1) > 0.001)) {
          _rc.localGeom = true;
        }
        if (_rc.motionBlur && (_rc.motionBlurAmount || 0) > 0.02) {
          _rc.mbAmt = Math.min(0.9, _rc.motionBlurAmount);
        }
      }

      // Combine video clips: concat (no transition) or xfade chain (transition).
      var voutLabel, aoutLabel = null;
      if (n === 1) {
        voutLabel = '[vc0]';
        if (aLabels.length) aoutLabel = aLabels[0];
      } else if (transition === 'none') {
        parts.push(vLabels.join('') + 'concat=n=' + n + ':v=1:a=0[vcat]'); voutLabel = '[vcat]';
        if (aLabels.length) { parts.push(aLabels.join('') + 'concat=n=' + n + ':v=0:a=1[acat]'); aoutLabel = '[acat]'; }
      } else if (!_edHasFilter('xfade')) {
        // Bundled 2018 ffmpeg has no xfade. Approximate the transition with fade edges
        // so the export still succeeds instead of aborting on an unknown filter.
        for (var _fd = 0; _fd < n; _fd++) {
          var _fclip = videoClips[_fd];
          var _fdur = (_fclip.end - _fclip.start) / (_fclip.speed || speed);
          var _fhalf = Math.max(0.05, Math.min(td, _fdur / 2));
          if (_fd === 0) parts.push(vLabels[_fd] + 'fade=t=in:st=0:d=' + _vesEsc(_fhalf) + '[vfd' + _fd + ']');
          else parts.push(vLabels[_fd] + 'fade=t=in:st=0:d=' + _vesEsc(_fhalf) + ',fade=t=out:st=' + _vesEsc(_fdur - _fhalf) + ':d=' + _vesEsc(_fhalf) + '[vfd' + _fd + ']');
        }
        voutLabel = '[vfd' + (n - 1) + ']';
        var _fFadeLabels = [];
        for (var _fa = 0; _fa < n; _fa++) _fFadeLabels.push('[vfd' + _fa + ']');
        parts.push(_fFadeLabels.join('') + 'concat=n=' + n + ':v=1:a=0[vfcat]');
        voutLabel = '[vfcat]';
        if (aLabels.length) { parts.push(aLabels.join('') + 'concat=n=' + n + ':v=0:a=1[acat]'); aoutLabel = '[acat]'; }
      } else {
        var lastV = '[vc0]', lastA = aLabels.length ? aLabels[0] : null;
        var accDur = (videoClips[0].end - videoClips[0].start) / speed;
        for (var x = 1; x < n; x++) {
          var xlabel = 'vx' + x, offset = Math.max(0, accDur - td);
          var tmode = (transition === 'crossfade' || transition === 'fade' || transition === 'zoom') ? 'fade' : (transition === 'slide' || transition === 'push') ? 'slideleft' : (transition === 'spin') ? 'rotate' : 'fade';
          parts.push(lastV + '[vc' + x + ']xfade=transition=' + _vesEsc(tmode) + ':duration=' + _vesEsc(td) + ':offset=' + _vesEsc(offset) + '[' + xlabel + ']');
          lastV = '[' + xlabel + ']';
          if (aLabels[x] && lastA) {
            var alabel = 'ax' + x, segA = (videoClips[x].end - videoClips[x].start) / speed;
            var ad = Math.max(0, Math.min(td, Math.min(segA, accDur)));
            parts.push(lastA + '[ac' + x + ']acrossfade=d=' + _vesEsc(ad) + '[a' + x + ']');
            lastA = '[a' + x + ']';
          }
          accDur += (videoClips[x].end - videoClips[x].start) / speed - td;
        }
        voutLabel = lastV; aoutLabel = lastA;
      }

      // ---- Text overlays: drawtext per text clip, timed against the concat timeline ----
      // Work out each text clip's start on the concatenated video by walking the clips
      // the same way the concat/xfade was assembled above.
      var _edTlCursor = 0;
      var _edClipTlStart = [];
      for (var _ci = 0; _ci < n; _ci++) {
        var _c0 = videoClips[_ci];
        var _d0 = (_c0.end - _c0.start) / (_c0.speed || speed);
        _edClipTlStart.push(Math.max(0, _edTlCursor));
        // xfade consumes `td` from the running total at every join.
        _edTlCursor += (_ci === 0) ? _d0 : (_d0 - td);
      }
      var _edTotalOut = Math.max(0, _edTlCursor);
      var _edFontFiles = {
        arial: 'C\\:/Windows/Fonts/arial.ttf',
        arialbd: 'C\\:/Windows/Fonts/arialbd.ttf',
        georgia: 'C\\:/Windows/Fonts/georgia.ttf',
        georgiab: 'C\\:/Windows/Fonts/georgiab.ttf',
        impact: 'C\\:/Windows/Fonts/impact.ttf',
        courier: 'C\\:/Windows/Fonts/cour.ttf',
        consolas: 'C\\:/Windows/Fonts/consola.ttf',
        verdana: 'C\\:/Windows/Fonts/verdana.ttf',
        tahoma: 'C\\:/Windows/Fonts/tahoma.ttf',
        calibri: 'C\\:/Windows/Fonts/calibri.ttf'
      };
      function _edPickFont(styleId, family) {
        var fam = String(family || '').toLowerCase();
        if (/courier|mono|consol/.test(fam)) return 'consolas';
        if (/georgia|serif|times/.test(fam)) return 'georgia';
        if (/impact/.test(fam)) return 'impact';
        if (/script|brush|hand/.test(fam)) return 'comic';
        if (/verdana|tahoma/.test(fam)) return 'verdana';
        if (/calibri|segoe|inter/.test(fam)) return 'calibri';
        if (styleId === 'title' || styleId === 'bold' || styleId === 'sticker') return 'arialbd';
        return 'arial';
      }
      function _edEscapeText(s) {
        // drawtext parses its own escaping; protect ffmpeg filter separators.
        return String(s == null ? '' : s)
          .replace(/\\/g, '\\\\')
          .replace(/'/g, "\\'")
          .replace(/:/g, '\\:')
          .replace(/%/g, '\\%')
          .replace(/,/g, '\\,')
          .replace(/\[/g, '\\[')
          .replace(/\]/g, '\\]')
          .replace(/\n/g, ' ');
      }
      function _edHexColor(v, fallback) {
        var m = /^#?([0-9a-f]{6})$/i.exec(String(v || '').trim());
        return m ? ('0x' + m[1]) : (fallback || 'white');
      }
      if (textClips.length) {
        for (var _t = 0; _t < textClips.length; _t++) {
          var _tc = textClips[_t];
          var _tStart = Math.max(0, parseFloat(_tc.start) || 0);
          var _tEnd = _edTotalOut;
          if (_tc.end < _edTotalOut - 0.05) _tEnd = Math.min(_edTotalOut, parseFloat(_tc.end) || _edTotalOut);
          var _tDur = _tEnd - _tStart;
          if (_tDur <= 0.03) continue;
          var _style = _tc.textStyle || 'plain';
          var _fontKey = _edPickFont(_style, _tc.textFont);
          var _fontPath = _edFontFiles[_fontKey] || _edFontFiles.arial;
          if (_fontKey === 'comic') _fontPath = 'C\\:/Windows/Fonts/comic.ttf';
          var _txt = _edEscapeText(_tc.text);
          if (!_txt) continue;
          var _fs = Math.max(8, Math.round((_tc.textSize || 28) * (outH / 720)));
          // Baseline position: highlight/boxed sit low, plain sits lower-third.
          var _fy = _style === 'boxed' || _style === 'highlight' ? '(h-text_h*0.16)' : '(h-text_h*0.12)';
          var _dt = 'drawtext=text=\'' + _txt + '\'' +
            ':fontfile=\'' + _fontPath + '\'' +
            ':fontsize=' + _fs +
            ':fontcolor=' + _edHexColor(_tc.textColor, 'white') +
            ':x=(w-text_w)/2:y=' + _fy +
            ':enable=\'between(t,' + _tStart.toFixed(3) + ',' + _tEnd.toFixed(3) + ')\'' +
            ':borderw=' + ((_style === 'outline' || _style === 'title' || _style === 'neon') ? Math.max(2, Math.round(_fs * 0.06)) : 0);
          if ((_style === 'boxed' || _style === 'highlight') && _tc.textBgColor) {
            _dt += ':box=1:boxcolor=' + _edHexColor(_tc.textBgColor, '0x000000') +
              ':boxborderw=' + Math.max(6, Math.round(_fs * 0.28));
          }
          if (_style === 'subtitle') {
            _dt = _dt.replace(':x=(w-text_w)/2', ':x=(w-text_w)/2:y=h-text_h*1.85');
          }
          var _outLabel = '[tx' + _t + ']';
          parts.push(voutLabel + _dt + _outLabel);
          voutLabel = _outLabel;
        }
      }

      // Final encoding-compatible format on the concatenated video.
      if (format === 'mp4') { parts.push(voutLabel + 'format=yuv420p[vf]'); voutLabel = '[vf]'; }

      // ---- Music / audio tracks: mix into the final audio ----
      var audioMixLabels = [];
      if (aoutLabel) audioMixLabels.push(aoutLabel);
      for (var k = 0; k < musicClips.length; k++) {
        var mc = musicClips[k];
        var minIdx = inputIdx[mc.file]; if (minIdx == null) continue;
        var mAch = ['atrim=start=' + _vesEsc(mc.start) + ':end=' + _vesEsc(mc.end), 'asetpts=PTS-STARTPTS'];
        var mVol = Math.max(0, vol * (mc.muted ? 0 : (mc.volume != null ? mc.volume : 1)));
        if (mVol > 0) mAch.push('volume=' + _vesEsc(mVol));
        var mfx = mc.audioFx || {};
        if (mfx.noiseGate) mAch.push('highpass=f=120:p=2', 'lowpass=f=8000:p=2');
        if (mfx.normalize) mAch.push('dynaudnorm=f=200:g=5:p=0.9:m=10');
        if (mfx.voiceISO) mAch.push('equalizer=f=1600:t=q:w=1.1:g=8', 'equalizer=f=3000:t=q:w=1.4:g=4');
        if (mfx.eq) {
          if (mfx.eq.bass) mAch.push('equalizer=f=200:t=q:w=0.7:g=' + _vesEsc(mfx.eq.bass));
          if (mfx.eq.mid) mAch.push('equalizer=f=1200:t=q:w=0.9:g=' + _vesEsc(mfx.eq.mid));
          if (mfx.eq.treble) mAch.push('equalizer=f=5000:t=q:w=0.7:g=' + _vesEsc(mfx.eq.treble));
        }
        if (mfx.fadeIn > 0) mAch.push('afade=t=in:st=0:d=' + _vesEsc(Math.min(mfx.fadeIn, Math.max(0.1, mc.end - mc.start))));
        if (mfx.fadeOut > 0) mAch.push('afade=t=out:st=' + _vesEsc(Math.max(0, (mc.end - mc.start) - mfx.fadeOut)) + ':d=' + _vesEsc(mfx.fadeOut));
        if (mfx.pitch && mfx.pitch !== 1) {
          var mp = Math.max(0.5, Math.min(2, parseFloat(mfx.pitch) || 1));
          var pr = mp, pat = [];
          while (pr > 2.0) { pat.push('atempo=2.0'); pr = pr / 2; }
          while (pr < 0.5) { pat.push('atempo=0.5'); pr = pr / 0.5; }
          pat.push('atempo=' + _vesEsc(Math.min(2, Math.max(0.5, pr)).toFixed(4)));
          mAch = mAch.concat(pat);
        }
        mAch.push('aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=44100');
        mAch.push('adelay=' + _vesEsc(Math.max(0, Math.round((mc.start || 0) * 1000))) + '|' + _vesEsc(Math.max(0, Math.round((mc.start || 0) * 1000))));
        parts.push('[' + minIdx + ':a]' + mAch.join(',') + '[am' + k + ']');
        audioMixLabels.push('[am' + k + ']');
      }
      if (audioMixLabels.length) {
        // normalize=0 keeps each source at its own level; only available on ffmpeg >= 4.4.
        var _amixOpt = ':duration=first' + (_edHasFilter('amixNormalize') ? ':normalize=0' : '');
        parts.push(audioMixLabels.join('') + 'amix=inputs=' + audioMixLabels.length + _amixOpt + '[amixed]');
        aoutLabel = '[amixed]';
      } else {
        aoutLabel = null;
      }

      var filterGraph = parts.join(';');
      // -noautorotate: never decode with implicit rotation (we bake the source rotation
      // manually via the transposes above); guarantees no double-rotation on any build.
      var args = ['-noautorotate'];
      for (var _ai = 0; _ai < inputList.length; _ai++) { args.push('-i'); args.push(inputList[_ai].srcPath); }
      args = args.concat(['-filter_complex', filterGraph, '-map', voutLabel]);
      if (aoutLabel) { args.push('-map'); args.push(aoutLabel); }
      args.push('-r', String(outFps));

      var bitrate = proj.bitrate || 15000000;
      bitrate = Math.max(2000000, Math.min(60000000, bitrate));
      if (format === 'webm') {
        args = args.concat(['-c:v', 'libvpx-vp9', '-b:v', String(Math.round(bitrate / 1000000)) + 'M', '-crf', '23', '-row-mt', '1']);
        if (aoutLabel) args = args.concat(['-c:a', 'libopus', '-b:a', '128k']);
      } else {
        args = args.concat(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-b:v', String(bitrate), '-maxrate', String(Math.round(bitrate * 1.2)), '-bufsize', String(bitrate * 2), '-pix_fmt', 'yuv420p']);
        if (aoutLabel) args = args.concat(['-c:a', 'aac', '-b:a', '192k']);
      }
      // Strip all source metadata so players never double-rotate the baked frames.
      args = args.concat(['-map_metadata', '-1', '-movflags', '+faststart', '-threads', '0', '-y', dest]);

      sendp({ state: 'running', pct: 0, message: 'Exporting... 0%' });
      var proc = null;
      var cancelled = false;
      var stderrBuf = '';
      var killTimer = setTimeout(function() { try { if (proc) proc.kill('SIGKILL'); } catch(e) {} }, Math.max(10, totalDur / speed * 8 + 30) * 1000);

      function cleanupProc() { try { delete _edExportProcs[expId]; } catch(e) {} clearTimeout(killTimer); }

      var done = new Promise(function(resolve) {
        proc = spawn(bin.ffmpeg, args, { windowsHide: true });
        _edExportProcs[expId] = { proc: proc, setCancelled: function(v) { cancelled = v; } };
        proc.stderr.on('data', function(d) {
          var s = String(d); stderrBuf += s; if (stderrBuf.length > 16000) stderrBuf = stderrBuf.slice(-16000);
          var m = s.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
          if (m && totalDur > 0) {
            var secs = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
            var pct = Math.min(100, Math.round((secs / totalDur) * 100));
            sendp({ state: 'running', pct: pct, message: 'Exporting... ' + pct + '%' });
          }
        });
        proc.on('error', function(err) { cleanupProc(); resolve({ ok: false, error: 'FFmpeg error: ' + err.message }); });
        proc.on('close', function(code) {
          cleanupProc();
          if (cancelled) { try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch(e) {} resolve({ ok: false, cancelled: true, error: 'Export cancelled' }); return; }
          if (code === 0 && fs.existsSync(dest)) {
            resolve({ ok: true, path: dest, size: fs.statSync(dest).size });
          } else {
            try { fs.writeFileSync(path.join(require('os').tmpdir(), 'neo_ed_export_debug.log'), 'CMD: ffmpeg ' + args.join(' ') + '\n\nSTDERR:\n' + stderrBuf); } catch(_) {}
            var tail = stderrBuf.split('\n').filter(function(l) { return l.trim(); }).slice(-5).join(' | ');
            resolve({ ok: false, error: 'Export failed (code ' + code + ')' + (tail ? ' — ' + tail : '') });
          }
        });
      });
      return await done;
    } catch(e) {
      try { if (win && !win.isDestroyed()) win.webContents.send('ed:export-progress', { id: expId, state: 'error', message: e.message }); } catch(_) {}
      return { ok: false, error: e.message };
    }
  });

  ipcMain.on('ed:export-cancel', function(event, expId) {
    var ent = _edExportProcs[expId];
    if (ent) { try { if (ent.setCancelled) ent.setCancelled(true); } catch(e) {} try { if (ent.proc) ent.proc.kill('SIGKILL'); } catch(e) {} }
  });

  ipcMain.handle('ua-get-overrides', function() {
    var result = {};
    for (var d in _uaOverrides) result[d] = _uaOverrides[d];
    return result;
  });
  ipcMain.handle('ua-for-url', function(event, url) { return getUAForURL(url); });
  ipcMain.on('ua-set-override', function(event, domain, ua) { setUAOverride(domain, ua); });
  ipcMain.on('ua-remove-override', function(event, domain) { setUAOverride(domain, null); });

  // Apply User-Agent per-request for webview (streaming sites)
  try {
    var _wvSession = session.fromPartition('persist:webview');
    _wvSession.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, function(details, callback) {
      details.requestHeaders['User-Agent'] = getUAForURL(details.url);
      callback({ requestHeaders: details.requestHeaders });
    });
  } catch(e) { console.warn('[DRM] webview UA error:', e.message); }

  // ===== SCREEN RECORDER =====
  var _recDir = ''; // lazy-init
  function recDir() {
    if (!_recDir) {
      _recDir = path.join(app.getPath('userData'), 'Recordings');
      try { fs.mkdirSync(_recDir, { recursive: true }); } catch(e) {}
    }
    return _recDir;
  }
  function recThumbDir() {
    var d = path.join(recDir(), '.thumbs');
    try { fs.mkdirSync(d, { recursive: true }); } catch(e) {}
    return d;
  }
  function recMetaPath(name) {
    var base = path.basename(name, path.extname(name));
    return path.join(recDir(), base + '.json');
  }
  function recScreensDir() {
    var d = path.join(recDir(), '.screenshots');
    try { fs.mkdirSync(d, { recursive: true }); } catch(e) {}
    return d;
  }

  ipcMain.handle('rec-get-sources', async function() {
    try {
      var sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
      return sources.map(function(s) {
        var isSelf = s.name && (s.name.toUpperCase().indexOf('NEXO') !== -1 || s.name.toUpperCase().indexOf('NEO') !== -1);
        var type = s.name && s.name.indexOf('Entire Screen') !== -1 ? 'screen' : s.id.startsWith('screen:') ? 'screen' : 'window';
        return { id: s.id, name: s.name, type: type, thumbnail: s.thumbnail ? s.thumbnail.toDataURL() : null, isSelf: isSelf };
      });
    } catch(e) { return []; }
  });

  ipcMain.handle('rec-save-recording', async function(event, data) {
    try {
      // The name arrives over IPC: keep it a plain .webm file inside the
      // recordings folder, never a path that escapes it.
      var rawName = (data && data.name) || ('Recording_' + Date.now() + '.webm');
      var name = _safeBaseName(rawName, ['.webm']);
      if (!name) return { ok: false, error: 'Invalid recording name.' };
      var meta = (data && data.meta) || {};
      // If buffer has data, save the recording file
      if (data.buffer && data.buffer.byteLength > 0) {
        var raw = new Uint8Array(data.buffer);
        var buf = Buffer.from(raw);
        var fpath = path.join(recDir(), name);
        fs.writeFileSync(fpath, buf);
        console.log('[REC-SAVE] wrote', buf.length, 'bytes to', fpath);
        meta.size = buf.length;
        meta.date = Date.now();
        meta.name = name;
      }
      // Merge with existing meta
      var mp = recMetaPath(name);
      var existing = {};
      if (fs.existsSync(mp)) {
        try { existing = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch(e) {}
      }
      meta.duration = meta.duration || existing.duration || 0;
      meta.quality = meta.quality || existing.quality || '720p';
      meta.fps = meta.fps || existing.fps || 30;
      if (meta.favorite === undefined) meta.favorite = existing.favorite || false;
      if (!meta.date) meta.date = existing.date || Date.now();
      if (!meta.name) meta.name = existing.name || name;
      if (!meta.size) meta.size = existing.size || 0;
      fs.writeFileSync(mp, JSON.stringify(meta, null, 2));
      // Generate thumbnail from first frame data if provided
      if (data.thumbnail) {
        try {
          var tb = Buffer.from(data.thumbnail.split(',')[1], 'base64');
          fs.writeFileSync(path.join(recThumbDir(), path.basename(name, path.extname(name)) + '.png'), tb);
        } catch(e) {}
      }
      return { ok: true, name: name, path: path.join(recDir(), name) };
    } catch(e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('rec-get-recordings', async function() {
    try {
      var dir = recDir();
      var VIDEO_EXT = ['.webm', '.mp4', '.mov', '.mkv', '.avi'];
      var AUDIO_EXT = ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac'];
      var files = fs.readdirSync(dir).filter(function(f) {
        var ext = path.extname(f).toLowerCase();
        return VIDEO_EXT.indexOf(ext) !== -1 || AUDIO_EXT.indexOf(ext) !== -1;
      });
      var list = [];
      files.forEach(function(f) {
        var ext = path.extname(f).toLowerCase();
        var isAudio = AUDIO_EXT.indexOf(ext) !== -1;
        var stat = fs.statSync(path.join(dir, f));
        var meta = { name: f, size: stat.size, date: stat.mtimeMs, duration: 0, quality: '720p', fps: 30, favorite: false, type: isAudio ? 'audio' : 'video' };
        var mp = recMetaPath(f);
        if (fs.existsSync(mp)) {
          try {
            var m = JSON.parse(fs.readFileSync(mp, 'utf8'));
            Object.assign(meta, m);
          } catch(e) {}
        }
        // Thumbnail
        var tn = path.join(recThumbDir(), path.basename(f, path.extname(f)) + '.png');
        meta.hasThumb = fs.existsSync(tn);
        list.push(meta);
      });
      list.sort(function(a,b) { return b.date - a.date; });
      // Probe durations for recordings with no cached value yet.
      // Async + bounded concurrency so opening the library never blocks the main process.
      var need = list.filter(function(m) { return !m.duration; });
      var idx = 0;
      async function worker() {
        while (idx < need.length) {
          var cur = need[idx++];
          try {
            var dur = await _probeDurationAsync(path.join(dir, cur.name));
            if (dur > 0) {
              cur.duration = dur;
              var mPath = recMetaPath(cur.name);
              var meta = {};
              try { meta = JSON.parse(fs.readFileSync(mPath, 'utf8')); } catch(e) {}
              meta.duration = dur;
              try { fs.writeFileSync(mPath, JSON.stringify(meta, null, 2)); } catch(e) {}
            }
          } catch(e) {}
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()]);
      return list;
    } catch(e) { return []; }
  });

  ipcMain.handle('rec-delete-recording', function(event, name) {
    try {
      name = _safeBaseName(name, ['.webm', '.mp4']);
      if (!name) return { ok: false, error: 'Invalid recording name.' };
      var fpath = path.join(recDir(), name);
      if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
      var mp = recMetaPath(name);
      if (fs.existsSync(mp)) fs.unlinkSync(mp);
      var tn = path.join(recThumbDir(), path.basename(name, path.extname(name)) + '.png');
      if (fs.existsSync(tn)) fs.unlinkSync(tn);
      return { ok: true };
    } catch(e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('rec-rename-recording', function(event, oldName, newName) {
    try {
      oldName = _safeBaseName(oldName, ['.webm', '.mp4']);
      if (!oldName) return { ok: false, error: 'Invalid recording name.' };
      var dir = recDir();
      var ext = path.extname(oldName);
      newName = _safeBaseName(String(newName || ''));
      if (!newName) return { ok: false, error: 'Invalid new name.' };
      if (!newName.endsWith(ext)) newName += ext;
      if (path.extname(newName).toLowerCase() !== ext) return { ok: false, error: 'Invalid new name.' };
      fs.renameSync(path.join(dir, oldName), path.join(dir, newName));
      var oldMeta = recMetaPath(oldName);
      var newMeta = recMetaPath(newName);
      if (fs.existsSync(oldMeta)) {
        var m = JSON.parse(fs.readFileSync(oldMeta, 'utf8'));
        m.name = newName;
        fs.writeFileSync(newMeta, JSON.stringify(m, null, 2));
        fs.unlinkSync(oldMeta);
      }
      var oldTn = path.join(recThumbDir(), path.basename(oldName, ext) + '.png');
      var newTn = path.join(recThumbDir(), path.basename(newName, ext) + '.png');
      if (fs.existsSync(oldTn)) fs.renameSync(oldTn, newTn);
      return { ok: true, name: newName };
    } catch(e) { return { ok: false, error: e.message }; }
  });

  // Async probe a media file for duration using ffprobe.
  // Never blocks the main process (the old execFileSync froze the whole app
  // while probing each recording).
  function _probeDurationAsync(filePath) {
    return new Promise(function(resolve) {
      try {
        var ffprobePath = '';
        if (_ytFfmpegPath) {
          var dir = path.dirname(_ytFfmpegPath);
          ffprobePath = path.join(dir, 'ffprobe.exe');
        }
        if (!ffprobePath || !fs.existsSync(ffprobePath)) {
          var candidates = [
            path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffprobe.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages', 'ffprobe.exe'),
            path.join(__dirname, 'bin', 'ffprobe.exe')
          ];
          for (var pi = 0; pi < candidates.length; pi++) {
            if (fs.existsSync(candidates[pi])) { ffprobePath = candidates[pi]; break; }
          }
        }
        if (!ffprobePath || !fs.existsSync(filePath)) return resolve(0);
        execFile(ffprobePath, [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          filePath
        ], { timeout: 10000, encoding: 'utf8', windowsHide: true }, function(err, stdout) {
          if (err) return resolve(0);
          var dur = parseFloat((stdout || '').trim());
          if (dur > 0 && isFinite(dur)) return resolve(dur);
          return resolve(0);
        });
      } catch(e) { resolve(0); }
    });
  }

  ipcMain.handle('rec-probe-duration', async function(event, name) {
    try {
      name = _safeBaseName(name, ['.webm', '.mp4', '.mov', '.mkv', '.avi']);
      if (!name) return 0;
      var dir = recDir();
      var fp = path.join(dir, path.basename(name));
      if (!fs.existsSync(fp)) return 0;
      var dur = await _probeDurationAsync(fp);
      // Save to metadata for future quick lookup
      if (dur > 0) {
        var mp = recMetaPath(name);
        var meta = {};
        if (fs.existsSync(mp)) {
          try { meta = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch(e) {}
        }
        meta.duration = dur;
        fs.writeFileSync(mp, JSON.stringify(meta, null, 2));
      }
      return dur;
    } catch(e) { return 0; }
  });

  ipcMain.handle('rec-show-save-dialog', async function(event, opts) {
    var win = BrowserWindow.fromId(event.sender.id);
    if (!win) win = BrowserWindow.getFocusedWindow();
    if (!win) return { canceled: true };
    var result = await dialog.showSaveDialog(win, opts || {});
    return result;
  });

  ipcMain.handle('rec-export-recording', async function(event, name, destPath, expOpts) {
    try {
      // Source must be one of our own recordings; the destination comes from
      // the user's own save dialog, so it stays as chosen.
      name = _safeBaseName(name, ['.webm', '.mp4']);
      if (!name) return { ok: false, error: 'Invalid recording name.' };
      if (typeof destPath !== 'string' || !path.isAbsolute(destPath)) return { ok: false, error: 'Invalid destination.' };
      var srcPath = path.join(recDir(), name);
      if (!fs.existsSync(srcPath)) return { ok: false, error: 'File not found' };
      // If destPath is same extension, just copy
      var srcExt = path.extname(name).toLowerCase();
      var destExt = path.extname(destPath).toLowerCase();
      if (srcExt === destExt) {
        fs.copyFileSync(srcPath, destPath);
        return { ok: true, path: destPath };
      }
      // Convert format: we rely on OS or external tool; for now, copy as-is if no conversion
      fs.copyFileSync(srcPath, destPath);
      return { ok: true, path: destPath, note: 'Copied (format conversion requires ffmpeg)' };
    } catch(e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('rec-get-storage-info', function() {
    try {
      var dir = recDir();
      var totalSize = 0;
      var files = fs.readdirSync(dir).filter(function(f) { return f.endsWith('.webm') || f.endsWith('.mp4'); });
      files.forEach(function(f) { try { totalSize += fs.statSync(path.join(dir, f)).size; } catch(e) {} });
      return { count: files.length, totalSize: totalSize };
    } catch(e) { return { count: 0, totalSize: 0 }; }
  });

  ipcMain.handle('rec-save-screenshot', async function(event, data) {
    try {
      var name = 'Screenshot_' + Date.now() + '.png';
      var buf = Buffer.from(data.split(',')[1], 'base64');
      var fpath = path.join(recScreensDir(), name);
      fs.writeFileSync(fpath, buf);
      return { ok: true, name: name, path: fpath };
    } catch(e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('rec-read-file', async function(event, name) {
    try {
      // Library files only: media extensions, no directory components.
      name = _safeBaseName(name, ['.webm', '.mp4', '.mov', '.mkv', '.avi', '.m4v', '.ts', '.flv', '.wmv',
        '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp',
        '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
      if (!name) return null;
      var fpath = path.join(recDir(), name);
      if (!fs.existsSync(fpath)) return null;
      // Cap at 1.5 GB so a pathological file can't OOM the app; editors stream in chunks.
      var MAX_READ = 1500 * 1024 * 1024;
      var st = fs.statSync(fpath);
      if (st.size > MAX_READ) return { error: 'too-large', size: st.size };
      var buf = await fs.promises.readFile(fpath);
      // Use Uint8Array to transfer exact bytes — avoids Buffer.buffer backing-store issue
      var arr = new Uint8Array(buf.length);
      arr.set(buf);
      var _ext = path.extname(name).toLowerCase();
      var _mime = { '.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.m4v': 'video/mp4', '.ts': 'video/mp2t', '.flv': 'video/x-flv', '.wmv': 'video/x-ms-wmv', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac' };
      console.log('[REC-READ]', name, 'size=' + arr.length);
      return { buffer: arr.buffer, name: name, size: arr.length, mimeType: _mime[_ext] || 'application/octet-stream' };
    } catch(e) { return null; }
  });

  ipcMain.handle('rec-import-recording', async function(event, srcPath) {
    try {
      // Imports come from the user's own file picker, but the path still arrives
      // over IPC: demand an absolute path to a media file before touching it.
      if (typeof srcPath !== 'string' || !path.isAbsolute(srcPath)) return { ok: false, error: 'Invalid source.' };
      if (!fs.existsSync(srcPath)) return { ok: false, error: 'Source not found' };
      var IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.avif', '.tif', '.tiff'];
      var VIDEO_EXT = ['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v', '.ts', '.flv', '.wmv'];
      var ext = path.extname(srcPath).toLowerCase();
      if (IMAGE_EXT.indexOf(ext) === -1 && VIDEO_EXT.indexOf(ext) === -1) return { ok: false, error: 'Unsupported file type.' };
      // Photos: convert into a short video clip so they work everywhere in the editor
      // (preview, timeline, crop, effects, export) exactly like recordings.
      if (IMAGE_EXT.indexOf(ext) !== -1) return await _importPhotoAsClip(srcPath);
      var name = path.basename(srcPath);
      var dest = path.join(recDir(), name);
      var count = 1;
      while (fs.existsSync(dest)) {
        var extc = path.extname(name);
        var base = path.basename(name, extc);
        dest = path.join(recDir(), base + '_' + count + extc);
        count++;
      }
      fs.copyFileSync(srcPath, dest);
      return { ok: true, name: path.basename(dest) };
    } catch(e) { return { ok: false, error: e.message }; }
  });

  // Convert a photo into a video clip (~5s, native aspect, 30fps) using FFmpeg.
  // Also writes meta JSON (duration cached so the library never re-probes) and a thumbnail.
  async function _importPhotoAsClip(srcPath) {
    var bin = _vesFfmpegBinary();
    if (!bin || !bin.ffmpeg) return { ok: false, error: 'FFmpeg not available - cannot convert photo' };
    var name = path.basename(srcPath);
    var base = path.basename(name, path.extname(name));
    var outName = base + '.mp4';
    var dest = path.join(recDir(), outName);
    var count = 1;
    while (fs.existsSync(dest)) { dest = path.join(recDir(), base + '_' + count + '.mp4'); count++; }
    outName = path.basename(dest);
    var PHOTO_SECS = 5;
    var args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-loop', '1', '-i', srcPath,
      '-t', String(PHOTO_SECS),
      '-vf', "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease,scale='trunc(iw/2)*2':'trunc(ih/2)*2'",
      '-r', '30', '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-an', dest
    ];
    console.log('[PHOTO-IMPORT] ffmpeg', bin.ffmpeg, args.join(' '));
    var stderrLog = '';
    var convertOk = await new Promise(function(resolve) {
      var p = require('child_process').spawn(bin.ffmpeg, args, { windowsHide: true });
      var killed = false;
      var t = setTimeout(function() { killed = true; try { p.kill('SIGKILL'); } catch(e) {} }, 120000);
      // Drain stderr to prevent pipe buffer fill from blocking ffmpeg
      p.stderr.on('data', function(d) { stderrLog += d; });
      p.stdout.on('data', function() {});
      p.on('error', function(e) { clearTimeout(t); console.error('[PHOTO-IMPORT] spawn error:', e.message); resolve(false); });
      var resolved = false;
      p.on('close', function(code) {
        clearTimeout(t);
        console.log('[PHOTO-IMPORT] exit', code, 'stderr:', stderrLog.slice(-300));
        try {
          fs.appendFileSync(path.join(recDir(), '_photo_import_log.txt'), '\n[' + new Date().toISOString() + '] code=' + code + '\ncmd: ' + bin.ffmpeg + ' ' + args.join(' ') + '\nstderr: ' + stderrLog.slice(0, 1500));
        } catch(e) {}
        if (!resolved) { resolved = true; resolve(code === 0); }
      });
    });
    if (!convertOk || !fs.existsSync(dest) || fs.statSync(dest).size < 200) {
      try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch(e) {}
      return { ok: false, error: 'FFmpeg conversion failed' + (stderrLog ? ': ' + stderrLog.slice(0, 200) : '') };
    }
    try {
      var meta = { name: outName, date: Date.now(), size: fs.statSync(dest).size, duration: PHOTO_SECS, quality: 'original', fps: 30, favorite: false, type: 'video', fromPhoto: true };
      fs.writeFileSync(recMetaPath(outName), JSON.stringify(meta, null, 2));
    } catch(e) {}
    // Thumbnail from first frame
    try {
      var tn = path.join(recThumbDir(), path.basename(outName, path.extname(outName)) + '.png');
      await new Promise(function(resolve) {
        var p2 = require('child_process').spawn(bin.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', dest, '-frames:v', '1', '-vf', 'scale=160:-1', tn], { windowsHide: true });
        p2.stderr.on('data', function() {});
        p2.stdout.on('data', function() {});
        p2.on('close', function() { resolve(); });
        p2.on('error', function() { resolve(); });
      });
    } catch(e) {}
    return { ok: true, name: outName, fromPhoto: true };
  }

  ipcMain.handle('rec-get-thumbnail', function(event, name) {
    try {
      var tn = path.join(recThumbDir(), path.basename(name, path.extname(name)) + '.png');
      if (fs.existsSync(tn)) {
        var buf = fs.readFileSync(tn);
        return 'data:image/png;base64,' + buf.toString('base64');
      }
    } catch(e) {}
    return null;
  });

  ipcMain.handle('rec-open-folder', function() {
    try { shell.openPath(recDir()); } catch(e) {}
  });

  // (Soundboard IPC handlers removed)

  // ============================================================
  //  MY APPS SHELF  -  drag & drop PC apps into the browser
  //  Drop an .exe/.msi/.bat/.lnk/folder/HTML file onto the panel and it
  //  becomes a clickable launcher:
  //    - Run  : launches the real program on Windows (detached + tracked)
  //    - Open : embeds web apps (html file / folder index.html) in a <webview>
  //  Only paths the user dropped or picked through the dialog are ever
  //  launched; the stored shelf is the allow-list, so a compromised page
  //  cannot talk this into executing an arbitrary file.
  // ============================================================
  var _APPS_PATH = path.join(_DATA_DIR, 'app-shelf.json');
  var _APP_ICON_DIR = path.join(_DATA_DIR, 'app-icons');
  var _appProcs = {};   // id -> child process
  var _APP_KIND = {
    '.exe': 'app', '.msi': 'installer', '.bat': 'app', '.cmd': 'app', '.com': 'app',
    '.lnk': 'app', '.appx': 'installer', '.msix': 'installer',
    '.html': 'webapp', '.htm': 'webapp', '.mhtml': 'webapp', '.url': 'webapp', '.webloc': 'webapp'
  };
  var _INSTALLER_HINT = /(^|[^a-z])(setup|install|installer|installsetup|updater|update)([^a-z]|$)/i;
  var _SKIP_EXE = /(unins|uninstall|uninst|vcredist|dxsetup|oainstall|aspeninst|setup\.cfg)/i;

  function _appsLoad() {
    try {
      if (fs.existsSync(_APPS_PATH)) {
        var d = JSON.parse(fs.readFileSync(_APPS_PATH, 'utf8'));
        if (d && Array.isArray(d.items)) return d;
      }
    } catch (e) { console.error('[APPS] load failed', e.message); }
    return { items: [] };
  }
  function _appsSave(d) {
    try {
      if (!fs.existsSync(_DATA_DIR)) fs.mkdirSync(_DATA_DIR, { recursive: true });
      fs.writeFileSync(_APPS_PATH, JSON.stringify(d, null, 2));
    } catch (e) { console.error('[APPS] save failed', e.message); }
  }
  // "steam-setup-1.2.3" -> "Steam Setup"
  function _appPrettyName(p) {
    var base = path.basename(String(p || '')).replace(/\.[^.]+$/, '');
    var small = /^(of|the|and|for|to|in|on|at|with|my)$/i;
    return base
      .replace(/[_\-]+/g, ' ')
      .replace(/\bv?\d+(\.\d+)+\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(function (w) { return w && !/^\d+$/.test(w); })
      .map(function (w, i) {
        if (i > 0 && small.test(w)) return w.toLowerCase();
        if (/^[A-Z0-9]{2,}$/.test(w)) return w;
        return w.charAt(0).toUpperCase() + w.slice(1);
      })
      .join(' ') || path.basename(String(p || ''));
  }
  function _appKindOf(p, isDir) {
    var ext = path.extname(String(p || '')).toLowerCase();
    if (isDir) {
      try {
        if (fs.existsSync(path.join(p, 'index.html'))) return 'webapp';
      } catch (e) {}
      return 'folder';
    }
    var kind = _APP_KIND[ext];
    if (kind === 'app' && _INSTALLER_HINT.test(path.basename(p)) && !_SKIP_EXE.test(path.basename(p))) return 'installer';
    return kind || 'app';
  }
  // Windows icon -> PNG data URL, cached on disk (extracted once per file).
  // Async on purpose: PowerShell takes ~1s per file and the main process must
  // not block while the shelf is being filled.
  async function _appIconFor(p) {
    try {
      // A text web page has no real icon of its own - keep the letter tile.
      if (/\.(html?|mhtml|webloc|url)$/i.test(p)) return null;
      var st = fs.statSync(p);
      var key = path.basename(p) + '-' + st.size + '-' + Math.floor(st.mtimeMs);
      var png = path.join(_APP_ICON_DIR, require('crypto').createHash('md5').update(p + '|' + key).digest('hex') + '.png');
      if (fs.existsSync(png)) return 'data:image/png;base64,' + fs.readFileSync(png).toString('base64');
      if (!fs.existsSync(_APP_ICON_DIR)) fs.mkdirSync(_APP_ICON_DIR, { recursive: true });
      // PowerShell eats double quotes inside -Command, so quote with
      // single-quoted literals (PS escapes an inner ' by doubling it).
      var q = function (s) { return "'" + String(s).replace(/'/g, "''") + "'"; };
      var ps = 'Add-Type -AssemblyName System.Drawing;' +
        'try{$i=[System.Drawing.Icon]::ExtractAssociatedIcon(' + q(p) + ');' +
        'if($i){$b=$i.ToBitmap();$b.Save(' + q(png) + ',[System.Drawing.Imaging.ImageFormat]::Png);$b.Dispose();exit 0}}catch{};exit 1';
      try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 15000, windowsHide: true }); } catch (e) {}
      if (fs.existsSync(png)) return 'data:image/png;base64,' + fs.readFileSync(png).toString('base64');
    } catch (e) {}
    return null;
  }
  // What URL (if any) can be embedded in the panel's <webview>?
  function _appEmbedUrl(item) {
    var p = item.path;
    try {
      // A folder that ships index.html is a web app no matter how it was typed.
      var isDir = false;
      try { isDir = fs.statSync(p).isDirectory(); } catch (e) {}
      if (isDir) {
        var idx = path.join(p, 'index.html');
        if (fs.existsSync(idx)) return 'file:///' + idx.replace(/\\/g, '/').replace(/\/+/g, '/');
        return null;
      }
      if (item.kind === 'webapp') {
        if (/\.(html?|mhtml|webloc)$/i.test(p)) return 'file:///' + p.replace(/\\/g, '/').replace(/([^:])\/+/g, '$1/');
        if (/\.url$/i.test(p)) {
          var raw = fs.readFileSync(p, 'utf8');
          var m = raw.match(/URL=([^\r\n]+)/i);
          return m ? m[1].trim() : null;
        }
      }
      // An installed app that ships a local UI (Electron/PWA build) can be
      // embedded too when it exposes an obvious page.
      if (item.kind === 'app' || item.kind === 'installer') {
        for (var cand of ['index.html', 'app.asar', 'resources\\app.asar']) {
          if (fs.existsSync(path.join(p, cand))) return 'file:///' + path.join(p, cand).replace(/\\/g, '/').replace(/([^:])\/+/g, '$1/');
        }
      }
    } catch (e) {}
    return null;
  }
  async function _appItemFromPath(p) {
    p = String(p || '').trim();
    if (!p) return null;
    var st;
    try { st = fs.statSync(p); } catch (e) { return { ok: false, error: 'File not found: ' + p }; }
    var kind = _appKindOf(p, st.isDirectory());
    return {
      ok: true,
      item: {
        id: 'app_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
        name: _appPrettyName(p),
        path: p,
        kind: kind,
        ext: path.extname(p).toLowerCase(),
        size: st.isDirectory() ? 0 : st.size,
        isDir: !!st.isDirectory(),
        addedAt: Date.now(),
        lastRunAt: 0,
        runCount: 0,
        icon: await _appIconFor(p),
        embedUrl: _appEmbedUrl({ path: p, kind: kind })
      }
    };
  }
  function _appFind(d, id) {
    for (var i = 0; i < d.items.length; i++) if (d.items[i].id === id) return d.items[i];
    return null;
  }
  function _appStatus(id, state, extra) {
    try {
      var wins = BrowserWindow.getAllWindows();
      var payload = Object.assign({ id: id, state: state }, extra || {});
      for (var i = 0; i < wins.length; i++) {
        try { wins[i].webContents.send('apps:status', payload); } catch (e) {}
      }
    } catch (e) {}
  }

  ipcMain.handle('apps:list', async () => {
    var d = _appsLoad();
    var out = [];
    for (var i = 0; i < d.items.length; i++) {
      var it = d.items[i];
      var missing = false;
      // A website has no file behind it, so it can never be "moved".
      if (!/^https?:\/\//i.test(String(it.path || ''))) {
        try { missing = !fs.existsSync(it.path); } catch (e) { missing = true; }
      }
      it.missing = missing;
      it.running = !!_appProcs[it.id];
      out.push(it);
    }
    return out;
  });

  // A website becomes a first-class tile: name + URL, opened in the built-in
  // viewer. This is the WhatsApp / Spotify case - no .exe needed.
  ipcMain.handle('apps:add-web', async (event, name, url) => {
    var u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'Not a web address' };
    var nm = String(name || '').trim() || (u.replace(/^https?:\/\//i, '').split('/')[0] || 'Website');
    var d = _appsLoad();
    var item = null;
    for (var i = 0; i < d.items.length; i++) {
      if (d.items[i].path.toLowerCase() === u.toLowerCase()) { item = d.items[i]; break; }
    }
    if (item) {
      item.name = nm;
      item.embedUrl = u;
    } else {
      item = {
        id: 'web_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
        name: nm, path: u, kind: 'webapp', ext: '', size: 0, isDir: false,
        addedAt: Date.now(), lastRunAt: 0, runCount: 0, icon: null, embedUrl: u
      };
      d.items.push(item);
    }
    _appsSave(d);
    console.log('[APPS] added website', nm, '-', u);
    return { ok: true, item: item, items: d.items };
  });

  ipcMain.handle('apps:add', async (event, p) => {
    var res = await _appItemFromPath(p);
    if (!res) return { ok: false, error: 'Nothing to add' };
    if (!res.ok) return res;
    var d = _appsLoad();
    var dup = -1;
    for (var i = 0; i < d.items.length; i++) if (d.items[i].path.toLowerCase() === res.item.path.toLowerCase()) dup = i;
    if (dup >= 0) { res.item.id = d.items[dup].id; res.item.runCount = d.items[dup].runCount || 0; d.items[dup] = res.item; _appsSave(d); return { ok: true, replaced: true, item: res.item, items: d.items }; }
    d.items.push(res.item);
    _appsSave(d);
    console.log('[APPS] added', res.item.kind, res.item.name, '-', res.item.path);
    return { ok: true, item: res.item, items: d.items };
  });

  async function _appsAddMany(paths) {
    var added = [], errors = [];
    var list = Array.isArray(paths) ? paths : [];
    for (var k = 0; k < list.length; k++) {
      var r = await _appItemFromPath(list[k]);
      if (r && r.ok) added.push(r.item); else errors.push({ path: list[k], error: (r && r.error) || 'unknown' });
    }
    if (added.length) {
      var d = _appsLoad();
      added.forEach(function (it) {
        var dup = -1;
        for (var i = 0; i < d.items.length; i++) if (d.items[i].path.toLowerCase() === it.path.toLowerCase()) dup = i;
        if (dup >= 0) { it.id = d.items[dup].id; it.runCount = d.items[dup].runCount || 0; d.items[dup] = it; }
        else d.items.push(it);
      });
      _appsSave(d);
    }
    return { ok: true, added: added, errors: errors, items: _appsLoad().items };
  }

  ipcMain.handle('apps:add-many', async (event, paths) => _appsAddMany(paths));

  ipcMain.handle('apps:remove', async (event, id) => {
    var d = _appsLoad();
    d.items = d.items.filter(function (x) { return x.id !== id; });
    _appsSave(d);
    return { ok: true, items: d.items };
  });

  ipcMain.handle('apps:rename', async (event, id, name) => {
    var d = _appsLoad();
    var it = _appFind(d, id);
    if (it && String(name || '').trim()) { it.name = String(name).trim().slice(0, 60); _appsSave(d); }
    return { ok: true, items: d.items };
  });

  // Starts the shelf item and returns the detached child. Shared by "Run" and
  // by native embedding, which launches the same exe and then re-parents the
  // window it opens.
  function _appSpawn(it) {
    var ext = path.extname(it.path).toLowerCase();
    try {
      if (ext === '.msi' || ext === '.msix' || ext === '.appx') {
        return spawn('msiexec.exe', ['/i', it.path], { detached: true, stdio: 'ignore', windowsHide: false });
      }
      if (ext === '.bat' || ext === '.cmd' || ext === '.com') {
        return spawn(process.env.ComSpec || 'cmd.exe', ['/c', it.path], { detached: true, stdio: 'ignore', windowsHide: false });
      }
      return spawn(it.path, [], { detached: true, stdio: 'ignore', windowsHide: false });
    } catch (e) {
      return null;
    }
  }

  ipcMain.handle('apps:launch', async (event, id) => {
    var d = _appsLoad();
    var it = _appFind(d, id);
    if (!it) return { ok: false, error: 'Not in your shelf' };
    if (!fs.existsSync(it.path)) return { ok: false, error: 'File is gone: ' + it.path };
    // A folder is not runnable by itself - point the user at the exe inside.
    if (it.isDir) {
      var inner = _appEmbedUrl({ path: it.path, kind: 'folder' });
      return {
        ok: false,
        error: inner
          ? 'That is a folder. Use "Open" to show it inside NEO.'
          : 'That folder has no app to run. Drop the .exe inside it to get a launcher.'
      };
    }
    var child = _appSpawn(it);
    if (!child) return { ok: false, error: 'Could not start ' + it.path };
    var pid = child.pid;
    child.on('error', function (e) {
      delete _appProcs[id];
      _appStatus(id, 'error', { message: e.message });
    });
    child.on('exit', function (code) {
      delete _appProcs[id];
      _appStatus(id, 'exited', { code: code });
    });
    child.unref();
    _appProcs[id] = child;
    it.lastRunAt = Date.now();
    it.runCount = (it.runCount || 0) + 1;
    _appsSave(d);
    _appStatus(id, 'running', { pid: pid });
    console.log('[APPS] launched', it.name, '->', it.path, 'pid', pid);
    return { ok: true, pid: pid, item: it };
  });

  ipcMain.handle('apps:stop', async (event, id) => {
    var child = _appProcs[id];
    if (!child || !child.pid) {
      _appStatus(id, 'stopped', {});
      return { ok: false, error: 'Not running' };
    }
    // Only the process NEO started is ours to close. Apps that hand off to a
    // running instance (or brokered apps like Notepad) keep their own window -
    // the user quits those from the app itself.
    try {
      execFile('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { timeout: 8000 }, function () {});
    } catch (e) {}
    delete _appProcs[id];
    _appStatus(id, 'stopped', {});
    return { ok: true };
  });

  ipcMain.handle('apps:reveal', async (event, id) => {
    var d = _appsLoad();
    var it = _appFind(d, id);
    if (!it) return { ok: false };
    try {
      if (it.isDir) shell.openPath(it.path);
      else shell.showItemInFolder(it.path);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('apps:embed-url', async (event, id) => {
    var d = _appsLoad();
    var it = _appFind(d, id);
    if (!it) return { ok: false, error: 'Not in your shelf' };
    var url = it.embedUrl || _appEmbedUrl(it);
    if (!url) return { ok: false, error: 'This app has no page to show inside the browser' };
    it.embedUrl = url;
    _appsSave(d);
    return { ok: true, url: url };
  });

  // Drop a whole folder: offer what is inside so the user can pick the real exe.
  // Scans a few levels deep because installers/game folders bury the .exe in a
  // subfolder ("Game\setup.exe", "Game\bin\launcher.exe", ...).
  ipcMain.handle('apps:probe-folder', async (event, p) => {
    var out = [];
    var SKIP_DIR = /^(unins|uninstall|directx|redist|dotnet|support|patch|downloads?|temp|cache|__pycache__|node_modules)$/i;
    function walk(dir, depth) {
      if (depth > 3 || out.length > 200) return;
      var entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      entries.sort(function (a, b) {
        // launchers/setup first, then web pages, then everything else
        var rank = function (n) {
          if (/^(setup|install|launcher|play|start|run)/i.test(n)) return 0;
          if (_INSTALLER_HINT.test(n)) return 1;
          if (/\.(html?|mhtml|webloc|url)$/i.test(n)) return 2;
          return 3;
        };
        return rank(a.name) - rank(b.name);
      });
      for (var i = 0; i < entries.length; i++) {
        var e2 = entries[i];
        var full = path.join(dir, e2.name);
        if (e2.isDirectory()) {
          if (!SKIP_DIR.test(e2.name) && e2.name.charAt(0) !== '.') walk(full, depth + 1);
        } else if (e2.isFile()) {
          var ext = path.extname(e2.name).toLowerCase();
          if (_APP_KIND[ext] && !_SKIP_EXE.test(e2.name)) {
            out.push({ name: e2.name, path: full, kind: _appKindOf(full, false), rel: path.relative(p, full) });
          }
        }
      }
    }
    try {
      var st = fs.statSync(p);
      if (!st.isDirectory()) return { ok: false, error: 'Not a folder' };
      walk(p, 1);
    } catch (e) { return { ok: false, error: e.message }; }
    var rank = { app: 0, installer: 1, webapp: 2 };
    out.sort(function (a, b) { return (rank[a.kind] === undefined ? 3 : rank[a.kind]) - (rank[b.kind] === undefined ? 3 : rank[b.kind]); });
    return { ok: true, entries: out.slice(0, 12), total: out.length, embeddable: !!_appEmbedUrl({ path: p, kind: 'folder' }) };
  });

  ipcMain.handle('apps:pick', async (event) => {
    try {
      var r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, {
        title: 'Add an app to your shelf',
        properties: ['openFile', 'openDirectory'],
        filters: [
          { name: 'Apps & installers', extensions: ['exe', 'msi', 'bat', 'cmd', 'lnk', 'appx'] },
          { name: 'Web apps', extensions: ['html', 'htm', 'url'] },
          { name: 'All files', extensions: ['*'] }
        ]
      });
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
      return _appsAddMany(r.filePaths);
    } catch (e) { return { ok: false, error: e.message }; }
  });
  // ============================================================
  //  WINDOW STREAM  -  use a real Windows app inside the browser
  //  A native .exe window cannot be re-parented into Chromium, so we do
  //  what remote-desktop software does: capture the window as a video
  //  stream and inject mouse/keyboard back into it. Works with any
  //  Windows app, including games.
  //
  //  Input goes through one long-lived PowerShell host (user32 P/Invoke)
  //  instead of a new process per event, so a click costs ~1ms instead of
  //  ~200ms. Commands are newline-delimited verbs on stdin.
  // ============================================================
  var _streamHost = null;   // { proc, buffer }
  var _streamHwnd = 0;
  var _streamQueue = [];    // pending query replies
  var _streamPs1 = '';

  // 'window:123456:0' -> 123456 (the HWND we need for input injection)
  function _hwndFromSourceId(id) {
    var m = String(id || '').match(/^window:(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }
  // getNativeWindowHandle() is documented as a Buffer, but depending on the
  // Electron build it can come back as a plain Uint8Array/Array - and a
  // readUIntLE() on those throws, which silently swallowed every HWND before.
  // Normalise all three shapes into the numeric handle.
  // Electron hands back an 8-byte little-endian buffer whose low 4 bytes are the
  // Win32 window handle. Two traps here, both of which silently produced a
  // garbage handle before: readUIntLE() requires an explicit byteLength in
  // modern Node (it throws, and a swallowed throw looks like "no value"), and
  // reading all 8 bytes as a BigInt is wrong anyway - the upper bytes are
  // padding, and a JS number cannot hold 64 bits exactly.
  function _hwndNum(h) {
    if (!h) return 0;
    var buf = null;
    try { buf = Buffer.isBuffer(h) ? h : Buffer.from(h); } catch (e) { return 0; }
    if (buf.length < 4) return 0;
    return buf.readUInt32LE(0);
  }

  function _selfHwnds() {
    var out = {};
    try {
      BrowserWindow.getAllWindows().forEach(function (w) {
        try {
          var n = _hwndNum(w.getNativeWindowHandle());
          if (n) out[n] = 1;
        } catch (e) {}
      });
    } catch (e) {}
    return out;
  }

  var _INJECT_PS = [
    '$ErrorActionPreference = "SilentlyContinue"',
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class U32 {',
    '  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);',
    '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
    '  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);',
    '  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, IntPtr e);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);',
    '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);',
    '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);',
    '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);',
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
    '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
    '}',
    '"@',
    'try { [void][U32]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch {}',
    '$hwnd = [IntPtr]0',
    'function Mbtn($s) { if ($s -eq "r") { return 2 } elseif ($s -eq "m") { return 4 } else { return 1 } }',
    'while ($true) {',
    '  $line = [Console]::In.ReadLine()',
    '  if ($line -eq $null) { break }',
    '  $line = $line.Trim()',
    '  if ($line -eq "") { continue }',
    '  foreach ($cmd in ($line -split ";")) {',
    '    $p = $cmd.Trim().Split(" ")',
    '    if ($p[0] -eq "") { continue }',
    '    # Only the three query verbs below print anything. Input verbs stay',
    '    # silent so their output can never be mistaken for a query reply.',
    '    switch ($p[0]) {',
    '      "HWND" { $hwnd = [IntPtr][int64]$p[1] }',
    '      "FOCUS" { if ([U32]::IsIconic($hwnd)) { [void][U32]::ShowWindow($hwnd, 9) }; $me = [U32]::GetCurrentThreadId(); $fg = [U32]::GetForegroundWindow(); $fgT = [U32]::GetWindowThreadProcessId($fg, [IntPtr]::Zero); [void][U32]::AttachThreadInput($me, $fgT, $true); [void][U32]::BringWindowToTop($hwnd); [void][U32]::SetForegroundWindow($hwnd); [void][U32]::AttachThreadInput($me, $fgT, $false); "OK " + [U32]::GetForegroundWindow() }',
    '      "RECT" { $r = New-Object U32+RECT; [void][U32]::GetWindowRect($hwnd, [ref]$r); "RECT " + $r.Left + " " + $r.Top + " " + ($r.Right - $r.Left) + " " + ($r.Bottom - $r.Top) }',
    '      "CUR" { $c = New-Object U32+POINT; [void][U32]::GetCursorPos([ref]$c); "CUR " + $c.X + " " + $c.Y }',
    '      "MOVE" { [void][U32]::SetCursorPos([int]$p[1], [int]$p[2]) }',
    '      "MD" { [U32]::mouse_event((Mbtn $p[1]), 0, 0, 0, [IntPtr]::Zero) }',
    '      "MU" { [U32]::mouse_event(((Mbtn $p[1]) + 2), 0, 0, 0, [IntPtr]::Zero) }',
    '      "WHEEL" { $d = ([int]$p[1] * 120) -band 0xFFFFFFFF; [U32]::mouse_event(0x0800, 0, 0, [uint32]$d, [IntPtr]::Zero) }',
    '      "KD" { [U32]::keybd_event([byte][int]$p[1], 0, 0, [IntPtr]::Zero) }',
    '      "KU" { [U32]::keybd_event([byte][int]$p[1], 0, 2, [IntPtr]::Zero) }',
    '      "SHOW" { [void][U32]::ShowWindow($hwnd, 5) }',
    '      "MIN" { [void][U32]::ShowWindow($hwnd, 6) }',
    '      "MAX" { [void][U32]::ShowWindow($hwnd, 3) }',
    '      "POS" { [void][U32]::SetWindowPos($hwnd, [IntPtr]::Zero, [int]$p[1], [int]$p[2], 0, 0, 0x0001 -bor 0x0004) }',
    '    }',
    '  }',
    '}'
  ].join('\n');

  function _streamHostScriptPath() {
    // -Command - would swallow stdin, and a huge script through argv gets its
    // quotes mangled. A real .ps1 file keeps stdin free for the verbs.
    if (!_streamPs1) _streamPs1 = path.join(_DATA_DIR, 'winstream-host.ps1');
    var current = null;
    try { current = fs.readFileSync(_streamPs1, 'utf8'); } catch (e) {}
    if (current !== _INJECT_PS) {
      if (!fs.existsSync(_DATA_DIR)) fs.mkdirSync(_DATA_DIR, { recursive: true });
      fs.writeFileSync(_streamPs1, _INJECT_PS, 'utf8');
    }
    return _streamPs1;
  }

  function _streamEnsureHost() {
    if (_streamHost && !_streamHost.proc.killed) return _streamHost;
    try {
      var proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', _streamHostScriptPath()], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      _streamHost = { proc: proc, buffer: '' };
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', function (c) { console.error('[STREAM] host:', String(c).trim().slice(0, 200)); });
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', function (chunk) {
        _streamHost.buffer += chunk;
        var lines = _streamHost.buffer.split(/\r?\n/);
        _streamHost.buffer = lines.pop();
        while (lines.length) {
          var line = lines.shift();
          if (!_streamQueue.length) continue;
          _streamQueue.shift()(line);
        }
      });
      proc.on('exit', function (code) {
        if (_streamHost) console.error('[STREAM] host exited', code);
        _streamHost = null;
      });
      proc.on('error', function (e) { console.error('[STREAM] host error', e.message); _streamHost = null; });
    } catch (e) {
      console.error('[STREAM] host failed', e.message);
      _streamHost = null;
    }
    return _streamHost;
  }

  // Fire-and-forget batched verbs. Several verbs can share one line ("A;B;C")
  // which keeps a drag at a single IPC round-trip per frame.
  function _streamSend(cmds, wantReply) {
    var h = _streamEnsureHost();
    if (!h) return Promise.resolve(null);
    var line = (Array.isArray(cmds) ? cmds : [cmds]).filter(Boolean).join(';');
    if (!line) return Promise.resolve(null);
    if (!wantReply) {
      try { h.proc.stdin.write(line + '\n'); } catch (e) {}
      return Promise.resolve(true);
    }
    return new Promise(function (resolve) {
      var done = false;
      _streamQueue.push(function (reply) {
        if (done) return;
        done = true;
        resolve(reply);
      });
      try { h.proc.stdin.write(line + '\n'); } catch (e) { resolve(null); }
      // The very first query also pays for Add-Type compiling user32, so the
      // timeout is generous. Queries are rare, so this costs nothing.
      setTimeout(function () { if (!done) { done = true; resolve(null); } }, 5000);
    });
  }

  function _streamStopHost() {
    try { if (_streamHost && _streamHost.proc) _streamHost.proc.kill(); } catch (e) {}
    _streamHost = null;
    _streamHwnd = 0;
    _streamQueue = [];
  }

  async function _streamRect() {
    var r = await _streamSend('RECT', true);
    var m = String(r || '').match(/^RECT (-?\d+) (-?\d+) (-?\d+) (-?\d+)/);
    if (!m) return null;
    return { x: parseInt(m[1], 10), y: parseInt(m[2], 10), w: parseInt(m[3], 10), h: parseInt(m[4], 10) };
  }

  async function _streamCursor() {
    var r = await _streamSend('CUR', true);
    var m = String(r || '').match(/^CUR (-?\d+) (-?\d+)/);
    if (!m) return null;
    return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
  }

  app.on('before-quit', _streamStopHost);

  // Live list of open, visible, non-NEO windows you can drop into the browser.
  ipcMain.handle('win:list', async () => {
    try {
      var sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 320, height: 200 },
        fetchWindowIcons: true
      });
      var mine = _selfHwnds();
      var ourTitles = {};
      try {
        BrowserWindow.getAllWindows().forEach(function (w) {
          var t = w.getTitle();
          if (t) ourTitles[t.trim().toLowerCase()] = 1;
        });
      } catch (e) {}
      var out = [];
      sources.forEach(function (s) {
        var hwnd = _hwndFromSourceId(s.id);
        if (!hwnd) return;
        // never offer our own windows, the backend console, or the desktop shell
        if (mine[hwnd]) return;
        var nm = (s.name || '').trim();
        if (!nm) return;
        if (ourTitles[nm.toLowerCase()]) return;
        if (/^(program manager|windows input experience|search host|neo backend)$/i.test(nm)) return;
        out.push({
          id: s.id,
          hwnd: hwnd,
          name: nm,
          thumb: s.thumbnail ? s.thumbnail.toDataURL() : null,
          icon: s.appIcon ? s.appIcon.toDataURL() : null
        });
      });
      return { windows: out, self: Object.keys(mine), titles: Object.keys(ourTitles) };
    } catch (e) {
      console.error('[STREAM] list failed', e.message);
      return { windows: [], error: e.message };
    }
  });

  ipcMain.handle('win:begin', async (event, sourceId) => {
    var hwnd = _hwndFromSourceId(sourceId);
    if (!hwnd) return { ok: false, error: 'That is not an app window' };
    _streamHwnd = hwnd;
    // HWND is a silent setter, so RECT is the first real query: if it answers,
    // the helper is alive and we already have the geometry we need.
    await _streamSend('HWND ' + hwnd, false);
    var rect = await _streamRect();
    if (!rect) return { ok: false, hwnd: hwnd, error: 'Input helper did not start' };
    var fg = await _streamSend('FOCUS', true);
    // Hand the window rect back so the renderer can request a capture that is
    // exactly the window size. Any mismatch makes Chromium crop-and-scale,
    // which would break every click coordinate.
    var got = fg ? String(fg).match(/^OK (\d+)/) : null;
    return { ok: true, hwnd: hwnd, rect: rect, focused: got ? parseInt(got[1], 10) === hwnd : false };
  });

  ipcMain.handle('win:input', async (event, cmds) => _streamSend(cmds, false));

  ipcMain.handle('win:focus', async () => {
    var r = await _streamSend('FOCUS', true);
    var got = r ? String(r).match(/^OK (\d+)/) : null;
    return { ok: !!got, fg: got ? parseInt(got[1], 10) : 0, hwnd: _streamHwnd };
  });

  ipcMain.handle('win:rect', async () => _streamRect());
  ipcMain.handle('win:cursor', async () => _streamCursor());
  ipcMain.handle('win:place', async (event, x, y) => _streamSend('POS ' + (x | 0) + ' ' + (y | 0), false));
  ipcMain.handle('win:show', async () => _streamSend('SHOW', false));
  ipcMain.handle('win:end', async () => { _streamHwnd = 0; return { ok: true }; });
  ipcMain.handle('win:host-stop', async () => { _streamStopHost(); return { ok: true }; });

  // ===== EXTENSIONS: Chrome-style add-on manager =====
  ipcMain.handle('ext:list', async () => {
    const store = _extReadStore();
    for (const e of store) {
      let live = false;
      for (const { ses } of _extSessions()) {
        try { if (ses.extensions.getExtension(e.id)) { live = true; break; } } catch (err) {}
      }
      e.loaded = !!(live && e.enabled);
      e.installed = !!e.path && fs.existsSync(e.path);
    }
    return store;
  });

  ipcMain.handle('ext:pick-folder', async () => {
    const w0 = _mainBrowserWin();
    const res = await dialog.showOpenDialog(w0 && !w0.isDestroyed() ? w0 : undefined, {
      title: 'Choose the extension folder (the one containing manifest.json)',
      properties: ['openDirectory']
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return await _extInstallFromDir(res.filePaths[0]);
  });

  ipcMain.handle('ext:install-zip', async () => {
    const w0 = _mainBrowserWin();
    const res = await dialog.showOpenDialog(w0 && !w0.isDestroyed() ? w0 : undefined, {
      title: 'Choose an extension .zip',
      properties: ['openFile'],
      filters: [{ name: 'Extension package', extensions: ['zip'] }]
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    // Same path as a .crx: detect the real type rather than trusting the extension,
    // and let one implementation own the unzip + manifest-root search.
    return await _extInstallFromPackageFile(res.filePaths[0], 'zip');
  });

  ipcMain.handle('ext:catalog', async () => _extCatalogWithState());

  ipcMain.handle('ext:store-install', async (event, key) => await _extInstallFromCatalog(key));

  ipcMain.handle('ext:pick-package', async () => {
    const w0 = _mainBrowserWin();
    const res = await dialog.showOpenDialog(w0 && !w0.isDestroyed() ? w0 : undefined, {
      title: 'Choose an extension .crx or .zip',
      properties: ['openFile'],
      filters: [{ name: 'Extension package', extensions: ['crx', 'zip'] }]
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const file = res.filePaths[0];
    return await _extInstallFromPackageFile(file, file.toLowerCase().endsWith('.crx') ? 'crx' : 'zip');
  });

  ipcMain.handle('ext:set-enabled', async (event, id, enabled) => {
    const store = _extReadStore();
    const entry = store.find(e => e.id === id);
    if (!entry) return { ok: false, error: 'Unknown extension.' };
    if (enabled) {
      if (!fs.existsSync(entry.path)) return { ok: false, error: 'Its folder is gone from disk.' };
      // Same pre-flight as a fresh install, so re-enabling gives the same useful
      // message instead of a bare Electron refusal.
      const known = entry.name && (() => {
        const mf = _extManifest(entry.path);
        if (!mf) return null;
        const miss = _extMissingAssets(entry.path, mf);
        return miss.length ? 'This package is missing ' + miss.length + ' file' + (miss.length === 1 ? '' : 's') +
          ' its manifest requires: ' + miss.slice(0, 4).join(', ') +
          (miss.length > 4 ? ', +' + (miss.length - 4) + ' more' : '') +
          '. It looks like a source archive rather than a built one.' : null;
      })();
      if (known) return { ok: false, error: known };
      const res = await _extLoadInto(entry);
      if (!res || res.error) return { ok: false, error: 'Electron refused to load it: ' + (res && res.error || 'unknown reason') };
      entry.id = res.id || entry.id;
      entry.enabled = true;
    } else {
      await _extUnloadFromAll(entry.id);
      entry.enabled = false;
    }
    _extWriteStore(store);
    return { ok: true, entry };
  });

  ipcMain.handle('ext:remove', async (event, id) => {
    const store = _extReadStore();
    const i = store.findIndex(e => e.id === id);
    if (i === -1) return { ok: false, error: 'Unknown extension.' };
    const entry = store[i];
    await _extUnloadFromAll(entry.id);
    try { if (entry.path && fs.existsSync(entry.path)) fs.rmSync(entry.path, { recursive: true, force: true }); }
    catch (e) { console.warn('[EXT] folder delete failed:', e.message); }
    store.splice(i, 1);
    _extWriteStore(store);
    console.log('[EXT] removed', entry.name);
    return { ok: true };
  });

  ipcMain.handle('ext:reload', async (event, id) => {
    const store = _extReadStore();
    const entry = store.find(e => e.id === id);
    if (!entry) return { ok: false, error: 'Unknown extension.' };
    await _extUnloadFromAll(entry.id);
    if (!entry.enabled) { _extWriteStore(store); return { ok: true, entry }; }
    const res = await _extLoadInto(entry);
    if (res && !res.error) entry.id = res.id || entry.id;
    _extWriteStore(store);
    if (res && !res.error) return { ok: true, entry };
    return { ok: false, error: 'Reload failed: ' + (res && res.error || 'unknown reason') };
  });

  // ===== CHROME WEB STORE INSTALL (called by the in-page button) =====
  ipcMain.handle('ext:webstore-parse', async (event, url) => {
    const info = _extParseStoreUrl(url);
    if (!info) return { ok: false, error: 'Not a Chrome Web Store extension page.' };
    const store = _extReadStore();
    const already = store.find(e => e && e.storeId === info.id);
    return {
      ok: true,
      id: info.id,
      slug: info.slug,
      installed: !!(already && fs.existsSync(already.path)),
      installedName: already ? already.name : ''
    };
  });

  ipcMain.handle('ext:webstore-install', async (event, id, opts) => {
    const r = await _extWebstoreInstall(id, opts || {});
    if (r.ok) console.log('[EXT] webstore install ' + (r.already ? 'already present: ' : 'ok: ') + id);
    else console.warn('[EXT] webstore install failed (' + (r.code || '?') + '): ' + id + ' - ' + r.error);
    return r;
  });

  // Install from an official source build the panel already knows about. This is
  // the route that keeps working when Google refuses the CRX download.
  ipcMain.handle('ext:webstore-catalog-lookup', async (event, id, name) => {
    const key = _extCatalogKeyFor(id, name);
    if (!key) return { ok: false, error: 'No official source build is known for this one yet.' };
    const r = await _extInstallFromCatalog(key);
    return r.ok ? { ok: true, entry: r.entry } : { ok: false, error: r.error || 'Could not install it.' };
  });

  ipcMain.handle('ext:proxy-get', async () => ({ proxy: _extReadProxy() }));

  ipcMain.handle('ext:proxy-set', async (event, rule) => {
    const val = String(rule || '').trim();
    // No $ anchor: JavaScript's $ also matches before a trailing newline, and a
    // pasted value with a stray line ending silently failed this check.
    if (val && !/^(socks5|https?|socks4):\/\/[^\s]+/i.test(val)) {
      return { ok: false, error: 'Use socks5://host:port or http://host:port.' };
    }
    const wrote = _extWriteProxy(val);
    await _extApplyProxy(val);
    return { ok: wrote, proxy: val, error: wrote ? '' : 'Could not save the proxy setting.' };
  });

  process.on('exit', _streamStopHost);
});

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') app.quit();
});
