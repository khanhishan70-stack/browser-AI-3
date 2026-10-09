(function (root) {
  'use strict';

  var KEY = 'neoUniversalTheme';
  var MODES = ['auto', 'dark', 'light'];
  var STRENGTHS = ['weak', 'medium', 'strong'];

  var DEFAULTS = {
    enabled: true,
    global: 'auto',
    strength: 'medium',
    sites: {}
  };

  var cache = null;
  var listeners = [];
  var bound = false;

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function normalize(raw) {
    var s = clone(DEFAULTS);
    if (!raw || typeof raw !== 'object') return s;
    if (typeof raw.enabled === 'boolean') s.enabled = raw.enabled;
    if (MODES.indexOf(raw.global) !== -1) s.global = raw.global;
    if (STRENGTHS.indexOf(raw.strength) !== -1) s.strength = raw.strength;
    if (raw.sites && typeof raw.sites === 'object' && !Array.isArray(raw.sites)) {
      Object.keys(raw.sites).forEach(function (host) {
        var m = raw.sites[host];
        if (MODES.indexOf(m) !== -1) s.sites[String(host).toLowerCase()] = m;
      });
    }
    return s;
  }

  function hasChromeStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  function read() {
    if (!hasChromeStorage()) {
      return Promise.resolve(cache ? clone(cache) : clone(DEFAULTS));
    }
    return new Promise(function (resolve) {
      chrome.storage.local.get(KEY, function (items) {
        if (chrome.runtime.lastError) {
          resolve(cache ? clone(cache) : clone(DEFAULTS));
          return;
        }
        cache = normalize(items ? items[KEY] : null);
        resolve(clone(cache));
      });
    });
  }

  function write(next) {
    cache = normalize(next);
    if (!hasChromeStorage()) {
      emit(cache);
      return Promise.resolve(clone(cache));
    }
    return new Promise(function (resolve) {
      var payload = {};
      payload[KEY] = cache;
      chrome.storage.local.set(payload, function () {
        emit(cache);
        resolve(clone(cache));
      });
    });
  }

  function update(patch) {
    return read().then(function (cur) {
      var next = clone(cur);
      Object.keys(patch || {}).forEach(function (k) { next[k] = patch[k]; });
      return write(next);
    });
  }

  function setSite(host, mode) {
    host = normalizeHost(host);
    if (!host) return read();
    return read().then(function (cur) {
      var next = clone(cur);
      next.sites = next.sites || {};
      if (mode === null || mode === 'inherit') delete next.sites[host];
      else next.sites[host] = mode;
      return write(next);
    });
  }

  function clearSites() {
    return update({ sites: {} });
  }

  function normalizeHost(host) {
    if (!host) return '';
    var h = String(host).trim().toLowerCase();
    h = h.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split('/')[0].split(':')[0];
    h = h.replace(/\.+$/, '');
    return h;
  }

  function siteChain(host) {
    var h = normalizeHost(host);
    var out = [];
    if (!h) return out;
    out.push(h);
    var parts = h.split('.');
    for (var i = 1; i < parts.length - 1; i++) {
      out.push('.' + parts.slice(i).join('.'));
    }
    return out;
  }

  function resolve(host) {
    var s = cache || clone(DEFAULTS);
    if (!s.enabled) return 'off';
    var chain = siteChain(host);
    for (var i = 0; i < chain.length; i++) {
      var m = s.sites[chain[i]];
      if (m) return m;
    }
    return s.global || 'auto';
  }

  function resolveStrength() {
    return (cache && cache.strength) || DEFAULTS.strength;
  }

  function emit(s) {
    listeners.forEach(function (fn) {
      try { fn(s); } catch (e) {}
    });
  }

  function subscribe(fn) {
    if (typeof fn === 'function' && listeners.indexOf(fn) === -1) listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    };
  }

  function bind() {
    if (bound) return;
    bound = true;
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[KEY]) return;
      cache = normalize(changes[KEY].newValue);
      emit(cache);
    });
  }

  var api = {
    DEFAULTS: clone(DEFAULTS),
    MODES: MODES.slice(),
    STRENGTHS: STRENGTHS.slice(),
    read: read,
    write: write,
    update: update,
    setSite: setSite,
    clearSites: clearSites,
    resolve: resolve,
    resolveStrength: resolveStrength,
    normalizeHost: normalizeHost,
    subscribe: subscribe,
    bind: bind
  };

  root.NeoThemeSettings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
