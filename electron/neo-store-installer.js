// "Add in NEXORA Browser" button for Chrome Web Store pages.
//
// This runs in the HOST renderer, not in the page. The visible site layer is a
// DOM <webview> which by design has NO preload (see get-beat-preload in main.js -
// any preload there triggers the black-screen bug), so the guest cannot reach the
// extension engine. The host can: window.electronAPI already exposes the ext:* IPC,
// and safeExecJS(wv, js) evaluates inside the guest through the main process, which
// is how the live store metadata is read.
//
// Usage from ai-browser.html:
//   NeoStoreInstaller.sync({ url, execGuest })   - on every navigation/update
//   NeoStoreInstaller.unmount()                  - when leaving a store page
(function () {
  if (window.NeoStoreInstaller) return;

  var ID_RE = /^[a-p]{32}$/;
  var HOST_ID = 'neo-store-installer-root';
  var current = null;   // { id, name, version, icon }
  var host = null;
  var parts = {};
  var state = { installed: false, installedName: '', busy: false };

  function parseStoreUrl(raw) {
    var s = String(raw || '');
    if (!s) return null;
    var u;
    try { u = new URL(s); } catch (e) { return null; }
    var h = u.hostname.replace(/^www\./, '');
    if (h !== 'chromewebstore.google.com' && h !== 'chrome.google.com') return null;
    var segs = u.pathname.split('/').filter(Boolean);
    for (var i = segs.length - 1; i >= 0; i--) {
      if (ID_RE.test(segs[i])) {
        var slug = '';
        var di = segs.indexOf('detail');
        if (di !== -1 && segs[di + 1] !== segs[i]) slug = segs[di + 1];
        return { id: segs[i], slug: slug };
      }
    }
    return null;
  }

  // Slug fallback so the button is not nameless before the guest scrape lands.
  function nameFromSlug(slug, id) {
    var t = String(slug || '').replace(/-+/g, ' ').trim();
    if (!t) return 'Chrome extension';
    return t.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  var CSS = [
    '#neo-store-installer-root{all:initial;}',
    '#neo-store-installer-root *{box-sizing:border-box;}',
    '#neo-store-installer-root button{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}',
    '.neo-si-btn{display:inline-flex;align-items:center;gap:8px;cursor:pointer;',
    '  height:38px;padding:0 18px;border-radius:999px;font-size:13.5px;font-weight:600;',
    '  letter-spacing:.1px;border:1px solid #1a73e8;background:#1a73e8;color:#fff;',
    '  box-shadow:0 4px 14px rgba(26,115,232,.32);transition:background .15s,box-shadow .15s;}',
    '.neo-si-btn:hover{background:#1765cc;box-shadow:0 6px 18px rgba(26,115,232,.4);}',
    '.neo-si-btn:disabled{opacity:.7;cursor:default;}',
    '.neo-si-btn.is-done{background:#188038;border-color:#188038;box-shadow:0 4px 14px rgba(24,128,56,.3);}',
    '.neo-si-panel{display:none;position:absolute;right:0;bottom:48px;width:340px;z-index:5;',
    '  background:#fff;color:#202124;border:1px solid #dadce0;border-radius:14px;',
    '  box-shadow:0 12px 38px rgba(0,0,0,.24);padding:16px;}',
    '.neo-si-panel.is-open{display:block;}',
    '.neo-si-hd{display:flex;align-items:flex-start;gap:11px;margin-bottom:4px;}',
    '.neo-si-ic{width:40px;height:40px;border-radius:10px;flex:0 0 auto;',
    '  background:#f1f3f4 center/cover no-repeat;}',
    '.neo-si-nm{font-size:14px;font-weight:600;line-height:1.25;word-break:break-word;}',
    '.neo-si-sub{font-size:11.5px;color:#5f6368;margin-top:3px;}',
    '.neo-si-x{margin-left:auto;cursor:pointer;width:27px;height:27px;flex:0 0 auto;',
    '  border:0;border-radius:50%;background:transparent;color:#5f6368;',
    '  font-size:19px;line-height:27px;text-align:center;}',
    '.neo-si-x:hover{background:#f1f3f4;color:#202124;}',
    '.neo-si-msg{font-size:12.5px;line-height:1.5;margin-top:11px;padding:9px 11px;',
    '  border-radius:9px;background:#f8f9fa;color:#3c4043;word-break:break-word;display:none;}',
    '.neo-si-msg.is-err{background:#fce8e6;color:#a50e0e;}',
    '.neo-si-msg.is-ok{background:#e6f4ea;color:#137333;}',
    '.neo-si-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:13px;}',
    '.neo-si-lbl{font-size:11px;font-weight:700;color:#5f6368;margin-top:14px;',
    '  text-transform:uppercase;letter-spacing:.5px;}',
    '.neo-si-in{width:100%;margin-top:6px;height:33px;padding:0 10px;',
    '  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;',
    '  border:1px solid #dadce0;border-radius:8px;background:#fff;color:#202124;}',
    '.neo-si-in:focus{outline:2px solid #1a73e8;outline-offset:-1px;border-color:transparent;}',
    '.neo-si-ghost{display:inline-flex;align-items:center;height:32px;padding:0 13px;',
    '  border-radius:8px;font-size:12.5px;font-weight:600;cursor:pointer;',
    '  border:1px solid #dadce0;background:#fff;color:#1a73e8;}',
    '.neo-si-ghost:hover{background:#f6f9ff;border-color:#c9dcfb;}',
    '.neo-si-hint{font-size:11.5px;color:#5f6368;line-height:1.5;margin-top:13px;',
    '  border-top:1px solid #eceff1;padding-top:10px;}',
    '.neo-si-spin{width:13px;height:13px;border:2px solid rgba(255,255,255,.45);',
    '  border-top-color:#fff;border-radius:50%;animation:neo-si-sp .7s linear infinite;}',
    '@keyframes neo-si-sp{to{transform:rotate(360deg)}}'
  ].join('');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function api() {
    return window.electronAPI || null;
  }

  function setMsg(text, kind) {
    if (!parts.msg) return;
    parts.msg.className = 'neo-si-msg' + (kind ? ' is-' + kind : '');
    parts.msg.textContent = text || '';
    parts.msg.style.display = text ? 'block' : 'none';
  }

  function setBusy(on, label) {
    state.busy = !!on;
    if (!parts.btn) return;
    parts.btn.disabled = !!on;
    parts.btn.innerHTML = on
      ? '<span class="neo-si-spin"></span>' + escapeHtml(label || 'Working')
      : (state.installed ? '&#10003; Installed in NEXORA' : '&#11015; Add in NEXORA Browser');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function closePanel() {
    if (parts.panel) parts.panel.classList.remove('is-open');
    setMsg('', '');
  }

  function openPanel() {
    if (!parts.panel) return;
    parts.panel.classList.add('is-open');
    var a = api();
    if (a && a.extProxyGet && parts.proxy) {
      Promise.resolve(a.extProxyGet()).then(function (r) {
        if (r && parts.proxy && !parts.proxy.value) parts.proxy.value = r.proxy || '';
      }).catch(function () {});
    }
  }

  function mount(info) {
    if (!document.body) return;
    if (host && current && current.id === info.id) return;
    unmount();
    current = info;

    host = el('div');
    host.id = HOST_ID;
    host.setAttribute('data-neo-theme-ignore', '');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483600;right:22px;bottom:22px;';

    var style = el('style');
    style.textContent = CSS;

    var wrap = el('div');
    wrap.style.cssText = 'all:initial;position:relative;display:inline-block;';

    parts.btn = el('button', 'neo-si-btn');
    parts.btn.type = 'button';
    parts.panel = el('div', 'neo-si-panel');

    wrap.appendChild(parts.btn);
    wrap.appendChild(parts.panel);
    host.appendChild(style);
    host.appendChild(wrap);
    document.body.appendChild(host);

    renderPanel();
    setBusy(false);

    parts.btn.addEventListener('click', function () {
      if (state.installed || state.busy) { openPanel(); return; }
      doInstall();
    });

    // Outside click and Escape behave like a real browser popup.
    document.addEventListener('pointerdown', function (e) {
      if (!parts.panel || !parts.panel.classList.contains('is-open')) return;
      var path = e.composedPath ? e.composedPath() : [];
      for (var i = 0; i < path.length; i++) if (path[i] === host) return;
      closePanel();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && parts.panel && parts.panel.classList.contains('is-open')) closePanel();
    }, true);
  }

  function unmount() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    parts = {};
    current = null;
    state = { installed: false, installedName: '', busy: false };
  }

  function renderPanel() {
    if (!parts.panel || !current) return;
    var p = parts.panel;
    p.innerHTML = '';

    var hd = el('div', 'neo-si-hd');
    var ic = el('div', 'neo-si-ic');
    if (current.icon) ic.style.backgroundImage = 'url("' + String(current.icon).replace(/"/g, '') + '")';
    var col = el('div');
    col.appendChild(el('div', 'neo-si-nm', current.name || 'Chrome extension'));
    col.appendChild(el('div', 'neo-si-sub',
      (current.version ? 'v' + current.version + '  ·  ' : '') +
      'Store ID ' + current.id.slice(0, 12) + '…'));
    var x = el('button', 'neo-si-x', '×');
    x.type = 'button';
    x.title = 'Close';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', closePanel);
    hd.appendChild(ic);
    hd.appendChild(col);
    hd.appendChild(x);
    p.appendChild(hd);

    parts.msg = el('div', 'neo-si-msg');
    p.appendChild(parts.msg);

    parts.lbl = el('div', 'neo-si-lbl', 'If Google blocks the download');
    p.appendChild(parts.lbl);

    parts.proxy = el('input', 'neo-si-in');
    parts.proxy.type = 'text';
    parts.proxy.placeholder = 'socks5://127.0.0.1:9050';
    parts.proxy.spellcheck = false;
    p.appendChild(parts.proxy);

    var row = el('div', 'neo-si-row');
    p.appendChild(row);
    addGhost(row, 'Apply proxy', applyProxy);
    addGhost(row, 'Try download again', function () { doInstall(); });
    addGhost(row, 'Official source build', doCatalog);
    addGhost(row, 'Load unpacked folder', function () { doPick('folder'); });
    addGhost(row, 'Choose .crx / .zip', function () { doPick('package'); });

    p.appendChild(el('div', 'neo-si-hint',
      'A proxy applies to NEXORA Browser as a whole, so ordinary pages load through it too. ' +
      'Leave the field empty for a direct connection.'));

    if (state.installed) {
      setMsg('Already installed in NEXORA Browser: ' + (state.installedName || 'this extension') + '.', 'ok');
    }
  }

  function addGhost(row, label, fn) {
    var b = el('button', 'neo-si-ghost', label);
    b.type = 'button';
    b.addEventListener('click', fn);
    row.appendChild(b);
    return b;
  }

  function finishOk(r, what) {
    state.installed = true;
    state.installedName = (r && r.entry && r.entry.name) || (current && current.name) || '';
    if (parts.btn) {
      parts.btn.classList.add('is-done');
      parts.btn.innerHTML = '&#10003; Installed in NEXORA';
    }
    setMsg(what, 'ok');
    return true;
  }

  function doInstall() {
    if (!current) return;
    var a = api();
    if (!a || !a.extWebstoreInstall) {
      setMsg('The NEXORA extension engine is not reachable from this window.', 'err');
      openPanel();
      return;
    }
    setBusy(true, 'Downloading');
    setMsg('Asking Google for the package…', '');
    Promise.resolve(a.extWebstoreInstall(current.id, {
      name: current.name,
      version: current.version,
      icon: current.icon
    })).then(function (r) {
      setBusy(false);
      if (r && r.ok) {
        if (!finishOk(r, (r.message || 'Installed.') +
          ' It is running now and is listed under Extensions.')) return;
        openPanel();
        return;
      }
      if (r && r.proxy && parts.proxy) parts.proxy.value = r.proxy;
      var blocked = r && (r.code === 'blocked' || r.blocked);
      setMsg(blocked
        ? ((r.error || 'Google did not hand over the package.') +
           ' Try a proxy below, an official source build, or load the folder you already have.')
        : ((r && r.error) || 'The install did not work.'), 'err');
      openPanel();
    }).catch(function (e) {
      setBusy(false);
      setMsg('Could not reach the NEXORA extension engine: ' + (e && e.message ? e.message : e), 'err');
      openPanel();
    });
  }

  function applyProxy() {
    var a = api();
    if (!a || !a.extProxySet) return;
    var rule = (parts.proxy && parts.proxy.value || '').trim();
    Promise.resolve(a.extProxySet(rule)).then(function (r) {
      if (r && r.ok) {
        setMsg(rule ? 'Proxy applied to NEXORA Browser. Trying again.'
                    : 'Proxy cleared. Trying again.', 'ok');
        doInstall();
      } else {
        setMsg((r && r.error) || 'That proxy address was rejected.', 'err');
      }
    }).catch(function (e) { setMsg(String(e && e.message ? e.message : e), 'err'); });
  }

  function doCatalog() {
    var a = api();
    if (!a || !a.extWebstoreCatalogLookup || !current) return;
    setBusy(true, 'Installing');
    Promise.resolve(a.extWebstoreCatalogLookup(current.id, current.name)).then(function (r) {
      setBusy(false);
      if (r && r.ok) finishOk(r, 'Installed from the official source build.');
      else setMsg((r && r.error) || 'No official source build is known for this extension.', 'err');
    }).catch(function (e) {
      setBusy(false);
      setMsg(String(e && e.message ? e.message : e), 'err');
    });
  }

  function doPick(kind) {
    var a = api();
    if (!a || !current) return;
    var fn = kind === 'folder' ? a.extPickFolder : a.extPickPackage;
    if (typeof fn !== 'function') { setMsg('That action is unavailable here.', 'err'); return; }
    Promise.resolve(fn()).then(function (r) {
      if (r && r.ok) finishOk(r, 'Installed: ' + ((r.entry && r.entry.name) || 'extension'));
      else if (r && !r.canceled && r.error) setMsg(r.error, 'err');
    }).catch(function (e) { setMsg(String(e && e.message ? e.message : e), 'err'); });
  }

  // Reads the rendered store DOM. The page is an SPA, so plain fetching the URL
  // returns an empty title - only the live guest has the name, version and icon.
  var SCRAPE_JS = '(function(){' +
    'try{' +
      'var o={};' +
      'var h=document.querySelector("h1");' +
      'if(h&&h.textContent.trim())o.name=h.textContent.trim().slice(0,80);' +
      'if(!o.name){var m=document.querySelector(\'meta[property="og:title"]\');' +
        'if(m&&m.content&&m.content.indexOf("Web Store")<0)o.name=m.content.trim().slice(0,80);}' +
      'var n=document.querySelectorAll("div,span,p");' +
      'for(var i=0;i<n.length;i++){' +
        'var m2=/^\\s*(?:version|v)\\s*([0-9][0-9.]{1,18})\\s*$/i.exec(n[i].textContent||"");' +
        'if(m2){o.version=m2[1];break;}}' +
      'var img=document.querySelector(\'img[src*="googleusercontent"],img[src*="ggpht"]\');' +
      'if(img&&img.src)o.icon=img.src;' +
      'return JSON.stringify(o);' +
    '}catch(e){return "{}";}})()';

  function applyMeta(meta) {
    if (!meta || !current || current.id !== meta.id) return;
    var changed = false;
    if (meta.name && meta.name !== current.name) { current.name = meta.name; changed = true; }
    if (meta.version && meta.version !== current.version) { current.version = meta.version; changed = true; }
    if (meta.icon && meta.icon !== current.icon) { current.icon = meta.icon; changed = true; }
    if (changed) renderPanel();
  }

  // Called on every navigation / URL change of the active tab.
  //   execGuest(js) -> Promise<string>  evaluates js inside the live guest
  function sync(opts) {
    var o = opts || {};
    var info = parseStoreUrl(o.url);
    if (!info) {
      if (host) unmount();
      return Promise.resolve(false);
    }
    info.name = info.slug ? nameFromSlug(info.slug, info.id) : 'Chrome extension';
    var alreadyHere = !!(host && current && current.id === info.id);

    var a = api();
    var parseTask = (a && a.extWebstoreParse)
      ? Promise.resolve(a.extWebstoreParse(o.url)).catch(function () { return null; })
      : Promise.resolve(null);

    return parseTask.then(function (r) {
      if (!host || !current || current.id !== info.id) {
        state.installed = !!(r && r.installed);
        state.installedName = (r && r.installedName) || '';
        mount(info);
        if (state.installed) {
          if (parts.btn) parts.btn.classList.add('is-done');
          setMsg('Already installed in NEXORA Browser: ' + (state.installedName || 'this extension') + '.', 'ok');
        }
      }
      if (typeof o.execGuest !== 'function' || alreadyHere) return true;
      return Promise.resolve(o.execGuest(SCRAPE_JS)).then(function (txt) {
        if (!txt) return true;
        var m = null;
        try { m = JSON.parse(String(txt).trim()); } catch (e) {}
        if (m) applyMeta({ id: info.id, name: m.name, version: m.version, icon: m.icon });
        return true;
      }).catch(function () { return true; });
    }).catch(function () { return false; });
  }

  window.NeoStoreInstaller = {
    sync: sync,
    unmount: unmount,
    parseStoreUrl: parseStoreUrl
  };
})();