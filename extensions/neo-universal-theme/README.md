# Neo Universal Theme

Real dark and light theming for any website in NEXORA Browser. Not an inversion
filter — every color is re-derived from what the page actually uses.

## What it does

- **Auto / Dark / Light** — Auto follows `prefers-color-scheme`.
- **Weak / Medium / Strong** — strength of the mapping.
- **Global or per-site** — set a mode once for everything, or override a mode
  for individual domains. Per-site overrides win over the global setting.
- **Remember this site** — on the in-page control. Off means the choice applies
  only to the current page and is discarded on navigation.

## Controls

An in-page control appears in the bottom-right corner of every page. Click it
to switch mode, change strength, or toggle the global/site scope.

A popup UI also ships at `popup/index.html` and is wired to storage, so it works
without tab APIs. Neo does not yet render `action.default_popup`, so the popup
is reachable by URL but not from the toolbar. The in-page control is the
supported surface today.

## Media safety

Images, video, canvas, SVG, and iframes are excluded from recoloring:

- `img`, `svg`, `canvas`, `video`, `picture`, `iframe` get `filter: none` so
  photos are not hue-shifted.
- Ancestors of media are never recolored, which protects photo backdrops and
  overlay chrome.

Verified: canvas pixels are byte-identical before and after a mode switch.

## How it themes

Two layers, applied together:

1. **CSS layer** — a scoped stylesheet handles document-level surfaces
   (`html`, `body`, headers, cards, tables, form controls) so the first paint is
   correct and there is no flash.
2. **Computed pass** — a batched walk reads each element's real computed colors,
   classifies them (background / border / text / accent), maps them to the
   target mode, and writes `!important` inline overrides.

Text colors resolve against the nearest *opaque* ancestor background rather than
their own, which is what makes transparent-background text recolor correctly.

Accent colors are hue-preserved. If a green or orange falls below 4.5:1 contrast
on the new background, it is lightened or darkened until it passes, rather than
being replaced with a generic color.

## Dynamic pages

- A `MutationObserver` picks up nodes added after load.
- `history.pushState` / `replaceState` / `popstate` are patched so single-page
  apps re-theme on navigation without a reload.
- Open Shadow DOM roots are pierced, styled, and re-processed on mode change.

## Files

| Path | Role |
| --- | --- |
| `manifest.json` | MV3. All frames, document-start, storage + scripting + i18n. |
| `content/boot.js` | Reads settings, applies mode, tracks hostname, transient overrides. |
| `content/theme-engine.js` | CSS layer, computed pass, batched queue, shadow piercing. |
| `content/color-engine.js` | Parsing, classification, luminance, contrast. |
| `content/site-rules.js` | Per-site rules for YouTube, GitHub, Reddit, Google, Wikipedia, Stack Overflow, Gmail. |
| `content/mutation-handler.js` | Observer and SPA history patching. |
| `content/inpage-ui.js` | In-page Neo-styled control. |
| `styles/preload.css` | Early anti-flash stylesheet. |
| `storage/settings.js` | Settings model and per-frame storage sync. |
| `popup/` | Popup UI (storage-driven). |

Settings propagate through `chrome.storage.onChanged`, which every frame already
listens to. There is deliberately no background service worker: nothing consumed
its messages, and it only produced a registration error under Electron.

## Permissions

Only `storage` and `scripting`, plus host access for all URLs. No network, no
tabs, no browsing data access.

## Verification

Tested in Electron with the extension loaded from the Neo store: Light → Dark →
Light round-trip, plus dynamic nodes, Shadow DOM, accent contrast, image filter,
and canvas pixel integrity.