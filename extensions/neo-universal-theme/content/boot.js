(function () {
  'use strict';

  var Settings = window.NeoThemeSettings;
  var Engine = window.NeoThemeEngine;
  var Rules = window.NeoSiteRules;
  var Watcher = window.NeoThemeWatcher;

  if (!Settings || !Engine) return;

  if (window.__neoUniversalThemeLoaded) return;
  window.__neoUniversalThemeLoaded = true;

  var siteStyleEl = null;
  var applied = null;
  var overrideMode = null;
  var overrideHost = null;

  function host() {
    try { return location.hostname || ''; } catch (e) { return ''; }
  }

  function injectCss(css) {
    if (!css) return;
    if (!siteStyleEl || !siteStyleEl.isConnected) {
      siteStyleEl = document.createElement('style');
      siteStyleEl.id = 'neo-universal-theme-site';
      siteStyleEl.setAttribute('type', 'text/css');
      (document.head || document.documentElement).appendChild(siteStyleEl);
    }
    siteStyleEl.textContent = css;
  }

  function currentMode() {
    if (overrideMode) return overrideMode;
    return Settings.resolve(host());
  }

  function currentStrength() {
    return Settings.resolveStrength();
  }

  function applyTheme(force) {
    var mode = currentMode();
    var strength = currentStrength();
    if (overrideMode && overrideHost !== host()) {
      overrideMode = null;
      overrideHost = null;
      mode = Settings.resolve(host());
    }
    var sig = mode + '|' + strength + '|' + host();
    if (!force && sig === applied) return;
    applied = sig;

    if (mode === 'off') {
      Engine.disable();
      injectCss('');
      if (window.NeoThemeInpage) window.NeoThemeInpage.sync(mode, strength);
      return;
    }

    Engine.apply(mode, strength);

    var ctx = {
      host: host(),
      mode: mode,
      strength: strength,
      injectCss: injectCss
    };

    Rules.pick(host());
    if (Rules.rules && Rules.rules.length) {
      for (var i = 0; i < Rules.rules.length; i++) {
        var r = Rules.rules[i];
        if (typeof r.onApply === 'function') {
          try { r.onApply(ctx); } catch (e) {}
        }
      }
    }

    if (window.NeoThemeInpage) window.NeoThemeInpage.sync(mode, strength);
  }

  Engine.flashGuard();
  Settings.bind();

  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      var h = host();
      chrome.storage.local.get(['neoLastHost'], function (items) {
        if (items && items.neoLastHost === h) return;
        var payload = {};
        payload.neoLastHost = h;
        chrome.storage.local.set(payload, function () {});
      });
    }
  } catch (e) {}

  Settings.read().then(function () {
    applyTheme(true);
    Watcher.init();
    Watcher.onChange(function (reason) {
      if (reason === 'spa-pushState' || reason === 'spa-replaceState' ||
          reason === 'popstate' || reason === 'hashchange' || reason === 'command:setTheme') {
        applyTheme(true);
      } else {
        applyTheme(true);
      }
    });

    Settings.subscribe(function () {
      applyTheme(true);
    });

    window.addEventListener('neo-theme:set', function (e) {
      var d = (e && e.detail) || {};
      if (d.global) { Settings.update({ global: d.global }); return; }
      if (d.strength) { Settings.update({ strength: d.strength }); return; }
      if (d.mode) {
        if (d.persist === false) {
          overrideMode = d.mode;
          overrideHost = host();
        } else {
          overrideMode = null;
          overrideHost = null;
          Settings.setSite(host(), d.mode);
        }
      }
      applyTheme(true);
    }, true);

    document.addEventListener('DOMContentLoaded', function () { applyTheme(true); }, { once: true });
    window.addEventListener('load', function () { applyTheme(true); }, { once: true });
  });

  window.__neoThemeApply = applyTheme;
  window.__neoThemeSet = function (mode, opts) {
    var o = opts || {};
    if (o.global) return Settings.update({ global: mode });
    return Settings.setSite(host(), mode);
  };
  window.__neoThemeGet = function () {
    return {
      host: host(),
      mode: currentMode(),
      strength: currentStrength(),
      state: Engine.getState()
    };
  };
})();
