(function (root) {
  'use strict';

  var Settings = root.NeoThemeSettings;
  if (window.__neoThemeInpageReady) return;
  window.__neoThemeInpageReady = true;

  var HOST_ID = 'neo-universal-theme-root';
  var open = false;
  var host = null;
  var shadow = null;
  var showFn = null;

  function hostLabel() {
    try { return location.hostname || 'this page'; } catch (e) { return 'this page'; }
  }

  function injectRoot() {
    if (document.getElementById(HOST_ID)) {
      host = document.getElementById(HOST_ID);
      shadow = host.shadowRoot;
      return;
    }
    if (!document.documentElement) return;

    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-neo-theme-ignore', '');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:18px;bottom:18px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;';
    host.attachShadow({ mode: 'open' });
    shadow = host.shadowRoot;

    var css = [
      ':host{all:initial;}',
      '*{box-sizing:border-box;}',
      '.fab{width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,.14);',
      'background:linear-gradient(145deg,#1c1c1f,#111113);color:#f5f5f5;display:flex;',
      'align-items:center;justify-content:center;cursor:pointer;font-size:20px;',
      'box-shadow:0 6px 22px rgba(0,0,0,.45);transition:transform .16s ease,box-shadow .16s ease;}',
      '.fab:hover{transform:translateY(-2px) scale(1.04);box-shadow:0 10px 26px rgba(0,0,0,.55);}',
      '.fab[hidden]{display:none;}',
      '.panel{position:absolute;right:0;bottom:54px;width:290px;border-radius:16px;',
      'border:1px solid rgba(255,255,255,.12);background:linear-gradient(180deg,#1b1b1f,#121214);',
      'color:#f5f5f5;padding:16px;box-shadow:0 18px 48px rgba(0,0,0,.6);display:none;}',
      '.panel.open{display:block;animation:pop .16s ease;}',
      '@keyframes pop{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}',
      'h3{margin:0 0 2px;font-size:14px;font-weight:600;letter-spacing:.2px;display:flex;gap:7px;align-items:center;}',
      '.x{margin-left:auto;flex:none;width:24px;height:24px;border-radius:50%;border:none;',
      'background:transparent;color:#9a9aa2;font-size:17px;line-height:22px;cursor:pointer;',
      'padding:0;font-family:inherit;}',
      '.x:hover{background:rgba(255,255,255,.1);color:#f5f5f5;}',
      '.x:focus-visible{outline:2px solid #4da3ff;outline-offset:1px;}',
      '.site{font-size:11px;color:#9a9aa2;margin-bottom:13px;word-break:break-all;}',
      '.lbl{font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:#8b8b93;margin:14px 0 7px;}',
      '.modes{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;}',
      '.modes button{border:1px solid rgba(255,255,255,.13);background:#222226;color:#e6e6ea;',
      'border-radius:10px;padding:9px 4px;font-size:12px;cursor:pointer;display:flex;flex-direction:column;',
      'align-items:center;gap:3px;transition:.14s;}',
      '.modes button:hover{background:#2b2b31;}',
      '.modes button.sel{background:#1d4ed8;border-color:#3b82f6;color:#fff;}',
      '.modes .ico{font-size:15px;}',
      '.strength{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;}',
      '.strength button{border:1px solid rgba(255,255,255,.13);background:#222226;color:#cfcfd6;',
      'border-radius:8px;padding:7px 3px;font-size:11px;cursor:pointer;}',
      '.strength button.sel{background:#334155;border-color:#64748b;color:#fff;}',
      '.row{display:flex;align-items:center;justify-content:space-between;margin-top:13px;',
      'font-size:11.5px;color:#c9c9d1;}',
      '.switch{position:relative;width:38px;height:21px;border-radius:999px;background:#3a3a42;',
      'cursor:pointer;transition:.16s;flex:none;}',
      '.switch.on{background:#2563eb;}',
      '.switch i{position:absolute;top:2.5px;left:2.5px;width:16px;height:16px;border-radius:50%;',
      'background:#fff;transition:.16s;}',
      '.switch.on i{left:19.5px;}',
      'select{width:100%;background:#222226;color:#e6e6ea;border:1px solid rgba(255,255,255,.13);',
      'border-radius:8px;padding:7px 8px;font-size:11.5px;}',
      '.foot{margin-top:14px;padding-top:11px;border-top:1px solid rgba(255,255,255,.09);',
      'display:flex;justify-content:space-between;align-items:center;font-size:10.5px;color:#77777f;}',
      '.foot button{background:none;border:none;color:#4da3ff;cursor:pointer;font-size:10.5px;padding:0;}',
      '.note{margin-top:9px;font-size:10px;color:#7c7c85;display:none;}',
      '.note.show{display:block;}'
    ].join('');

    var style = document.createElement('style');
    style.textContent = css;
    shadow.appendChild(style);

    var wrap = document.createElement('div');
    wrap.innerHTML = [
      '<div class="fab" title="Neo Universal Theme">🎨</div>',
      '<div class="panel">',
      '  <h3>🎨 Neo Universal Theme<button class="x" data-close title="Close" aria-label="Close">×</button></h3>',
      '  <div class="site"></div>',
      '  <div class="lbl">Theme</div>',
      '  <div class="modes">',
      '    <button data-mode="light"><span class="ico">☀️</span>Light</button>',
      '    <button data-mode="dark"><span class="ico">🌙</span>Dark</button>',
      '    <button data-mode="auto"><span class="ico">⚙️</span>Auto</button>',
      '  </div>',
      '  <div class="lbl">Theme Strength</div>',
      '  <div class="strength">',
      '    <button data-strength="weak">Weak</button>',
      '    <button data-strength="medium">Medium</button>',
      '    <button data-strength="strong">Strong</button>',
      '  </div>',
      '  <div class="row"><span>Remember for this website</span><div class="switch" data-toggle="remember"><i></i></div></div>',
      '  <div class="row"><span>Apply to all websites</span><div class="switch" data-toggle="global"><i></i></div></div>',
      '  <div class="lbl">Global Theme</div>',
      '  <select data-global="global">',
      '    <option value="auto">⚙️ Auto (follow system)</option>',
      '    <option value="dark">🌙 Dark — all websites</option>',
      '    <option value="light">☀️ Light — all websites</option>',
      '  </select>',
      '  <div class="note"></div>',
      '  <div class="foot"><span>Neo Universal Theme</span><button data-clear="clear">Reset this site</button></div>',
      '</div>'
    ].join('');

    shadow.appendChild(wrap);

    var fab = shadow.querySelector('.fab');
    var panel = shadow.querySelector('.panel');

    // Close leaves the FAB visible so the popup can be reopened. The FAB was
    // hidden while open only to avoid two overlapping widgets in the same corner.
    function close() {
      open = false;
      panel.classList.remove('open');
      fab.hidden = false;
      try { fab.focus({ preventScroll: true }); } catch (e) {}
    }

    function show() {
      open = true;
      panel.classList.add('open');
      fab.hidden = true;
      refresh();
      try {
        var x = shadow.querySelector('.x');
        if (x) x.focus({ preventScroll: true });
      } catch (e) {}
    }

    fab.addEventListener('click', function () {
      if (open) return;
      show();
    });

    showFn = show;

    shadow.querySelector('.x').addEventListener('click', close);

    // A panel that can only be dismissed by clicking its own open button is a trap
    // on pages where the FAB sits under something, so Escape and an outside click
    // close it too, matching how a browser popup behaves.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && open) { close(); e.stopPropagation(); }
    }, true);

    document.addEventListener('pointerdown', function (e) {
      if (!open) return;
      var path = e.composedPath ? e.composedPath() : [];
      for (var i = 0; i < path.length; i++) {
        if (path[i] === host) return;
      }
      close();
    }, true);

    shadow.querySelectorAll('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        var mode = b.getAttribute('data-mode');
        var useGlobal = shadow.querySelector('[data-toggle="global"]').classList.contains('on');
        var remember = shadow.querySelector('[data-toggle="remember"]').classList.contains('on');
        if (useGlobal) {
          Settings.update({ global: mode });
        } else {
          try {
            window.dispatchEvent(new CustomEvent('neo-theme:set', {
              detail: { mode: mode, persist: remember }
            }));
          } catch (e) {}
        }
        refresh();
      });
    });

    shadow.querySelectorAll('[data-strength]').forEach(function (b) {
      b.addEventListener('click', function () {
        Settings.update({ strength: b.getAttribute('data-strength') });
        refresh();
      });
    });

    shadow.querySelector('[data-toggle="remember"]').addEventListener('click', function () {
      this.classList.toggle('on');
    });

    shadow.querySelector('[data-toggle="global"]').addEventListener('click', function () {
      this.classList.toggle('on');
    });

    shadow.querySelector('[data-global="global"]').addEventListener('change', function () {
      Settings.update({ global: this.value });
    });

    shadow.querySelector('[data-clear="clear"]').addEventListener('click', function () {
      Settings.setSite(hostLabel(), null);
      refresh();
    });

    document.documentElement.appendChild(host);
    shadow = host.shadowRoot;
  }

  function refresh() {
    if (!shadow) return;
    Settings.read().then(function (s) {
      var site = Settings.normalizeHost(hostLabel());
      var mode = Settings.resolve(site);
      shadow.querySelector('.site').textContent = site || 'this page';
      shadow.querySelectorAll('[data-mode]').forEach(function (b) {
        b.classList.toggle('sel', b.getAttribute('data-mode') === mode);
      });
      shadow.querySelectorAll('[data-strength]').forEach(function (b) {
        b.classList.toggle('sel', b.getAttribute('data-strength') === (s.strength || 'medium'));
      });
      shadow.querySelector('[data-toggle="remember"]').classList.toggle('on', !!s.sites[site]);
      shadow.querySelector('[data-global="global"]').value = s.global || 'auto';
      var note = shadow.querySelector('.note');
      if (root.NeoThemeEngine) {
        var st = root.NeoThemeEngine.getState();
        if (st.lastError) {
          note.textContent = 'Neo Theme applied. Some elements could not be modified.';
          note.classList.add('show');
        } else {
          note.classList.remove('show');
        }
      }
    });
  }

  function sync(mode, strength) {
    if (host && host.shadowRoot) {
      var panel = host.shadowRoot.querySelector('.panel');
      if (panel && panel.classList.contains('open')) refresh();
    }
  }

function boot() {
    Settings = root.NeoThemeSettings || Settings;
    if (!Settings) return;
    try {
      injectRoot();
    } catch (e) {}
  }

  if (document.documentElement) boot();
  document.addEventListener('DOMContentLoaded', boot, { once: true });
  window.addEventListener('load', boot, { once: true });

  root.NeoThemeInpage = {
    sync: sync,
    refresh: refresh,
    open: function () {
      if (showFn) { showFn(); return; }
      if (host) { var f = host.shadowRoot.querySelector('.fab'); if (f) f.click(); }
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
