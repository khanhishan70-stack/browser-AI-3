/* ===== NEXORA Hand Control - HandTracker.js =====
   Wraps MediaPipe Hand Landmarker (bundled locally & served via
   mediapipe-hand://) + the getUserMedia camera feed.

   - webcam is only opened when start() is called (i.e. Hand Control is ON)
   - stop() always tears the camera down and closes the model
   - frames are processed via requestVideoFrameCallback (runs per fresh frame,
     never re-processes a stale frame, no busy loop)
   - GPU delegate with automatic CPU fallback
   - one hand tracked (MediaPipe returns the most confident single hand) */
'use strict';

(function () {
  var NS = (window.NeoHandControl = window.NeoHandControl || {});

  var VENDOR_BASE = 'mediapipe-hand://app';
  var MODEL_URL = VENDOR_BASE + '/models/hand_landmarker.task';
  var WASM_BASE = VENDOR_BASE + '/wasm/';

  function NeoHandTracker(opts) {
    this.opts = Object.assign({
      onStatus: function () {},
      onHand: function () {}
    }, opts || {});
    this.status = 'idle';
    this.video = null;
    this.stream = null;
    this.landmarker = null;
    this._rcb = null;
    this._raf = null;
    this._started = false;
    this._frameCb = null;
    this._stopping = false;
  }

  NeoHandTracker.prototype._setStatus = function (s) {
    if (this.status !== s) {
      this.status = s;
      try { this.opts.onStatus(s); } catch (e) {}
    }
  };

  NeoHandTracker.prototype._ensureVideo = function () {
    if (this.video && this.video.parentNode) return this.video;
    var v = document.querySelector('#neo-hand-video');
    if (!v) {
      v = document.createElement('video');
      v.id = 'neo-hand-video';
      document.body.appendChild(v);
    } else if (v.parentNode !== document.body) {
      // re-home a video orphaned into a removed preview box
      document.body.appendChild(v);
    }
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('muted', '');
    v.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1;';
    this.video = v;
    return v;
  };

  NeoHandTracker.prototype._loadModel = async function () {
    var vision = NS.vision;
    if (!vision || !vision.FilesetResolver || !vision.HandLandmarker) {
      throw new Error('MediaPipe vision bundle not loaded');
    }
    var fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
    var res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error('hand model fetch failed ' + res.status);
    var buf = await res.arrayBuffer();
    var bytes = new Uint8Array(buf);

    var make = function (delegate) {
      return vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: bytes, delegate: delegate },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
    };
    try {
      this.landmarker = await make('GPU');
    } catch (e) {
      try { this.landmarker = await make('CPU'); }
      catch (e2) { throw new Error('hand landmarker init failed: ' + e2.message); }
    }
  };

  NeoHandTracker.prototype._pickVideoDevice = async function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return null;
    try {
      var ds = await navigator.mediaDevices.enumerateDevices();
      var vids = ds.filter(function (d) { return d.kind === 'videoinput'; });
      if (!vids.length) return null;
      // Prefer the laptop's built-in camera over any external/USB camera.
      var rank = function (dev) {
        var label = (dev.label || '').toLowerCase();
        if (/integrated|built[\s-]?in|internal|front camera|facet|syntek|bison|realtek|asus|lenovo|dell|acer|toshiba|hp|compaq|fhd camera|hd camera|webcam|imaging|wide vision/.test(label)) return 3;
        if (/camera|isight|face/.test(label)) return 2;
        if (/droid|phone|cell|mobile|usb|virtual|obs|screen|external|video capture|driver|network|\d{4}:\d{4}$/.test(label)) return 0;
        return 1;
      };
      vids.sort(function (a, b) { return rank(b) - rank(a); });
      return vids[0].deviceId || null;
    } catch (e) { return null; }
  };

  NeoHandTracker.prototype._openCamera = async function () {
    var v = this._ensureVideo();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw { code: 'nomediadevices', message: 'mediaDevices unavailable' };
    }
    var deviceId = await this._pickVideoDevice();
    var videoOpts = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 360 } }
      : { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 360 } };
    var stream = await navigator.mediaDevices.getUserMedia({
      video: videoOpts,
      audio: false
    });
    if (this._stopping) {
      stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      throw { code: 'stopped', message: 'stopped while opening' };
    }
    this.stream = stream;
    v.srcObject = stream;
    try { await v.play(); } catch (e) {}
    await this._waitReady(v, 5000);
    if (this.opts.onAspect) {
      try {
        if (v.videoWidth > 0 && v.videoHeight > 0) this.opts.onAspect(v.videoWidth, v.videoHeight);
      } catch (e2) {}
    }
  };

  NeoHandTracker.prototype._waitReady = function (v, timeout) {
    return new Promise(function (resolve, reject) {
      if (v.readyState >= 2 && v.videoWidth > 0) return resolve();
      var done = false;
      var onReady = function () { if (done) return; done = true; clearTimeout(t); resolve(); };
      v.addEventListener('loadeddata', onReady);
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        v.removeEventListener('loadeddata', onReady);
        if (v.videoWidth > 0) resolve(); else reject(new Error('video never became ready'));
      }, timeout);
    });
  };

  NeoHandTracker.prototype._loop = function (now) {
    var self = this;
    if (!this._started || this._stopping) return;
    try {
      if (this.video && this.video.readyState >= 2 && this.video.videoWidth > 0 && this.landmarker) {
        var ts = (typeof performance !== 'undefined' && performance.now) ? performance.now() : now;
        var res = this.landmarker.detectForVideo(this.video, ts);
        this._emit(res);
      } else {
        this.opts.onHand(null);
      }
    } catch (e) {
      console.warn('[NEO Hand] detect error', e);
      this.opts.onHand(null);
    }
    if (this._started && !this._stopping && this.video) {
      if (typeof this.video.requestVideoFrameCallback === 'function') {
        this._rcb = this.video.requestVideoFrameCallback(function (_, t) { self._loop(t); });
      } else {
        this._raf = requestAnimationFrame(function (t) { self._loop(t); });
      }
    }
  };

  NeoHandTracker.prototype._emit = function (res) {
    var self = this;
    if (!res || !res.landmarks || !res.landmarks.length) { this.opts.onHand(null); return; }
    var lm = res.landmarks[0];
    var conf = 0;
    var label = '';
    try {
      if (res.handedness && res.handedness[0] && res.handedness[0][0]) {
        conf = res.handedness[0][0].score || 0;
        label = res.handedness[0][0].categoryName || '';
      }
    } catch (e) {}
    if (!lm || !lm[4] || !lm[8]) { this.opts.onHand(null); return; }
    var ix = lm[8], th = lm[4];
    var dx = ix.x - th.x, dy = ix.y - th.y;
    var pinchDist = Math.sqrt(dx * dx + dy * dy);
    this.opts.onHand({
      landmarks: lm,
      handLabel: label,
      confidence: conf,
      rawX: ix.x,
      rawY: ix.y,
      pinchDist: pinchDist
    });
  };

  NeoHandTracker.prototype.start = async function (previewVideo) {
    if (this._started) return;
    this._started = true;
    this._stopping = false;
    try {
      this._setStatus('loading');
      if (previewVideo) {
        var self = this;
        this._ensureVideo().addEventListener('loadeddata', function () {
          try { if (self.video) self.video.play(); } catch (e) {}
        });
      }
      await this._loadModel();
      await this._openCamera();
      if (!this._started) return;
      this._setStatus('active');
      this._loop(0);
    } catch (e) {
      this._started = false;
      var code = (e && e.code) || '';
      if (code === 'nomediadevices' || (e && /NotFoundError|DevicesNotFoundError|no camera/i.test(e.message || ''))) {
        this._setStatus('no-camera');
      } else if (code === 'NotAllowedError' || e.name === 'NotAllowedError' || (e && /Permission|NotAllowed/i.test(e.message || ''))) {
        this._setStatus('denied');
      } else if (code === 'inuse' || (e && /in use|Overconstrained|TrackStartError/i.test(e.message || ''))) {
        this._setStatus('inuse');
      } else {
        this._setStatus('load-fail');
      }
      console.warn('[NEO Hand] start failed', e);
      this._teardownCamera();
    }
  };

  NeoHandTracker.prototype.stop = function () {
    this._started = false;
    this._stopping = true;
    if (this._rcb) { try { /* cancel only via next frame guard */ } catch (e) {} this._rcb = null; }
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    this._teardownCamera();
    if (this.landmarker) {
      try { this.landmarker.close(); } catch (e) {}
      this.landmarker = null;
    }
    this.status = 'idle';
    this._setStatus('idle');
  };

  NeoHandTracker.prototype._teardownCamera = function () {
    if (this.stream) {
      var tracks = this.stream.getTracks();
      for (var i = 0; i < tracks.length; i++) { try { tracks[i].stop(); } catch (e) {} }
      this.stream = null;
    }
    if (this.video) {
      try { this.video.srcObject = null; } catch (e) {}
    }
  };

  NeoHandTracker.prototype.getVideo = function () { return this._ensureVideo(); };

  NS.HandTracker = NeoHandTracker;
})();