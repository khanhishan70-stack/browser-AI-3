// Chrome Web Store install bridge for the visible browsing surface. The store
// button is injected into the page's main world, and contextBridge is the only
// way a main-world script can reach the extension engine in the main process.
// Namespaced and limited to install actions so a site script cannot do more than
// the user could from the extension manager.
try {
  const { contextBridge, ipcRenderer } = require('electron');
  contextBridge.exposeInMainWorld('neoStore', {
    parse: (url) => ipcRenderer.invoke('ext:webstore-parse', url),
    install: (id, meta) => ipcRenderer.invoke('ext:webstore-install', id, meta || {}),
    installCatalog: (id, name) => ipcRenderer.invoke('ext:webstore-catalog-lookup', id, name),
    proxyGet: () => ipcRenderer.invoke('ext:proxy-get'),
    proxySet: (rule) => ipcRenderer.invoke('ext:proxy-set', rule),
    pickUnpacked: () => ipcRenderer.invoke('ext:pick-folder'),
    pickPackage: () => ipcRenderer.invoke('ext:pick-package')
  });
} catch (e) { /* no bridge on this surface; the store button simply will not appear */ }

const script = document.createElement('script');
script.textContent = `
(function(){
  if (window.__neoBP) return;
  window.__neoBP = true;
  // ===== BEAT AUDIO-ROUTING GATE + VOLUME BOOST =====
  // (1) VOLUME BOOST: window.__neoVolumeBoost(level) routes every <audio>/<video>
  // through a Web-Audio GainNode so the volume can go UP TO 500% instead of the
  // browser's 100% cap. Default level 1 (100%) routes nothing and leaves the
  // page's audio path completely alone.
  // (2) BEAT ANALYSER: on non-streaming sites an injected AnalyserNode powers the
  // visualizer. On streaming hosts the analyser is OFF (routing Spotify/Netflix
  // audio through a Web-Audio graph is documented as breaking playback there).
  // Protected/DRM hosts here are the ones where the gain graph is guaranteed to
  // fail or break music (Spotify track transitions go silent + error, Netflix
  // et al throw NotSupportedError). Boost is disabled on these, never silently.
  var _hn = (function(){ try { return (location.hostname || '').replace(/^www\./, '').toLowerCase(); } catch(e) { return ''; } })();
  // Live voice/video calls: never reroute or boost. WebRTC call audio must go
  // straight to the hardware - pushing it through a side AudioContext resamples
  // it and voices come out high-pitched (chipmunk) on these sites.
  var _isCallHost = /(^|\.)(whatsapp\.com|meet\.google\.com|hangouts\.google\.com|duo\.google\.com|teams\.microsoft\.com|teams\.live\.com|zoom\.us|discord\.com|telegram\.org|web\.telegram\.org|messenger\.com|skype\.com|web\.skype\.com|slack\.com|whereby\.com|meet\.jit\.si)$/i.test(_hn);
  var _isStreamingHost = /(^|\.)(spotify\.com|open\.spotify\.com|netflix\.com|hulu\.com|primevideo\.com|disneyplus\.com|hbomax\.com|max\.com|hotstar\.com|peacocktv\.com|paramountplus\.com|crunchyroll\.com|appletv\.apple\.com|tv\.apple\.com|youtube\.com|music\.youtube\.com|vimeo\.com|plex\.tv|soundcloud\.com|bandcamp\.com)$/i.test(_hn);
  var _noBoost = /(^|\.)(spotify\.com|open\.spotify\.com|netflix\.com|disneyplus\.com|primevideo\.com|hulu\.com|hbomax\.com|max\.com|hotstar\.com|peacocktv\.com|paramountplus\.com|crunchyroll\.com|appletv\.apple\.com|tv\.apple\.com)$/i.test(_hn) || _isCallHost;
  // ===== CHROME IDENTITY FOR CALLING SITES =====
  // Discord and WhatsApp wall off camera/screen-sharing when their JS detects
  // a non-Chrome browser, even when the UA string and client-hint headers are
  // already pure Chrome (the main process handles those). This aligns the
  // in-page navigator.userAgentData the same way so their feature checks see
  // one consistent Chrome identity. Scoped to these hosts only — every other
  // site keeps the real values.
  try {
    if (/(^|\.)(discord\.com|whatsapp\.com)$/i.test(_hn) && window.navigator) {
      var _chromeBrands = [
        { brand: 'Chromium', version: '153' },
        { brand: 'Not/A)Brand', version: '8' },
        { brand: 'Google Chrome', version: '153' }
      ];
      var _chromeUAD = {
        brands: _chromeBrands,
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: function(hints) {
          return Promise.resolve({
            brands: _chromeBrands,
            mobile: false,
            platform: 'Windows',
            platformVersion: '15.0.0',
            architecture: 'x86',
            bitness: '64',
            model: '',
            uaFullVersion: '153.0.8010.53'
          });
        }
      };
      try {
        Object.defineProperty(window.navigator, 'userAgentData', { get: function() { return _chromeUAD; }, configurable: true });
      } catch (e) {
        try { window.navigator.__defineGetter__('userAgentData', function() { return _chromeUAD; }); } catch (e2) {}
      }
    }
  } catch (e) {}
  var AC = window.AudioContext || window.webkitAudioContext;
  // Real (unpatched) AudioContext, captured BEFORE any analyser patching below so
  // the boost gain graph is never rerouted through the analyser node.
  var _RealAC = AC;
  window.__neoAnalyser = null;
  // ---- Boost state ----
  var _boost = 1;
  var _boostGain = null;
  var _boostCtx = null;
  var _boostEngaged = false;
  var _boostRouted = window.__neoBoostRouted;
  if (!_boostRouted) { _boostRouted = new Set(); window.__neoBoostRouted = _boostRouted; }
  window.__neoVolumeBoostStatus = function() {
    return { supported: !_noBoost, engaged: _boostEngaged, gain: _boostGain ? _boostGain.gain.value : null, routed: _boostRouted.size };
  };
  function _boostEnsureGraph() {
    if (_boostEngaged) return true;
    try {
      var Ctor = _RealAC || window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return false;
      var ctx = new Ctor();
      try { if (ctx.state === 'suspended' && ctx.resume) ctx.resume(); } catch(e) {}
      var g = ctx.createGain();
      g.gain.value = _boost;
      g.connect(ctx.destination);
      _boostCtx = ctx; _boostGain = g; _boostEngaged = true;
      return true;
    } catch(e) { return false; }
  }
  function _boostRoute(el) {
    if (!el || !_boostEngaged || _boostRouted.has(el)) return;
    _boostRouted.add(el);
    try {
      var src = _boostCtx.createMediaElementSource(el);
      src.connect(_boostGain);
    } catch(e) {
      try { el.dataset.neoBoostFail = '1'; } catch(e2) {}
    }
  }
  function _boostEngage() {
    if (_noBoost) return -2; // unsupported on this site (DRM/protected)
    if (!_boostEnsureGraph()) return -1; // no Web-Audio support
    var els = document.querySelectorAll('video,audio');
    for (var i = 0; i < els.length; i++) (function(el) {
      if (el.readyState > 0 || el.currentTime > 0) _boostRoute(el);
      else setTimeout(function() { if (el.readyState > 0) _boostRoute(el); }, 300);
    })(els[i]);
    return _boost;
  }
  window.__neoVolumeBoost = function(level) {
    level = Number(level) || 0;
    if (level <= 0) level = 1;
    level = Math.min(5, Math.max(1, level));
    _boost = level;
    if (_boost === 1 && !_boostEngaged) return 1;
    if (_boostEngaged) {
      try { _boostGain.gain.setTargetAtTime(_boost, _boostCtx.currentTime, 0.02); }
      catch(e) { try { _boostGain.gain.value = _boost; } catch(e2) {} }
      return _boost;
    }
    return _boostEngage();
  };
  // ---- Analyser (streaming gate) ----
  var _anConnected = false;
  var _poll = function() {
    var an = window.__neoAnalyser;
    if (!an) return null;
    var f = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(f);
    if (f.every(function(v){return v===0})) return null;
    return Array.from(f);
  };
  window.__neoPollAudio = _poll;
  if (!_isStreamingHost && !_isCallHost) {
    var realAC = _RealAC || AC;
    var ACtor = function() {
      var ctx = new realAC();
      var an = null;
      try {
        an = ctx.createAnalyser();
        an.fftSize = 128;
        window.__neoAnalyser = an;
      } catch(e) {}
      var bs = ctx.createBufferSource.bind(ctx);
      ctx.createBufferSource = function() {
        var src = bs();
        try { if (!_anConnected) { src.connect(an); an.connect(ctx.destination); _anConnected = true; } } catch(e) {}
        return src;
      };
      var mes = ctx.createMediaElementSource.bind(ctx);
      ctx.createMediaElementSource = function(el) {
        var src = mes(el);
        try { if (!_anConnected && !_boostEngaged) { src.connect(an); an.connect(ctx.destination); _anConnected = true; } } catch(e) {}
        return src;
      };
      var cos = ctx.createOscillator.bind(ctx);
      ctx.createOscillator = function() {
        var src = cos();
        try { if (!_anConnected) { src.connect(an); an.connect(ctx.destination); _anConnected = true; } } catch(e) {}
        return src;
      };
      return ctx;
    };
    ACtor.prototype = realAC.prototype;
    window.AudioContext = ACtor;
    if (window.webkitAudioContext) window.webkitAudioContext = ACtor;
  }
  // ---- Media-element tracking (boost + analyser fallback) ----
  function _tryConnectMedia(el) {
    if (_boostEngaged) { _boostRoute(el); return; }
    if (_isCallHost || _isStreamingHost || !window.__neoAnalyser || _anConnected || !el) return;
    try {
      var ac = window.__neoBeatCtx;
      if (!ac) { ac = new (_RealAC || AC)(); window.__neoBeatCtx = ac; }
      var src = ac.createMediaElementSource(el);
      src.connect(window.__neoAnalyser);
      window.__neoAnalyser.connect(ac.destination);
      _anConnected = true;
    } catch(e) {}
  }
  var _origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function() {
    var self = this;
    setTimeout(function() { _tryConnectMedia(self); }, 100);
    return _origPlay.apply(this, arguments);
  };
  var _obs = new MutationObserver(function(muts) {
    for (var i = 0; i < muts.length; i++) {
      var nodes = muts[i].addedNodes;
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (n && (n.tagName === 'VIDEO' || n.tagName === 'AUDIO')) {
          setTimeout(function(el) { _tryConnectMedia(el); }, 500, n);
        } else if (n && n.querySelectorAll) {
          var inn = n.querySelectorAll('video,audio');
          for (var k = 0; k < inn.length; k++) setTimeout(function(el) { _tryConnectMedia(el); }, 500, inn[k]);
        }
      }
    }
  });
  try { _obs.observe(document.body || document.documentElement, {childList: true, subtree: true}); } catch(e) {}
  // ===== YOUTUBE DOWNLOAD BUTTON =====
  function _injectYTDL() {
    if (!location.pathname.startsWith('/watch')) return;
    if (document.querySelector('.neo-yt-dl-btn')) return;
    var b = document.createElement('button');
    b.className = 'neo-yt-dl-btn';
    b.innerHTML = '\u2b07 Download';
    b.style.cssText = 'position:fixed;bottom:90px;right:20px;z-index:9999;padding:10px 18px;background:linear-gradient(135deg,#a78bfa,#7c3aed);border:none;border-radius:24px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 20px rgba(124,58,237,0.4);transition:transform 0.2s,box-shadow 0.2s;';
    b.onmouseenter = function() { b.style.transform = 'scale(1.05)'; b.style.boxShadow = '0 6px 28px rgba(124,58,237,0.6)'; };
    b.onmouseleave = function() { b.style.transform = ''; b.style.boxShadow = '0 4px 20px rgba(124,58,237,0.4)'; };
    b.onclick = function() {
      if (b.disabled) return;
      var t = document.title.replace(/\\s*-\\s*YouTube$/, '');
      var ch = '';
      var ce = document.querySelector('#owner #channel-name .ytd-channel-name a,#upload-info #channel-name a,.ytd-video-owner-renderer .ytd-channel-name a');
      if (ce) ch = ce.textContent.trim();
      console.log('NEO_YTDL:' + JSON.stringify({url:location.href,title:t,channel:ch}));
      b.innerHTML = '\u2705 Queued...';
      b.disabled = true;
      b.style.opacity = '0.6';
      setTimeout(function() { b.innerHTML = '\u2b07 Download'; b.disabled = false; b.style.opacity = '1'; }, 60000);
    };
    var p = document.querySelector('#movie_player,#player-container,#player-theater-container,.html5-video-player');
    if (p && p.parentNode) p.parentNode.appendChild(b);
    else document.body.appendChild(b);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _injectYTDL);
  } else {
    _injectYTDL();
  }
  var _ytdlTimer = null;
  function _ytdlPoll() {
    if (_ytdlTimer) return;
    if (!location.hostname.indexOf) return;
    var hn = (location.hostname || '').toLowerCase();
    if (hn.indexOf('youtube.com') === -1 && hn.indexOf('youtu.be') === -1) return;
    _ytdlTimer = setInterval(function() {
      if (location.pathname.startsWith('/watch') && !document.querySelector('.neo-yt-dl-btn')) {
        _injectYTDL();
      }
    }, 1500);
  }
  _ytdlPoll();
  window.addEventListener('beforeunload', function() {
    if (_ytdlTimer) { clearInterval(_ytdlTimer); _ytdlTimer = null; }
  });
})();
`;
try {
  var _root = document.head || document.documentElement || document;
  if (_root) _root.appendChild(script);
} catch(e) {
  (document.head || document.documentElement || document.body || document).appendChild(script);
}