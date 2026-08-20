(function() {
  if (window.__leetInjected) return;
  window.__leetInjected = true;

  var DEBUG = [];
  var LAST_DATA = null;
  var CACHE = {};

  function logDebug(key, status, detail) {
    DEBUG.push({ key: key, status: status, detail: detail, time: Date.now() });
    if (DEBUG.length > 200) DEBUG.splice(0, 50);
  }

  // --- Selector sets (ordered by reliability) ---

  var SELECTORS = {
    title: [
      '[data-cy="question-title"]',
      'h4[class*="title"]',
      'div[class*="css-v3d"]',
      'div[class*="question-title"]',
      'meta[property="og:title"]',
      'title'
    ],
    difficulty: [
      '[data-cy="question-difficulty"]',
      '[diff]',
      'div[class*="difficulty"]',
      'span[class*="difficulty"]',
      'div[diff]'
    ],
    description: [
      '[data-track-load="description_content"]',
      '[data-cy="question-content"]',
      'div[class*="question-content"]',
      'div[class*="content__"]',
      'div[class*="description__"]',
      '.question-content',
      '[class*="description"]'
    ],
    examples: [
      '[data-track-load="description_content"] pre',
      '[data-cy="question-content"] pre',
      'div[class*="question-content"] pre',
      'div[class*="content__"] pre'
    ],
    codeLang: [
      '[data-cy="lang-select"] span:first-child',
      '[data-cy="lang-select"]',
      'button[data-cy="lang-select"]',
      'div[class*="language"]',
      '#lang-select',
      '[class*="lang-select"]'
    ],
    submissionStatus: [
      '[data-cy="submission-result"]',
      'span[class*="result"]',
      'div[class*="submission-result"]',
      '[class*="accepted"]',
      '[class*="wrong-answer"]'
    ],
    runtime: [
      '[data-cy="runtime"]',
      'div[class*="runtime"]',
      'span[class*="runtime"]'
    ],
    memory: [
      '[data-cy="memory"]',
      'div[class*="memory"]',
      'span[class*="memory"]'
    ],
    testcase: [
      'textarea[class*="testcase"]',
      'div[class*="testcase"] textarea',
      '[data-cy="testcase"]',
      'div[class*="test-case"]',
      '[class*="testcase"]'
    ]
  };

  function queryFirst(selectors, attr) {
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) {
        if (attr === 'href') return el.getAttribute('href') || el.textContent.trim();
        if (attr === 'content') return el.getAttribute('content') || '';
        if (attr === 'text') return el.textContent.trim();
        return el.textContent.trim();
      }
    }
    return '';
  }

  // --- Problem slug from URL ---
  function getSlug() {
    var m = window.location.pathname.match(/\/problems\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  // --- Title ---
  function getTitle() {
    var t = queryFirst(SELECTORS.title);
    if (!t) { logDebug('title', 'MISS', 'No selector matched'); return ''; }
    if (t.indexOf('LeetCode') !== -1) t = t.replace(/ - LeetCode.*/, '').trim();
    logDebug('title', 'OK', SELECTORS.title[0] + ' → "' + t.substring(0, 40) + '"');
    return t;
  }

  // --- Difficulty ---
  function getDifficulty() {
    var t = queryFirst(SELECTORS.difficulty).toLowerCase();
    if (t.indexOf('easy') !== -1) return 'Easy';
    if (t.indexOf('medium') !== -1) return 'Medium';
    if (t.indexOf('hard') !== -1) return 'Hard';
    // fallback: body class
    var b = document.body.className.toLowerCase();
    if (b.indexOf('easy') !== -1) return 'Easy';
    if (b.indexOf('medium') !== -1) return 'Medium';
    if (b.indexOf('hard') !== -1) return 'Hard';
    logDebug('difficulty', 'MISS', 'No difficulty element found');
    return 'Easy';
  }

  // --- Description (HTML to preserve examples/constraints structure) ---
  function getDescription() {
    var sel = SELECTORS.description;
    for (var i = 0; i < sel.length; i++) {
      var el = document.querySelector(sel[i]);
      if (el) {
        logDebug('description', 'OK', sel[i] + ' (' + el.textContent.trim().length + ' chars)');
        return el.textContent.trim();
      }
    }
    logDebug('description', 'MISS', 'No description container found');
    return '';
  }

  // --- Examples ---
  function getExamples(descText) {
    var results = [];
    var blocks = descText ? descText.split(/\n\s*\n/) : [];
    var exampleStrs = [];
    for (var si = 0; si < blocks.length; si++) {
      if (/^Example\s*\d/i.test(blocks[si].trim())) {
        exampleStrs.push(blocks[si].trim());
      }
    }
    if (exampleStrs.length) {
      logDebug('examples', 'OK', exampleStrs.length + ' examples found via text split');
      return exampleStrs;
    }
    // Try from DOM
    var sel = SELECTORS.examples;
    for (var i = 0; i < sel.length; i++) {
      var pres = document.querySelectorAll(sel[i]);
      if (pres.length > 1) {
        for (var j = 0; j < pres.length; j++) results.push(pres[j].textContent.trim());
        logDebug('examples', 'OK', results.length + ' examples from pre tags');
        return results;
      }
    }
    // Fallback: look for "Example" headings
    var headings = document.querySelectorAll('p, strong, b, h3');
    for (var hi = 0; hi < headings.length; hi++) {
      if (/^Example\s*\d/i.test(headings[hi].textContent.trim())) {
        var parent = headings[hi].closest('div') || headings[hi].parentNode;
        if (parent) results.push(parent.textContent.trim());
      }
    }
    logDebug('examples', results.length ? 'OK' : 'MISS', results.length + ' examples via heading scan');
    return results;
  }

  // --- Constraints ---
  function getConstraints(descText) {
    if (!descText) return '';
    var m = descText.match(/Constraints:?\s*([\s\S]*?)(?=\n\s*\n|Example\s*\d|Follow.up|$)/i);
    if (m) {
      logDebug('constraints', 'OK', m[1].substring(0, 60));
      return m[1].trim();
    }
    // Try "Constraints:" as a visible label
    var labels = document.querySelectorAll('p, strong, h4, h3');
    for (var i = 0; i < labels.length; i++) {
      if (/^Constraints/i.test(labels[i].textContent.trim())) {
        var parent = labels[i].closest('div') || labels[i].parentNode;
        if (parent) {
          var txt = parent.textContent.trim().replace(/^Constraints:?\s*/i, '');
          logDebug('constraints', 'OK', txt.substring(0, 60));
          return txt;
        }
      }
    }
    logDebug('constraints', 'MISS', 'No constraints found');
    return '';
  }

  // --- Follow-up ---
  function getFollowup(descText) {
    if (!descText) return '';
    var m = descText.match(/Follow.up:?\s*([\s\S]*?)$/i);
    if (m) {
      logDebug('followup', 'OK', m[1].substring(0, 60));
      return m[1].trim();
    }
    var els = document.querySelectorAll('p, div');
    for (var i = 0; i < els.length; i++) {
      if (/Follow.up/i.test(els[i].textContent)) {
        logDebug('followup', 'OK', els[i].textContent.substring(0, 60));
        return els[i].textContent.trim();
      }
    }
    return '';
  }

  // --- Hints ---
  function getHints() {
    var hints = [];
    // LeetCode loads hints on demand; try to find hidden hint containers
    var containers = document.querySelectorAll('[class*="hint"]');
    for (var i = 0; i < containers.length; i++) {
      var txt = containers[i].textContent.trim();
      if (/^Hint\s*\d/i.test(txt)) hints.push(txt);
    }
    return hints;
  }

  // --- Code from Monaco Editor ---
  function getCode() {
    // 1. Monaco API
    try {
      if (window.monaco && window.monaco.editor) {
        var models = window.monaco.editor.getModels();
        if (models && models.length) {
          var val = models[0].getValue();
          if (val) {
            logDebug('code', 'OK', 'Monaco API, ' + val.length + ' chars');
            return val;
          }
        }
      }
    } catch(e) { logDebug('code', 'ERR', 'Monaco API error: ' + e.message); }

    // 2. Monaco editor DOM
    var editorEl = document.querySelector('.monaco-editor');
    if (editorEl) {
      // Get from view lines
      var lines = editorEl.querySelectorAll('.view-line');
      if (lines && lines.length) {
        var parts = [];
        for (var i = 0; i < lines.length; i++) parts.push(lines[i].textContent);
        var txt = parts.join('\n');
        if (txt.length > 10) {
          logDebug('code', 'OK', 'Monaco .view-line, ' + txt.length + ' chars');
          return txt;
        }
      }
      // Get from textarea
      var ta = editorEl.querySelector('textarea');
      if (ta && ta.value) {
        logDebug('code', 'OK', 'Monaco textarea, ' + ta.value.length + ' chars');
        return ta.value;
      }
    }

    // 3. Generic textarea
    var textareas = document.querySelectorAll('textarea');
    for (var ti = 0; ti < textareas.length; ti++) {
      if (textareas[ti].className.indexOf('inputarea') !== -1 || textareas[ti].getAttribute('aria-roledescription')) {
        if (textareas[ti].value) {
          logDebug('code', 'OK', 'textarea.inputarea, ' + textareas[ti].value.length + ' chars');
          return textareas[ti].value;
        }
      }
    }

    // 4. CodeMirror
    if (window.CodeMirror) {
      var cm = document.querySelector('.CodeMirror');
      if (cm && cm.CodeMirror) {
        var cmVal = cm.CodeMirror.getValue();
        if (cmVal) {
          logDebug('code', 'OK', 'CodeMirror API, ' + cmVal.length + ' chars');
          return cmVal;
        }
      }
    }

    logDebug('code', 'MISS', 'No code source found');
    return '';
  }

  // --- Language ---
  function getLanguage() {
    var t = queryFirst(SELECTORS.codeLang);
    if (t && t !== 'unknown') {
      logDebug('language', 'OK', SELECTORS.codeLang[0] + ' → "' + t + '"');
      return t;
    }
    // Try to parse from Monaco model
    try {
      if (window.monaco && window.monaco.editor) {
        var models = window.monaco.editor.getModels();
        if (models && models.length && models[0].getLanguageId) {
          var lang = models[0].getLanguageId();
          if (lang) {
            logDebug('language', 'OK', 'Monaco languageId: ' + lang);
            return lang;
          }
        }
      }
    } catch(e) {}
    // Try URL hash or query params
    var langMatch = window.location.hash.match(/language=(\w+)/);
    if (langMatch) return langMatch[1];
    logDebug('language', 'MISS', 'No language selector found');
    return 'unknown';
  }

  // --- Submission ---
  function getSubmissionStatus() {
    var t = queryFirst(SELECTORS.submissionStatus).toLowerCase();
    if (t.indexOf('accepted') !== -1) return 'Accepted';
    if (t.indexOf('wrong') !== -1 || t.indexOf('error') !== -1) return 'Wrong Answer';
    if (t.indexOf('time') !== -1) return 'Time Limit Exceeded';
    if (t.indexOf('compil') !== -1) return 'Compile Error';
    if (t.indexOf('runtime') !== -1) return 'Runtime Error';
    // Check for visible status badges
    var badges = document.querySelectorAll('[class*="accepted"],[class*="correct"]');
    if (badges.length && badges[0].offsetParent !== null) return 'Accepted';
    return '';
  }

  function getRuntime() {
    return queryFirst(SELECTORS.runtime);
  }

  function getMemory() {
    return queryFirst(SELECTORS.memory);
  }

  // --- Testcase ---
  function getTestcase() {
    return queryFirst(SELECTORS.testcase);
  }

  // --- Console output ---
  function getConsoleOutput() {
    // LeetCode shows console output in a panel after running
    var el = document.querySelector('[class*="console"] [class*="output"], [class*="console-output"], [data-cy="console"]');
    return el ? el.textContent.trim() : '';
  }

  // --- Main extraction ---
  function extractAll() {
    if (window.location.href.indexOf('/problems/') === -1) {
      window.__leetState = null;
      return null;
    }

    var desc = getDescription();
    var data = {
      title: getTitle(),
      slug: getSlug(),
      difficulty: getDifficulty(),
      description: desc,
      examples: getExamples(desc),
      constraints: getConstraints(desc),
      followup: getFollowup(desc),
      hints: getHints(),
      language: getLanguage(),
      code: getCode(),
      submission: getSubmissionStatus(),
      runtime: getRuntime(),
      memory: getMemory(),
      testcase: getTestcase(),
      consoleOutput: getConsoleOutput(),
      accepted: getSubmissionStatus().toLowerCase().indexOf('accepted') !== -1,
      url: window.location.href,
      debug: DEBUG.slice(-50),
      timestamp: Date.now()
    };
    return data;
  }

  // --- Diff check (only update when something changed) ---
  function hasChanged(newData) {
    if (!LAST_DATA) return true;
    var keys = ['title','difficulty','language','code','submission','runtime','memory','testcase','url'];
    for (var i = 0; i < keys.length; i++) {
      if (newData[keys[i]] !== LAST_DATA[keys[i]]) return true;
    }
    return false;
  }

  // --- Update cycle ---
  function update() {
    var data = extractAll();
    if (!data) {
      window.__leetState = null;
      return;
    }
    // Only set if changed or cache expired
    if (hasChanged(data) || !window.__leetState) {
      window.__leetState = data;
      LAST_DATA = data;
      // Also keep old __leetData for backward compat
      window.__leetData = {
        problem: {
          title: data.title,
          difficulty: data.difficulty,
          description: data.description,
          url: data.url
        },
        code: data.code,
        language: data.language,
        submission: {
          result: data.submission,
          runtime: data.runtime,
          memory: data.memory
        },
        timestamp: data.timestamp
      };
    }
  }

  // --- MutationObserver for live DOM changes ---
  var observer = new MutationObserver(function() {
    update();
  });

  function startObserver() {
    var target = document.body || document.documentElement;
    if (target) {
      observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
        attributeFilter: ['class', 'style', 'data-cy', 'diff']
      });
      logDebug('observer', 'OK', 'MutationObserver attached to ' + target.tagName);
    }
  }

  // --- History API interception for SPA navigation ---
  var origPush = history.pushState;
  history.pushState = function() {
    origPush.apply(this, arguments);
    setTimeout(update, 500);
  };
  var origReplace = history.replaceState;
  history.replaceState = function() {
    origReplace.apply(this, arguments);
    setTimeout(update, 500);
  };
  window.addEventListener('popstate', function() {
    setTimeout(update, 500);
  });
  logDebug('history', 'OK', 'pushState/replaceState/popstate intercepted');

  // --- URL change detection ---
  var LAST_URL = window.location.href;
  setInterval(function() {
    if (window.location.href !== LAST_URL) {
      LAST_URL = window.location.href;
      logDebug('url', 'CHANGE', LAST_URL);
      update();
    }
  }, 500);

  // --- Initial extraction with retry ---
  var retries = 0;
  var MAX_RETRIES = 40; // 20 seconds
  var RETRY_INTERVAL = 500;

  function tryExtract() {
    var data = extractAll();
    if (data && data.title && data.code) {
      logDebug('init', 'OK', 'All data captured on attempt ' + retries);
      update();
      startObserver();
      return;
    }
    retries++;
    if (retries >= MAX_RETRIES) {
      logDebug('init', 'WARN', 'Max retries reached. Partial data: title=' + (data ? data.title : 'null') + ' code=' + (data && data.code ? 'yes' : 'no'));
      update();
      startObserver();
      return;
    }
    setTimeout(tryExtract, RETRY_INTERVAL);
  }

  // Start
  tryExtract();

  // Periodic refresh every 2s
  setInterval(update, 2000);
})();
