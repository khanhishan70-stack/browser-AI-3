const { app, BrowserWindow, ipcMain, session, webContents, dialog, shell, Menu, protocol, net, desktopCapturer, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn, execFile, execSync } = require('child_process');
const os = require('os');
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
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});


// ===== DRM / STREAMING / GPU COMMAND LINE FLAGS =====
if (process.env.NEO_NO_GPU_FLAGS === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}
app.commandLine.appendSwitch('enable-features', 'VideoToolboxHEVCHWEncoding,MseDecoderAdapter,WebCodecs,Vp9kSVCHWDecoding,Vp9Decoder,Vp9Encoder,PlatformHEVCDecoderSupport,AV1Decoder,SharedArrayBuffer,WebGPU,WebRTCPeerConnection,WebRTC-H264WithOpenH264FFmpeg,CanvasOopRasterization,ThumbnailCapturer,ParallelDownloading,WebAssembly,WebAssemblyExceptionHandling,WebAssemblyTailCall,WebAssemblySimd,UserAgentClientHint');
app.commandLine.appendSwitch('disable-features', 'WebRTC-DisableEncryption');
app.commandLine.appendSwitch('enable-hardware-overlays', 'single-fullscreen');// GPU rasterization and rendering optimizations for media-heavy sites like Instagram.
// NOTE: enable-zero-copy / enable-native-gpu-memory-buffers / enable-begin-frame-scheduling
// were removed because they interfere with <webview> guest surface compositing and cause
// the intermittent black-webview bug after navigation on Windows.
if (process.env.NEO_NO_GPU_FLAGS !== '1') {
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
app.commandLine.appendSwitch('force-accelerated-mjpeg-decode');
// Disable power-saving optimizations that can reduce video decode resolution
app.commandLine.appendSwitch('disable-features', 'VideoDecodeDownscaleForPerformance,VideoFrameSubmitter');
// Ensure high-quality video rendering
app.commandLine.appendSwitch('force-color-profile', 'srgb');
// Enable WebGPU and shared memory for modern web apps
app.commandLine.appendSwitch('enable-unsafe-swiftshader'); // software WebGPU fallback
app.commandLine.appendSwitch('enable-blink-features', 'SharedArrayBuffer');
// Point to the CDM directory — removed: DRM streaming system disabled
// (streaming DRM system removed per user request)

// Disable automation flags so Google doesn't detect this as an automated browser
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-automation');
// Suppress dev-only security warnings (app uses known-required features)
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

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

function startBackend() {
  return new Promise((resolve) => {
    if (process.env.NEO_NO_BACKEND === '1') {
      console.log('[Backend] Skipped by NEO_NO_BACKEND');
      resolve();
      return;
    }
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

    console.log('[Backend] Starting:', pythonExe, appPy);
    backendProcess = spawn(pythonExe, [appPy], {
      cwd: BACKEND_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    backendProcess.stdout.on('data', (d) => { try { process.stdout.write('[Backend] ' + d); } catch(e) {} });
    backendProcess.stderr.on('data', (d) => { try { process.stderr.write('[Backend] ' + d); } catch(e) {} });
    backendProcess.on('error', (e) => console.warn('[Backend] Error:', e.message));
    backendProcess.on('exit', (code) => {
      console.log('[Backend] Exited with code', code);
      backendProcess = null;
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
  });
}

function stopBackend() {
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

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.169 Safari/537.36';

// ===== USER-AGENT MANAGER =====
var _uaOverrides = {};
var _streamingSites = ['netflix.com','disneyplus.com','primevideo.com','amazon.com/video','hulu.com','hbomax.com','max.com','hotstar.com','peacocktv.com','paramountplus.com','crunchyroll.com','spotify.com','appletv.apple.com','tv.apple.com','youtube.com','music.youtube.com','vimeo.com','plex.tv','discoveryplus.com','bbc.co.uk/iplayer'];
function getUAForURL(url) {
  try {
    var u = url.toLowerCase();
    // Check per-site override first
    for (var domain in _uaOverrides) {
      if (u.indexOf(domain) !== -1) return _uaOverrides[domain];
    }
    // Auto-switch Chrome UA for streaming sites
    for (var i = 0; i < _streamingSites.length; i++) {
      if (u.indexOf(_streamingSites[i]) !== -1) return USER_AGENT;
    }
  } catch(e) {}
  return USER_AGENT;
}
function setUAOverride(domain, ua) {
  if (ua) _uaOverrides[domain] = ua;
  else delete _uaOverrides[domain];
}

// Anti-detection flags
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
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
app.commandLine.appendSwitch('allow-file-access-from-files');
// removed: disable-background-networking (needed for Widevine component updater)

// Register neo:// protocol as privileged for file serving
protocol.registerSchemesAsPrivileged([
  { scheme: 'neo', privileges: { stream: true, supportFetchAPI: true, bypassCSP: true } }
]);

// Auto-accept SSL certificates for all origins (secure HTTPS login)
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  console.log('[CERT] Accepting cert for', url.split('?')[0], ':', error);
  event.preventDefault();
  callback(true);
});

app.whenReady().then(async () => {
  // Register neo:// protocol for serving downloaded files
  protocol.handle('neo', (request) => {
    var fileName = decodeURIComponent(request.url.replace(/^neo:\/\//, ''));
    var filePath = path.join(DOWNLOADS_DIR, path.basename(fileName));
    return net.fetch('file:///' + filePath.replace(/\\/g, '/'));
  });
  // Start backend in background — don't block window creation
  startBackend();

  // Chrome headers for all requests
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    details.requestHeaders['Accept-Language'] = 'en-US,en;q=0.9';
    details.requestHeaders['Accept-Encoding'] = 'gzip, deflate, br';
    // Add Chrome-specific headers for Google domains (critical for "this browser is not secure")
    if (/\.google\./.test(details.url) || /accounts\./.test(details.url)) {
      details.requestHeaders['sec-ch-ua'] = '"Google Chrome";v="138", "Not?A_Brand";v="99"';
      details.requestHeaders['sec-ch-ua-mobile'] = '?0';
      details.requestHeaders['sec-ch-ua-platform'] = '"Windows"';
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  session.defaultSession.setUserAgent(USER_AGENT);
  // Enable Service Workers on default session
  try { session.defaultSession.setEnableServiceWorkers(true); } catch(e) {}
  // Set storage quota to unlimited for modern web apps
  try { session.defaultSession.setPermissionRequestHandler(null); } catch(e) {}
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['https://*.youtube.com/*', 'https://*.ytimg.com/*', 'https://*.googlevideo.com/*', 'https://*.ggpht.com/*', 'https://*.google.com/*', 'https://*.googleapis.com/*', 'https://*.gstatic.com/*', 'https://accounts.google.com/*', 'https://*.facebook.com/*', 'https://*.fbcdn.net/*', 'https://*.instagram.com/*', 'https://*.nvidia.com/*', 'https://*.discord.com/*', 'https://*.netflix.com/*', 'https://*.nflxvideo.net/*'] }, stripFrameOpts);
  // Also apply to the webview's persistent session for Google login
  var wvSession = session.fromPartition('persist:webview');
  wvSession.setUserAgent(USER_AGENT);
  // Enable Service Workers and storage on webview session
  try { wvSession.setEnableServiceWorkers(true); } catch(e) {}
  // Allow all cookies including cross-site (needed for OAuth)
  try {
    wvSession.cookies.set({ url: 'https://accounts.google.com', name: '_dummy', value: '1', secure: true, sameSite: 'no_restriction' }).catch(function(){}).then(function() {
      wvSession.cookies.remove('https://accounts.google.com', '_dummy').catch(function(){});
    });
  } catch(e) {}
  wvSession.webRequest.onHeadersReceived({ urls: ['https://*.google.com/*', 'https://*.googleapis.com/*', 'https://*.gstatic.com/*', 'https://accounts.google.com/*', 'https://*.youtube.com/*', 'https://*.ytimg.com/*', 'https://*.facebook.com/*', 'https://*.fbcdn.net/*', 'https://*.instagram.com/*', 'https://*.nvidia.com/*', 'https://*.discord.com/*', 'https://*.netflix.com/*', 'https://*.nflxvideo.net/*'] }, stripFrameOpts);
  wvSession.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, function(details, callback) {
    details.requestHeaders['Accept-Language'] = 'en-US,en;q=0.9';
    details.requestHeaders['Accept-Encoding'] = 'gzip, deflate, br';
    if (/\.google\./.test(details.url) || /accounts\./.test(details.url)) {
      details.requestHeaders['sec-ch-ua'] = '"Google Chrome";v="138", "Not?A_Brand";v="99"';
      details.requestHeaders['sec-ch-ua-mobile'] = '?0';
      details.requestHeaders['sec-ch-ua-platform'] = '"Windows"';
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  function stripFrameOpts(details, callback) {
    if (details.responseHeaders) {
      delete details.responseHeaders['x-frame-options'];
      delete details.responseHeaders['X-Frame-Options'];
      delete details.responseHeaders['content-security-policy'];
      delete details.responseHeaders['Content-Security-Policy'];
      delete details.responseHeaders['content-security-policy-report-only'];
      delete details.responseHeaders['Content-Security-Policy-Report-Only'];
      // Ensure SameSite=None + Secure for cross-site cookies (needed for Google OAuth in embedded webview)
      var setCookie = details.responseHeaders['set-cookie'];
      if (setCookie) {
        var modified = [];
        for (var sci = 0; sci < setCookie.length; sci++) {
          var c = setCookie[sci];
          // Only add SameSite=None if it's a cross-site cookie scenario
          if (c.indexOf('SameSite=None') === -1 && c.indexOf('SameSite=Lax') === -1 && c.indexOf('SameSite=Strict') === -1) {
            // Add SameSite=None + Secure to cookies that don't specify SameSite
            if (c.indexOf('SameSite') === -1) {
              if (c.indexOf('Secure') === -1) {
                c += '; Secure';
              }
              c += '; SameSite=None';
            }
          }
          modified.push(c);
        }
        details.responseHeaders['set-cookie'] = modified;
      }
    }
    callback({ responseHeaders: details.responseHeaders });
  }

  // ===== AD + TRACKER BLOCKER =====
  let _adBlockEnabled = true;
  let _saveAcknowledged = false;
  const AD_BLOCK_DOMAINS = new Set([
    // --- Google / YouTube Ads ---
    'doubleclick.net','googlesyndication.com','googleadservices.com','googleads.g.doubleclick.net','pagead2.googlesyndication.com',
    'pagead.l.doubleclick.net','adservice.google.com','googleads4.g.doubleclick.net','pubads.g.doubleclick.net',
    'securepubads.g.doubleclick.net','tpc.googlesyndication.com','cm.g.doubleclick.net','ad.doubleclick.net',
    'adclick.g.doubleclick.net','partnerad.l.doubleclick.net','google-analytics.com','googletagmanager.com',
    'googletagservices.com','googlecommerce.com','googleadsserving.cn','adwords.google.com','googleadservices.com',
    'youtube.com/api/stats/ads','ads.youtube.com','youtube.com/pagead','youtubeadvertising.com',
    // --- Social trackers ---
    'facebook.com/tr','connect.facebook.net','facebook.net','fbcdn.net','fbsbx.com','pixel.facebook.com',
    'an.facebook.com','www.facebook.com/tr/','analytics.twitter.com','ads-twitter.com','t.co',
    'pinterest.com/analytics','analytics.pinterest.com','ads.pinterest.com',
    'linkedin.com/analytics','ads.linkedin.com','px.ads.linkedin.com',
    'snapchat.com/ads','tr.snapchat.com','sc-static.net',
    'tiktok.com/analytics','ads.tiktok.com','analytics.tiktok.com',
    // --- Major ad networks ---
    'adnxs.com','adsrvr.org','casalemedia.com','demdex.net','exelator.com','moatads.com','pubmatic.com',
    'rubiconproject.com','openx.net','criteo.com','criteo.net','taboola.com','outbrain.com',
    'revcontent.com','mgid.com','sharethrough.com','adform.com','sovrn.com','indexww.com',
    'appnexus.com','adzerk.net','amazon-adsystem.com','aax.amazon-adsystem.com','advertising.amazon.com',
    'adsafeprotected.com','bluekai.com','crwdcntrl.net','media.net','contextweb.com','rhythmone.com',
    'turn.com','krux.com','tidaltv.com','spotxchange.com','springserve.com','improving.digital',
    'advertising.com','atdmt.com','atwola.com','bidswitch.net','ads.linkedin.com','adcolony.com',
    'adap.tv','adsrv.io','adtech.de','adzerk.com','bdia.com','bidsxchange.com','brightcove.com/ads',
    'cdn.adsrvr.org','comcluster.cxense.com','connextra.com','dp-dhl.com','emxdgt.com','eyeota.net',
    'gammaplatform.com','gumgum.com','hbbtv.org','innovid.com','integralds.com','ipromote.com',
    'kaltura.com','kixer.com','ligatus.com','liverail.com','loopme.com','mediashakers.com',
    'mookie1.com','nanointeractive.com','netseer.com','onescreen.com','opinary.com','optimatic.com',
    'picreel.com','pro-market.net','proboards.com','pulsepoint.com','quantcount.com','quantserve.com',
    'radiantmediaplayer.com','richrelevance.com','rocketfuel.com','rtbidder.com','sekindo.com',
    'simpli.fi','smaato.net','smilewanted.com','sonobi.com','specificmedia.com','stickyadstv.com',
    'swan-swan-goose.com','syndication.com','telaria.com','thetrade.com','thirtyseven.com',
    'trackingsoft.com','tremorhub.com','triplelift.com','trustx.org','undertone.com','unicorn.com',
    'videoamp.com','vidible.tv','vidyard.com','visiblemeasures.com','vizu.com','west-bridge.com',
    'widespace.com','xaxis.com','yadro.com','yume.com','zanox.com','zedo.com',
    // --- Analytics / Tracking ---
    'hotjar.com','mouseflow.com','fullstory.com','crazyegg.com','luckyorange.com','clicktale.com',
    'inspectlet.com','sessioncam.com','smartlook.com','heap.io','amplitude.com','mixpanel.com',
    'segment.com','segment.io','segmentpages.com','kochava.com','adjust.com','appsflyer.com',
    'branch.io','urbanairship.com','onesignal.com','pushwoosh.com','batch.com','intercom.io',
    'intercomcdn.com','driftt.com','olark.com','livechatinc.com','tawk.to','zendesk.com',
    'freshdesk.com','hubspot.com','marketo.com','pardot.com','eloqua.com','acton.com',
    'leadfeeder.com','clearbit.com','bizible.com','engagio.com','6sense.com','demandbase.com',
    'optimizely.com','vwo.com','abtasty.com','convert.com','googleoptimize.com','unbounce.com',
    'instapage.com','clickfunnels.com','leadpages.com','sumo.com','hello-bar.com','privacy-center.com',
    'cookiebot.com','cookiepro.com','onetrust.com','trustarc.com','cmp.quantcast.com','iubenda.com',
    'ensighten.com','tealium.com','tagcommander.com','brighttag.com','lytics.com','mParticle.com',
    // --- Crypto miners ---
    'coinhive.com','coin-hive.com','crypto-loot.com','minero.cc','coinimp.com','webmine.cz',
    'reasedoper.pw','javapipe.com','minemytraffic.com','coin-have.com','crypto-js.com',
    'coinnebula.com','kizocoin.com','coinerra.com','moneyminer.com','coinblind.com',
    'coinlab.org','cryptonight.js','cryptonight.min.js','minr.pw','minexmr.com',
    'coiner.site','coinminer.site','jsecoin.com','miner.js','mining.biz','monerominer.com',
    'crypto-webminer.com','lollipap.com','webminerpool.com','afminer.com','mineralt.io',
    'cryptoloot.pro','ad-miner.com','cryptotab.farm','coinhive.xyz','coinhive.org',
    'coin-hive.xyz','coin-hive.org','crypto-loot.org','crypto-loot.xyz',
    // --- Popups / Malvertising ---
    'popads.net','pops.us','popcash.net','popunder.net','popadscdn.net','clickunder.com',
    'propellerads.com','trafficfactory.com','trafficjunky.com','trafficfuel.com','pushnative.com',
    'adsterra.com','adbucks.com','ad-maven.com','adf.ly','adf.ly','bc.vc','ouo.io',
    'sh.st','shorte.st','shortest.link','tinyurl.com/ad','advertise.com','bannerdo.com',
    'cpmstone.com','clicksor.com','clipclaps.com','com-email.com','conversion-pixel.com',
    'cpaxentric.com','cpays.com','cpmstar.com','cpm20.com','credits.plus','crispmedia.com',
    'dinkleblank.com','discountclick.com','dubli.com','earnify.com','eThor.com','exitjunction.com',
    'eyewonder.com','f5w.asia','fineclicks.com','first-call.com','fluxcdn.com','fpc2.com',
    'freedownloadmanager.org','fresheye.com','games2win.com','globalismedia.com','go-earn.com',
    'go-clicks.com','grabiola.com','greentoadmedia.com','gsmarena.com','hermetic.com',
    'hosting25.com','ilovelongichor.com','imgfarm.com','infolink.com','intentmedia.com',
    'interclick.com','itsmyurls.com','iwillwork.com','juicyads.com','justin.tv','kadam.net',
    'kontera.com','leadclick.com','link4ads.com','linkcandy.com','lnk.site','logicity.com',
    'm4n.net','madvertising.com','madvertise.com','matomy.com','mb01.com','mdotm.com',
    'media-factory.org','media-servers.net','mediabong.com','medianet.com','brainpixels.com',
    'mellowads.com','microadinc.com','mnetm.net','myadmarket.com','mydas.mobi','mysearchdial.com',
    'mysqldump.net','nativeads.com','neudesic.com','nuffnang.com','omnicom.com','online-casino.local',
    'onlinetvrecorder.com','optimum.com','oxado.com','paddypower.com','partage.com','parsely.com',
    'paypopup.com','perfection.com','pixelx.com','polymorphads.com','pop-online.com','popup.tips',
    'popupmaker.com','popuptraffic.com','premium.com','procoliseum.com','pubdirecte.com',
    'pushcrew.com','quantumads.com','richmedia.com','rtbhouse.com','runremailer.com','sendpulse.com',
    'servedbyopenx.com','servedbyadbutler.com','shareaholic.com','sixapart.com','skimresources.com',
    'skimlinks.com','smowtion.com','socialtwist.com','sociomantic.com','specificpop.com',
    'sponsorads.com','spot.im','ssl-images-ads.com','static.ads','swoop.com','syndic.com',
    'talkads.com','tecno.com','textad.net','textlinks.com','trafficrevenue.com','trafficz.com',
    'tribalfusion.com','trion.com','truEffect.com','tv-spot.com','verticurl.com','vibrantmedia.com',
    'videoegg.com','viewable.com','viralmedia.com','voltier.com','vrtb.com','wdads.com',
    'weborama.com','winamp.com','witchcraftstudios.com','wp-ads.net','xad.com','xl-click.com',
    'xxxrevcon.com','yoc.com','zapadserver.com','zevents.com','advertserve.com','bluestreak.com',
    'burstnet.com','dianomi.com','epom.com','fuseplatform.com','glammedia.com','indieclick.com',
    'massimpact.com','shopzilla.com','specificclick.net','tornadoads.com','uplift.com','vcommission.com',
    // --- Known ERR_ABORTED domains ---
    'elevenlabs.io',
  ]);

  // YouTube-specific ad URL patterns (matches hostname + path)
  // Note: googlevideo.com is deliberately NOT blocked - it's the CDN for ALL YouTube content
  // Only block YouTube's ad-specific API endpoints (path-based, not hostname)
  AD_BLOCK_DOMAINS.add('googleadservices.com');

  const YT_AD_PATTERNS = [
    'youtube.com/api/stats/ads',
    'youtube.com/pagead/',
    'youtube.com/youtubei/v1/ads',
    'youtube.com/youtubei/v1/ad_break',
    'youtube.com/get_midroll_info',
    'youtube.com/ptracking',
    'youtube.com/pagead/',
    'youtube.com/ads/',
    'youtube.com/adunit',
    'youtube.com/instream_ad_status',
    'youtube.com/api/stats/qoe',
    'youtube.com/api/stats/playback',
    'youtube.com/youtubei/v1/player/ads',
    'youtube.com/youtubei/v1/next',
  ];

  // Build full URLs from domains (append path patterns for YouTube)
  function buildBlockPatterns() {
    const patterns = [];
    AD_BLOCK_DOMAINS.forEach(d => {
      if (d.startsWith('youtube.com/') || d.startsWith('www.facebook.com/')) {
        patterns.push('*://' + d + '*');
      } else {
        patterns.push('*://*.' + d + '/*');
        patterns.push('*://' + d + '/*');
      }
    });
    // Also block common ad script paths directly
    patterns.push('*://*/pagead/js/adsbygoogle.js*');
    patterns.push('*://*/wp-content/plugins/*/js/*.js*');
    patterns.push('*://*/banner/*');
    patterns.push('*://*/ads/*');
    patterns.push('*://*/adserver/*');
    // YouTube-specific ad URL patterns
    YT_AD_PATTERNS.forEach(p => patterns.push('*://' + p + '*'));
    return patterns;
  }
  const AD_BLOCK_PATTERNS = buildBlockPatterns();

  // Register the ad-blocking webRequest handler on both default AND webview sessions
  let _adBlockHandler = null;

  function enableAdBlocking() {
    if (_adBlockHandler) return;
    // Fast path: split domains into an O(1) hostname Set vs a tiny path-pattern list.
    // (Hostname lookups replace scanning ~440 strings per request, which added real
    // latency on every HTTP request.)
    var AD_BLOCK_HOSTS = new Set();
    var AD_BLOCK_PATHS = [];
    AD_BLOCK_DOMAINS.forEach(function(d) {
      if (d.indexOf('/') !== -1) AD_BLOCK_PATHS.push(d);
      else AD_BLOCK_HOSTS.add(d);
    });
    function _hostOf(url) {
      var s = url.indexOf('://');
      var start = s === -1 ? 0 : s + 3;
      var end = url.indexOf('/', start);
      return end === -1 ? url.slice(start) : url.slice(start, end);
    }
    _adBlockHandler = (details, callback) => {
      const url = details.url.toLowerCase();
      // Suppress Chromium internal favicon requests that would 404 in the console.
      // Redirect to a transparent 1x1 pixel so no error fires and favicons just stay blank.
      if (url.indexOf('faviconv2') !== -1) {
        callback({ redirectURL: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' });
        return;
      }
      if (!_adBlockEnabled) { callback({}); return; }
      // O(1) hostname match (exact + subdomains + www)
      var host = _hostOf(url);
      if (host.indexOf('www.') === 0) host = host.slice(4);
      var probe = host;
      while (probe.indexOf('.') !== -1) {
        if (AD_BLOCK_HOSTS.has(probe)) { callback({ cancel: true }); return; }
        probe = probe.slice(probe.indexOf('.') + 1);
      }
      // Rare path-based patterns (YouTube ad API endpoints etc.)
      for (var i = 0; i < AD_BLOCK_PATHS.length; i++) {
        if (url.indexOf(AD_BLOCK_PATHS[i]) !== -1) { callback({ cancel: true }); return; }
      }
      callback({});
    };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, _adBlockHandler);
    // Also block on the webview session (persist:webview) — this is what YouTube actually uses
    try {
      var wvSess = session.fromPartition('persist:webview');
      wvSess.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, _adBlockHandler);
    } catch(e) { console.warn('[AdBlock] Could not register on webview session:', e.message); }
  }
  enableAdBlocking();

  // IPC to toggle from renderer
  ipcMain.on('set-ad-blocking', (event, enabled) => {
    _adBlockEnabled = enabled;
    console.log('[AdBlock] ' + (enabled ? 'Enabled' : 'Disabled'));
  });

  // Grant all permissions by default for ALL sessions (default + webview)
  var _permHandler = function(wc, p, cb) {
    console.log('[PERM] Request:', p, 'granted');
    cb(true);
  };
  var _permCheckHandler = function(wc, p, o) {
    return true;
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
  var _ytDownloads = {};
  var _ytDlpPath = path.join(__dirname, 'bin', 'yt-dlp.exe');
  var _ytFfmpegPath = '';
  var ffCandidates = [
    'C:\\Users\\Admin\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe'
  ];
  for (var fi = 0; fi < ffCandidates.length; fi++) {
    if (fs.existsSync(ffCandidates[fi])) { _ytFfmpegPath = ffCandidates[fi]; break; }
  }

  var _YT_FORMATS = {
    360: 'best[height<=360]',
    720: 'best[height<=720]',
    1080: 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]',
    2160: 'bestvideo[height<=2160][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=2160]+bestaudio/best[height<=2160]'
  };

  ipcMain.handle('yt-download-start', async (event, url, quality, meta) => {
    var id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    var idSuffix = id.slice(-4);
    var filename = 'YouTube_Video_' + idSuffix + '.mp4';
    var savePath = path.join(DOWNLOADS_DIR, filename);
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

    var args = [
      '--no-warnings',
      '--no-check-certificates',
      '--no-mtime',
      '--no-playlist',
      '--retries', '20',
      '--fragment-retries', '20',
      '--socket-timeout', '120',
      '--geo-bypass',
      '--age-limit', '99',
      '--no-check-formats',
      '--format-sort', 'res,codec:avc1:h264:vp9.2:vp9:av01,vbr,size,br,asr',
      '--extractor-args', 'youtube:player_client=android,web;skip=webpage',
      '--user-agent', USER_AGENT,
      '-f', fmt,
      '-o', savePath,
      '--newline',
      url
    ];
    // Try to use browser cookies for authenticated downloads
    try {
      var cookiePaths = [
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'Default', 'Cookies'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'Profile 1', 'Cookies'),
        path.join(process.env.APPDATA || '', 'Opera Software', 'Opera Stable', 'Cookies'),
      ];
      for (var ci = 0; ci < cookiePaths.length; ci++) {
        if (fs.existsSync(cookiePaths[ci])) {
          args.unshift('--cookies-from-browser', 'chrome');
          break;
        }
      }
    } catch(e) {}
    if (_ytFfmpegPath) {
      args.unshift('--ffmpeg-location', path.dirname(_ytFfmpegPath));
    }

    console.log('[YTDL] Spawning:', _ytDlpPath, args.join(' '));

    var proc;
    try {
      proc = spawn(_ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
          var df = fs.readdirSync(DOWNLOADS_DIR);
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
                var dirFiles = fs.readdirSync(DOWNLOADS_DIR);
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
          sp({ filename: finalName, percent: 100, state: 'completed', path: path.join(DOWNLOADS_DIR, finalName) });
          resolve({ success: true, filename: finalName, path: path.join(DOWNLOADS_DIR, finalName) });
        } else {
          try { fs.unlinkSync(savePath); } catch(e) {}
          var errMsg = _ytStderr.replace(/\n/g, ' | ').replace(/\r/g, '').slice(0, 1000);
          console.log('[YTDL] FAILED. STDERR:', _ytStderr);
          // Retry with simpler format
          sp({ filename: filename, percent: 0, state: 'downloading', error_hint: 'Retrying...' });
          var fbArgs = [
            '--no-warnings', '--no-check-certificates', '--no-mtime', '--no-playlist',
            '--retries', '10', '--fragment-retries', '10', '--socket-timeout', '120',
            '--geo-bypass', '--age-limit', '99', '--no-check-formats',
            '--extractor-args', 'youtube:player_client=android,web;skip=webpage',
            '--user-agent', USER_AGENT,
            '-f', '18/best[height<=360]',
            '-o', savePath, '--newline', url
          ];
          // Try browser cookies for fallback too
          try {
            if (fs.existsSync(path.join(process.env.LOCALAPPDATA||'', 'Google', 'Chrome', 'User Data', 'Default', 'Cookies')))
              fbArgs.unshift('--cookies-from-browser', 'chrome');
          } catch(e) {}
          if (_ytFfmpegPath) fbArgs.unshift('--ffmpeg-location', path.dirname(_ytFfmpegPath));
          var fbProc = spawn(_ytDlpPath, fbArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
          var fbStderr = '';
          fbProc.stderr.on('data', function(d) { fbStderr += d.toString(); });
          fbProc.on('close', function(fbCode) {
            var fbSaved = _checkMediaFile();
            if (fbSaved) {
              console.log('[YTDL] Fallback OK:', fbSaved);
              sp({ filename: fbSaved, percent: 100, state: 'completed', path: path.join(DOWNLOADS_DIR, fbSaved) });
              resolve({ success: true, filename: fbSaved, path: path.join(DOWNLOADS_DIR, fbSaved) });
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
  var _lastCpuSample = null;
  function _sampleCpuPct() {
    try {
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
          return Math.max(0, Math.min(100, Math.round(100 * (1 - dIdle / dTotal))));
        }
      } else {
        _lastCpuSample = now;
      }
      return 0;
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

  // Pixel-check the host window region that contains the <webview>, to detect the
  // black-webview compositing bug (host stops compositing the guest surface).
  ipcMain.handle('neo-check-webview-paint', async (event, rect) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return { black: false, error: 'no-window' };
      const img = await win.webContents.capturePage();
      const imgSize = img.getSize();
      const content = win.getContentSize(); // CSS px
      if (!content || !content[0] || !content[1]) return { black: false, error: 'bad-content-size' };
      const sx = imgSize.width / content[0];
      const sy = imgSize.height / content[1];
      const x = Math.max(0, Math.floor((rect.x || 0) * sx));
      const y = Math.max(0, Math.floor((rect.y || 0) * sy));
      const w = Math.min(imgSize.width - x, Math.floor((rect.width || 0) * sx));
      const h = Math.min(imgSize.height - y, Math.floor((rect.height || 0) * sy));
      if (w < 80 || h < 60) return { black: false, error: 'rect-too-small' };
      const crop = img.crop({ x, y, width: w, height: h });
      const buf = crop.toBitmap();
      const cw = crop.getSize().width;
      const ch = crop.getSize().height;
      const stride = Math.floor(buf.length / ch);
      let total = 0, samples = 0, nonBlack = 0;
      for (let yy = 0; yy < ch; yy += 5) {
        for (let xx = 0; xx < cw; xx += 5) {
          const o = yy * stride + xx * 4;
          if (o + 3 >= buf.length) continue;
          // toBitmap is BGRA: B=buf[o], G=buf[o+1], R=buf[o+2]
          const lum = 0.2126 * buf[o + 2] + 0.7152 * buf[o + 1] + 0.0722 * buf[o];
          total += lum; samples++;
          if (lum > 14) nonBlack++;
        }
      }
      if (!samples) return { black: false, error: 'no-samples' };
      const avg = total / samples;
      const nb = (100 * nonBlack) / samples;
      // Broken case measures avg ~4-8 with 3-24% non-black. Painted pages are avg 30+ with 90%+ non-black.
      const black = nb < 25;
      return { black, avg: Math.round(avg * 10) / 10, nb: Math.round(nb * 10) / 10 };
    } catch (e) {
      return { black: false, error: String((e && e.message) || e) };
    }
  });

  let downloadIdCounter = 0;
  const _pendingDownloads = {};

  // Download tracking — saved to managed downloads folder.
  // Registered ONCE (previously inside web-contents-created, so every webview
  // added permanent duplicate session/ipcMain listeners that fired N times per
  // download and pinned every webContents in memory).
  const DANGEROUS_EXTS = ['.exe','.msi','.bat','.cmd','.ps1','.vbs','.js','.jar','.scr','.com','.pif','.reg','.sh','.app','.dmg','.zip','.rar','.7z'];
  const MUSIC_SITES = ['music.youtube.com', 'spotify.com', 'soundcloud.com', 'bandcamp.com', 'open.spotify.com'];
  function _registerDownloadSession(sess) {
    if (!sess || sess._neoDownloadHooked) return;
    sess._neoDownloadHooked = true;
    sess.on('will-download', (event, item) => {
      const id = ++downloadIdCounter;
      var filename = item.getFilename();
      const totalBytes = item.getTotalBytes();
      if (!event.sender || event.sender.isDestroyed()) return;
      // Don't intercept downloads from music sites — let them use default behavior
      try {
        var senderUrl = event.sender.getURL();
        for (var msIdx = 0; msIdx < MUSIC_SITES.length; msIdx++) {
          if (senderUrl.indexOf(MUSIC_SITES[msIdx]) !== -1) return;
        }
      } catch(e) {}
      const senderWin = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getAllWindows()[0];
      if (!senderWin) return;
      const ext = (path.extname(filename) || '').toLowerCase();
      const isDangerous = DANGEROUS_EXTS.indexOf(ext) !== -1;
      // Ensure unique filename
      var savePath = path.join(DOWNLOADS_DIR, filename);
      var counter = 1;
      while (fs.existsSync(savePath)) {
        var base = path.basename(filename, ext);
        savePath = path.join(DOWNLOADS_DIR, base + '_' + counter + ext);
        counter++;
      }
      if (isDangerous) {
        _pendingDownloads[id] = item;
        senderWin.webContents.send('download-warning', { id, filename, ext, totalBytes });
        return;
      }
      senderWin.webContents.send('download-start', { id, filename: path.basename(savePath), totalBytes });
      item.on('updated', (event, state) => {
        if (state === 'progressing') {
          senderWin.webContents.send('download-progress', { id, received: item.getReceivedBytes(), total: item.getTotalBytes() });
        }
      });
      item.on('done', (event, state) => {
        senderWin.webContents.send('download-done', { id, filename: path.basename(savePath), state, path: savePath });
        delete _pendingDownloads[id];
      });
      item.setSavePath(savePath);
      item.save();
    });
  }
  ipcMain.on('download-response', (event, { id, allow }) => {
    const item = _pendingDownloads[id];
    if (!item) return;
    if (!allow) {
      item.cancel();
      delete _pendingDownloads[id];
      return;
    }
    const senderWin = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getAllWindows()[0];
    if (!senderWin) return;
    var filename = item.getFilename();
    const ext = (path.extname(filename) || '').toLowerCase();
    var savePath = path.join(DOWNLOADS_DIR, filename);
    var counter = 1;
    while (fs.existsSync(savePath)) {
      var base2 = path.basename(filename, ext);
      savePath = path.join(DOWNLOADS_DIR, base2 + '_' + counter + ext);
      counter++;
    }
    senderWin.webContents.send('download-start', { id, filename: path.basename(savePath), totalBytes: item.getTotalBytes() });
    item.on('updated', (event, state) => {
      if (state === 'progressing') {
        senderWin.webContents.send('download-progress', { id, received: item.getReceivedBytes(), total: item.getTotalBytes() });
      }
    });
    item.on('done', (event, state) => {
      senderWin.webContents.send('download-done', { id, filename: path.basename(savePath), state, path: savePath });
      delete _pendingDownloads[id];
    });
    item.setSavePath(savePath);
    item.save();
    delete _pendingDownloads[id];
  });
  // Hook the sessions webviews and the main window actually download through.
  // Registered once (guarded), so N webviews never add N duplicate listeners.
  _registerDownloadSession(session.defaultSession);
  try { _registerDownloadSession(session.fromPartition('persist:webview')); } catch(e) {}

  app.on('web-contents-created', (event, contents) => {
    const type = contents.getType();
    contents.setUserAgent(USER_AGENT);

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

    // Inject anti-detection into ALL web contents (webview, window, etc.)
    // Use did-navigate AND did-finish-load for maximum timing coverage
    contents.on('did-navigate', (e, url) => {
      console.log('[AUTH] did-navigate:', (url||'').split('?')[0]);
      if (process.env.NEO_NO_INJECTIONS !== '1') {
        injectAntiDetect(contents);
        injectLeetAssistant(contents);
      }
    });
    contents.on('did-finish-load', () => {
      // Re-inject on finish-load to catch any timing gaps
      if (process.env.NEO_NO_INJECTIONS !== '1') {
        injectAntiDetect(contents);
        injectLeetAssistant(contents);
      }
    });
    contents.on('did-navigate-in-page', (e, url, isMainFrame) => {
      if (isMainFrame && process.env.NEO_NO_INJECTIONS !== '1') {
        injectAntiDetect(contents);
        injectLeetAssistant(contents);
      }
    });

    var _antiDetectInjected = {};
    function injectAntiDetect(wc) {
      if (process.env.NEO_NO_ANTIDETECT === '1') return;
      // Webview guests already get anti-detect from beat-preload.js, which runs
      // before page scripts. Runtime executeJavaScript here runs DURING page load
      // and breaks the guest's first frame on heavy sites (Google/Bing) -> the host
      // compositor spins and the whole window deadlocks. Skip webviews entirely.
      if (wc.getType && wc.getType() === 'webview') return;
      try { var url = wc.getURL(); } catch(e) { return; }
      var wcId = wc.id || wc._internalId || Math.random();
      if (_antiDetectInjected[wcId]) return;
      _antiDetectInjected[wcId] = true;
      console.log('[ANTIDETECT] Injecting into', (url||'').slice(0,80));
      wc.executeJavaScript(`
          try {
            // 1. Remove navigator.webdriver completely (not just set to false)
            try { delete navigator.__proto__.webdriver; } catch(e) {}
            try { delete navigator.webdriver; } catch(e) {}

            // 2. Set proper languages
            Object.defineProperty(navigator,'languages',{get:()=>['en-US','en'],configurable:true});

            // 3. Fake Chrome plugins (Google login checks this)
            var _fp = [
              {name:'Chrome PDF Plugin',filename:'internal-pdf-viewer',description:'Portable Document Format',length:1},
              {name:'Chrome PDF Viewer',filename:'mhjfbmdgcfjbbpaeojofohoefgiehjai',description:'',length:1},
              {name:'Native Client',filename:'internal-nacl-plugin',description:'',length:0}
            ];
            if(!navigator.plugins || navigator.plugins.length === 0) {
              Object.defineProperty(navigator,'plugins',{get:function(){return _fp;},configurable:true});
            }
            // Also add fake mimeTypes
            if(!navigator.mimeTypes || navigator.mimeTypes.length === 0) {
              Object.defineProperty(navigator,'mimeTypes',{get:function(){return[{type:'application/pdf',suffixes:'pdf'},{type:'text/pdf',suffixes:'pdf'}]},configurable:true});
            }

            // 4. Fake chrome.runtime (needed for extension detection)
            if(window.chrome&&!window.chrome.runtime)window.chrome.runtime={connect:()=>({}),sendMessage:()=>Promise.resolve()};
            if(!window.chrome.loadTimes)window.chrome.loadTimes=function(){return{}};
            if(!window.chrome.csi)window.chrome.csi=function(){return{}};
            window.chrome.app = window.chrome.app || {};
            if(!window.chrome.webstore)window.chrome.webstore={install:function(){}};
            // Add some Chrome runtime properties
            Object.defineProperty(window.chrome,'runtime',{value:window.chrome.runtime||{},writable:true,configurable:true});
            if(window.chrome.runtime&&!window.chrome.runtime.id)window.chrome.runtime.id='ghbmnnjooekpmoecnnnilnnbdlolhkhi';
            if(window.chrome.runtime&&!window.chrome.runtime.getManifest)window.chrome.runtime.getManifest=function(){return{version:'1.0'}};

            // 5. Device specs matching real Chrome
            if(!navigator.deviceMemory)navigator.deviceMemory=8;
            Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>8,configurable:true});

            // 6. Hide Electron process info
            if(window.process && window.process.versions) {
              Object.defineProperty(window.process.versions,'electron',{get:()=>undefined,configurable:true});
            }
            if(window.process && window.process.type) {
              Object.defineProperty(window.process,'type',{get:()=>'browser',configurable:true});
            }

            // 7. Add userAgentData to match Chrome UA
            if(!navigator.userAgentData) {
              Object.defineProperty(navigator,'userAgentData',{get:()=>{
                return {
                  brands:[
                    {brand:'Chromium',version:'142'},
                    {brand:'Google Chrome',version:'142'},
                    {brand:'Not=A?Brand',version:'99'}
                  ],
                  mobile:false,
                  platform:'Windows',
                  getHighEntropyValues:function(keys){return Promise.resolve({architecture:'x64',bitness:'64',model:'',platform:'Windows',platformVersion:'10.0',uaFullVersion:'142.0.0.0'});}
                };
              },configurable:true});
            }

            // 8. Add missing API stubs that Google checks
            if(!window.getComputedStyle)window.getComputedStyle=function(el){return el.style||{}};
            if(!navigator.mediaCapabilities)navigator.mediaCapabilities={decodingInfo:function(){return Promise.resolve({supported:true,powefficient:true,smoth:true})}};
            if(!navigator.pdfViewerEnabled)navigator.pdfViewerEnabled=true;
            if(!navigator.serial)navigator.serial={};
            if(!navigator.usb)navigator.usb={};
            if(!navigator.bluetooth)navigator.bluetooth={};
          }catch(e){}
        `).catch(function(err) {
          console.warn('[ANTIDETECT] Injection failed:', err.message);
        });
      }

      // DOM-level ad blocking is handled by renderer-side injection (ai-browser.html)
      // Network-level blocking via webRequest handles URL filtering above

      if (type === 'webview') {
      // Log all navigations for auth debugging
      contents.on('will-navigate', (e, url) => {
        if (/accounts\.google\.com|login\.|oauth|signin|auth/i.test(url)) {
          console.log('[AUTH] Navigation:', url.split('?')[0]);
        }
        if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('file:')) return;
      });
      contents.on('will-redirect', (e, url) => {
        if (/accounts\.google\.com|login\.|oauth|signin|auth/i.test(url)) {
          console.log('[AUTH] Redirect:', url.split('?')[0]);
        }
        if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('file:')) return;
      });
      // Suppress ERR_ABORTED and ERR_FAILED — normal when navigation is cancelled/redirected
      contents.on('did-fail-load', (e, errorCode, errorDescription, validatedURL) => {
        if (errorCode === -3 || errorCode === -1) {
          e.preventDefault();
        }
      });
      // Route popups — OAuth/help popups open as separate windows, others go to new tab
      contents.setWindowOpenHandler(function({ url }) {
        var openerUrl = '';
        try { openerUrl = contents.getURL(); } catch(e) {}
        var isLoginPopup = /accounts\.google\.com|google\.com\/signin|accounts\.youtube|login\.microsoftonline\.com|github\.com\/login|discord\.com\/api\/oauth2|facebook\.com\/(?:v2\.\d+\/)?dialog\/oauth/i.test(openerUrl);
        var isHelpLink = /help|support|privacy|policy|terms|faq/i.test(url);
        if (isLoginPopup || isHelpLink) {
          return { action: 'allow', overrideBrowserWindowOptions: { width: 900, height: 700, autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } } };
        }
        // All other popups -> new tab
        var w = BrowserWindow.getAllWindows().find(function(bw) { return !bw.isDestroyed() && bw.webContents; });
        if (w && !w.isDestroyed()) {
          try { w.webContents.send('open-in-new-tab', url); } catch(e) {}
        }
        return { action: 'deny' };
      });

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
      contents.session.setPermissionRequestHandler((wc, p, cb) => cb(true));
      contents.session.setPermissionCheckHandler((wc, p, o) => true);

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
    backgroundColor: '#0a0e1c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      sandbox: false,
      nativeWindowOpen: true,
      enableRemoteModule: false,
      allowRunningInsecureContent: true,
      spellcheck: true,
      backgroundThrottling: false,
      experimentalFeatures: true,
      enableBlinkFeatures: 'CSSBackdropFilter,LayoutNG,FontAccess,FileSystemAccess,SerialPort,WebGPU',
      disableDialogs: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  win.loadFile(path.join(__dirname, 'ai-browser.html'));
  win.webContents.setUserAgent(USER_AGENT);

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
    if (w) w.close();
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
    if (!url) { console.warn('[LoginWin] No URL'); return; }
    opts = opts || {};
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
        backgroundColor: '#ffffff',
        webPreferences: wp,
      });
      loginWin.setUserAgent(USER_AGENT);
      _loginWindows.add(loginWin);
      loginWin.webContents.setUserAgent(USER_AGENT);
      // Allow popups from login windows (Google sign-in may open popups)
      loginWin.webContents.setWindowOpenHandler(function(details) {
        return { action: 'allow' };
      });
      // (new-window event deprecated in Electron 28+; handled by setWindowOpenHandler above)
      // Comprehensive anti-detection — inject early (dom-ready) and again on finish
      function _injectAntiDetectLogin() {
        try {
          loginWin.webContents.executeJavaScript(`
            try {
              // 1. Remove navigator.webdriver
              try { delete navigator.__proto__.webdriver; } catch(e) {}
              try { delete navigator.webdriver; } catch(e) {}

              // 2. Languages
              Object.defineProperty(navigator,'languages',{get:()=>['en-US','en'],configurable:true});

              // 3. Fake Chrome plugins
              var _fp = [
                {name:'Chrome PDF Plugin',filename:'internal-pdf-viewer',description:'Portable Document Format',length:1},
                {name:'Chrome PDF Viewer',filename:'mhjfbmdgcfjbbpaeojofohoefgiehjai',description:'',length:1},
                {name:'Native Client',filename:'internal-nacl-plugin',description:'',length:0}
              ];
              if(!navigator.plugins || navigator.plugins.length === 0) {
                Object.defineProperty(navigator,'plugins',{get:function(){return _fp;},configurable:true});
              }
              if(!navigator.mimeTypes || navigator.mimeTypes.length === 0) {
                Object.defineProperty(navigator,'mimeTypes',{get:function(){return[{type:'application/pdf',suffixes:'pdf'},{type:'text/pdf',suffixes:'pdf'}]},configurable:true});
              }

              // 4. Chrome runtime
              if(window.chrome&&!window.chrome.runtime)window.chrome.runtime={connect:()=>({}),sendMessage:()=>Promise.resolve()};
              if(!window.chrome.loadTimes)window.chrome.loadTimes=function(){return{}};
              if(!window.chrome.csi)window.chrome.csi=function(){return{}};
              window.chrome.app = window.chrome.app || {};
              if(!window.chrome.webstore)window.chrome.webstore={install:function(){}};
              if(window.chrome.runtime&&!window.chrome.runtime.id)window.chrome.runtime.id='ghbmnnjooekpmoecnnnilnnbdlolhkhi';
              if(window.chrome.runtime&&!window.chrome.runtime.getManifest)window.chrome.runtime.getManifest=function(){return{version:'1.0'}};

              // 5. Device specs
              if(!navigator.deviceMemory)navigator.deviceMemory=8;
              Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>8,configurable:true});
              Object.defineProperty(navigator,'platform',{get:()=>'Win32',configurable:true});

              // 6. Hide Electron
              if(window.process && window.process.versions) {
                Object.defineProperty(window.process.versions,'electron',{get:()=>undefined,configurable:true});
              }
              if(window.process && window.process.type) {
                Object.defineProperty(window.process,'type',{get:()=>'browser',configurable:true});
              }

              // 7. userAgentData
              if(!navigator.userAgentData) {
                Object.defineProperty(navigator,'userAgentData',{get:()=>{
                  return {
                    brands:[
                      {brand:'Chromium',version:'135'},
                      {brand:'Google Chrome',version:'135'},
                      {brand:'Not=A?Brand',version:'99'}
                    ],
                    mobile:false,
                    platform:'Windows',
                    getHighEntropyValues:function(keys){return Promise.resolve({architecture:'x64',bitness:'64',model:'',platform:'Windows',platformVersion:'10.0',uaFullVersion:'142.0.0.0'});}
                  };
                },configurable:true});
              }

              // 8. API stubs
              if(!navigator.pdfViewerEnabled)navigator.pdfViewerEnabled=true;
              if(!navigator.serial)navigator.serial={};
              if(!navigator.usb)navigator.usb={};
              if(!navigator.bluetooth)navigator.bluetooth={};
            }catch(e){}
          `).catch(function(){});
        } catch(e) {}
      }
      loginWin.webContents.on('dom-ready', function() {
        _injectAntiDetectLogin();
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
      loginWin.webContents.on('did-finish-load', function() {
        _injectAntiDetectLogin();
        var u = loginWin.webContents.getURL() || '';
        // Auto-close only if navigated to a completely unrelated site
        if (u && u.indexOf('google.') === -1 && u.indexOf('youtube.') === -1 && u.indexOf('accounts.google') === -1
            && u.indexOf('/signin') === -1 && u.indexOf('/login') === -1 && u.indexOf('accounts.youtube') === -1
            && u.indexOf('ServiceLogin') === -1 && u.indexOf('support.google') === -1) {
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

  // Return preload path for webview beat analyzer
  ipcMain.handle('get-beat-preload', () => {
    if (process.env.NEO_NO_BEAT_PRELOAD === '1') return '';
    return path.join(__dirname, 'beat-preload.js');
  });

  // Run JS inside a guest webview from the main process with a hard timeout.
  // Doing this in main keeps a hung/unresponsive guest from freezing the UI renderer.
  ipcMain.handle('webview-execjs', async (event, payload) => {
    try {
      var wcId = payload && payload.wcId;
      var js = payload && payload.js;
      var ms = payload && payload.ms ? payload.ms : 2000;
      if (!wcId || typeof js !== 'string') return '';
      var wc = webContents.fromId(wcId);
      if (!wc || wc.isDestroyed()) return '';
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

// App launcher: open file dialog to select .exe or enter URL for web app
  ipcMain.handle('select-app-exe', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Applications', extensions: ['exe', 'bat', 'cmd', 'lnk'] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const fp = result.filePaths[0];
    return { path: fp, name: path.basename(fp).replace(/\.(exe|bat|cmd|lnk)$/i, ''), type: 'exe' };
  });

  // App launcher: launch an .exe using shell.openPath
  ipcMain.handle('launch-app', async (event, appPath) => {
    try {
      const err = await shell.openPath(appPath);
      if (err) { console.warn('shell.openPath error:', err); return false; }
      return true;
    } catch (e) { console.warn('launch-app error:', e); return false; }
  });

  // Launch a URL in the user's default browser (for DRM sites that require VMP)
  ipcMain.handle('launch-in-chrome', async (event, url) => {
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
  const DOWNLOADS_DIR = path.join(app.getPath('userData'), 'downloads');
  try { if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true }); } catch(e) {}

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
          // Skip files under 100KB — likely junk/cache
          if (stat.size < 102400) return false;
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
      const fp = path.join(DOWNLOADS_DIR, path.basename(fileName));
      if (!fs.existsSync(fp)) return null;
      var ext = path.extname(fileName).toLowerCase();
      var mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      var buffer = fs.readFileSync(fp);
      return { data: buffer.toString('base64'), mime: mime };
    } catch(e) { return null; }
  });

  // ===== PLAYBACK STATE PERSISTENCE =====
  const _PLAYBACK_STATE_PATH = path.join(DOWNLOADS_DIR, '_playback_state.json');

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
  const _META_PATH = path.join(DOWNLOADS_DIR, '_metadata_index.json');

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
  const _PLAYLIST_PATH = path.join(DOWNLOADS_DIR, '_playlists.json');

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
    try {
      const fs = require('fs');
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return null;
      if (stat.size > 200 * 1024 * 1024) return { error: 'File too large (max 200MB)' };
      const buffer = await fs.promises.readFile(filePath);
      return { data: buffer.toString('base64'), ext: path.extname(filePath).toLowerCase() };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('ua-get-overrides', function() {
    var result = {};
    for (var d in _uaOverrides) result[d] = _uaOverrides[d];
    return result;
  });
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
        var isSelf = s.name && s.name.toUpperCase().indexOf('NEO') !== -1;
        var type = s.name && s.name.indexOf('Entire Screen') !== -1 ? 'screen' : s.id.startsWith('screen:') ? 'screen' : 'window';
        return { id: s.id, name: s.name, type: type, thumbnail: s.thumbnail ? s.thumbnail.toDataURL() : null, isSelf: isSelf };
      });
    } catch(e) { return []; }
  });

  ipcMain.handle('rec-save-recording', async function(event, data) {
    try {
      var name = data.name || ('Recording_' + Date.now() + '.webm');
      var meta = data.meta || {};
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
      var files = fs.readdirSync(dir).filter(function(f) { return f.endsWith('.webm') || f.endsWith('.mp4'); });
      var list = [];
      files.forEach(function(f) {
        var stat = fs.statSync(path.join(dir, f));
        var meta = { name: f, size: stat.size, date: stat.mtimeMs, duration: 0, quality: '720p', fps: 30, favorite: false };
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
      var dir = recDir();
      var ext = path.extname(oldName);
      if (!newName.endsWith(ext)) newName += ext;
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
            'C:\\Users\\Admin\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffprobe.exe'
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
      console.log('[REC-READ]', name, 'size=' + arr.length);
      return { buffer: arr.buffer, name: name, size: arr.length };
    } catch(e) { return null; }
  });

  ipcMain.handle('rec-import-recording', async function(event, srcPath) {
    try {
      if (!fs.existsSync(srcPath)) return { ok: false, error: 'Source not found' };
      var name = path.basename(srcPath);
      var dest = path.join(recDir(), name);
      var count = 1;
      while (fs.existsSync(dest)) {
        var ext = path.extname(name);
        var base = path.basename(name, ext);
        dest = path.join(recDir(), base + '_' + count + ext);
        count++;
      }
      fs.copyFileSync(srcPath, dest);
      return { ok: true, name: path.basename(dest) };
    } catch(e) { return { ok: false, error: e.message }; }
  });

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
});

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') app.quit();
});
