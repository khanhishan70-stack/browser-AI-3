/* NEXORA VOLUME BOOST ENGINE
 * Injected into every frame of every page (top + subframes, including
 * cross-origin iframe players) by the MAIN process via executeJavaScript, and
 * also into webview guests by the renderer. Self-contained; guards against
 * double-install with window.__neoBP.
 *
 * Amplifies audio >100% by routing each <video>/<audio> through a WebAudio
 * GainNode. Auto-tracks media with a MutationObserver + play() hook so players
 * created later (or inside iframes) still get routed.
 */
(function(){
  if (window.__neoBP) return;
  window.__neoBP = true;
  var _hn = (function(){ try { return (location.hostname || '').replace(/^www\./, '').toLowerCase(); } catch(e) { return ''; } })();
  // Live voice/video calls: never reroute or boost. WebRTC call audio must go
  // straight to the hardware - pushing it through a side AudioContext resamples
  // it and voices come out high-pitched (chipmunk) on these sites.
  var _isCallHost = /(^|\.)(whatsapp\.com|meet\.google\.com|hangouts\.google\.com|duo\.google\.com|teams\.microsoft\.com|teams\.live\.com|zoom\.us|discord\.com|telegram\.org|web\.telegram\.org|messenger\.com|skype\.com|web\.skype\.com|slack\.com|whereby\.com|meet\.jit\.si)$/i.test(_hn);
  var _isStreamingHost = /(^|\.)(spotify\.com|open\.spotify\.com|netflix\.com|hulu\.com|primevideo\.com|disneyplus\.com|hbomax\.com|max\.com|hotstar\.com|peacocktv\.com|paramountplus\.com|crunchyroll\.com|appletv\.apple\.com|tv\.apple\.com|youtube\.com|music\.youtube\.com|vimeo\.com|plex\.tv|soundcloud\.com|bandcamp\.com)$/i.test(_hn);
  var _noBoost = /(^|\.)(spotify\.com|open\.spotify\.com|netflix\.com|disneyplus\.com|primevideo\.com|hulu\.com|hbomax\.com|max\.com|hotstar\.com|peacocktv\.com|paramountplus\.com|crunchyroll\.com|appletv\.apple\.com|tv\.apple\.com)$/i.test(_hn) || _isCallHost;
  var AC = window.AudioContext || window.webkitAudioContext;
  var _RealAC = AC;
  window.__neoAnalyser = null;
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
    if (_noBoost) return -2;
    if (!_boostEnsureGraph()) return -1;
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
})();