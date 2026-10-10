const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

// Make navigator.userAgentData in the MAIN world report the same Chrome brand
// set our Sec-CH-UA headers send. Runs before any page script, so Google's
// sign-in checks (which compare header hints vs. navigator.userAgentData) pass
// everywhere — including popup/login windows that have no anti-detect injection.
try {
  const _cv = (process.versions && process.versions.chrome) || '148.0.7778.97';
  const _cm = String(_cv).split('.')[0];
  webFrame.executeJavaScript(`
    (function(){
      try {
        Object.defineProperty(navigator, 'userAgentData', {
          get: function() {
            return {
              brands: [
                { brand: 'Not)A;Brand', version: '99' },
                { brand: 'Chromium', version: '${_cm}' },
                { brand: 'Google Chrome', version: '${_cm}' }
              ],
              mobile: false,
              platform: 'Windows',
              getHighEntropyValues: function(keys) {
                return Promise.resolve({
                  architecture: 'x86', bitness: '64', model: '',
                  platform: 'Windows', platformVersion: '10.0.0',
                  uaFullVersion: '${_cv}',
                  fullVersionList: [
                    { brand: 'Not)A;Brand', version: '99.0.0.0' },
                    { brand: 'Chromium', version: '${_cv}' },
                    { brand: 'Google Chrome', version: '${_cv}' }
                  ]
                });
              }
            };
          },
          configurable: true
        });
      } catch(e) {}
    })();
  `);
} catch(e) {}

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  clearBrowsingData: (opts) => ipcRenderer.invoke('clear-browsing-data', opts),
  webhistLog: (url, title) => ipcRenderer.invoke('webhist-log', { url, title }),
  webhistTitle: (url, title) => ipcRenderer.invoke('webhist-title', { url, title }),
  webhistGet: () => ipcRenderer.invoke('webhist-get'),
  webhistDel: (ids) => ipcRenderer.invoke('webhist-del', ids),
  webhistClear: () => ipcRenderer.invoke('webhist-clear'),
  getCookies: (filter) => ipcRenderer.invoke('get-cookies', filter),
  clearAllCookies: () => ipcRenderer.invoke('clear-all-cookies'),
  getPermissionState: (perm) => ipcRenderer.invoke('get-permission-state', perm),
  getCertInfo: (url) => ipcRenderer.invoke('get-cert-info', url),
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  restore: () => ipcRenderer.send('window-restore'),
  close: () => ipcRenderer.send('window-close'),
  toggleFullscreen: () => ipcRenderer.send('window-fullscreen'),
  onFullscreenChange: (cb) => ipcRenderer.on('fullscreen-changed', (e, fs) => cb(fs)),
  onBeforeQuit: (cb) => ipcRenderer.on('before-quit', () => cb()),
  appQuitting: () => ipcRenderer.send('app-quitting'),
  onOpenInNewTab: (cb) => ipcRenderer.on('open-in-new-tab', (e, url) => cb(url)),
  onOpenNewTab: (cb) => ipcRenderer.on('neo-open-tab', (e, data) => cb(data)),
  onDownloadStart: (cb) => ipcRenderer.on('download-start', (e, d) => cb(d)),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (e, d) => cb(d)),
  onDownloadDone: (cb) => ipcRenderer.on('download-done', (e, d) => cb(d)),
  onDownloadWarning: (cb) => ipcRenderer.on('download-warning', (e, d) => cb(d)),
  sendDownloadResponse: (id, allow) => ipcRenderer.send('download-response', { id, allow }),
  pauseDownload: (id) => ipcRenderer.send('download-pause', id),
  resumeDownload: (id) => ipcRenderer.send('download-resume', id),
  cancelDownload: (id) => ipcRenderer.send('download-cancel', id),
  openDownloadedFile: (idOrName) => ipcRenderer.invoke('open-downloaded-file', idOrName),
  showDownloadInFolder: (idOrName) => ipcRenderer.invoke('show-download-in-folder', idOrName),
  removeDownloadListeners: () => {
    ipcRenderer.removeAllListeners('download-start');
    ipcRenderer.removeAllListeners('download-progress');
    ipcRenderer.removeAllListeners('download-done');
    ipcRenderer.removeAllListeners('download-warning');
  },
  getWallpaperDataUrl: (name) => ipcRenderer.invoke('get-wallpaper', name),
  getBundledWallpapers: () => ipcRenderer.invoke('get-bundled-wallpapers'),
  listIntroSounds: () => ipcRenderer.invoke('intro-sound-list'),
  readIntroSound: (name) => ipcRenderer.invoke('intro-sound-read', name),
  setIntroSound: (payload) => ipcRenderer.invoke('intro-sound-set', payload),
  takeScreenshot: () => ipcRenderer.invoke('take-screenshot'),
  ytSearch: (query) => ipcRenderer.invoke('yt-search', query),
  getBeatPreload: () => ipcRenderer.invoke('get-beat-preload'),
  webviewExecJs: (wcId, js, ms) => ipcRenderer.invoke('webview-execjs', { wcId, js, ms }),
  translateBatch: (payload) => ipcRenderer.invoke('translate-batch', payload),
  kickCompositor: () => ipcRenderer.send('neo-kick-compositor'),
  getGpuStatus: () => ipcRenderer.invoke('neo-gpu-status'),
  getPerf: () => ipcRenderer.invoke('neo-perf'),
  getPerfExternal: () => ipcRenderer.invoke('neo-perf-external'),
  getSystemMemory: () => ipcRenderer.invoke('get-system-memory'),
  onWebviewRecover: (cb) => ipcRenderer.on('webview-recover', () => cb()),
setAdBlocking: (enabled) => ipcRenderer.send('set-ad-blocking', enabled),
  // ===== NEXORA SHIELDS (Brave-style ads & trackers) =====
  shieldsGetState: () => ipcRenderer.invoke('shields:get-state'),
  shieldsGetSite: (url) => ipcRenderer.invoke('shields:get-site', url),
  shieldsSetGlobal: (enabled) => ipcRenderer.invoke('shields:set-global', enabled),
  shieldsSetCategory: (key, enabled) => ipcRenderer.invoke('shields:set-category', key, enabled),
  shieldsSetSiteDisabled: (url, disabled) => ipcRenderer.invoke('shields:set-site-disabled', url, disabled),
  shieldsSetListEnabled: (id, enabled) => ipcRenderer.invoke('shields:set-list-enabled', id, enabled),
  shieldsUpdateLists: () => ipcRenderer.invoke('shields:update-lists'),
  shieldsGetLists: () => ipcRenderer.invoke('shields:get-lists'),
  onShieldsStats: (cb) => ipcRenderer.on('shields:stats', (e, d) => cb(d)),
  onShieldsState: (cb) => ipcRenderer.on('shields:state', (e, d) => cb(d)),
  selectVideoFile: () => ipcRenderer.invoke('select-video-file'),
  readVideoFile: (path) => ipcRenderer.invoke('read-video-file', path),
  // NEXORA Video Editor
  vesSelect: () => ipcRenderer.invoke('ves:select'),
  vesProbe: (path) => ipcRenderer.invoke('ves:probe', path),
  vesExport: (id, state) => ipcRenderer.invoke('ves:export', id, state),
  vesSave: (opts) => ipcRenderer.invoke('ves:save', opts),
  onVesExportProgress: (cb) => ipcRenderer.on('ves:export-progress', (e, d) => cb(d)),
  removeVesExportListeners: () => { ipcRenderer.removeAllListeners('ves:export-progress'); },
  // Download manager
  getDownloadedFiles: () => ipcRenderer.invoke('get-downloaded-files'),
  getYouTubeDownloads: () => ipcRenderer.invoke('get-youtube-downloads'),
  deleteYouTubeDownload: (name) => ipcRenderer.invoke('delete-youtube-download', name),
  openYouTubeDownloadsFolder: () => ipcRenderer.invoke('open-youtube-downloads-folder'),
  getDownloadPath: (name) => ipcRenderer.invoke('get-download-path', name),
  getFileStats: (name) => ipcRenderer.invoke('get-file-stats', name),
  setHwAccelPref: (value) => ipcRenderer.invoke('set-hw-accel-pref', value),
  deleteDownloadedFile: (name) => ipcRenderer.invoke('delete-downloaded-file', name),
  readDownloadedFile: (name) => ipcRenderer.invoke('read-downloaded-file', name),
  openDownloadsFolder: () => ipcRenderer.invoke('open-downloads-folder'),
  onDlMgrOpenFolder: (cb) => ipcRenderer.on('open-downloads-folder', () => cb()),
  getDownloadHistory: () => ipcRenderer.invoke('get-download-history'),
  clearDownloadHistory: () => ipcRenderer.invoke('clear-download-history'),
  removeDownloadHistory: (time) => ipcRenderer.invoke('remove-download-history', time),
  // YouTube downloader
  getYTDownloadInfo: (url) => ipcRenderer.invoke('yt-download-info', url),
  startYTDownload: (url, quality, meta) => ipcRenderer.invoke('yt-download-start', url, quality, meta),
  startYTPlaylistDownload: (url, quality, meta) => ipcRenderer.invoke('yt-playlist-download-start', url, quality, meta),
  cancelYTDownload: (id) => ipcRenderer.invoke('yt-download-cancel', id),
  onYTDownloadProgress: (cb) => ipcRenderer.on('yt-download-progress', (e, d) => cb(d)),
  removeYTDownloadListeners: () => {
    ipcRenderer.removeAllListeners('yt-download-progress');
  },
  // Download metadata & AI categorization
  getAllDownloadMeta: () => ipcRenderer.invoke('get-all-download-meta'),
  saveDownloadMeta: (name, data) => ipcRenderer.invoke('save-download-meta', name, data),
  aiCategorize: (title, channel) => ipcRenderer.invoke('ai-categorize', title, channel),
  readThumbnailFile: (name) => ipcRenderer.invoke('read-thumbnail-file', name),
  generateVideoThumbnail: (name) => ipcRenderer.invoke('generate-video-thumbnail', name),
  // Playlist system
  playlistList: () => ipcRenderer.invoke('playlist-list'),
  playlistCreate: (name) => ipcRenderer.invoke('playlist-create', name),
  playlistDelete: (id) => ipcRenderer.invoke('playlist-delete', id),
  playlistRename: (id, name) => ipcRenderer.invoke('playlist-rename', id, name),
  playlistAddVideo: (id, fileName, meta) => ipcRenderer.invoke('playlist-add-video', id, fileName, meta),
  playlistRemoveVideo: (id, fileName) => ipcRenderer.invoke('playlist-remove-video', id, fileName),
  playlistGet: (id) => ipcRenderer.invoke('playlist-get', id),
  playlistDuplicate: (id) => ipcRenderer.invoke('playlist-duplicate', id),
  playlistExport: (id) => ipcRenderer.invoke('playlist-export', id),
  playlistSort: (id, method) => ipcRenderer.invoke('playlist-sort', id, method),
  playlistUpdateMeta: (id, meta) => ipcRenderer.invoke('playlist-update-meta', id, meta),
  getUAOverrides: () => ipcRenderer.invoke('ua-get-overrides'),
  getUAForUrl: (url) => ipcRenderer.invoke('ua-for-url', url),
  setUAOverride: (domain, ua) => ipcRenderer.send('ua-set-override', domain, ua),
  removeUAOverride: (domain) => ipcRenderer.send('ua-remove-override', domain),
  launchInChrome: (url) => ipcRenderer.invoke('launch-in-chrome', url),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (e, d) => cb(d)),
  updateCheckNow: () => ipcRenderer.invoke('update-check-now'),
  updateDismiss: (v) => ipcRenderer.invoke('update-dismiss', v),
  updateDownloadInstall: () => ipcRenderer.invoke('update-download-install'),
  updateRestartApply: (p) => ipcRenderer.invoke('update-restart-apply', p),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (e, d) => cb(d)),
  onDrmHint: (cb) => ipcRenderer.on('drm-hint', (e, d) => cb(d)),
  sendVolBoost: (pct) => ipcRenderer.send('vol-boost-set', pct),
  getVolBoostEngine: () => ipcRenderer.invoke('get-vol-boost-engine'),
  openLoginWindow: (url, opts) => ipcRenderer.send('open-login-window', url, opts || {}),
  onLoginWindowClosed: (cb) => ipcRenderer.on('login-window-closed', () => cb()),
  // Playback state persistence
  savePlaybackState: (state) => ipcRenderer.invoke('save-playback-state', state),
  loadPlaybackState: () => ipcRenderer.invoke('load-playback-state'),
  // Screen recording video-end detection
  injectVideoWatcher: () => ipcRenderer.invoke('inject-video-watcher'),
  onVideoEnded: (cb) => ipcRenderer.on('video-ended', () => cb()),
  removeVideoEndedListeners: () => { ipcRenderer.removeAllListeners('video-ended'); },
  // Generic fire-and-forget channel. This used to forward ANY channel name, which
  // meant a compromised renderer could invoke every ipcMain.on handler in main
  // (navigation, downloads, panels, login windows). Now only the three
  // log-only telemetry channels the UI actually uses are allowed through;
  // everything with side effects has its own named, validated bridge above.
  send: (channel, data) => {
    if (channel === 'neo-navtrace' || channel === 'ejlog' || channel === 'auth-debug') {
      ipcRenderer.send(channel, typeof data === 'string' ? data.slice(0, 2000) : data);
    }
  },
  // WebContentsView site engine bridge — ENABLED. The <webview> guest compositor
  // drops static surfaces after navigation on this machine (black page), while the
  // WebContentsView is composited by the SAME host compositor as the window => static
  // sites paint immediately. It has built-in fallback safety: it only hides the DOM
  // webview after a capturePage pixel probe confirms real content, else keeps DOM.
  wcvShow: (data) => ipcRenderer.send('neo-wcv-show', data),
  wcvNavigate: (url) => ipcRenderer.send('neo-wcv-navigate', url),
  wcvResize: (rect) => ipcRenderer.send('neo-wcv-resize', rect),
  wcvHide: () => ipcRenderer.send('neo-wcv-hide'),
  wcvBack: () => ipcRenderer.send('neo-wcv-back'),
  wcvForward: () => ipcRenderer.send('neo-wcv-forward'),
  wcvReload: () => ipcRenderer.send('neo-wcv-reload'),
  wcvExecJs: (js) => ipcRenderer.invoke('neo-wcv-execjs', js),
  wcvGetState: () => ipcRenderer.invoke('neo-wcv-getstate'),
  onWcvEvent: (cb) => { ipcRenderer.on('neo-wcv-event', (e, ev) => cb(ev)); },
  // Screen recorder
  recGetSources: () => ipcRenderer.invoke('rec-get-sources'),
  recStartCapture: (sourceId, opts) => ipcRenderer.invoke('rec-start-capture', sourceId, opts),
  recSaveRecording: (data) => ipcRenderer.invoke('rec-save-recording', data),
  recGetRecordings: () => ipcRenderer.invoke('rec-get-recordings'),
  recDeleteRecording: (name) => ipcRenderer.invoke('rec-delete-recording', name),
  recRenameRecording: (oldName, newName) => ipcRenderer.invoke('rec-rename-recording', oldName, newName),
  recExportRecording: (name, destPath, opts) => ipcRenderer.invoke('rec-export-recording', name, destPath, opts),
  recShowSaveDialog: (opts) => ipcRenderer.invoke('rec-show-save-dialog', opts),
  recGetStorageInfo: () => ipcRenderer.invoke('rec-get-storage-info'),
  recSaveScreenshot: (data) => ipcRenderer.invoke('rec-save-screenshot', data),
  recReadFile: (name) => ipcRenderer.invoke('rec-read-file', name),
  recProbeDuration: (name) => ipcRenderer.invoke('rec-probe-duration', name),
  recImportRecording: (src) => ipcRenderer.invoke('rec-import-recording', src),
  recGetThumbnail: (name) => ipcRenderer.invoke('rec-get-thumbnail', name),
  recOpenFolder: () => ipcRenderer.invoke('rec-open-folder'),
  // ===== Editor FFmpeg export (fast, non-real-time) =====
  edExport: (expId, state) => ipcRenderer.invoke('ed:export', expId, state),
  edExportCancel: (expId) => ipcRenderer.send('ed:export-cancel', expId),
  onEdExportProgress: (cb) => ipcRenderer.on('ed:export-progress', (e, data) => cb(data)),
  // ===== Account Manager Security =====
  onDevtoolsChange: (cb) => {
    ipcRenderer.on('devtools-changed', (e, open) => cb(open));
    ipcRenderer.invoke('acct-sec-status').then(s => cb(s.devtoolsOpen)).catch(() => {});
  },
  getDevtoolsState: () => ipcRenderer.invoke('acct-sec-status'),
  acctWipeVault: () => ipcRenderer.invoke('acct-sec-wipe'),
  // ===== Google OAuth (system-browser sign-in) =====
  // Sign-in runs in the user's default system browser via OAuth2 Code + PKCE.
  // All handling stays in the main process; the renderer only receives results.
  googleOAuthStart: () => ipcRenderer.invoke('google-oauth-start'),
  googleOAuthStartCallback: () => ipcRenderer.invoke('google-oauth-start-callback'),
  googleOAuthSignOut: () => ipcRenderer.invoke('google-oauth-signout'),
  googleOAuthStatus: () => ipcRenderer.invoke('google-oauth-status'),
  onGoogleAuthResult: (cb) => ipcRenderer.on('google-auth-result', (e, data) => cb(data)),
  googleOAuthFetch: (apiPath) => ipcRenderer.invoke('google-oauth-fetch', apiPath),
  googleOAuthConfigGet: () => ipcRenderer.invoke('google-oauth-config-get'),
  googleOAuthConfigSet: (input) => ipcRenderer.invoke('google-oauth-config-set', input),
  leetGetScript: () => ipcRenderer.invoke('leet-get-script'),
  // ===== LeetCode Pop-out Floating Window =====
  leetPopoutCreate: (data) => ipcRenderer.invoke('leet-popout-create', data),
  leetPopoutDock: (chatHtml) => ipcRenderer.send('leet-popout-dock', chatHtml),
  onLeetPopoutInit: (cb) => ipcRenderer.on('leet-popout-init', (e, data) => cb(data)),
  onLeetPopoutDocked: (cb) => ipcRenderer.on('leet-popout-docked', (e, chatHtml) => cb(chatHtml)),
  // ===== History Lock (master password for histories) =====
  historyLockStatus: () => ipcRenderer.invoke('history-lock-status'),
  historyLockSave: (payload) => ipcRenderer.invoke('history-lock-save', payload),
  historyLockCheck: (pass) => ipcRenderer.invoke('history-lock-check', pass),
  historyLockRelock: () => ipcRenderer.invoke('history-lock-relock'),
  onHistoryLockRequest: (cb) => ipcRenderer.on('neo-show-history-lock', (e, data) => cb(data)),
  // ===== NEXORA Account cookie sync =====
  syncCookiesExport: () => ipcRenderer.invoke('sync-cookies-export'),
  syncCookiesImport: (cookies) => ipcRenderer.invoke('sync-cookies-import', cookies),
  clearGoogleAuthCookies: () => ipcRenderer.invoke('clear-google-auth-cookies'),
  // ===== ESTA Saved-chats detachable desktop panel =====
  chatPanelOpen: () => ipcRenderer.invoke('chat-panel-open'),
  chatPanelSync: (payload) => ipcRenderer.send('chat-panel-sync', payload),
  chatPanelOpenConv: (id) => ipcRenderer.send('chat-panel-open-conv', { id: id }),
  chatPanelDeleteConv: (id) => ipcRenderer.send('chat-panel-delete-conv', { id: id }),
  chatPanelDock: () => ipcRenderer.send('chat-panel-request-dock'),
  chatPanelNewChat: () => ipcRenderer.send('chat-panel-new-chat'),
  onChatPanelSync: (cb) => ipcRenderer.on('chat-panel-sync', (e, d) => cb(d)),
  onChatPanelDock: (cb) => ipcRenderer.on('neo-show-chat-panel', () => cb()),
  onLoadConvFromPanel: (cb) => ipcRenderer.on('neo-load-conv', (e, d) => cb(d)),
  onDeleteConvFromPanel: (cb) => ipcRenderer.on('neo-delete-conv', (e, d) => cb(d)),
  onNewChatFromPanel: (cb) => ipcRenderer.on('neo-new-chat', (e) => cb()),
  onPanelSyncRequest: (cb) => ipcRenderer.on('neo-panel-request-sync', () => cb()),
  // ===== SITE PERMISSIONS (camera / mic / screen share, Chrome-style) =====
  onPermissionRequest: (cb) => ipcRenderer.on('permission-request', (e, d) => cb(d)),
  permissionResponse: (payload) => ipcRenderer.send('permission-response', payload),
  onDisplayMediaRequest: (cb) => ipcRenderer.on('display-media-request', (e, d) => cb(d)),
  displayMediaResponse: (payload) => ipcRenderer.send('display-media-response', payload),
  permGet: (origin) => ipcRenderer.invoke('perm-get', origin),
  permSet: (origin, key, value) => ipcRenderer.invoke('perm-set', origin, key, value),
  permReset: (origin) => ipcRenderer.invoke('perm-reset', origin),
  // ===== MY APPS SHELF (drag & drop PC apps) =====
  // Electron 32+ removed File.path, so dropped files are resolved with the
  // official webUtils helper. Returns '' for non-local files.
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch (e) { return ''; }
  },
  appsList: () => ipcRenderer.invoke('apps:list'),
  appsAdd: (path) => ipcRenderer.invoke('apps:add', path),
  appsAddMany: (paths) => ipcRenderer.invoke('apps:add-many', paths),
  appsAddWeb: (name, url) => ipcRenderer.invoke('apps:add-web', name, url),
  appsRemove: (id) => ipcRenderer.invoke('apps:remove', id),
  appsRename: (id, name) => ipcRenderer.invoke('apps:rename', id, name),
  appsLaunch: (id) => ipcRenderer.invoke('apps:launch', id),
  appsStop: (id) => ipcRenderer.invoke('apps:stop', id),
  appsReveal: (id) => ipcRenderer.invoke('apps:reveal', id),
  appsEmbedUrl: (id) => ipcRenderer.invoke('apps:embed-url', id),
  appsProbeFolder: (path) => ipcRenderer.invoke('apps:probe-folder', path),
  appsPick: () => ipcRenderer.invoke('apps:pick'),
  onAppsStatus: (cb) => {
    ipcRenderer.on('apps:status', (d) => cb(d));
  },

  // ===== WINDOW STREAM: run a real Windows app inside the browser =====
  winList: () => ipcRenderer.invoke('win:list'),
  winBegin: (sourceId) => ipcRenderer.invoke('win:begin', sourceId),
  winInput: (cmds) => ipcRenderer.invoke('win:input', cmds),
  winFocus: () => ipcRenderer.invoke('win:focus'),
  winRect: () => ipcRenderer.invoke('win:rect'),
  winPlace: (x, y) => ipcRenderer.invoke('win:place', x, y),
  winCursor: () => ipcRenderer.invoke('win:cursor'),
  winShow: () => ipcRenderer.invoke('win:show'),
winEnd: () => ipcRenderer.invoke('win:end'),
  
  // ===== EXTENSIONS: Chrome-style add-ons =====
  extList: () => ipcRenderer.invoke('ext:list'),
  extPickFolder: () => ipcRenderer.invoke('ext:pick-folder'),
  extInstallZip: () => ipcRenderer.invoke('ext:install-zip'),
  extCatalog: () => ipcRenderer.invoke('ext:catalog'),
  extStoreInstall: (key) => ipcRenderer.invoke('ext:store-install', key),
  extPickPackage: () => ipcRenderer.invoke('ext:pick-package'),
  extSetEnabled: (id, enabled) => ipcRenderer.invoke('ext:set-enabled', id, !!enabled),
  extRemove: (id) => ipcRenderer.invoke('ext:remove', id),
  extReload: (id) => ipcRenderer.invoke('ext:reload', id),
  
  // ===== Chrome Web Store install, used by the in-page "Add in NEXORA" button =====
  extWebstoreParse: (url) => ipcRenderer.invoke('ext:webstore-parse', url),
  extWebstoreInstall: (id, meta) => ipcRenderer.invoke('ext:webstore-install', id, meta || {}),
  extWebstoreCatalogLookup: (id, name) => ipcRenderer.invoke('ext:webstore-catalog-lookup', id, name),
  extProxyGet: () => ipcRenderer.invoke('ext:proxy-get'),
  extProxySet: (rule) => ipcRenderer.invoke('ext:proxy-set', rule),
  
  });
