/* ===== NEXORA Hand Control - CoordinateMapper.js =====
   Maps normalized camera-fame fingertip coordinates into browser viewport
   coordinates with:
   - camera aspect-ratio compensation (the camera image is NOT simply stretched
     over the whole window)
   - mirroring (the GUI is a "mirror" view: hand moving to the user's right
     moves the pointer to the right)
   - coverage / edge margin so the pointer does not slam against the borders
   - exponential smoothing + snap guard so tracking noise does not shake it. */
'use strict';

(function () {
  var NS = (window.NeoHandControl = window.NeoHandControl || {});

  function NeoCoordinateMapper(opts) {
    this.opts = Object.assign({} , opts || {});
    this.px = -1;
    this.py = -1;
    this.smoothing = 0.5;   // 0..1 (1 = slowest/most smooth)
    this.coverage = 0.9;    // usable fraction of the window the camera covers
    this.camAspect = 1.777; // default 16:9; refreshed from actual video frame
    this.hasFrame = false;
    this.setSmoothing = function (f) {
      if (typeof f === 'number' && isFinite(f)) this.smoothing = Math.max(0.02, Math.min(0.98, f));
    }.bind(this);
    this.setCameraAspect = function (w, h) {
      if (w > 0 && h > 0) { this.camAspect = w / h; this.hasFrame = true; }
    }.bind(this);
    this.reset = function () { this.px = -1; this.py = -1; }.bind(this);
  }

  NeoCoordinateMapper.prototype.map = function (rawX, rawY) {
    var W = window.innerWidth || document.documentElement.clientWidth || 800;
    var H = window.innerHeight || document.documentElement.clientHeight || 600;
    var asp = this.camAspect > 0.1 ? this.camAspect : 1.777;

    // Fit a centred rectangle with the camera's aspect ratio inside the window
    // (scaled by coverage) - this keeps the projection natural and gives a
    // margin so fingers near the camera edges do not throw the pointer away.
    var rw = H * asp, rh = H;
    if (rw < W) { rw = W; rh = W / asp; }
    rw *= this.coverage; rh *= this.coverage;
    var offX = (W - rw) / 2;
    var offY = (H - rh) / 2;

    // Mirror horizontally: rawX = 0 (left of camera image) maps to the RIGHT side.
    var sx = offX + (1 - rawX) * rw;
    var sy = offY + rawY * rh;
    if (!(sx >= 0)) sx = 0;
    if (!(sy >= 0)) sy = 0;
    if (sx > W - 1) sx = W - 1;
    if (sy > H - 1) sy = H - 1;

    if (this.px < 0 || this.py < 0) {
      this.px = sx; this.py = sy;
    } else {
      // Snap-guard: if the new point is absurdly far from the smoothed one it
      // usually means the tracked hand was swapped/mis-tracked. Re-seat instead
      // of dragging one point across the screen.
      var jump = Math.abs(sx - this.px) + Math.abs(sy - this.py);
      if (jump > Math.max(W, H) * 0.6) { this.px = sx; this.py = sy; }
      else {
        var k = Math.max(0.02, 1 - this.smoothing);
        this.px += (sx - this.px) * k;
        this.py += (sy - this.py) * k;
      }
    }
    return { x: this.px, y: this.py, rawX: sx, rawY: sy };
  };

  NS.CoordinateMapper = NeoCoordinateMapper;
})();