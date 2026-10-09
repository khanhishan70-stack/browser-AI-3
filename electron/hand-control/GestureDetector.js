/* ===== NEXORA Hand Control - GestureDetector.js =====
   Frame-by-frame finger-state classification + the NEXORA gesture state machine.

   Classifications produced by the controller:
     'index'  -> only index finger extended        (pointer / move / highlight)
     'pinch'  -> index + thumb tips touching        (primary click)
     'two'    -> index + middle extended            (secondary action)
     'fist'   -> all four fingers folded            (BACK / configurable action)
     'none'   -> hand present but no known gesture

   State machine (spec): IDLE -> INDEX_MOVE -> PINCH -> CLICK/COOLDOWN -> INDEX_MOVE
   and INDEX_MOVE -> FIST_HOLD(->700ms hold)-> FIST_ACT -> FIST_COOLDOWN -> IDLE.

   Actions fire exactly ONCE per gesture; holding a gesture never re-fires. */
'use strict';

(function () {
  var NS = (window.NeoHandControl = window.NeoHandControl || {});

  var STATES = {
    IDLE: 'IDLE',
    INDEX_MOVE: 'INDEX_MOVE',
    PINCH: 'PINCH',
    PINCH_COOLDOWN: 'PINCH_COOLDOWN',
    TWO_FINGER: 'TWO_FINGER',
    FIST_HOLD: 'FIST_HOLD',
    FIST_ACT: 'FIST_ACT',
    FIST_COOLDOWN: 'FIST_COOLDOWN',
    NONE: 'NONE'
  };

  function NeoGestureDetector(opts) {
    this.opts = Object.assign({
      pinchThreshold: 0.055,   // normalized distance index tip <-> thumb tip
      pinchStableTime: 70,     // ms a pinch must hold before firing
      pinchCooldown: 500,      // ms before a NEW pinch may fire
      fistHoldTime: 700,       // ms a stable fist must be held before action
      twoStableTime: 320,      // ms two-finger must be stable before action
      onEvent: function () {}  // {type:'click'|'secondary'|'fist'|'state', ...}
    }, opts || {});
    this.state = STATES.IDLE;
    this._pinchSince = 0;
    this._pinchEnd = 0;
    this._fistSince = 0;
    this._fistActed = false;
    this._twoSince = 0;
    this._twoActed = false;
    this._lastGesture = 'none';
    this._lastPinchDist = 0;
    this._lastConfidence = 0;
  }

  NeoGestureDetector.prototype.now = function () {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  };

  NeoGestureDetector.prototype.reset = function () {
    this.state = STATES.IDLE;
    this._pinchSince = 0; this._pinchEnd = 0;
    this._fistSince = 0; this._fistActed = false;
    this._twoSince = 0; this._twoActed = false;
    this._lastGesture = 'none';
  };

  NeoGestureDetector.prototype._setState = function (s) {
    if (this.state !== s) {
      this.state = s;
      try { this.opts.onEvent({ type: 'state', state: s }); } catch (e) {}
    }
  };

  NeoGestureDetector.prototype._fire = function (name, extra) {
    var ev = Object.assign({ type: name }, extra || {});
    try { this.opts.onEvent(ev); } catch (e) { console.warn('[NEO Hand] onEvent threw', e); }
  };

  NeoGestureDetector.prototype.stateName = function () { return this.state; };

  /** classify: expects { gesture, pinchDist, confidence } */
  NeoGestureDetector.prototype.update = function (fr) {
    var g = (fr && fr.gesture) ? fr.gesture : 'none';
    var now = this.now();
    this._lastGesture = g;
    this._lastPinchDist = (fr && typeof fr.pinchDist === 'number') ? fr.pinchDist : 0;
    this._lastConfidence = (fr && typeof fr.confidence === 'number') ? fr.confidence : 0;

    // ---- PINCH (primary click) -----------------------------------------
    if (g === 'pinch') {
      if (this._pinchSince === 0) this._pinchSince = now;
      if (this.state === STATES.PINCH || this.state === STATES.PINCH_COOLDOWN) {
        // Keep holding (or still inside cooldown). A pinch reaching its
        // stable time while held fires the click exactly once.
        if (this.state === STATES.PINCH && this._pinchEnd === 0 &&
            now - this._pinchSince >= this.opts.pinchStableTime) {
          this._fire('click', { pinchDist: this._lastPinchDist });
          this._pinchEnd = now;
        }
        return this.stateName();
      }
      if (now - this._pinchSince >= this.opts.pinchStableTime && this._pinchEnd === 0) {
        this._setState(STATES.PINCH);
        this._fire('click', { pinchDist: this._lastPinchDist });
        this._pinchEnd = now;
      } else {
        this._setState(STATES.PINCH);
      }
      return this.stateName();
    }

    if (this.state === STATES.PINCH || this.state === STATES.PINCH_COOLDOWN) {
      // Pinch released -> cooldown gate so a held pinch cannot auto re-fire.
      if (this._pinchEnd === 0) this._pinchEnd = now;
      if (now - this._pinchEnd >= this.opts.pinchCooldown) {
        this._pinchSince = 0;
        this._pinchEnd = 0;
        this._setState(STATES.IDLE);
      } else {
        return this.stateName();
      }
    }

    // ---- FIST (hold -> action, fire once) -------------------------------
    if (g === 'fist') {
      if (this._fistSince === 0) this._fistSince = now;
      var held = now - this._fistSince;
      if (this._fistActed) {
        this._setState(STATES.FIST_COOLDOWN);
        return this.stateName();
      }
      if (held >= this.opts.fistHoldTime) {
        this._fistActed = true;
        this._setState(STATES.FIST_ACT);
        this._fire('fist', { held: held });
      } else {
        this._setState(STATES.FIST_HOLD);
      }
      return this.stateName();
    }

    // Fist released -> clear the latch; only a *fresh* held fist re-fires.
    if (this._fistActed || this.state === STATES.FIST_HOLD ||
        this.state === STATES.FIST_ACT || this.state === STATES.FIST_COOLDOWN) {
      this._fistSince = 0;
      this._fistActed = false;
      this._setState(STATES.IDLE);
    }

    // ---- TWO FINGER (secondary action, fire once per stable hold) ------
    if (g === 'two') {
      if (this._twoSince === 0) this._twoSince = now;
      if (!this._twoActed && now - this._twoSince >= this.opts.twoStableTime) {
        this._twoActed = true;
        this._setState(STATES.TWO_FINGER);
        this._fire('secondary', {});
      } else {
        this._setState(STATES.TWO_FINGER);
      }
      return this.stateName();
    }
    if (this.state === STATES.TWO_FINGER || this._twoActed) {
      this._twoSince = 0; this._twoActed = false;
      this._setState(STATES.IDLE);
    }

    // ---- INDEX (pointer / hover) ---------------------------------------
    if (g === 'index') {
      this._setState(STATES.INDEX_MOVE);
      return this.stateName();
    }

    this._setState(g === 'none' ? STATES.NONE : STATES.IDLE);
    return this.stateName();
  };

  NS.GestureDetector = NeoGestureDetector;
  NS.HAND_GESTURE_STATES = STATES;
})();