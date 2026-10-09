'use strict';
/* ============================================================================
 * NEXORA SHIELDS - Brave-style ads & trackers blocking for NEXORA Browser
 * ----------------------------------------------------------------------------
 * A real filtering engine (@cliqz/adblocker) driven by EasyList + EasyPrivacy
 * (downloaded + cached + updatable), split at compile time into independently
 * toggleable category engines:
 *
 *   ads       <- EasyList (network rules, minus $popup)
 *   trackers  <- EasyPrivacy (network rules, minus analytics subset)
 *   analytics <- EasyPrivacy (analytics-token subset)
 *   popups    <- $popup rules from EasyList + EasyPrivacy
 *   malicious <- bundled curated malicious/phishing/miner hosts list
 *   (cosmetic) EasyList with cosmetic load for in-page element hiding
 *
 * The module owns the (single) onBeforeRequest webRequest listener on each
 * session - Electron only allows one such listener per session, so this MUST
 * replace the old hardcoded AD_BLOCK_DOMAINS handler in main.js.
 *
 * Persistent state lives under  userData/neo-shields/:
 *   settings.json       <- global on/off + category toggles + list toggles
 *   site-overrides.json <- per-site shields off (keyed by eTLD+1)
 *   lists/<name>.txt    <- cached filter list text
 *   engines/<key>.bin   <- compiled+serialized category engines
 * ========================================================================= */

const { app, ipcMain, session } = require('electron');
const { FiltersEngine, Request, fromElectronDetails } = require('@cliqz/adblocker-electron');
const { parse: parseDomain } = require('tldts');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const LISTS = {
  easylist: {
    id: 'easylist',
    label: 'EasyList',
    url: 'https://easylist.to/easylist/easylist.txt',
    category: 'ads',
  },
  easyprivacy: {
    id: 'easyprivacy',
    label: 'EasyPrivacy',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    category: 'trackers', // also feeds 'analytics' + 'popups'
  },
  // Brave/uBlock-tier coverage. EasyList alone misses large swaths of modern
  // ad networks; these extend network + cosmetic coverage dramatically.
  ubofilters: {
    id: 'ubofilters',
    label: 'uBlock Origin filters',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
    category: 'ads',
  },
  adguard: {
    id: 'adguard',
    label: 'AdGuard Base',
    url: 'https://filters.adtidy.org/extension/ublock/filters/2.txt',
    category: 'ads',
  },
  peterlow: {
    id: 'peterlow',
    label: "Peter Lowe's ad server list",
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext',
    category: 'ads',
  },
  // Live malware/redirector domain feed. Feeds the 'malicious' engine which
  // (unlike ads/trackers) is also allowed to CANCEL main-frame navigations so
  // redirect-based ad hijacks get stopped, Brave-style.
  urlhaus: {
    id: 'urlhaus',
    label: 'Malware domains (URLhaus)',
    url: 'https://urlhaus.abuse.ch/downloads/hostfile/',
    category: 'malicious',
  },
};

// Which lists feed which engine. `ads` is the big network-blocking engine,
// `cosmetic` hides in-page ad elements, `popups` catches window.open traffic.
const ADS_LISTS = ['easylist', 'ubofilters', 'adguard', 'peterlow'];
const COSMETIC_LISTS = ['easylist', 'ubofilters', 'adguard'];
const POPUP_LISTS = ['easylist', 'easyprivacy', 'ubofilters', 'adguard'];

// Analytics-token subset of EasyPrivacy. The union of everything that matches
// this regex (analytics engine) plus everything that does not (trackers
// engine) is exactly EasyPrivacy - toggling either category cannot leak the
// other's rules.
const ANALYTICS_RE = /\b(?:googletagmanager|google-analytics|gtag(?:\.js)?|\bga\.js|mixpanel|\bsegment\b|amplitude|heap\.io|fullstory|mouseflow|hotjar|smartlook|crazyegg|luckyorange|clicktale|inspectlet|sessioncam|optimizely|vwo|abtest|abtasty|visualwebsiteoptimizer|appdynamics|applicationinsights|telemetry|sentry|raygun|rollbar|datadog|newrelic|kissmetrics|chartbeat|quantcast|parsely|similarweb|alexa|crazyegg|lnkd\.|pixel\.facebook|connect\.facebook|beacon|analys|metrics|stats)\b/i;

// ABP filter options live after '$' as a comma-separated list. A rule is a
// popup rule iff one option token is exactly 'popup' (not '~popup').
function isPopupRule(line) {
  const i = line.indexOf('$');
  if (i === -1) return false;
  const opts = line.slice(i + 1).split(',');
  for (let j = 0; j < opts.length; j++) {
    if (opts[j].trim().toLowerCase() === 'popup') return true;
  }
  return false;
}
// @cliqz/adblocker does NOT implement the `$popup` option - it silently drops
// such filters. Since our popup engine is consulted ONLY for window.open URLs,
// we can safely remove the `popup` token and keep the rest of the rule, turning
// it into a normal host/path filter that we test against the popup URL.
function stripPopupOption(line) {
  const i = line.indexOf('$');
  if (i === -1) return line;
  const kept = line.slice(i + 1).split(',').filter((o) => o.trim().toLowerCase() !== 'popup');
  if (kept.length === 0) return line.slice(0, i);
  return line.slice(0, i) + '$' + kept.join(',');
}
const ENG_DAYS_TO_REFRESH = 7;     // auto-refresh lists if older than this
const AUTO_CHECK_MS = 24 * 60 * 60 * 1000;

const CATEGORY_LABELS = {
  ads: 'Ads',
  trackers: 'Trackers',
  analytics: 'Analytics',
  popups: 'Popups',
  malicious: 'Malicious Domains',
};

const DEFAULT_SETTINGS = {
  enabled: true,
  categories: { ads: true, trackers: true, analytics: true, popups: true, malicious: true },
  lists: { easylist: true, easyprivacy: true },
};

// Small honest curate-of-comments: bundled malicious/miner/phishing hosts.
// Kept as a real ABP-syntax list (updatable in-app later), completes the
// 'Malicious Domains' category without depending on an unstable 3rd source.
const BUNDLED_MALICIOUS_HEADER = [
  '! NEXORA Malicious / Crypto-Miner / Phishing block list (bundled)',
  '! Format-compatible with EasyList/ABP syntax.',
  '',
];
const BUNDLED_MALICIOUS = [
  '||coinhive.com^', '||coin-hive.com^', '||crypto-loot.com^', '||minero.cc^',
  '||coinimp.com^', '||webmine.cz^', '||reasedoper.pw^', '||javapipe.com^',
  '||minemytraffic.com^', '||coin-have.com^', '||coinnebula.com^', '||kizocoin.com^',
  '||coinerra.com^', '||moneyminer.com^', '||coinblind.com^', '||coinlab.org^',
  '||minr.pw^', '||minexmr.com^', '||coiner.site^', '||coinminer.site^',
  '||jsecoin.com^', '||mining.biz^', '||monerominer.com^', '||crypto-webminer.com^',
  '||lollipap.com^', '||webminerpool.com^', '||afminer.com^', '||mineralt.io^',
  '||cryptoloot.pro^', '||ad-miner.com^', '||cryptotab.farm^', '||coinhive.xyz^',
  '||cryptonight.js^', '||cryptonight.min.js^',
  '||popads.net^', '||pops.us^', '||popcash.net^', '||popunder.net^',
  '||popadscdn.net^', '||clickunder.com^', '||propellerads.com^',
  '||trafficfactory.com^', '||trafficjunky.com^', '||trafficfuel.com^',
  '||pushnative.com^', '||adsterra.com^', '||adbucks.com^', '||ad-maven.com^',
  '||adf.ly^', '||bc.vc^', '||ouo.io^', '||sh.st^', '||shorte.st^',
  '||paypopup.com^', '||popup.tips^', '||popupmaker.com^', '||popuptraffic.com^',
  // Observed redirect hijackers (scam landing pages). watchanimeworld-style
  // pirate sites force-navigate the whole tab to these. Blocking the malicious
  // engine CANCELS those main-frame navigations (see makeHandler).
  '||decafeligiblyhad.com^', '||getbollywoodupdates.com^',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function dataDir() {
  const dir = path.join(app.getPath('userData'), 'neo-shields');
  return dir;
}
function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (e) {}
  return p;
}
function jsonRead(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  return fallback;
}
function jsonWrite(file, data) {
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {}
}
function sha256(str) {
  return crypto.createHash('sha256').update(String(str || '')).digest('hex');
}
// eTLD+1 of any URL/host using tldts (public suffix aware).
function eTLD1(input) {
  try {
    if (!input) return '';
    let url = input;
    if (!/^[a-zA-Z]+:\/\//.test(url) && input.indexOf('://') === -1 && input.indexOf('.') !== -1) {
      url = 'http://' + url;
    }
    const p = parseDomain(url);
    return (p.domain || p.hostname || '').toLowerCase();
  } catch (e) {
    return '';
  }
}

// YouTube ad requests that EasyList does not reliably cover. Returns true when
// the URL is a known YouTube ad/telemetry endpoint or a googlevideo ad segment.
const YT_AD_PATHS = [
  '/api/stats/ads',
  '/pagead',
  '/ptracking',
  '/youtubei/v1/ads',
  '/ad_break',
  '/youtubei/v1/player/ads',
  '/get_midroll_info',
  '/instream_ad_status',
  '/adunit'
];
function isYouTubeAdRequest(url) {
  const u = String(url || '').toLowerCase();
  // Ad video segments served from the CDN (content segments have no adformat).
  if (u.indexOf('googlevideo.com') !== -1 && u.indexOf('/videoplayback') !== -1) {
    if (/[?&](adformat=|adurl=|oad=|ctier=l)/.test(u)) return true;
  }
  // Dedicated YouTube ad-serving hosts.
  if (/\/\/(ads\.youtube\.com|youtubeadvertising\.com)\//.test(u)) return true;
  if (u.indexOf('youtube.com') === -1 && u.indexOf('youtube-nocookie.com') === -1) {
    return false;
  }
  for (let i = 0; i < YT_AD_PATHS.length; i++) {
    if (u.indexOf(YT_AD_PATHS[i]) !== -1) return true;
  }
  return false;
}

// Hosts Spotify relies on for playback (page, API/possession, player assets,
// and the audio CDN). EasyList contains rules targeting these that break
// ad-supported (Free) playback — the ads and the music stream from the same
// CDN, so blocking the endpoints makes every track fail with "Something went
// wrong". These hosts are allowlisted ONLY while the SOURCE page is Spotify,
// so Spotify embeds on other sites are not protected and ads/trackers elsewhere
// stay fully blocked.
const SPOTIFY_STREAM_HOSTS = [
  'spotify.com',              // open./play. page + api/scdn of possession token
  'spotifycdn.com',           // player scripts + audio-files
  'spotifycdn.net',           // alternate asset CDN
  'spotify.com.edgesuite.net',// legacy audio CDN (audio-ak-spotify-com)
  'scdn.co',                  // artist images / media assets
  'akamaized.net',            // audio CDN (audio-ak-spotify-com.akamaized.net)
  'fastly.net',               // audio-ak-spotify-com.global.ssl.fastly.net
];
function hostOf(input) {
  try {
    return (new URL(input).hostname || '').toLowerCase();
  } catch (e) {
    return '';
  }
}
function isSpotifyPlaybackHost(url, sourceSite) {
  if (sourceSite !== 'spotify.com') return false;
  const host = hostOf(url);
  if (!host) return false;
  for (let i = 0; i < SPOTIFY_STREAM_HOSTS.length; i++) {
    const h = SPOTIFY_STREAM_HOSTS[i];
    if (host === h || host.endsWith('.' + h)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// NeoShields
// ---------------------------------------------------------------------------
class NeoShields {
  constructor(opts) {
    opts = opts || {};
    this.dir = ensureDir(dataDir());
    this.listsDir = ensureDir(path.join(this.dir, 'lists'));
    this.enginesDir = ensureDir(path.join(this.dir, 'engines'));

    this.settings = Object.assign({}, DEFAULT_SETTINGS, jsonRead(path.join(this.dir, 'settings.json'), {}));
    this.siteOverrides = jsonRead(path.join(this.dir, 'site-overrides.json'), {});
    this.listMeta = jsonRead(path.join(this.dir, 'meta.json'), {});

    // eng: { ads, trackers, analytics, popups, malicious, cosmetic }
    this.eng = {};
    this.engReady = { ads: false, trackers: false, analytics: false, popups: false, malicious: false };
    this.listStatus = {}; // id -> { status, lastUpdated, error }

    this.stats = { site: null, perSite: { ads: 0, trackers: 0, analytics: 0, popups: 0, malicious: 0, total: 0, requests: 0 } };
    this.globalStats = { ads: 0, trackers: 0, analytics: 0, popups: 0, malicious: 0, total: 0, requests: 0 };
    this._statsTimer = null;
    this._pubRate = 500;
    this._sessions = [];
    this._registered = false;
    this._lastMainFrameSite = null;
    this._logger = opts.logger || (() => {});
    this._mainWin = opts.getMainWindow || null;
  }

  // ---- persistence ---------------------------------------------------------
  _saveSettings() { jsonWrite(path.join(this.dir, 'settings.json'), this.settings); }
  _saveOverrides() { jsonWrite(path.join(this.dir, 'site-overrides.json'), this.siteOverrides); }
  _saveMeta() { jsonWrite(path.join(this.dir, 'meta.json'), this.listMeta); }

  _listFile(id) { return path.join(this.listsDir, id + '.txt'); }
  _engineFile(key) { return path.join(this.enginesDir, key + '.bin'); }

  _readListCache(id) {
    try {
      const f = this._listFile(id);
      if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
    } catch (e) {}
    return null;
  }
  _writeListCache(id, text) {
    try { fs.writeFileSync(this._listFile(id), text); } catch (e) {}
  }
  _readEngineCache(key) {
    try {
      const f = this._engineFile(key);
      if (fs.existsSync(f)) return fs.readFileSync(f);
    } catch (e) {}
    return null;
  }
  _writeEngineCache(key, bin) {
    try { fs.writeFileSync(this._engineFile(key), Buffer.from(bin)); } catch (e) {}
  }

  // ---- public queries -------------------------------------------------------
  getState() {
    const lists = Object.keys(LISTS).map((id) => {
      const m = this.listMeta[id] || {};
      const stStatus = this.listStatus[id] || {};
      return {
        id: id,
        label: LISTS[id].label,
        category: LISTS[id].category,
        enabled: this.settings.lists[id] !== false,
        installed: !!this._readListCache(id),
        status: stStatus.status || (m.lastUpdated ? 'ok' : 'not-installed'),
        lastUpdated: stStatus.lastUpdated || m.lastUpdated || null,
        error: stStatus.error || null,
      };
    });
    return {
      enabled: !!this.settings.enabled,
      categories: this.settings.categories,
      lists: lists,
      malicious: { installed: true, status: 'ok' },
      engineReady: Object.keys(this.engReady).filter((k) => this.engReady[k]),
    };
  }

  getSiteState(url) {
    const site = eTLD1(url);
    const stats = this.stats.site === site ? this.stats.perSite : { ads: 0, trackers: 0, analytics: 0, popups: 0, malicious: 0, total: 0, requests: 0 };
    return {
      site: site,
      disabled: this.siteOverrides[site] === false,
      stats: stats,
      global: this.globalStats,
    };
  }

  // ---- per-site -------------------------------------------------------------
  setSiteDisabled(url, disabled) {
    const site = eTLD1(url);
    if (disabled) this.siteOverrides[site] = false;
    else delete this.siteOverrides[site];
    this._saveOverrides();
    return { site: site, disabled: disabled };
  }

  // ---- settings toggles -----------------------------------------------------
  setGlobalEnabled(enabled) {
    this.settings.enabled = !!enabled;
    this._saveSettings();
    return this.settings.enabled;
  }

  setCategory(key, enabled) {
    if (this.settings.categories) this.settings.categories[key] = !!enabled;
    this._saveSettings();
    return this.settings.categories;
  }

  setListEnabled(id, enabled) {
    this.settings.lists[id] = !!enabled;
    this._saveSettings();
    // Rebuild the engine(s) this list feeds so toggling actually takes effect.
    if (Object.prototype.hasOwnProperty.call(LISTS, id)) this._rebuildForList(id);
    return this.settings.lists;
  }

  // ---- webRequest pipeline (ONE handler per session) ------------------------
  // Handles: favicon suppression, main-frame stats reset, per-site off,
  // category engines, stats + publish. MUST be the only onBeforeRequest on the
  // session.
  makeHandler() {
    return (details, callback) => {
      try {
        const url = details.url || '';
        if (!url) { callback({}); return; }

        // Chromium internal favicon -> transparent 1x1 (matches old behavior).
        if (url.indexOf('faviconv2') !== -1) {
          callback({ redirectURL: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' });
          return;
        }
        if (!/^https?:\/\//i.test(url)) { callback({}); return; }
        if (this.settings.enabled !== true) { callback({}); return; }

        // Main frame = navigation. Reset the per-site counter when the site
        // key changes (fresh page-load stats like Brave). Only the MALICIOUS
        // engine may cancel a navigation - this is the redirect-hijack
        // firewall (stops pirate sites force-navigating to scam landers) and
        // mirrors Brave's always-on malware protection.
        if (details.resourceType === 'mainFrame') {
          const site = eTLD1(url);
          if (this.stats.site !== site) {
            this.stats.site = site;
            this.stats.perSite = { ads: 0, trackers: 0, analytics: 0, popups: 0, malicious: 0, total: 0, requests: 0 };
          }
          if (/^https?:/i.test(url) && this.settings.categories && this.settings.categories.malicious !== false && this.engReady.malicious && this.eng.malicious) {
            try {
              const rq = fromElectronDetails(details);
              const res = this.eng.malicious.match(rq);
              if (res && res.match === true) {
                const att = this._lastMainFrameSite || site;
                this._count(att, 'malicious');
                callback({ cancel: true });
                return;
              }
            } catch (e) {}
          }
          this._lastMainFrameSite = site;
          callback({});
          return;
        }

        // Per-site shields off: any request whose SOURCE page is a disabled
        // site passes. Reconstruct source from referrer (fallback: tab URL).
        let sourceUrl = details.referrer || '';
        if (!sourceUrl) {
          try {
            const wc = details.webContentsId ? require('electron').webContents.fromId(details.webContentsId) : null;
            if (wc && !wc.isDestroyed()) sourceUrl = wc.getURL() || '';
          } catch (e) {}
        }
        const sourceSite = eTLD1(sourceUrl);
        if (sourceSite && this.siteOverrides[sourceSite] === false) { callback({}); return; }

        // Spotify playback-critical hosts always pass (see SPOTIFY_STREAM_HOSTS
        // above) — EasyList breaks ad-supported Spotify otherwise.
        if (sourceSite && isSpotifyPlaybackHost(url, sourceSite)) { callback({}); return; }

        // Build adblocker Request directly from Electron details.
        let request;
        try {
          request = request || fromElectronDetails(details);
        } catch (e) {}

        // Run category engines in deterministic priority. First match wins for
        // attribution; any match blocks.
        const order = ['ads', 'analytics', 'trackers', 'malicious'];
        let blockedCat = null;

        // Guaranteed YouTube ad-request blocking. EasyList misses most of the
        // in-page YouTube ad/telemetry endpoints and the googlevideo ad
        // segments, so match them explicitly when the Ads category is on.
        // Checked FIRST so the first-party guard below can never disable it.
        if (this.settings.categories && this.settings.categories.ads !== false) {
          if (isYouTubeAdRequest(url)) blockedCat = 'ads';
        }

        // First-party guard. A generic list rule that matches the site's OWN
        // host/path (e.g. youtube.com/playlist, a site's own /ads/ bundle) stops
        // the page from ever finishing its bootstrap, which is what produces the
        // "half-rendered page / missing buttons / never loads" glitches. Real ad
        // networks are third-party (doubleclick, googlesyndication, ...) so they
        // still match below; only genuine first-party code is let through, and
        // first-party ad SLOTS are still hidden by cosmetic rules + DOM cleaning.
        if (!blockedCat) {
          const frameSite = this._lastMainFrameSite || '';
          const reqSite = eTLD1(url);
          if (frameSite && reqSite && frameSite === reqSite) {
            callback({});
            return;
          }
        }

        for (let i = 0; i < order.length && !blockedCat; i++) {
          const key = order[i];
          if (this.settings.categories && this.settings.categories[key] !== false && this.engReady[key]) {
            try {
              const res = this.eng[key].match(request);
              if (res && res.match === true) { blockedCat = key; break; }
            } catch (e) {}
          }
        }
        if (!blockedCat) { callback({}); return; }

        // Count (per-site + global) with the source site if known, else the
        // request's own host (fallback attribution).
        const attSite = sourceSite || eTLD1(url);
        if (attSite) this._count(attSite, blockedCat);

        callback({ cancel: true });
      } catch (e) {
        callback({});
      }
    };
  }

  _count(attSite, cat) {
    const g = this.globalStats;
    g[cat] = (g[cat] || 0) + 1;
    g.total = (g.total || 0) + 1;
    try {
      const s = this.stats;
      if (s.site === attSite) {
        const p = s.perSite;
        p[cat] = (p[cat] || 0) + 1;
        p.total = (p.total || 0) + 1;
      }
    } catch (e) {}
    this._schedulePublish();
  }

  _schedulePublish() {
    if (this._statsTimer) return;
    this._statsTimer = setTimeout(() => {
      this._statsTimer = null;
      this._publishStats();
    }, this._pubRate);
  }
  _publishStats() {
    const win = this._mainWin ? this._mainWin() : null;
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('shields:stats', { global: this.globalStats }); } catch (e) {}
    }
  }

  // Redirect-hijack firewall for window.open: if the target URL matches the
  // malicious engine, deny the new window/tab outright. Complements the
  // main-frame cancel in makeHandler (which covers in-tab navigations).
  shouldBlockMalicious(url) {
    try {
      if (typeof url !== 'string' || !/^https?:/i.test(url)) return false;
      if (this.settings.enabled !== true) return false;
      if (this.settings.categories && this.settings.categories.malicious === false) return false;
      if (!this.engReady.malicious || !this.eng.malicious) return false;
      const request = Request.fromRawDetails({ url: url, type: 'document' });
      const res = this.eng.malicious.match(request);
      return !!(res && res.match === true);
    } catch (e) {
      return false;
    }
  }

  // Popup window blocking (used from setWindowOpenHandler). $popup rules only
  // match requests typed 'popup', which webRequest never surfaces - window
  // open is where popups actually happen.
  shouldBlockPopup(url, sourceUrl) {
    try {
      if (this.settings.enabled !== true) return false;
      if (this.settings.categories && this.settings.categories.popups === false) return false;
      const src = sourceUrl || '';
      const sourceSite = eTLD1(src);
      if (sourceSite && this.siteOverrides[sourceSite] === false) return false;
      if (!this.engReady.popups || !this.eng.popups) return false;
      const request = Request.fromRawDetails({ url: url, sourceUrl: src || undefined, type: 'document' });
      const res = this.eng.popups.match(request);
      if (res && res.match === true) {
        const att = sourceSite || eTLD1(url);
        if (att) this._count(att, 'popups');
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // Cosmetic CSS + scriptlet injections for in-page element hiding and
  // anti-ad-script neutralization on the visible page. Returns BOTH the styles
  // sheet (pushed via insertCSS) and the JS injections (run with
  // executeJavaScript), which together match Brave/uBlock's cosmetic tier.
  getCosmetic(url) {
    try {
      if (this.settings.enabled !== true) return { css: '', injections: '' };
      if (this.settings.categories && this.settings.categories.ads === false) return { css: '', injections: '' };
      const site = eTLD1(url);
      if (site && this.siteOverrides[site] === false) return { css: '', injections: '' };
      const parsed = parseDomain(url);
      let css = '';
      let injections = '';
      if (this.engReady.cosmetic && this.eng.cosmetic) {
        const out = this.eng.cosmetic.getCosmeticsFilters({
          url: url,
          hostname: parsed.hostname || '',
          domain: parsed.domain || '',
          getBaseRules: true,
          getInjectionRules: true,
          getExtendedRules: false,
          getRulesFromHostname: true,
          getRulesFromDOM: false,
          callerContext: { frameId: 0, processId: 0 },
        });
        const styles = out.styles || '';
        css = typeof styles === 'string' ? styles : (Array.isArray(styles) ? styles.join('\n') : '');
        injections = typeof out.injections === 'string' ? out.injections : (Array.isArray(out.injections) ? out.injections.join('\n') : '');
      }
      // YouTube overlay/banner ad containers (the in-stream ad itself is
      // skipped by isYouTubeAdRequest blocking the ad video segment).
      if (site === 'youtube.com' || site === 'youtube-nocookie.com' || site === 'youtu.be') {
        css += '\n.ytp-ad-overlay-container,.ytp-ad-module,.ytp-ad-image-overlay,' +
               '.ytp-ad-text-overlay,.ytp-ad-progress-list,.ytd-action-companion-ad-renderer,' +
               'ytd-display-ad-renderer,ytd-promoted-sparkles-web-renderer,ytd-ad-slot-renderer,' +
               '#player-ads,.ytd-banner-promo-renderer{display:none !important;visibility:hidden !important;}';
      }
      return { css: css, injections: injections };
    } catch (e) {
      return { css: '', injections: '' };
    }
  }

  // Back-compat: CSS only.
  getCosmeticCSS(url) {
    return (this.getCosmetic(url) || {}).css || '';
  }

  // ---- filter list & engine management --------------------------------------
  async init() {
    try {
      // Load category engines. Fails fast if no cache yet - build is async and
      // non-blocking below, handler passes everything until ready.
      for (const key of ['ads', 'trackers', 'analytics', 'popups', 'malicious', 'cosmetic']) {
        await this._ensureEngine(key);
      }
      this._publishReady();
      this._checkAutoUpdate();
      setInterval(() => this._checkAutoUpdate(), AUTO_CHECK_MS);
    } catch (e) {
      this._logger('shields init error: ' + e.message);
      setTimeout(() => this.init(), 10 * 1000); // retry in 10s (network race)
    }
  }

  _publishReady() {
    const win = this._mainWin ? this._mainWin() : null;
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('shields:state', this.getState()); } catch (e) {}
    }
  }

  _listEnabled(id) {
    return this.settings && this.settings.lists ? this.settings.lists[id] !== false : true;
  }

  // Merge the raw text of several list ids (respecting per-list on/off) into a
  // single feed string + its hash.
  async _mergeLists(ids) {
    const parts = [];
    for (let i = 0; i < ids.length; i++) {
      if (!this._listEnabled(ids[i])) continue;
      const t = await this._cachedOrDownload(ids[i]);
      if (t) parts.push(t);
    }
    const text = parts.join('\n');
    return { text: text, hash: sha256(text) };
  }

  async _ensureEngine(key) {
    // Which source text(s) feed this engine?
    let text = '';
    let hash = '';
    let cacheEngine = false;
    if (key === 'ads') {
      const m = await this._mergeLists(ADS_LISTS);
      // Strip headers + pure-$popup lines from each list before merging (same
      // pre-processing the old single-list path applied).
      const net = String(m.text || '').split('\n').filter((l) => {
        const t = l.trim();
        if (!t || t[0] === '!' || t[0] === '[' || t[0] === '#' || t.startsWith('! ') || t.startsWith('[')) return false;
        if (isPopupRule(t)) return false;
        return true;
      });
      text = net.join('\n');
      hash = m.hash;
      cacheEngine = true;
    } else if (key === 'trackers') {
      if (this._listEnabled('easyprivacy')) {
        text = await this._cachedOrDownload('easyprivacy');
        text = this._splitList(text).trackers;
        cacheEngine = true;
      } else { text = ''; }
    } else if (key === 'analytics') {
      if (this._listEnabled('easyprivacy')) {
        text = await this._cachedOrDownload('easyprivacy');
        text = this._splitList(text).analytics;
        cacheEngine = true;
      } else { text = ''; }
    } else if (key === 'popups') {
      const popLines = [];
      for (let i = 0; i < POPUP_LISTS.length; i++) {
        const id = POPUP_LISTS[i];
        if (!this._listEnabled(id)) continue;
        const t = await this._cachedOrDownload(id);
        if (t) {
          const p = this._splitList(t).popups;
          if (p) popLines.push(p);
        }
      }
      text = popLines.join('\n').split('\n').filter(Boolean).map(stripPopupOption).join('\n');
      cacheEngine = true;
    } else if (key === 'malicious') {
      // Bundled curated list + the live URLhaus malware-host feed (cached +
      // auto-updated like the other lists). Parses hosts-format fine.
      let extra = '';
      if (this._listEnabled('urlhaus')) {
        const t = await this._cachedOrDownload('urlhaus');
        if (t) extra = t;
      }
      text = BUNDLED_MALICIOUS_HEADER.join('\n') + '\n' + BUNDLED_MALICIOUS.join('\n') + '\n' + extra;
      cacheEngine = true;
    } else if (key === 'cosmetic') {
      const m = await this._mergeLists(COSMETIC_LISTS);
      text = m.text;
      hash = m.hash;
      cacheEngine = true;
    }

    if (!text) {
      this.engReady[key] = false;
      return;
    }

    hash = hash || sha256(text);
    // Try serialized cache first (fast boot) unless source changed.
    if (cacheEngine) {
      const cached = this._readEngineCache(key);
      if (cached && this.listMeta[key + ':hash'] === hash) {
        try {
          const cfg = key === 'cosmetic'
            ? { loadNetworkFilters: true, loadCosmeticFilters: true }
            : { loadNetworkFilters: true, loadCosmeticFilters: false };
          this.eng[key] = FiltersEngine.deserialize(cached, cfg);
          this.engReady[key] = true;
          this._logger('shields: loaded ' + key + ' from cache (' + JSON.stringify(this.eng[key] ? this.eng[key].getFilters() : '') + ')');
          return;
        } catch (e) {
          this._logger('shields: cache miss ' + key + ': ' + e.message);
        }
      }
    }

    // Fabricate text if we produced it via split (avoid re-parsing full list).
    // Code-path: _splitList returned a subset line string already in `text`.
    try {
      const cfg = key === 'cosmetic'
        ? { loadNetworkFilters: true, loadCosmeticFilters: true }
        : { loadNetworkFilters: true, loadCosmeticFilters: false };
      const start = Date.now();
      const engine = await FiltersEngine.parse(text, cfg);
      this.eng[key] = engine;
      this.engReady[key] = true;
      this._logger('shields: compiled ' + key + ' (' + (engine.getFilters().networkFilters || 0) + ' net) in ' + (Date.now() - start) + 'ms');
      if (cacheEngine) {
        try {
          const bin = engine.serialize();
          this._writeEngineCache(key, bin);
          this.listMeta[key + ':hash'] = hash;
          this._saveMeta();
        } catch (e) {}
      }
    } catch (e) {
      this.engReady[key] = false;
      this._logger('shields: FAILED compile ' + key + ': ' + e.message);
    }
  }

  // Download + cache a list (or reuse cached) and refresh its meta.
  async _cachedOrDownload(id, force) {
    const cached = this._readListCache(id);
    const meta = this.listMeta[id] || {};
    const stale = !meta.lastUpdated || (Date.now() - meta.lastUpdated) > ENG_DAYS_TO_REFRESH * 86400000;
    if (cached && !force && !stale) return cached;
    if (cached && !force) return cached; // keep using while we try to refresh async

    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(LISTS[id].url, { signal: ctrl.signal });
      clearTimeout(to);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (!text || text.length < 1000) throw new Error('list too small (' + text.length + ')');
      this._writeListCache(id, text);
      this.listMeta[id] = Object.assign({}, meta, { lastUpdated: Date.now(), bytes: text.length, hash: sha256(text) });
      this.listStatus[id] = { status: 'ok', lastUpdated: Date.now() };
      this._saveMeta();
      this._logger('shields: downloaded ' + id + ' (' + text.length + ' bytes)');
      // Rebuild engines that depend on this list.
      this._rebuildForList(id);
      return text;
    } catch (e) {
      this.listStatus[id] = { status: 'error', error: e.message, lastUpdated: meta.lastUpdated || null };
      this._logger('shields: download FAILED ' + id + ': ' + e.message);
      return cached || '';
    }
  }

  _splitList(text) {
    const ads = [];
    const trackers = [];
    const analytics = [];
    const popups = [];
    const lines = String(text || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line[0] === '!' || line[0] === '[') continue;
      const l = line.trim();
      if (!l || l[0] === '#' || l.startsWith('! ') || l.startsWith('[')) continue;
      if (l === '') continue;
      if (isPopupRule(l)) { popups.push(l); continue; }
      if (ANALYTICS_RE.test(l)) { analytics.push(l); continue; }
      trackers.push(l);
      ads.push(l);
    }
    return { ads: ads.join('\n'), trackers: trackers.join('\n'), analytics: analytics.join('\n'), popups: popups.join('\n'), raw: lines.join('\n') };
  }

  _rebuildForList(id) {
    // cheap: just re-ensure the affected engines asynchronously
    const keys = [];
    if (id === 'easylist') keys.push('ads', 'popups', 'cosmetic');
    if (id === 'easyprivacy') keys.push('trackers', 'analytics', 'popups');
    if (id === 'ubofilters') keys.push('ads', 'popups', 'cosmetic');
    if (id === 'adguard') keys.push('ads', 'popups', 'cosmetic');
    if (id === 'peterlow') keys.push('ads');
    if (id === 'urlhaus') keys.push('malicious');
    // Invalidate cached bin immediately so _ensureEngine recompiles.
    keys.forEach((k) => {
      try { fs.unlinkSync(this._engineFile(k)); } catch (e) {}
      this.engReady[k] = false;
      this._ensureEngine(k).then(() => this._publishReady()).catch(() => {});
    });
  }

  async updateAllLists() {
    const results = {};
    for (const id of Object.keys(LISTS)) {
      this.listStatus[id] = { status: 'downloading', lastUpdated: this.listMeta[id]?.lastUpdated || null };
      results[id] = await this._cachedOrDownload(id, true);
    }
    this._publishReady();
    return { results: this.listStatus };
  }

  _checkAutoUpdate() {
    for (const id of Object.keys(LISTS)) {
      const meta = this.listMeta[id] || {};
      const stale = !meta.lastUpdated || (Date.now() - meta.lastUpdated) > ENG_DAYS_TO_REFRESH * 86400000;
      if (stale && this.settings.lists[id] !== false) this._cachedOrDownload(id).catch(() => {});
    }
  }

  // ---- wiring ----------------------------------------------------------------
  registrations(win) {
    this._mainWin = win || this._mainWin;

    // Register the SINGLE onBeforeRequest handler on all browsing sessions.
    const sessions = [];
    try { sessions.push(session.defaultSession); } catch (e) {}
    try { sessions.push(session.fromPartition('persist:webview')); } catch (e) {}
    try { sessions.push(session.fromPartition('persist:webview_wcv')); } catch (e) {}
    this._registered = true;
    sessions.forEach((ses) => {
      try {
        ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, this.makeHandler());
      } catch (e) {
        this._logger('shields: register session failed: ' + e.message);
      }
    });
    this._sessions = sessions;

    // IPC surface
    ipcMain.handle('shields:get-state', () => this.getState());
    ipcMain.handle('shields:get-site', (e, url) => this.getSiteState(url));
    ipcMain.handle('shields:set-global', (e, enabled) => this.setGlobalEnabled(enabled));
    ipcMain.handle('shields:set-category', (e, key, enabled) => this.setCategory(key, enabled));
    ipcMain.handle('shields:set-site-disabled', (e, url, disabled) => this.setSiteDisabled(url, disabled));
    ipcMain.handle('shields:set-list-enabled', (e, id, enabled) => this.setListEnabled(id, enabled));
    ipcMain.handle('shields:update-lists', () => this.updateAllLists());
    ipcMain.handle('shields:get-lists', () => this.getState().lists);
    // Keep the old renderer IPC toggle working (settings select).
    ipcMain.removeHandler('set-ad-blocking');
    ipcMain.on('set-ad-blocking', (event, enabled) => {
      this.setGlobalEnabled(!!enabled);
    });

    // Kick off async engine/list setup (non-blocking).
    this.init().catch(() => {});
    return this;
  }
}

module.exports = { NeoShields, eTLD1, ANALYTICS_RE, isPopupRule, stripPopupOption, isYouTubeAdRequest };