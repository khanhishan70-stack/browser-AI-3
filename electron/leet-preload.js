// LeetCode Assistant — injected via executeJavaScript into webview
// No require() calls — runs in web page context

(function() {
  if (window.__leetInjected) return;
  window.__leetInjected = true;

  window.__leetData = null;

  function getProblemTitle() {
    var el = document.querySelector('[data-cy="question-title"]') ||
             document.querySelector('.css-v3d350') ||
             document.querySelector('h4[class*="title"]') ||
             document.querySelector('[class*="question-title"]');
    return el ? el.textContent.trim() : '';
  }

  function getDifficulty() {
    var el = document.querySelector('[data-cy="question-difficulty"]') ||
             document.querySelector('[diff]') ||
             document.querySelector('[class*="difficulty"]');
    if (el) {
      var txt = el.textContent.trim().toLowerCase();
      if (txt.indexOf('easy') !== -1) return 'Easy';
      if (txt.indexOf('medium') !== -1) return 'Medium';
      if (txt.indexOf('hard') !== -1) return 'Hard';
    }
    return '';
  }

  function getProblemDescription() {
    var el = document.querySelector('[data-cy="question-content"]') ||
             document.querySelector('[class*="content__"]') ||
             document.querySelector('.question-content') ||
             document.querySelector('[class*="description"]');
    return el ? el.textContent.trim() : '';
  }

  function getCode() {
    var lines = document.querySelectorAll('.view-line');
    if (lines.length) return Array.from(lines).map(function(l) { return l.textContent; }).join('\n');
    var ta = document.querySelector('textarea[class*="inputarea"]');
    if (ta && ta.value) return ta.value;
    return '';
  }

  function getLanguage() {
    var el = document.querySelector('[data-cy="lang-select"]') ||
             document.querySelector('[class*="language"]') ||
             document.querySelector('#lang-select');
    return el ? el.textContent.trim() : 'unknown';
  }

  function getSubmissionResult() {
    var el = document.querySelector('[data-cy="submission-result"]') ||
             document.querySelector('[class*="submission-result"]') ||
             document.querySelector('[class*="result"]');
    if (el) return el.textContent.trim();
    if (document.querySelector('[class*="accepted"]')) return 'Accepted';
    if (document.querySelector('[class*="wrong"]')) return 'Wrong Answer';
    return '';
  }

  function getRuntime() {
    var el = document.querySelector('[data-cy="runtime"]') ||
             document.querySelector('[class*="runtime"]');
    return el ? el.textContent.trim() : '';
  }

  function getMemory() {
    var el = document.querySelector('[data-cy="memory"]') ||
             document.querySelector('[class*="memory"]');
    return el ? el.textContent.trim() : '';
  }

  function extractProblemData() {
    return {
      problem: {
        title: getProblemTitle(),
        difficulty: getDifficulty(),
        description: getProblemDescription(),
        url: window.location.href,
      },
      code: getCode(),
      language: getLanguage(),
      submission: {
        result: getSubmissionResult(),
        runtime: getRuntime(),
        memory: getMemory(),
      },
      timestamp: Date.now(),
    };
  }

  // Store data on window for polling
  function updateData() {
    if (window.location.href.indexOf('/problems/') !== -1) {
      window.__leetData = extractProblemData();
    } else {
      window.__leetData = null;
    }
  }

  // Update immediately
  updateData();

  // Poll for changes
  setInterval(updateData, 1500);
})();
