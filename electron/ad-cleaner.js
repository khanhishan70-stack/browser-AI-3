/* NEXORA SHIELDS - DOM ad-sniper (injected into every page by main.js).
 * A lightweight, self-contained MutationObserver that removes ad elements the
 * network filter lists / cosmetic rules miss: dynamically inserted ad iframes,
 * adsense slots, sponsored containers, and ad-network embeds. Deliberately
 * conservative - only well-known ad selectors, never generic 'ad'-substrings
 * that could match legit content. Cheap: batches removals behind requestAnimationFrame.
 */
(function () {
  try {
    if (window.__neoAdCleaner) return;
    window.__neoAdCleaner = true;

    var AD_SELECTORS = [
      'ins.adsbygoogle',
      'ins.adsbydfp',
      '[id^="google_ads_"]',
      '[id^="google_ads_iframe"]',
      '[id^="div-gpt-ad-"]',
      '[id^="gpt-ad-"]',
      '[data-ad-slot]',
      '[data-ad-client]',
      '[data-adtest]',
      '[data-google-query-id]',
      '[data-google-afc]',
      '[data-ad-type]',
      '[id*="ad-container"]',
      '[id*="ad-banner"]',
      '[id*="ad-slot"]',
      '[id*="ad-wrapper"]',
      '[id*="ad-box"]',
      '[id*="adsense"]',
      '[id*="dfp-ad"]',
      '[class*="ad-container"]',
      '[class*="ads-container"]',
      '[class*="ad-banner"]',
      '[class*="ads-banner"]',
      '[class*="ad-slot"]',
      '[class*="ads-slot"]',
      '[class*="ad-wrapper"]',
      '[class*="ads-wrapper"]',
      '[class*="ad-box"]',
      '[class*="ads-box"]',
      '[class*="ad-placeholder"]',
      '[class*="adsense"]',
      '[class*="ad-badge"]',
      '[class*="advert-"]',
      '[class*="advert_"]',
      '[class*="leaderboard-ad"]',
      '[class*="responsive-ad"]',
      '[class*="skyscraper-ad"]',
      '[class*="mrec"]',
      '[class*="sticky-ad"]',
      '.advertisement',
      '.advertising',
      '.advertise',
      '.sponsored-ad',
      '.sponsoredAds',
      '.rail-ads',
      '.homepage-ad',
      '.topad',
      '.bottom-ad',
      '.mid-article-ad',
      '.ad_global_header',
      '.ad_header',
      '.AD728x90'
    ];

    // Ad-network embeds that get injected into the DOM as <iframe>/<script>.
    var AD_SRC_RE = /(?:googlesyndication\.com|doubleclick\.net|googleadservices\.com|\b2mdn\.net|taboola\.com|outbrain\.com|adsterra\.com|propellerads\.com|popads\.net|popunder\.net|mgid\.com|revcontent\.com|adcash\.com|adroll\.com|smartadserver\.com|adform\.net|adnxs\.com|amazon-adsystem\.com|yieldlab\.net|rubiconproject\.com|criteo\.com|contextweb\.com|sharethrough\.com|teads\.tv|innovid\.com|spotx\.tv|insticator\.com|anj\.io|cpmstar\.com)/i;

    // Site chrome we must NEVER touch. Several app frameworks (YouTube
    // Polymer, LeetCode, most SPA shells) build the masthead/header/search bar
    // with the same substring classes the ad list looks for. Removing one of
    // these nodes mid-hydration blanks the whole top bar, so any candidate
    // that sits inside (or is) page chrome is skipped.
    var CHROME_SELECTORS = [
      'header', 'nav', '[role="banner"]', '[role="navigation"]', '[role="search"]',
      '#masthead', '#header', 'ytd-masthead', '#masthead-container',
      'ytd-searchbox', 'form[role="search"]', 'input[type="search"]',
      'form[action*="search"]', '.topbar', '.navbar', '.app-header'
    ];

    function isInChrome(node) {
      try {
        if (!node) return false;
        for (var i = 0; i < CHROME_SELECTORS.length; i++) {
          if (node.matches && node.matches(CHROME_SELECTORS[i])) return true;
        }
        if (node.closest) {
          for (var j = 0; j < CHROME_SELECTORS.length; j++) {
            if (node.closest(CHROME_SELECTORS[j])) return true;
          }
        }
      } catch (e) { return true; }
      return false;
    }

    function isAdNode(n) {
      if (!n || n.nodeType !== 1) return false;
      if (isInChrome(n)) return false;
      var src = (n.getAttribute && (n.getAttribute('src') || n.getAttribute('srcset') || n.getAttribute('data-src'))) || '';
      if (src && AD_SRC_RE.test(src)) return true;
      if (n.tagName === 'IFRAME') {
        var sr = '';
        try { sr = n.src || ''; } catch (e) {}
        if (sr && AD_SRC_RE.test(sr)) return true;
      }
      try { if (n.matches) if (n.matches(AD_SELECTORS.join(','))) return true; } catch (e) {}
      return false;
    }

    function removeAdNode(n) {
      try {
        if (isInChrome(n) || isInChrome(n.parentNode)) return;
        if (n.parentNode) n.parentNode.removeChild(n);
      } catch (e) {}
    }

var pending = null;
    function flush() {
    pending = null;
    try {
      var nodes = document.querySelectorAll(AD_SELECTORS.join(','));
      for (var i = 0; i < nodes.length; i++) removeAdNode(nodes[i]);
    } catch (e) {}
    }
    function scheduleFlush() {
    if (pending) return;
    pending = requestAnimationFrame(flush);
    }

    var lastFlush = 0;
    function onMutations(muts) {
      // Never run during hydration: removing nodes while the app framework is
      // still building its DOM is what blanks mastheads/search bars.
      if (document.readyState === 'loading') return;
      var now = Date.now();
      if (now - lastFlush < 400) return;
      var need = false;
      for (var i = 0; i < muts.length; i++) {
      var added = muts[i].addedNodes;
      if (!added || !added.length) continue;
      for (var j = 0; j < added.length; j++) {
        if (isAdNode(added[j])) { removeAdNode(added[j]); need = true; }
      }
      }
      if (need) { lastFlush = now; scheduleFlush(); }
    }

    // Also scrub scripts/iframes with ad srcs directly at the top level.
    function sweep() {
      try {
        var all = document.querySelectorAll('iframe,script');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          var src = '';
          try { src = el.src || el.getAttribute('src') || ''; } catch (e) {}
          if (src && AD_SRC_RE.test(src)) {
            if (el.tagName === 'IFRAME') removeAdNode(el);
          }
        }
      } catch (e) {}
    }

    // Only start observing once the document has finished parsing/hydrating.
    // Attaching at did-navigate means the observer is live while Polymer/React
    // are still constructing the page, which costs CPU and removes live nodes.
    function start() {
      if (window.__neoAdCleanerStarted) return;
      window.__neoAdCleanerStarted = true;
      try {
        new MutationObserver(onMutations).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
      } catch (e) {}
      sweep();
      scheduleFlush();
    }

    if (document.readyState === 'complete') {
      start();
    } else {
      window.addEventListener('load', start, { once: true });
      // Safety net if `load` never fires (blocked subresource keeps it pending).
      window.setTimeout(function () {
        if (!window.__neoAdCleanerStarted) {
          window.__neoAdCleanerStarted = true;
          start();
        }
      }, 8000);
    }
  } catch (e) {}
})();