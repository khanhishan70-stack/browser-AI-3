(function () {
  'use strict';

  var S = window.NeoThemeSettings;
  var $ = function (id) { return document.getElementById(id); };

  var currentHost = '';

  function hostFromQuery() {
    try {
      var p = new URLSearchParams(window.location.search);
      var h = p.get('host') || '';
      if (h) return S.normalizeHost(h);
    } catch (e) {}
    return '';
  }

  function hostFromStorage(cb) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['neoLastHost'], function (items) {
          cb(items && items.neoLastHost ? S.normalizeHost(items.neoLastHost) : '');
        });
        return;
      }
    } catch (e) {}
    cb('');
  }

  function paint(s) {
    var mode = S.resolve(currentHost);
    $('hostLabel').textContent = currentHost || 'no website detected';

    Array.prototype.forEach.call(document.querySelectorAll('[data-mode]'), function (b) {
      b.classList.toggle('sel', b.getAttribute('data-mode') === mode);
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-strength]'), function (b) {
      b.classList.toggle('sel', b.getAttribute('data-strength') === (s.strength || 'medium'));
    });

    $('globalMode').value = s.global || 'auto';
    $('remember').checked = !!(s.sites && s.sites[currentHost]);
    $('rememberHint').textContent = s.sites && s.sites[currentHost]
      ? 'saved as ' + s.sites[currentHost]
      : 'stores a per-domain preference';
    $('extToggle').setAttribute('aria-pressed', s.enabled !== false ? 'true' : 'false');
    $('statusLine').textContent = s.enabled === false ? 'Disabled' : 'Active';
    $('statusDot').className = 'dot' + (s.enabled === false ? ' off' : '');

    var hints = {
      weak: 'Weak — only major backgrounds and text.',
      medium: 'Medium — cards, buttons, inputs, borders, menus.',
      strong: 'Strong — forces colours on stubborn sites.'
    };
    $('strengthHint').textContent = hints[s.strength] || hints.medium;

    var keys = Object.keys(s.sites || {});
    var list = $('siteList');
    if (!keys.length) {
      list.innerHTML = '<span class="empty">No per-site overrides yet.</span>';
      return;
    }
    list.innerHTML = '';
    keys.sort().forEach(function (k) {
      var row = document.createElement('div');
      row.className = 'siteitem';
      var b = document.createElement('b');
      b.textContent = k;
      var sp = document.createElement('span');
      sp.textContent = s.sites[k];
      var del = document.createElement('button');
      del.textContent = '✕';
      del.title = 'Remove override';
      del.addEventListener('click', function () {
        S.setSite(k, null).then(render);
      });
      row.appendChild(b);
      row.appendChild(sp);
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  function render() {
    return S.read().then(paint);
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-mode]'), function (b) {
    b.addEventListener('click', function () {
      var mode = b.getAttribute('data-mode');
      var remember = $('remember').checked;
      if (remember) S.setSite(currentHost, mode).then(render);
      else S.update({ global: mode }).then(render);
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-strength]'), function (b) {
    b.addEventListener('click', function () {
      S.update({ strength: b.getAttribute('data-strength') }).then(render);
    });
  });

  $('remember').addEventListener('change', function () {
    if (this.checked) S.setSite(currentHost, S.resolve(currentHost)).then(render);
    else S.setSite(currentHost, null).then(render);
  });

  $('globalMode').addEventListener('change', function () {
    S.update({ global: this.value }).then(render);
  });

  $('clearSite').addEventListener('click', function () {
    S.setSite(currentHost, null).then(render);
  });

  $('extToggle').addEventListener('click', function () {
    S.read().then(function (s) {
      return S.update({ enabled: s.enabled === false });
    }).then(render);
  });

  S.bind();

  var q = hostFromQuery();
  if (q) {
    currentHost = q;
    render();
  } else {
    hostFromStorage(function (h) {
      currentHost = h;
      render();
    });
  }
})();