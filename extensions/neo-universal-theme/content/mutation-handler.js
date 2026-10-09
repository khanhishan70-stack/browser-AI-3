(function (root) {
  'use strict';

  var listeners = [];
  var lastUrl = location.href;
  var shadowTimer = null;
  var ready = false;

  function emit(reason) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](reason, location.href); } catch (e) {}
    }
  }

  function checkUrl(reason) {
    var now = location.href;
    if (now === lastUrl) return;
    lastUrl = now;
    emit(reason);
  }

  function patchHistory(name) {
    var original = history[name];
    if (typeof original !== 'function') return;
    history[name] = function () {
      var out = original.apply(this, arguments);
      try { setTimeout(function () { checkUrl('spa-' + name); }, 0); } catch (e) {}
      return out;
    };
  }

  function init() {
    if (ready) return;
    ready = true;

    patchHistory('pushState');
    patchHistory('replaceState');

    window.addEventListener('popstate', function () { checkUrl('popstate'); }, true);
    window.addEventListener('hashchange', function () { checkUrl('hashchange'); }, true);

    window.addEventListener('neo-theme-command', function (e) {
      emit('command:' + (e && e.detail ? e.detail.type : 'unknown'));
    }, true);

    var mq = null;
    try { mq = window.matchMedia('(prefers-color-scheme: dark)'); } catch (e) {}
    if (mq && mq.addEventListener) {
      mq.addEventListener('change', function () { emit('color-scheme-change'); });
    }

    if (root.NeoThemeEngine) {
      scheduleShadowSweep();
      window.addEventListener('load', function () {
        root.NeoThemeEngine.rescan();
        scheduleShadowSweep();
      }, { once: true });
    }
  }

  function scheduleShadowSweep() {
    if (shadowTimer) clearTimeout(shadowTimer);
    var run = function () {
      if (!root.NeoThemeEngine) return;
      var n = root.NeoThemeEngine.pierceShadowRoots();
      shadowTimer = setTimeout(run, n > 0 ? 900 : 4200);
    };
    shadowTimer = setTimeout(run, 1500);
  }

  root.NeoThemeWatcher = {
    init: init,
    onChange: function (fn) {
      if (typeof fn === 'function') listeners.push(fn);
    },
    currentUrl: function () { return location.href; },
    check: function () { checkUrl('manual'); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
