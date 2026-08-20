const script = document.createElement('script');
script.textContent = `
(function(){
  if (window.__neoBP) return;
  window.__neoBP = true;
  // ===== ANTI-ELECTRON DETECTION =====
  // Runs before any page scripts to prevent Electron fingerprinting
  try {
    // Hide webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: function() { return undefined; }, configurable: true });
    // Add fake Chrome plugins
    var fakePlugins = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
    ];
    var pluginsArr = fakePlugins.map(function(p, i) {
      return { name: p.name, filename: p.filename, description: p.description, length: 0, item: function(){return null;}, namedItem: function(){return null;}, '0': null };
    });
    Object.defineProperty(navigator, 'plugins', {
      get: function() {
        var arr = pluginsArr.slice();
        arr.length = pluginsArr.length;
        arr.item = function(i) { return this[i] || null; };
        arr.namedItem = function(n) {
          for (var j = 0; j < this.length; j++) { if (this[j].name === n) return this[j]; }
          return null;
        };
        for (var pi = 0; pi < pluginsArr.length; pi++) {
          arr[pi] = pluginsArr[pi];
        }
        return arr;
      },
      configurable: true
    });
    // Mock userAgentData
    if (navigator.userAgentData) {
      var origGetHighEntropy = navigator.userAgentData.getHighEntropyValues;
      navigator.userAgentData.getHighEntropyValues = function(hints) {
        var result = origGetHighEntropy ? origGetHighEntropy.call(navigator.userAgentData, hints) : Promise.resolve({});
        return result.then(function(he) {
          he.platform = 'Windows';
          he.platformVersion = '15.0.0';
          he.architecture = 'x86';
          he.model = '';
          he.bitness = '64';
          he.wow64 = false;
          he.fullVersionList = [
            { brand: 'Not A(Brand', version: '99.0.0.0' },
            { brand: 'Google Chrome', version: '142.0.0.0' },
            { brand: 'Chromium', version: '142.0.0.0' }
          ];
          return he;
        });
      };
    }
    // Hide chrome.runtime (Electron-specific)
    if (window.chrome && window.chrome.runtime) {
      ['sendMessage', 'onMessage', 'connect', 'onConnect', 'runtime'].forEach(function(k) {
        if (window.chrome.runtime[k]) {
          var orig = window.chrome.runtime[k];
          // Keep basic stubs, remove Electron internals
          if (typeof orig === 'object') {
            Object.keys(orig).forEach(function(p) {
              if (typeof orig[p] === 'function') {
                try { orig[p] = function() {}; } catch(e) {}
              }
            });
          }
        }
      });
    }
    // Mock process.cwd (Electron-specific)
    if (typeof window.process === 'object' && window.process) {
      try { Object.defineProperty(window.process, 'type', { get: function() { return undefined; }, configurable: true }); } catch(e) {}
      try { Object.defineProperty(window.process, 'versions', { get: function() { return undefined; }, configurable: true }); } catch(e) {}
    }
  } catch(e) { /* anti-detection errors suppressed */ }
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  var realAC = AC;
  window.__neoAnalyser = null;
  var _an = null;
  var _connected = false;
  var _poll = function() {
    var an = window.__neoAnalyser;
    if (!an) return null;
    var f = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(f);
    if (f.every(function(v){return v===0})) return null;
    return Array.from(f);
  };
  window.__neoPollAudio = _poll;
  // Patch AudioContext constructor to inject analyser
  var ACtor = function() {
    var ctx = new realAC();
    var an = ctx.createAnalyser();
    an.fftSize = 128;
    window.__neoAnalyser = an;
    _an = an;
    var bs = ctx.createBufferSource.bind(ctx);
    ctx.createBufferSource = function() {
      var src = bs();
      try { src.connect(an); an.connect(ctx.destination); _connected = true; } catch(e) {}
      return src;
    };
    var mes = ctx.createMediaElementSource.bind(ctx);
    ctx.createMediaElementSource = function(el) {
      var src = mes(el);
      try { src.connect(an); an.connect(ctx.destination); _connected = true; } catch(e) {}
      return src;
    };
    // Also catch OscillatorNode and other sources
    var cos = ctx.createOscillator.bind(ctx);
    ctx.createOscillator = function() {
      var src = cos();
      try { src.connect(an); an.connect(ctx.destination); _connected = true; } catch(e) {}
      return src;
    };
    var cgs = ctx.createGain.bind(ctx);
    ctx.createGain = function() {
      var g = cgs();
      // If something connects to this gain, it will pass through the analyser via destination
      return g;
    };
    return ctx;
  };
  ACtor.prototype = realAC.prototype;
  window.AudioContext = ACtor;
  if (window.webkitAudioContext) window.webkitAudioContext = ACtor;
  // Also patch OfflineAudioContext just in case
  if (window.OfflineAudioContext) {
    var realOAC = window.OfflineAudioContext;
    window.OfflineAudioContext = function() {
      var ctx = new (Function.prototype.bind.apply(realOAC, [null].concat(Array.prototype.slice.call(arguments))))();
      if (!window.__neoAnalyser) {
        try { var an2 = ctx.createAnalyser(); an2.fftSize = 128; window.__neoAnalyser = an2; } catch(e) {}
      }
      return ctx;
    };
    window.OfflineAudioContext.prototype = realOAC.prototype;
  }
  // Fallback: intercept ANY media element playback and connect it
  var _tryConnectMedia = function(el) {
    if (_connected || !el) return;
    try {
      if (!window.__neoAnalyser) {
        var ctx2 = new realAC();
        var an3 = ctx2.createAnalyser();
        an3.fftSize = 128;
        window.__neoAnalyser = an3;
        _an = an3;
      }
      var ctx = window.__neoAnalyser ? null : null;
      var ac = window.__neoAudioCtx;
      if (!ac) {
        ac = new realAC();
        window.__neoAudioCtx = ac;
      }
      var src = ac.createMediaElementSource(el);
      src.connect(window.__neoAnalyser);
      window.__neoAnalyser.connect(ac.destination);
      _connected = true;
    } catch(e) {}
  };
  // Intercept when any media starts playing
  var _origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function() {
    var self = this;
    setTimeout(function() { _tryConnectMedia(self); }, 100);
    return _origPlay.apply(this, arguments);
  };
  // Also watch for new media elements being added to the page
  var _obs = new MutationObserver(function(muts) {
    if (_connected) { try { _obs.disconnect(); } catch(e) {} return; }
    for (var i = 0; i < muts.length; i++) {
      var nodes = muts[i].addedNodes;
      for (var j = 0; j < nodes.length; j++) {
        if (nodes[j].tagName === 'VIDEO' || nodes[j].tagName === 'AUDIO') {
          setTimeout(function(el) { _tryConnectMedia(el); }, 500, nodes[j]);
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
