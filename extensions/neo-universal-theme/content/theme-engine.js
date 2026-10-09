(function (root) {
  'use strict';

  var Color = root.NeoColor;

  var STYLE_ID = 'neo-universal-theme-style';
  var IGNORE_ATTR = 'data-neo-theme-ignore';
  var PROCESSED_ATTR = 'data-neo-theme-done';

  var MEDIA_TAGS = {
    IMG: 1, VIDEO: 1, AUDIO: 1, CANVAS: 1, SVG: 1, PICTURE: 1, SOURCE: 1,
    IFRAME: 1, OBJECT: 1, EMBED: 1, TRACK: 1, MAP: 1, AREA: 1
  };

  var strengthRank = { weak: 0, medium: 1, strong: 2 };

  var state = {
    mode: 'auto',
    effective: 'auto',
    strength: 'medium',
    styleEl: null,
    observers: [],
    idleHandle: null,
    queue: [],
    queued: new WeakSet(),
    running: false,
    lastError: null,
    // Original (pre-theme) background per element, captured before we ever write
    // an inline style. Elevation mapping needs to compare a child's original
    // background against its parent's original, not against colors we already
    // overwrote.
    origBg: new WeakMap(),
    processedCount: 0,
    touchedCount: 0
  };

  function rememberOriginalBg(el, value) {
    if (value && !state.origBg.has(el)) state.origBg.set(el, value);
    return value;
  }

  // Capture the root surfaces before the stylesheet exists, otherwise their
  // original white/black is lost the moment we set background-color on them.
  function captureRootBg() {
    if (!document.documentElement) return;
    var h = document.documentElement;
    var hc = getComputedStyle(h).backgroundColor;
    rememberOriginalBg(h, hc);
    var b = document.body;
    if (b) rememberOriginalBg(b, getComputedStyle(b).backgroundColor);
  }

  function isMedia(el) {
    if (!el || el.nodeType !== 1) return false;
    if (MEDIA_TAGS[el.tagName]) return true;
    if (el.tagName === 'DIV' && el.querySelector && el.querySelector('canvas, video')) {
      return !!getComputedStyle(el).backgroundImage.indexOf('url(') !== -1;
    }
    return false;
  }

  function hasAncestorMedia(el) {
    var p = el;
    var depth = 0;
    while (p && p.nodeType === 1 && depth < 12) {
      if (MEDIA_TAGS[p.tagName]) return true;
      p = p.parentElement;
      depth++;
    }
    return false;
  }

  function isIgnored(el) {
    if (!el || el.nodeType !== 1) return true;
    var p = el;
    var guard = 0;
    while (p && p.nodeType === 1 && guard < 64) {
      if (p.hasAttribute && p.hasAttribute(IGNORE_ATTR)) return true;
      if (p.closest && p.closest('[' + IGNORE_ATTR + ']')) return true;
      var rn = p.getRootNode ? p.getRootNode() : null;
      p = (rn && rn.host) ? rn.host : p.parentElement;
      guard++;
    }
    return false;
  }

  function effectiveMode() {
    if (state.mode !== 'auto') return state.mode;
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch (e) {}
    return 'light';
  }

  function mediaGuardCss() {
    return [
      'img,video,canvas,svg,picture,iframe,object,embed,audio{',
      'filter:none !important;',
      'background-color:transparent !important;',
      'box-shadow:none !important;',
      '}'
    ].join('');
  }

  function paletteVars(mode) {
    var p = Color.PALETTES[mode];
    return [
      '--neo-bg:' + Color.toRgbaString(p.canvas) + ';',
      '--neo-surface:' + Color.toRgbaString(p.surface) + ';',
      '--neo-surface-alt:' + Color.toRgbaString(p.surfaceAlt) + ';',
      '--neo-raised:' + Color.toRgbaString(p.raised) + ';',
      '--neo-text:' + Color.toRgbaString(p.text) + ';',
      '--neo-text-dim:' + Color.toRgbaString(p.textDim) + ';',
      '--neo-border:' + Color.toRgbaString(p.border) + ';',
      '--neo-link:' + Color.toRgbaString(p.link) + ';'
    ].join('');
  }

  // Stripped of blanket rules. Site styling wins wherever the page already has an
// opinion; the computed pass does the real work. The only things the stylesheet
    // handles are document-level surfaces and scrollbars, which must be right at
    // first paint before any element has been walked.
    function genericCss(mode, strength) {
    var dark = mode === 'dark';

    var css = [];

    css.push(':root{color-scheme:' + (dark ? 'dark' : 'light') + ';' + paletteVars(mode) + '}');
    css.push('html{background:var(--neo-bg) !important;}');
    css.push('body{background:var(--neo-bg) !important;color:var(--neo-text) !important;}');
    css.push('::selection{background:' + (dark ? 'rgba(77,163,255,.35)' : 'rgba(21,101,192,.28)') + ' !important;}');

    if (strengthRank[strength] !== undefined ? strengthRank[strength] >= 1 : true) {
      css.push(mediaGuardCss());
      css.push('*::-webkit-scrollbar{background:var(--neo-bg) !important;}');
      css.push('*::-webkit-scrollbar-thumb{background:var(--neo-raised) !important;border-radius:8px;}');
      css.push('*::-webkit-scrollbar-track{background:var(--neo-bg) !important;}');
    }

    return css.join('\n');
  }

  function autoCss(strength) {
    return [
      '@media (prefers-color-scheme: dark){',
      genericCss('dark', strength),
      '}',
      '@media (prefers-color-scheme: light){',
      genericCss('light', strength),
      '}'
    ].join('\n');
  }

  function ensureStyleEl() {
    if (state.styleEl && state.styleEl.isConnected) return state.styleEl;
    var doc = document;
    var parent = doc.head || doc.documentElement;
    if (!parent) return null;
    var el = doc.createElement('style');
    el.id = STYLE_ID;
    el.setAttribute('type', 'text/css');
    el.textContent = '';
    parent.appendChild(el);
    state.styleEl = el;
    return el;
  }

  function buildCss() {
    if (state.mode === 'auto') return autoCss(state.strength);
    return genericCss(state.mode, state.strength);
  }

  function immediateCss() {
    var mode = effectiveMode();
    return [
      'html{background:' + Color.toRgbaString(Color.PALETTES[mode].canvas) + ' !important;',
      'color-scheme:' + mode + ';}'
    ].join('');
  }

  function render() {
    captureRootBg();
    state.processedCount = 0;
    state.touchedCount = 0;
    state.lastError = null;
    var el = ensureStyleEl();
    if (!el) return;
    var next = buildCss();
    if (el.getAttribute('data-neo-css') !== next) {
      el.setAttribute('data-neo-css', next);
      el.textContent = next;
    }
  }

  function renderFlashGuard() {
    var el = ensureStyleEl();
    if (!el) return;
    el.textContent = immediateCss();
  }

  function clearInlineMarks() {
    state.queued = new WeakSet();
    var roots = [document];
    var all = document.querySelectorAll ? document.querySelectorAll('*') : [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) roots.push(all[i].shadowRoot);
    }
    for (var r = 0; r < roots.length; r++) {
      var nodes = roots[r].querySelectorAll('[' + PROCESSED_ATTR + ']');
      for (var j = 0; j < nodes.length; j++) {
        var el = nodes[j];
        el.removeAttribute(PROCESSED_ATTR);
        el.style.removeProperty('background-color');
        el.style.removeProperty('color');
        el.style.removeProperty('border-color');
        el.style.removeProperty('box-shadow');
      }
    }
  }

  // The background an element had before we touched anything, so elevation mapping
  // is not fooled by our own earlier writes.
  function effectiveOriginalBackground(el) {
    var node = el;
    var guard = 0;
    while (node && node.nodeType === 1 && guard < 24) {
      if (isIgnored(node)) break;
      var c = Color.parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.05) {
        var known = state.origBg.get(node);
        if (known) {
          var k = Color.parse(known);
          if (k && k.a > 0.05) return k;
        }
        return c;
      }
      node = node.parentElement;
      guard++;
    }
    return null;
  }

  function effectiveBackground(el) {
    var node = el;
    var guard = 0;
    while (node && node.nodeType === 1 && guard < 24) {
      if (isIgnored(node)) break;
      var c = Color.parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.05) return c;
      node = node.parentElement;
      guard++;
    }
    return null;
  }

  function enqueue(el) {
    if (!el || el.nodeType !== 1) return;
    if (state.queued.has(el)) return;
    if (state.queue.length > 6000) return;
    state.queued.add(el);
    state.queue.push(el);
  }

  function enqueueSubtree(rootEl) {
    if (!rootEl) return;
    if (rootEl.nodeType === 1) enqueue(rootEl);
    else if (rootEl.nodeType !== 9 && rootEl.nodeType !== 11) return;
    var all = rootEl.querySelectorAll ? rootEl.querySelectorAll('*') : [];
    for (var i = 0; i < all.length; i++) enqueue(all[i]);
  }

  function pump() {
    if (state.running) return;
    state.running = true;

    var go = function () {
      if (!state.running) return;
      var mode = effectiveMode();
      var processed = 0;
      var budgetEnd = Date.now() + 10;

      while (state.queue.length && Date.now() < budgetEnd && processed < 400) {
        var el = state.queue.shift();
        if (!el || !el.isConnected) continue;
        try { processElement(el, mode); } catch (e) { state.lastError = e; }
        processed++;
      }

      if (state.queue.length) {
        if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 120 });
        setTimeout(go, 24);
      } else {
        state.running = false;
        publishDiag();
      }
    };

    if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 120 });
    setTimeout(go, 24);
  }

  function processElement(el, mode) {
    if (isIgnored(el)) return;
    if (el.hasAttribute && el.hasAttribute(PROCESSED_ATTR)) return;
    if (MEDIA_TAGS[el.tagName]) return;

    var cs = getComputedStyle(el);
    if (!cs) return;

    // Capture before writing, so a later sibling/child still sees the true original.
    rememberOriginalBg(el, cs.backgroundColor);

    var bgRaw = cs.backgroundColor;
    var bgColor = Color.parse(bgRaw);
    var textColor = Color.parse(cs.color);
    var borderColor = Color.parse(cs.borderTopColor);
    var hasBgImage = cs.backgroundImage && cs.backgroundImage !== 'none';

    var touched = false;

    var hadShadow = cs.boxShadow && cs.boxShadow !== 'none';
    var hadBorder = cs.borderTopWidth && parseFloat(cs.borderTopWidth) > 0;
    // Elevation cues the page drew itself. A shadow or a border is the page saying
    // "this is a separate surface", which pure tone comparison cannot detect when
    // the surface happens to be the same color as its parent (Google's search pill,
    // most inputs and buttons on a white page).
    var parentEl = el.parentElement;
    var srcParent = null;
    if (parentEl) {
      srcParent = effectiveOriginalBackground(parentEl);
    } else {
      // Inside a shadow root parentElement is null, so walk out to the host.
      // Without this, shadow-DOM elements have no parent color to compare against
      // and a bordered white box on a white host collapses into the page.
      var rootNode = el.getRootNode ? el.getRootNode() : null;
      var host = rootNode && rootNode.host ? rootNode.host : null;
      if (host) srcParent = effectiveOriginalBackground(host);
    }
    var matchesParent = !!(srcParent && bgColor && bgColor.a > 0.05 &&
      Math.abs(Color.relativeLuminance(bgColor) - Color.relativeLuminance(srcParent)) < 0.004);
    var isRaised = hadShadow ||
      (hadBorder && (bgColor.a < 0.05 || matchesParent));

    if (bgColor && bgColor.a > 0.05 && !hasBgImage) {
      var tone = Color.classify(bgColor);
      var shouldFlip = (mode === 'dark' && (tone === 'veryLight' || tone === 'light')) ||
                       (mode === 'light' && (tone === 'veryDark' || tone === 'dark'));
      var isTransparentLayer = bgColor.a < 0.95;

      var needsWork = shouldFlip ||
        (isRaised && bgColor.a > 0.05 && Color.classify(bgColor) !== 'medium');
      if (needsWork) {
        // Compare against the parent's ORIGINAL background, but step along the ramp
        // from where that original color actually landed.
        var mappedParent = null;
        if (srcParent && srcParent.a > 0.05) {
          mappedParent = Color.parse(Color.mapSurface(
            Color.toRgbaString(srcParent), mode, null, null));
        }
        var mapped = Color.mapSurface(bgRaw, mode, srcParent, mappedParent, isRaised && matchesParent ? 1 : 0);
        var p = Color.parse(mapped);
        if (p && p.a > 0) {
          var targetBg = { r: p.r, g: p.g, b: p.b, a: isTransparentLayer ? Math.min(1, p.a + bgColor.a) : 1 };
          el.style.setProperty('background-color', Color.toRgbaString(targetBg), 'important');
          bgColor = targetBg;
          touched = true;
        }
      }
    }

    var directText = hasDirectText(el);
    if (textColor && directText && !hasAncestorMedia(el)) {
      var textTone = Color.classify(textColor);
      var accent = Color.isAccent(textColor);
      var effBg = (bgColor && bgColor.a > 0.05) ? bgColor : null;
      var textShouldFlip = (mode === 'dark' && (textTone === 'veryDark' || textTone === 'dark') && !accent) ||
                           (mode === 'light' && (textTone === 'veryLight' || textTone === 'light') && !accent);

      if (!effBg && (textShouldFlip || accent)) effBg = effectiveBackground(el);

      // True only for text the site itself made a link. Applying a link color to
      // every anchor turns icons, logos and button wrappers blue.
      var linkish = el.tagName === 'A' && textTone !== 'veryLight' && textTone !== 'veryDark';

      if (textShouldFlip && effBg) {
        el.style.setProperty('color', Color.bestTextOn(effBg, mode), 'important');
        touched = true;
      } else if (textShouldFlip) {
        el.style.setProperty('color', Color.mapColor(cs.color, mode, 'text'), 'important');
        touched = true;
      } else if (linkish) {
        var linkRatio = effBg ? Color.contrastRatio(textColor, effBg) : 0;
        if (!effBg || linkRatio < 3) {
          var pal = Color.PALETTES[mode];
          el.style.setProperty('color', Color.toRgbaString(pal.link), 'important');
          touched = true;
        }
      } else if (accent && effBg) {
        var ratio = Color.contrastRatio(textColor, effBg);
        if (ratio < 4.5) {
          var adjusted = Color.ensureContrast(textColor, effBg, 4.5, mode === 'light');
          el.style.setProperty('color', Color.toRgbaString(adjusted), 'important');
          touched = true;
        }
      }
    }

if (borderColor && borderColor.a > 0.05) {
        var bTone = Color.classify(borderColor);
        var bFlip = (mode === 'dark' && (bTone === 'veryLight' || bTone === 'light')) ||
                    (mode === 'light' && (bTone === 'veryDark' || bTone === 'dark'));
        // Only recolor a border the page actually draws. Forcing a color onto
        // every element's border made unbordered boxes look outlined.
        if (bFlip && hadBorder) {
          el.style.setProperty('border-color', Color.mapColor(cs.borderTopColor, mode, 'border'), 'important');
          touched = true;
        }
      }

    if (touched) {
      el.setAttribute(PROCESSED_ATTR, '1');
      state.touchedCount++;
    }
    state.processedCount++;
  }

  // Lightweight counters mirrored onto <html> so a harness (or a bug report) can
  // tell "the engine ran and chose not to change this" apart from "it never ran".
  function publishDiag() {
    var h = document.documentElement;
    if (!h) return;
    h.setAttribute('data-neo-diag',
      'processed=' + state.processedCount + ' touched=' + state.touchedCount +
      ' queued=' + state.queue.length + ' errors=' + (state.lastError ? 1 : 0) +
      (state.lastError ? ' (' + state.lastError + ')' : ''));
    var n = 0;
    try {
      var nodes = document.querySelectorAll('[' + PROCESSED_ATTR + ']');
      for (var i = 0; i < nodes.length && n < 12; i++) {
        var el = nodes[i];
        var st = el.style;
        h.setAttribute('data-ran-' + (++n),
          (el.tagName + (el.id ? '#' + el.id : '') + ' bg=' + st.backgroundColor +
           ' color=' + st.color + ' border=' + st.borderColor).slice(0, 120));
      }
    } catch (e) { /* diagnostics must never break theming */ }
  }

  function hasDirectText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim().length) return true;
    }
    return false;
  }

  function observeMutations() {
    disconnectObservers();
    var mo = new MutationObserver(function (records) {
      if (state.mode === 'off') return;
      var added = 0;
      for (var i = 0; i < records.length && added < 300; i++) {
        var rec = records[i];
        if (rec.type === 'attributes') {
          if (rec.attributeName === 'style' || rec.attributeName === 'class') {
            enqueue(rec.target);
            added++;
          }
          continue;
        }
        for (var j = 0; j < rec.addedNodes.length && added < 300; j++) {
          var n = rec.addedNodes[j];
          if (n.nodeType === 1) { enqueueSubtree(n); added++; }
        }
      }
      if (added) pump();
    });

    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class']
    });
    state.observers.push(mo);

    var mq = null;
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
    } catch (e) {}
    if (mq && mq.addEventListener) {
      var onChange = function () {
        if (state.mode !== 'auto') return;
        clearInlineMarks(document);
        render();
        enqueueSubtree(document.body || document.documentElement);
        pump();
      };
      mq.addEventListener('change', onChange);
      state.observers.push({ disconnect: function () { mq.removeEventListener('change', onChange); } });
    }
  }

  function disconnectObservers() {
    for (var i = 0; i < state.observers.length; i++) {
      try { state.observers[i].disconnect(); } catch (e) {}
    }
    state.observers.length = 0;
  }

  function pierceShadowRoots() {
    if (!document.querySelectorAll) return 0;
    var all = document.querySelectorAll('*');
    var touched = 0;
    for (var i = 0; i < all.length && touched < 120; i++) {
      var el = all[i];
      if (!el.shadowRoot) continue;
      if (isIgnored(el)) continue;
      try {
        var existing = el.shadowRoot.querySelector('#' + STYLE_ID);
        if (existing) {
          var next = buildCss();
          if (existing.getAttribute('data-neo-css') !== next) {
            existing.setAttribute('data-neo-css', next);
            existing.textContent = next;
          }
        } else {
          var s = document.createElement('style');
          s.id = STYLE_ID;
          var css2 = buildCss();
          s.setAttribute('data-neo-css', css2);
          s.textContent = css2;
          el.shadowRoot.appendChild(s);
          touched++;
        }
        enqueueSubtree(el.shadowRoot);
      } catch (e) {}
    }
    if (touched) pump();
    return touched;
  }

  function apply(mode, strength) {
    var nextMode = mode || 'auto';
    var nextStrength = strength || 'medium';
    var changed = nextMode !== state.mode || nextStrength !== state.strength;

    state.mode = nextMode;
    state.strength = nextStrength;

    if (nextMode === 'off') {
      disable();
      return;
    }

    render();
    document.documentElement.setAttribute('data-neo-theme', nextMode);
    document.documentElement.setAttribute('data-neo-theme-strength', nextStrength);

    if (changed) {
      clearInlineMarks(document);
      state.queue.length = 0;
    }

    var target = document.body || document.documentElement;
    if (target) enqueueSubtree(target);
    pump();
    pierceShadowRoots();
    observeMutations();
  }

  function disable() {
    disconnectObservers();
    state.queue.length = 0;
    state.mode = 'off';
    document.documentElement.removeAttribute('data-neo-theme');
    document.documentElement.removeAttribute('data-neo-theme-strength');
    if (state.styleEl) {
      state.styleEl.textContent = '';
      state.styleEl.removeAttribute('data-neo-css');
    }
    clearInlineMarks(document);
  }

  function rescan() {
    if (state.mode === 'off') return;
    render();
    clearInlineMarks(document);
    var target = document.body || document.documentElement;
    if (target) enqueueSubtree(target);
    pump();
    pierceShadowRoots();
  }

  function flashGuard() {
    renderFlashGuard();
  }

  root.NeoThemeEngine = {
    apply: apply,
    disable: disable,
    rescan: rescan,
    flashGuard: flashGuard,
    pierceShadowRoots: pierceShadowRoots,
    effectiveMode: effectiveMode,
    enqueueSubtree: enqueueSubtree,
    pump: pump,
    getState: function () {
      return {
        mode: state.mode,
        effective: effectiveMode(),
        strength: state.strength,
        queued: state.queue.length,
        lastError: state.lastError ? String(state.lastError.message || state.lastError) : null
      };
    },
    IGNORE_ATTR: IGNORE_ATTR
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
