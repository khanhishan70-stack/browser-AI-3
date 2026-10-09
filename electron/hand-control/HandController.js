/* ===== NEXORA Hand Control - HandController.js =====
   Orchestrates the full hand-control pipeline inside the NEXORA Browser UI:

     HandTracker -> CoordinateMapper -> InteractiveElementDetector -> FocusOverlay
                       -> GestureDetector (state machine) -> actions

   Also owns: Settings wiring + persistence, the status pill, the draggable
   camera preview, the debug overlay, and clean shutdown when Hand Control OFF.

   KEEP IN SYNC: settings row ids referenced here are injected into the
   Settings panel by the static markup in ai-browser.html. */
'use strict';

(function () {
  var NS = (window.NeoHandControl = window.NeoHandControl || {});
  var LS_PREFIX = 'neoHand.';

  var CONFIG = {
    HAND_CONTROL_ENABLED: true, // camera + gesture detection active on every startup
    SMOOTHING_FACTOR: 0.5,      // 0..1  (higher = smoother / more lag)
    PINCH_THRESHOLD: 0.055,     // normalized index<->thumb tip distance
    PINCH_COOLDOWN: 500,        // ms
    FIST_HOLD_TIME: 700,        // ms the fist must be held
    GESTURE_STABILITY_TIME: 320, // ms two-finger must be stable
    SHOW_CAMERA_PREVIEW: false, // camera runs in the background; no preview box in the UI
    SHOW_FINGERTIP: true,
    SHOW_FOCUS_BORDER: true,
    SECONDARY_GESTURE_ACTION: 'none',   // none | reload | newTab | settings
    FIST_GESTURE_ACTION: 'back',        // back | reload | newTab | settings
    DEBUG_MODE: false
  };

  NS.HAND_CONTROL_CONFIG = CONFIG;
  NS.HAND_CONTROL_LS_PREFIX = LS_PREFIX;

  var ACTION_ELEMENTS = { back: 'backBtn', reload: 'reloadBtn', newTab: 'newTabBtn', settings: 'settingsBtn' };

  function loadCfg() {
    var c = {};
    Object.keys(CONFIG).forEach(function (k) {
      var raw;
      try { raw = localStorage.getItem(LS_PREFIX + k); } catch (e) { raw = null; }
      if (raw === null) c[k] = CONFIG[k];
      else if (typeof CONFIG[k] === 'boolean') c[k] = raw === '1' || raw === 'true';
      else if (typeof CONFIG[k] === 'number') { var n = parseFloat(raw); c[k] = isFinite(n) ? n : CONFIG[k]; }
      else c[k] = raw;
    });
    return c;
  }

  function saveCfg(cfg) {
    try {
      Object.keys(CONFIG).forEach(function (k) {
        if (k in cfg) localStorage.setItem(LS_PREFIX + k, String(cfg[k]));
      });
    } catch (e) {}
  }

  function dist(a, b) {
    if (!a || !b) return 0;
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** Per-finger extension. Robust metric: an extended finger has its TIP far
      beyond its own MCP base (distance tip->MCP >> distance PIP->MCP). A curled
      finger pulls the tip back toward the palm, so that ratio collapses. This
      is far more reliable than comparing against the wrist, which fails for
      hands with naturally curled (but 'open') fingers. */
  function fingerState(lm) {
    var ext = function (tip, pip, mcp) {
      return dist(lm[tip], lm[mcp]) > dist(lm[pip], lm[mcp]) * 1.25;
    };
    var f = {
      thumb: dist(lm[4], lm[1]) > dist(lm[3], lm[1]) * 1.1,
      index: ext(8, 6, 5),
      middle: ext(12, 10, 9),
      ring: ext(16, 14, 13),
      pinky: ext(20, 18, 17)
    };
    return f;
  }

  function classifyGesture(fs, pinchDist, threshold) {
    if (!fs.thumb && !fs.index && !fs.middle && !fs.ring && !fs.pinky) return 'fist';
    var midRingPinky = !fs.middle && !fs.ring && !fs.pinky;
    if (fs.index && fs.thumb && midRingPinky && pinchDist < threshold) return 'pinch';
    if (fs.index && fs.middle && !fs.ring && !fs.pinky) return 'two';
    if (fs.index && midRingPinky) return 'index';
    return 'none';
  }

  function NeoHandController() {
    this.cfg = loadCfg();
    this.enabled = false;
    this.starting = false;
    this.tracker = null;
    this.mapper = null;
    this.detector = null;
    this.overlay = null;
    this.gesture = null;
    this._statusEl = null;
    this._settingStatusEl = null;
    this._chip = null;
    this._preview = null;
    this._debug = null;
    this._lastPoint = { x: 0, y: 0 };
    this._lostSince = 0;
    this._debugTimer = 0;
    this._lastTargetLabel = '';
    this._lastGestureName = 'none';
    this._lastState = 'IDLE';
    this._lastConfidence = 0;
    this._lastPinchDist = 0;
    this._boundReady = null;
  }

  NeoHandController.prototype._persist = function () { saveCfg(this.cfg); };

  // ---------- UI: status pill -----------------------------------------
  NeoHandController.prototype._ensureChip = function () {
    if (this._chip) return this._chip;
    var c = document.getElementById('neo-hand-status');
    if (!c) {
      c = document.createElement('div');
      c.id = 'neo-hand-status';
      c.setAttribute('data-hand-skip', '');
      var dot = document.createElement('span');
      dot.className = 'nhs-dot';
      var txt = document.createElement('span');
      txt.className = 'nhs-txt';
      c.appendChild(dot);
      c.appendChild(txt);
      document.body.appendChild(c);
    }
    this._chip = c;
    return c;
  };

  NeoHandController.prototype._setChip = function (cls, txt) {
    var c = this._ensureChip();
    c.classList.remove('ok', 'warn', 'err', 'secondary');
    if (cls) c.classList.add(cls);
    if (txt) c.querySelector('.nhs-txt').textContent = txt;
    c.classList.add('visible');
  };

  NeoHandController.prototype._hideChip = function () {
    if (this._chip) this._chip.classList.remove('visible');
  };

  // ---------- UI: settings status line --------------------------------
  NeoHandController.prototype._setSettingStatus = function (txt) {
    var el = document.getElementById('handControlStatus');
    if (el) el.textContent = txt || '';
  };

  // ---------- UI: camera preview --------------------------------------
  NeoHandController.prototype._ensurePreview = function () {
    if (this._preview) return this._preview;
    var root = document.getElementById('neo-hand-preview');
    if (!root) {
      root = document.createElement('div');
      root.id = 'neo-hand-preview';
      root.setAttribute('data-hand-skip', '');
      root.innerHTML =
        '<div class="nhp-bar"><span class="nhp-label">Hand Camera</span>' +
        '<button type="button" class="nhp-min" title="Minimize">-</button>' +
        '<button type="button" class="nhp-close" title="Hide preview">x</button></div>' +
        '<div class="nhp-body"></div>';
      document.body.appendChild(root);
      var bar = root.querySelector('.nhp-bar');
      var pos = null;
      try { pos = JSON.parse(localStorage.getItem(LS_PREFIX + 'previewPos') || 'null'); } catch (e) { pos = null; }
      if (pos && typeof pos.x === 'number') { root.style.right = 'auto'; root.style.left = pos.x + 'px'; root.style.bottom = 'auto'; root.style.top = pos.y + 'px'; }
      bar.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        var sx = ev.clientX, sy = ev.clientY, px = root.offsetLeft, py = root.offsetTop;
        function mm(me) {
          var nx = px + (me.clientX - sx), ny = py + (me.clientY - sy);
          nx = Math.max(0, Math.min(window.innerWidth - 40, nx));
          ny = Math.max(0, Math.min(window.innerHeight - 30, ny));
          root.style.left = nx + 'px'; root.style.top = ny + 'px';
          root.style.right = 'auto'; root.style.bottom = 'auto';
        }
        function mu() {
          document.removeEventListener('mousemove', mm);
          document.removeEventListener('mouseup', mu);
          try { localStorage.setItem(LS_PREFIX + 'previewPos', JSON.stringify({ x: root.offsetLeft, y: root.offsetTop })); } catch (e) {}
        }
        document.addEventListener('mousemove', mm);
        document.addEventListener('mouseup', mu);
      });
      root.querySelector('.nhp-min').addEventListener('click', function () {
        root.classList.toggle('minimized');
      });
      root.querySelector('.nhp-close').addEventListener('click', function () {
        this.hidePreview();
      }.bind(this));
    }
    this._preview = root;

    // attach the tracker's single <video> into the preview body (one decode)
    if (this.tracker) {
      var v = this.tracker.getVideo();
      var body = root.querySelector('.nhp-body');
      if (v && body && v.parentNode !== body) {
        body.appendChild(v);
        v.removeAttribute('style');
      }
    }
    return root;
  };

  NeoHandController.prototype._refreshPreview = function () {
    // Preview is intentionally DISABLED: the webcam runs silently in the
    // background so nothing shows inside the browser window.
    var p = document.getElementById('neo-hand-preview');
    if (p && p.parentNode) p.parentNode.removeChild(p);
    this._preview = null;
  };

  NeoHandController.prototype.hidePreview = function () {
    this.cfg.SHOW_CAMERA_PREVIEW = false;
    this._persist();
    this._refreshPreview();
    var chk = document.getElementById('handPreviewChk');
    if (chk) chk.checked = false;
  };

  // ---------- UI: debug overlay ---------------------------------------
  NeoHandController.prototype._ensureDebug = function () {
    if (this._debug) return this._debug;
    var d = document.getElementById('neo-hand-debug');
    if (!d) {
      d = document.createElement('div');
      d.id = 'neo-hand-debug';
      d.setAttribute('data-hand-skip', '');
      document.body.appendChild(d);
    }
    this._debug = d;
    return d;
  };

  NeoHandController.prototype._updateDebug = function () {
    if (!this.cfg.DEBUG_MODE) return;
    var d = this._ensureDebug();
    d.textContent =
      'GESTURE: ' + this._lastGestureName + '\n' +
      'STATE:   ' + this._lastState + '\n' +
      'TARGET:  ' + (this._lastTargetLabel || 'none') + '\n' +
      'PINCH:   ' + this._lastPinchDist.toFixed(3) + '\n' +
      'CONF:    ' + this._lastConfidence.toFixed(2) + '\n' +
      'PT:      ' + Math.round(this._lastPoint.x) + ',' + Math.round(this._lastPoint.y);
    d.classList.add('visible');
  };

  // ---------- enable / disable ----------------------------------------
  NeoHandController.prototype.enable = function () {
    var self = this;
    if (this.enabled || this.starting) return;
    this.starting = true;
    this.enabled = false;
    this._setSettingStatus('Preparing Hand Control...');

    this.mapper = new NS.CoordinateMapper();
    this.mapper.setSmoothing(this.cfg.SMOOTHING_FACTOR);
    this.detector = new NS.InteractiveElementDetector({ extraSelectors: [] });
    this.overlay = new NS.FocusOverlay({
      showFocusBorder: this.cfg.SHOW_FOCUS_BORDER,
      showFingertip: this.cfg.SHOW_FINGERTIP
    });
    this.gesture = new NS.GestureDetector({
      pinchThreshold: this.cfg.PINCH_THRESHOLD,
      pinchCooldown: this.cfg.PINCH_COOLDOWN,
      fistHoldTime: this.cfg.FIST_HOLD_TIME,
      twoStableTime: this.cfg.GESTURE_STABILITY_TIME,
      onEvent: function (ev) { self._onGestureEvent(ev); }
    });
    this.overlay.setVisible(true);

    this.tracker = new NS.HandTracker({
      onStatus: function (s) { self._onStatus(s); },
      onHand: function (h) { self._onHand(h); },
      onAspect: function (w, h) { if (self.mapper) self.mapper.setCameraAspect(w, h); }
    });

    this._refreshPreview();
    this._setChip('warn', 'Preparing Hand Control...');

    this.tracker.start().then(function () {
      self.starting = false;
      if (!self.enabled && (self.tracker && self.tracker.status === 'active')) {
        self.enabled = true;
        self._setChip('ok', 'Hand Control Active');
        self._setSettingStatus('Hand Control Active');
        self._refreshPreview();
      } else if (self.tracker && self.tracker.status !== 'active') {
        // tracker surfaced an error via _onStatus already
        self._finalizeFailedStart();
      }
    }).catch(function (e) {
      self.starting = false;
      self._finalizeFailedStart();
    });
  };

  NeoHandController.prototype._finalizeFailedStart = function () {
    this.enabled = false;
    this._setSettingStatus('Hand Control unavailable - toggle again to retry');
  };

  NeoHandController.prototype.disable = function () {
    var self = this;
    this.enabled = false;
    this.starting = false;
    if (this.tracker) { this.tracker.stop(); this.tracker = null; }
    if (this.overlay) { this.overlay.destroy(); this.overlay = null; }
    if (this.gesture) { this.gesture.reset(); this.gesture = null; }
    if (this.detector) { this.detector.reset(); this.detector = null; }
    if (this.mapper) { this.mapper.reset(); this.mapper = null; }
    this._lastPoint = { x: 0, y: 0 };
    this._lastTargetLabel = '';
    this._lastGestureName = 'none';
    this._lastState = 'IDLE';
    this._hideChip();
    var d = document.getElementById('neo-hand-debug');
    if (d) d.classList.remove('visible');

    // Remove the preview box entirely (camera already stopped by tracker.stop).
    var p = document.getElementById('neo-hand-preview');
    if (p && p.parentNode) p.parentNode.removeChild(p);
    this._preview = null;

    this._setSettingStatus('Hand Control is OFF');
    try {
      var tgl = document.getElementById('handControlToggle');
      if (tgl && tgl.checked) tgl.checked = false;
    } catch (e) {}
  };

  NeoHandController.prototype._onStatus = function (s) {
    var self = this;
    if (!this.enabled && s !== 'active' && s !== 'loading') {
      this._setSettingStatus(this._statusText(s));
      this._setChip('err', this._statusText(s));
    }
  };

  NeoHandController.prototype._statusText = function (s) {
    switch (s) {
      case 'active': return 'Hand Control Active';
      case 'loading': return 'Preparing Hand Control...';
      case 'no-camera': return 'Camera unavailable';
      case 'denied': return 'Camera permission required';
      case 'inuse': return 'Camera already in use';
      case 'load-fail': return 'Hand AI failed to load';
      default: return 'Camera error';
    }
  };

  // ---------- per-frame pipeline --------------------------------------
  NeoHandController.prototype._onHand = function (hand) {
    if (!this.enabled) return;
    var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (!hand || hand.confidence < 0.2) {
      if (this._lostSince === 0) this._lostSince = now;
      if (now - this._lostSince > 450) {
        if (this.overlay) { this.overlay.clear(); this.overlay.hideCursor(); }
        if (this.gesture) this.gesture.reset();
        this._updateDebug();
      }
      return;
    }
    this._lostSince = 0;

    var map = this.mapper.map(hand.rawX, hand.rawY);
    this._lastPoint = map;
    this._lastConfidence = hand.confidence;
    this._lastPinchDist = hand.pinchDist;

    var fs = fingerState(hand.landmarks);
    var g = classifyGesture(fs, hand.pinchDist, this.cfg.PINCH_THRESHOLD);
    this._lastGestureName = g;

    if (this.gesture) {
      this.gesture.update({
        gesture: g,
        pinchDist: hand.pinchDist,
        confidence: hand.confidence
      });
      this._lastState = this.gesture.stateName();
    }

    if (this.overlay) this.overlay.moveCursor(map.x, map.y);

    if (g !== 'none') {
      var t = this.detector.detect(map.x, map.y);
      if (t) { this._lastTargetLabel = t.label; this.overlay.highlight(t); }
      else { this._lastTargetLabel = ''; this.overlay.clear(); }
    } else {
      this._lastTargetLabel = '';
      if (this.overlay) this.overlay.clear();
    }

    this._updateDebug();
  };

  // ---------- gesture events (fire ONCE per gesture) ------------------
  NeoHandController.prototype._onGestureEvent = function (ev) {
    if (!this.enabled) return;
    switch (ev.type) {
      case 'click':
        this._doPinchClick(this._lastPoint.x, this._lastPoint.y);
        break;
      case 'secondary':
        this._doSecondary();
        break;
      case 'fist':
        this._doFist();
        break;
      case 'state':
        if (ev.state === 'TWO_FINGER') { this._setChip('secondary', 'SECONDARY MODE'); }
        else if (this.enabled) { this._setChip('ok', 'Hand Control Active'); }
        break;
    }
  };

  NeoHandController.prototype._doPinchClick = function (x, y) {
    if (!this.detector || !this.overlay) return;
    var t = this.detector.detect(x, y);
    this.overlay.pulse(x, y);
    if (!t) return;
    if (t.kind === 'page') { this._forwardPageClick(t, x, y); return; }
    try {
      if (typeof t.el.click === 'function') t.el.click();
      else if (t.el.dispatchEvent) {
        t.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }
    } catch (e) { console.warn('[NEO Hand] click', e); }
  };

  NeoHandController.prototype._forwardPageClick = function (t, x, y) {
    var wv = window.siteWebview || (typeof siteWebview !== 'undefined' ? siteWebview : null) || document.getElementById('siteWebview');
    var wvc = document.getElementById('webviewContainer');
    if (!wv || (wvc && wvc.classList.contains('hidden'))) return;
    var r = t.rect;
    if (!r) return;
    var lx = Math.max(0, Math.min(r.width - 1, Math.round(x - r.left)));
    var ly = Math.max(0, Math.min(r.height - 1, Math.round(y - r.top)));
    var mk = function (type) { return { type: type, x: lx, y: ly, button: 'left', clickCount: 1 } };
    try { if (wv.sendInputEvent) wv.sendInputEvent(mk('mouseDown')); } catch (e) {}
    try { if (wv.sendInputEvent) wv.sendInputEvent(mk('mouseUp')); } catch (e) {}
  };

  NeoHandController.prototype._doSecondary = function () {
    var a = this.cfg.SECONDARY_GESTURE_ACTION || 'none';
    if (a === 'none') {
      this._setChip('secondary', 'SECONDARY MODE');
      this._toast('Secondary gesture - assign an action in Settings');
      return;
    }
    this._activateAction(a);
  };

  NeoHandController.prototype._doFist = function () {
    var a = this.cfg.FIST_GESTURE_ACTION || 'back';
    this._activateAction(a);
  };

  NeoHandController.prototype._activateAction = function (name) {
    var id = ACTION_ELEMENTS[name];
    if (!id) { this._toast('Unassigned gesture action'); return; }
    var el = document.getElementById(id);
    if (!el) return;
    try {
      if (el.classList && el.classList.contains('tab-link')) { /* tabs handled by ids */ }
      if (typeof el.click === 'function') el.click();
    } catch (e) { console.warn('[NEO Hand] action', e); }
    if (this.overlay) {
      var r = el.getBoundingClientRect();
      this.overlay.pulse(r.left + r.width / 2, r.top + r.height / 2);
    }
  };

  NeoHandController.prototype._toast = function (msg) {
    try { if (typeof window.showToast === 'function') { window.showToast(msg, 'info', 1800); return; } } catch (e) {}
    console.log('[NEO Hand]', msg);
  };

  // ---------- settings wiring ------------------------------------------
  NeoHandController.prototype._bindSettings = function () {
    var self = this;
    var tgl = document.getElementById('handControlToggle');
    if (tgl) {
      tgl.checked = !!this.cfg.HAND_CONTROL_ENABLED;
      tgl.addEventListener('change', function () {
        if (tgl.checked) { self.cfg.HAND_CONTROL_ENABLED = true; self._persist(); self.enable(); }
        else { self.cfg.HAND_CONTROL_ENABLED = false; self._persist(); self.disable(); }
      });
    }
    var smooth = document.getElementById('handSmoothSel');
    if (smooth) {
      var fac = this.cfg.SMOOTHING_FACTOR;
      smooth.value = fac >= 0.7 ? 'smooth' : fac <= 0.3 ? 'fast' : 'balanced';
      smooth.addEventListener('change', function () {
        var f = smooth.value === 'smooth' ? 0.75 : smooth.value === 'fast' ? 0.22 : 0.5;
        self.cfg.SMOOTHING_FACTOR = f; self._persist();
        if (self.mapper) self.mapper.setSmoothing(f);
      });
    }
    var chks = [
      ['handFingertipChk', 'SHOW_FINGERTIP'],
      ['handPreviewChk', 'SHOW_CAMERA_PREVIEW'],
      ['handDebugChk', 'DEBUG_MODE']
    ];
    chks.forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (!el) return;
      el.checked = !!self.cfg[pair[1]];
      el.addEventListener('change', function () {
        self.cfg[pair[1]] = el.checked; self._persist();
        if (pair[1] === 'SHOW_CAMERA_PREVIEW') self._refreshPreview();
        if (pair[1] === 'DEBUG_MODE') {
          var d = document.getElementById('neo-hand-debug');
          if (d) d.classList.toggle('visible', !!el.checked && self.cfg.DEBUG_MODE && self.enabled);
        }
        if (self.overlay) self.overlay.setConfig(pair[1] === 'SHOW_FINGERTIP' ? 'showFingertip' : pair[1] === 'SHOW_FOCUS_BORDER' ? 'showFocusBorder' : '', el.checked);
      });
    });
    var sec = document.getElementById('handSecondarySel');
    if (sec) {
      sec.value = this.cfg.SECONDARY_GESTURE_ACTION;
      sec.addEventListener('change', function () {
        self.cfg.SECONDARY_GESTURE_ACTION = sec.value; self._persist();
      });
    }
    var fist = document.getElementById('handFistSel');
    if (fist) {
      fist.value = this.cfg.FIST_GESTURE_ACTION;
      fist.addEventListener('change', function () {
        self.cfg.FIST_GESTURE_ACTION = fist.value; self._persist();
      });
    }
    // extra: SHOW_FOCUS_BORDER has no UI checkbox - keep configurable via CONFIG/localStorage
  };

  NeoHandController.prototype.init = function () {
    var self = this;
    this._bindSettings();
    if (this.cfg.HAND_CONTROL_ENABLED) {
      // auto-enable on startup if the user had it ON
      setTimeout(function () { self.enable(); }, 1500);
    }
  };

  NS.HandController = NeoHandController;

  // Static boot - runs when the document is ready (after NEXORA's own inline
  // script has defined layout globals like siteWebview/showToast).
  function boot() {
    try { NS.controller = new NeoHandController(); NS.controller.init(); }
    catch (e) { console.warn('[NEO Hand] boot failed', e); }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();