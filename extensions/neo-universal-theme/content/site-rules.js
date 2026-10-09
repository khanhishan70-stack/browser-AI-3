(function (root) {
  'use strict';

  var rules = [];

  function reg(hosts, def) {
    rules.push({
      hosts: Array.isArray(hosts) ? hosts : [hosts],
      onApply: def && def.onApply || null,
      css: (def && def.css) || '',
      priority: (def && def.priority) || 0,
      label: (def && def.label) || 'site rule'
    });
  }

  function hostMatches(rule, host) {
    var h = String(host || '').toLowerCase();
    for (var i = 0; i < rule.hosts.length; i++) {
      var p = String(rule.hosts[i]).toLowerCase();
      if (h === p) return true;
      if (p.charAt(0) === '.' && (h === p.slice(1) || h.endsWith(p))) return true;
      if (h.endsWith('.' + p.replace(/^\./, ''))) return true;
    }
    return false;
  }

  var THEME_VARS = {
    'youtube.com': {
      'ytd-app': 'background:var(--neo-bg) !important;color:var(--neo-text) !important;',
      'ytd-watch-flexy': 'background:var(--neo-bg) !important;',
      'ytd-video-primary-info-renderer': 'color:var(--neo-text) !important;',
      '#header': 'background:var(--neo-surface) !important;',
      'ytd-billboard': 'background:var(--neo-surface) !important;',
      'ytd-popup-container': 'background:var(--neo-surface) !important;',
      'tp-yt-paper-listbox': 'background:var(--neo-surface) !important;color:var(--neo-text) !important;'
    },
    'github.com': {
      '.Header': 'background:var(--neo-surface) !important;border-color:var(--neo-border) !important;',
      '.js-darkening-enabled .Box, .js-darkening-enabled .Box-row': 'background:var(--neo-surface) !important;',
      '#repo-content-pjax-container': 'background:var(--neo-bg) !important;',
      '.Popover-message': 'background:var(--neo-surface-alt) !important;',
      '.flash': 'background:var(--neo-surface-alt) !important;'
    },
    'reddit.com': {
      'shreddit-app': 'background:var(--neo-bg) !important;color:var(--neo-text) !important;',
      'shreddit-comment': 'background:var(--neo-surface) !important;',
      'faceplate-tracker': 'background:var(--neo-surface-alt) !important;',
      'shreddit-async-loader': 'background:var(--neo-surface-alt) !important;'
    },
    'google.com': {
'#top_nav': 'background:var(--neo-bg) !important;color:var(--neo-text) !important;',
        'body:not(.srp)': 'background:var(--neo-bg) !important;color:var(--neo-text) !important;',
        // Google draws the search box with a shadow on a transparent textarea.
        // Both need explicit surfaces or the field disappears into the page.
        'textarea[name="q"],input[name="q"]': 'background:transparent !important;',
        '.RNNXgb,.M8OgIe,[role="combobox"]': 'background:var(--neo-surface) !important;',
        '#search,form[role="search"]': 'background:transparent !important;'
      },
    'wikipedia.org': {
      '.mw-page-container': 'background:var(--neo-bg) !important;',
      '.vector-footer': 'background:var(--neo-surface) !important;'
    },
    'stackoverflow.com': {
      '.topbar,.top-bar': 'background:var(--neo-surface) !important;color:var(--neo-text) !important;',
      '.s-sidebarwidget': 'background:var(--neo-surface) !important;',
      '.js-grip-focused .s-postsummary': 'background:var(--neo-surface) !important;'
    },
    'mail.google.com': {
      '.aG': 'background:var(--neo-bg) !important;',
      '.aT': 'background:var(--neo-surface) !important;'
    }
  };

  function themeCssFor(host) {
    var map = null;
    var h = String(host || '').toLowerCase();
    var keys = Object.keys(THEME_VARS);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (h === k || h.endsWith('.' + k)) { map = THEME_VARS[k]; break; }
    }
    if (!map) return '';
    var out = [];
    Object.keys(map).forEach(function (sel) {
      out.push(sel + '{' + map[sel] + '}');
    });
    return out.join('\n');
  }

  reg('*', {
    label: 'base',
    priority: 0,
    onApply: function (ctx) {
      ctx.injectCss(themeCssFor(ctx.host));
      var rule = pick(ctx.host);
      if (rule && rule.onApply) {
        try { rule.onApply(ctx); } catch (e) {}
      }
    }
  });

  function pick(host) {
    var best = null;
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.priority <= 0) continue;
      if (hostMatches(r, host)) {
        if (!best || r.priority > best.priority) best = r;
      }
    }
    return best;
  }

  root.NeoSiteRules = {
    register: reg,
    pick: pick,
    themeCssFor: themeCssFor,
    rules: rules,
    hostMatches: hostMatches
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
