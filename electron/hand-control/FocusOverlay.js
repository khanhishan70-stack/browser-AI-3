/* ===== NEXORA Hand Control - FocusOverlay.js =====
   The single reusable #neo-hand-focus highlight + the fingertip marker.
   - ONE overlay element for the whole session (created once)
   - positioned via getBoundingClientRect() of the highlighted element
   - CSS transition gives the smooth 100-150ms tracking motion
   - pointer-events:none so normal mouse use is untouched
   - repositions on scroll / resize / target change, not on every video frame */
'use strict';

(function () {
  var NS = (window.NeoHandControl = window.NeoHandControl || {});

  function NeoFocusOverlay(opts) {
    this.opts = Object.assign({
      showFocusBorder: true,
      showFingertip: true,
      onStatus: function () {}
    }, opts || {});
    this.el = null;
    this.cursor = null;
    this.pulseRing = null;
    this._currentTarget = null;
    this._visible = false;
    this._cursorReady = false;
    this._scrolled = false;
    this._boundReposition = this._reposition.bind(this);
    this._boundResize = this._reposition.bind(this);
  }

  NeoFocusOverlay.prototype._ensure = function () {
    if (this.el) return;
    this.el = document.getElementById('neo-hand-focus');
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.id = 'neo-hand-focus';
      document.body.appendChild(this.el);
    }
    this.cursor = document.getElementById('neo-hand-cursor');
    if (!this.cursor) {
      this.cursor = document.createElement('div');
      this.cursor.id = 'neo-hand-cursor';
      document.body.appendChild(this.cursor);
    }
    this.pulseRing = document.getElementById('neo-hand-pulse-ring');
    if (!this.pulseRing) {
      this.pulseRing = document.createElement('div');
      this.pulseRing.id = 'neo-hand-pulse-ring';
      this.pulseRing.style.display = 'none';
      document.body.appendChild(this.pulseRing);
    }
    window.addEventListener('scroll', this._boundReposition, true);
    window.addEventListener('resize', this._boundResize);
  };

  NeoFocusOverlay.prototype._reposition = function () {
    if (!this.el || !this._currentTarget) return;
    var r = this._rectOf(this._currentTarget);
    if (!r) { this.clear(); return; }
    this._place(r, this._currentTarget);
  };

  NeoFocusOverlay.prototype._rectOf = function (t) {
    try { return t && t.el ? t.el.getBoundingClientRect() : null; } catch (e) { return null; }
  };

  NeoFocusOverlay.prototype._place = function (r, t) {
    var el = this.el;
    el.style.left = Math.round(r.left) + 'px';
    el.style.top = Math.round(r.top) + 'px';
    el.style.width = Math.max(2, Math.round(r.width)) + 'px';
    el.style.height = Math.max(2, Math.round(r.height)) + 'px';
    el.classList.toggle('page-target', !!(t && t.kind === 'page'));
    if (!el.classList.contains('ready')) el.classList.add('ready');
    this._visible = true;
  };

  /** highlight(target|null); target = {el, kind, label, rect}. */
  NeoFocusOverlay.prototype.highlight = function (target) {
    this._ensure();
    if (!this.opts.showFocusBorder) { this.clear(); return; }
    if (!target || !target.el) { this.clear(); return; }

    var same = this._currentTarget && this._currentTarget.el === target.el;
    this._currentTarget = target;
    if (same) { this._reposition(); return; }

    var r = target.rect || this._rectOf(target);
    if (r && r.width > 0 && r.height > 0) this._place(r, target);
    else this.clear();
  };

  NeoFocusOverlay.prototype.clear = function () {
    if (this.el) {
      this.el.classList.remove('ready', 'page-target');
      this._currentTarget = null;
      this._visible = false;
    }
  };

  NeoFocusOverlay.prototype.setVisible = function (v) {
    this._ensure();
    if (!this.opts.showFocusBorder) v = false;
    if (v) {
      if (this._currentTarget) this._reposition();
      if (this.el && !this.el.classList.contains('ready')) {
        this.el.classList.add('ready');
        this._visible = true;
      }
    } else {
      this.clear();
    }
  };

  NeoFocusOverlay.prototype.pulse = function (x, y) {
    if (!this.el) this._ensure();
    if (this.el) {
      this.el.classList.remove('pulse');
      void this.el.offsetWidth;             // restart animation
      this.el.classList.add('pulse');
    }
    if (this.pulseRing && typeof x === 'number') {
      this.pulseRing.style.display = 'block';
      this.pulseRing.style.left = Math.round(x) + 'px';
      this.pulseRing.style.top = Math.round(y) + 'px';
      this.pulseRing.classList.remove('go');
      void this.pulseRing.offsetWidth;
      this.pulseRing.classList.add('go');
    }
  };

  NeoFocusOverlay.prototype.moveCursor = function (x, y) {
    if (!this.opts.showFingertip) { this.hideCursor(); return; }
    this._ensure();
    this.cursor.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';
    if (!this._cursorReady) { this.cursor.classList.add('ready'); this._cursorReady = true; }
  };

  NeoFocusOverlay.prototype.hideCursor = function () {
    if (this.cursor && this._cursorReady) {
      this.cursor.classList.remove('ready');
      this._cursorReady = false;
    }
  };

  NeoFocusOverlay.prototype.setConfig = function (key, val) {
    if (key === 'showFocusBorder') {
      this.opts.showFocusBorder = !!val;
      if (!val) this.clear();
    } else if (key === 'showFingertip') {
      this.opts.showFingertip = !!val;
      this.moveCursor(0, 0);
    }
  };

  NeoFocusOverlay.prototype.destroy = function () {
    window.removeEventListener('scroll', this._boundReposition, true);
    window.removeEventListener('resize', this._boundResize);
    var ids = ['neo-hand-focus', 'neo-hand-cursor', 'neo-hand-pulse-ring'];
    for (var i = 0; i < ids.length; i++) {
      var n = document.getElementById(ids[i]);
      if (n) n.parentNode.removeChild(n);
    }
    this.el = null; this.cursor = null; this.pulseRing = null;
    this._currentTarget = null; this._visible = false; this._cursorReady = false;
  };

  NS.FocusOverlay = NeoFocusOverlay;
})();