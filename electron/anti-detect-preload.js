// Anti-Electron-detection preload for webview guests.
// Injected into every site so fingerprinting sites (Spotify, Google login, etc.)
// see a normal Chrome browser instead of an embedded/automated Electron webview.
// This contains ONLY safe navigator/window overrides - it does NOT touch audio
// routing or media playback (those were split out to avoid the blank-screen bug).
const script = document.createElement('script');
script.textContent = `
(function(){
  if (window.__neoAntiDetect) return;
  window.__neoAntiDetect = true;
  try {
    // 1. Remove navigator.webdriver completely
    try { delete navigator.__proto__.webdriver; } catch(e) {}
    try { Object.defineProperty(navigator, 'webdriver', { get: function() { return undefined; }, configurable: true }); } catch(e) {}

    // 2. Set proper languages
    Object.defineProperty(navigator, 'languages', { get: function() { return ['en-US', 'en']; }, configurable: true });

    // 3. Fake Chrome plugins (Google login checks this)
    var fakePlugins = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 0 }
    ];
    var pluginsArr = fakePlugins.map(function(p, i) {
      return { name: p.name, filename: p.filename, description: p.description, length: p.length, item: function(){return null;}, namedItem: function(){return null;} };
    });
    pluginsArr.item = function(i) { return this[i] || null; };
    pluginsArr.namedItem = function(n) {
      for (var j = 0; j < this.length; j++) { if (this[j].name === n) return this[j]; }
      return null;
    };
    var pluginsDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'plugins') ||
                      Object.getOwnPropertyDescriptor(navigator, 'plugins');
    if (!navigator.plugins || navigator.plugins.length === 0) {
      Object.defineProperty(navigator, 'plugins', { get: function() { return pluginsArr; }, configurable: true });
    }
    if (!navigator.mimeTypes || navigator.mimeTypes.length === 0) {
      Object.defineProperty(navigator, 'mimeTypes', { get: function() { return [{type:'application/pdf',suffixes:'pdf',description:'Portable Document Format'},{type:'text/pdf',suffixes:'pdf',description:'Portable Document Format'}]; }, configurable: true });
    }

    // 4. Fake chrome.runtime (needed for extension detection)
    if(window.chrome && !window.chrome.runtime) window.chrome.runtime = { connect: function(){return{};}, sendMessage: function(){return Promise.resolve();} };
    if(!window.chrome.loadTimes) window.chrome.loadTimes = function(){return{};};
    if(!window.chrome.csi) window.chrome.csi = function(){return{};};
    window.chrome.app = window.chrome.app || {};
    if(!window.chrome.webstore) window.chrome.webstore = { install: function(){} };

    // 5. Device specs matching real Chrome
    if(!navigator.deviceMemory) navigator.deviceMemory = 8;
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: function() { return 8; }, configurable: true });

    // 6. Hide Electron process info
    if(window.process && window.process.versions) {
      Object.defineProperty(window.process.versions, 'electron', { get: function() { return undefined; }, configurable: true });
    }
    if(window.process && window.process.type) {
      Object.defineProperty(window.process, 'type', { get: function() { return 'browser'; }, configurable: true });
    }

    // 7. userAgentData matching Chrome 138 UA string (consistent with main UA)
    if(!navigator.userAgentData) {
      Object.defineProperty(navigator, 'userAgentData', { get: function() {
        return {
          brands: [
            { brand: 'Chromium', version: '138' },
            { brand: 'Google Chrome', version: '138' },
            { brand: 'Not=A?Brand', version: '99' }
          ],
          mobile: false,
          platform: 'Windows',
          getHighEntropyValues: function(keys) {
            return Promise.resolve({
              architecture: 'x86',
              bitness: '64',
              model: '',
              platform: 'Windows',
              platformVersion: '10.0.0',
              uaFullVersion: '138.0.7204.169',
              fullVersionList: [
                { brand: 'Not=A?Brand', version: '99.0.0.0' },
                { brand: 'Google Chrome', version: '138.0.7204.169' },
                { brand: 'Chromium', version: '138.0.7204.169' }
              ]
            });
          }
        };
      }, configurable: true });
    } else if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      var origGetHighEntropy = navigator.userAgentData.getHighEntropyValues;
      navigator.userAgentData.getHighEntropyValues = function(hints) {
        var result = origGetHighEntropy ? origGetHighEntropy.call(navigator.userAgentData, hints) : Promise.resolve({});
        return result.then(function(he) {
          he.platform = 'Windows';
          he.platformVersion = '10.0.0';
          he.architecture = 'x86';
          he.model = '';
          he.bitness = '64';
          he.wow64 = false;
          he.fullVersionList = [
            { brand: 'Not=A?Brand', version: '99.0.0.0' },
            { brand: 'Google Chrome', version: '138.0.7204.169' },
            { brand: 'Chromium', version: '138.0.7204.169' }
          ];
          return he;
        });
      };
    }

    // 8. Add missing API stubs that sites check
    if(!window.getComputedStyle) window.getComputedStyle = function(el) { return el.style || {}; };
    if(!navigator.mediaCapabilities) navigator.mediaCapabilities = { decodingInfo: function() { return Promise.resolve({supported: true, powerEfficient: true, smooth: true}); } };
    if(!navigator.pdfViewerEnabled) navigator.pdfViewerEnabled = true;
    if(!navigator.serial) navigator.serial = {};
    if(!navigator.usb) navigator.usb = {};
    if(!navigator.bluetooth) navigator.bluetooth = {};

    // 9. Hide chrome.runtime Electron internals
    if (window.chrome && window.chrome.runtime) {
      ['sendMessage', 'onMessage', 'connect', 'onConnect'].forEach(function(k) {
        if (window.chrome.runtime[k]) {
          var orig = window.chrome.runtime[k];
          if (typeof orig === 'object') {
            Object.keys(orig).forEach(function(p) {
              if (typeof orig[p] === 'function') {
                try { orig[p] = function() {}; } catch(e) {}
              }
            });
          }
        }
      });
    }
  } catch(e) { /* anti-detection errors suppressed */ }
})();
`;
try {
  var _root = document.head || document.documentElement || document;
  if (_root) _root.appendChild(script);
} catch(e) {
  (document.head || document.documentElement || document.body || document).appendChild(script);
}
