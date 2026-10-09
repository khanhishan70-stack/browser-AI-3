# NEXORA Browser — Official Website

Static website. Open `index.html` in any browser, or serve the folder:

```powershell
cd website
python -m http.server 8080
# → http://localhost:8080
```

## Going public checklist

1. Edit **`config.js`** — fill in `githubRepoUrl`, `releasesUrl`,
   `windowsInstallerUrl`, and `releaseInfo`. Until then, download
   buttons stay disabled ("Coming Soon") and GitHub buttons show a
   notice. Never hard-code release URLs in `index.html`.
2. Replace the illustrative CSS mockups in **Screenshots** with real
   NEXORA screenshots (drop files in `assets/screenshots/` and swap
   the `.shot-mini` blocks for `<img>` tags).
3. Publish Privacy Policy + Security Policy pages and link them from
   the Privacy section and footer.
4. Set the `securityContact` in `config.js` and surface it in Privacy.

## Honesty rules for this site

- Only advertise features verified in the real build.
- Never invent version numbers, sizes, dates, or requirements.
- Gallery mockups are labeled illustrative until real screenshots land.
