/* ===== NEXORA Hand Control - InteractiveElementDetector.js =====
   Turns a viewport coordinate into the interactive DOM element underneath it:
   - document.elementFromPoint(...)
   - walks UP the DOM tree to resolve the real clickable ancestor
     (e.g. <span> inside a <button> -> the <button>)
   - recognises NEXORA Browser's own chrome controls (tabs, nav buttons, tool
     buttons, Spotify/music & AI-panel toggles, etc.)
   - never highlights disabled / invisible elements
   - treats the <webview> area as a special 'page' target. */
'use strict';

(function () {
  var NS = (window.NeoHandControl = window.NeoHandControl || {});

  var DEFAULT_SELECTORS = [
    'a', 'button', 'input', 'textarea', 'select', 'summary',
    '[role="button"]', '[tabindex]', '[contenteditable="true"]', '[onclick]',
    'label:has(input), label:has(select)',
    // NEXORA Browser chrome controls (buttons/anchors mostly, but be liberal):
    '.tab', '.nav-btn', '.new-tab-btn', '.top-icon-btn', '.settings-btn',
    '.tab-mgr-btn', '.mp-btn', '.sr-tool-btn', '.shortcut-btn', '.ai-panel-toggle',
    '.music-toggle', '.chatgpt-toggle', '.leet-toggle', '.workspace-panel .trn-close',
    '.trn-toggle', '.sr-tools-drop .sr-tool-btn', '.video-card', '.rec-card',
    '.home-shortcut-btn', '.dl-item', '[id$="Btn"]', '[id$="btn"]'
  ];

  var SKIP_SELECTOR = 'script,style,noscript,textarea,option,svg,path,defs,use,[data-hand-skip]';

  function NeoInteractiveElementDetector(opts) {
    this.opts = Object.assign({
      extraSelectors: [],
      maxClimb: 5
    }, opts || {});
    var sel = DEFAULT_SELECTORS.concat(this.opts.extraSelectors || []);
    // NOTE: never wrap this in parentheses - el.matches() takes a plain
    // comma-separated selector LIST; '(a,button)' is an invalid selector.
    this._selector = sel.join(', ');
    this.lastTarget = null;
    this._cacheTick = 0;
    this._lastX = 0; this._lastY = 0;
  }

  NeoInteractiveElementDetector.prototype._matches = function (el) {
    if (!el || !el.matches) return false;
    if (el.matches(this._selector)) return true;
    // Catch-all: anything the UI styles as pointer-cursor (custom clickable
    // controls that didn't use a standard <button> / <a>). SVG internals are
    // excluded so we only ever land on the real control.
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'svg' || tag === 'path' || tag === 'use' || tag === 'defs' ||
        tag === 'html' || tag === 'body') return false;
    try {
      return getComputedStyle(el).cursor === 'pointer';
    } catch (e) { return false; }
  };

  NeoInteractiveElementDetector.prototype._isDisabled = function (el) {
    if (typeof el.disabled === 'boolean' && el.disabled) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    if (el.classList && el.classList.contains('disabled')) return true;
    return false;
  };

  NeoInteractiveElementDetector.prototype._visibleRect = function (el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    if (!r || (r.width <= 0.5 && r.height <= 0.5)) return null;
    // offscreen / zero-area or display:none (rect zero) get skipped
    if (r.bottom < 0 || r.right < 0 || r.top > (window.innerHeight || 500) || r.left > (window.innerWidth || 800)) return null;
    var sty = getComputedStyle(el);
    if (sty.display === 'none' || sty.visibility === 'hidden' || (+sty.opacity === 0)) return null;
    return r;
  };

  /** Returns { el, kind:'ui'|'page', rect, label } or null. */
  NeoInteractiveElementDetector.prototype.detect = function (x, y) {
    x = Math.round(x); y = Math.round(y);
    this._cacheTick++;
    if (this._cacheTick > 1000000) this._cacheTick = 0;
    this._lastX = x; this._lastY = y;

    var el = null;
    try { el = document.elementFromPoint(x, y); } catch (e) { el = null; }
    if (!el) return this._clearLast();

    // The NEXORA DOM elements live in the same document as the chrome, so a raw
    // hit may be a text node / span nested inside the real control. Climb up.
    // We use the full element STACK so decorative overlays that cover chrome
    // buttons (drag handles, masks, bars) do not block detection - the real
    // control below still gets picked up.
    var found = null;
    var stack = [el];
    try {
      var ked = document.elementsFromPoint(x, y);
      if (ked && ked.length) stack = ked;
    } catch (e) { /* keep [el] */ }
    for (var s = 0; s < stack.length && !found; s++) {
      var cur = stack[s];
      for (var i = 0; i < this.opts.maxClimb && cur; i++) {
        if (cur.matches && cur.matches(this._selector)) {
          if (!cur.closest(SKIP_SELECTOR) && !this._isDisabled(cur) && this._visibleRect(cur)) {
            found = cur;
            break;
          }
        }
        cur = cur.parentElement;
      }
    }

    // 'page' target: pointer is over the <webview> (the rendered site).
    var wv = null;
    if (!found) {
      var probe = el.closest ? el.closest('webview, #webviewContainer, iframe') : null;
      if (probe) {
        var wvEl = (probe.tagName === 'WEBVIEW') ? probe : (probe.querySelector ? probe.querySelector('webview') : null);
        if (!wvEl) {
          // inside #webviewContainer but webview not queryable (hidden?) - treat container
          wvEl = probe.id === 'webviewContainer' && probe.firstElementChild && probe.firstElementChild.tagName === 'WEBVIEW' ? probe.firstElementChild : probe;
        }
        if (wvEl && wvEl.getBoundingClientRect) {
          var r = wvEl.getBoundingClientRect();
          if (r && r.width > 0 && r.height > 0) {
            var wv2 = wvEl.tagName === 'WEBVIEW' ? wvEl : (wvEl.querySelector ? wvEl.querySelector('webview') : null);
            var kindEl = wv2 || wvEl;
            this.lastTarget = { el: kindEl, kind: 'page', rect: r, label: 'web page' };
            return this.lastTarget;
          }
        }
      }
    }

    if (found) {
      var rect = this._visibleRect(found);
      if (!rect) return this._clearLast();
      var label = this._labelOf(found);
      this.lastTarget = { el: found, kind: 'ui', rect: rect, label: label };
      return this.lastTarget;
    }

    return this._clearLast();
  };

  NeoInteractiveElementDetector.prototype._labelOf = function (el) {
    var t = '';
    if (el.getAttribute) t = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (!t && el.textContent) t = el.textContent.replace(/\s+/g, ' ').trim();
    if (!t) t = '<' + el.tagName.toLowerCase() + '>';
    t = t.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim(); // ASCII-only
    if (!t) t = '<' + el.tagName.toLowerCase() + '>';
    return t.length > 42 ? t.slice(0, 40) + '...' : t;
  };

  NeoInteractiveElementDetector.prototype._clearLast = function () {
    this.lastTarget = null;
    return null;
  };

  NeoInteractiveElementDetector.prototype.reset = function () { this.lastTarget = null; };

  NS.InteractiveElementDetector = NeoInteractiveElementDetector;
})();