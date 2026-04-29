# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Logic Rail – Poslovni plan kalkulator**: A single-page static web app (no framework, no build step, no npm) for a Slovenian freight rail operator. Calculates costs, revenues, and generates a 7-page business plan PDF. Route: Dobova (SI/HR border) ↔ Villa Opicina (Italy).

## Running the app

Open `index.html` directly in a browser (`file://` works) or via any static server:
```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

No build, no install. All dependencies are CDN scripts loaded in `index.html`.

## Regenerating embedded fonts

If you need to change the PDF font (currently Inter), edit `build-fonts.js` then:
```bash
node build-fonts.js
```
This reads `Inter-Regular.ttf` and `Inter-Bold.ttf` and writes `Inter-Regular-normal.js` and `Inter-Bold-bold.js`. The TTF files were sourced from `@expo-google-fonts/inter@0.2.3` via jsdelivr. Script outputs auto-registration JS compatible with jsPDF UMD v2.5.

## Architecture

```
index.html             – All CSS + UI structure; data-i18n attributes on every translatable element
app.js                 – All logic: calculations, DOM renderers, Chart.js, jsPDF export, i18n helpers
i18n.js                – Translation dictionary: I18N object, 5 langs × 431 keys
Inter-Regular-normal.js – Base64-encoded Inter Regular font (auto-registered into jsPDF at load time)
Inter-Bold-bold.js      – Base64-encoded Inter Bold font (auto-registered into jsPDF at load time)
build-fonts.js         – One-shot script: converts Inter TTF → jsPDF font JS files
```

### Data flow

1. User changes input → `oninput="calc()"` → `calc()` computes everything, saves to `lastData`
2. `calc()` calls all renderers: `renderHero()`, `renderResources()`, `renderCosts()`, `renderRevenue()`, `renderPlan()`, `renderCharts()`
3. All renderers read from `lastData.calc` and `lastData.inputs`; they write translated HTML via `t()` calls
4. PDF button → `exportPDF()` reads `lastData` and builds a 7-page jsPDF document, also fully translated

### i18n system

- `currentLang` – global, persisted in `localStorage.lr_lang`, default `'hr'`
- `t(key, vars)` – lookup with HR fallback; `vars` replaces `{name}` placeholders; arrays (e.g. `months.short`) pass through unchanged
- `applyTranslations()` – walks all `[data-i18n]` elements and sets `.textContent = t(key)`; also marks active lang button
- `setLang(lang)` – persists, calls `applyTranslations()`, then `calc()` to re-render dynamic content
- Called at startup: `applyTranslations()` before `calc()`

### jsPDF font setup

jsPDF is loaded as UMD (`window.jspdf.jsPDF`). The generated font JS files self-register via:
```js
jsPDF.API.events.push(['addFonts', function () {
  this.addFileToVFS('Inter-Regular.ttf', font);
  this.addFont('Inter-Regular.ttf', 'Inter', 'normal');
}]);
```
Must load after jsPDF CDN but before jspdf-autotable. `autoTable()` calls need `styles: { font: 'Inter' }` explicitly — it does not inherit `setFont()`.

### Languages

| Code | Language | PDF filename prefix |
|------|----------|---------------------|
| `hr` | Hrvatski (default) | `Logic_Rail_Poslovni_Plan` |
| `en` | English | `Logic_Rail_Business_Plan` |
| `it` | Italiano | `Logic_Rail_Piano_Aziendale` |
| `sl` | Slovenščina | `Logic_Rail_Poslovni_Nacrt` |
| `sr` | Srpski (latinica) | `Logic_Rail_Poslovni_Plan` |

### Adding i18n keys

All 5 languages must have identical key sets. Verify parity with:
```bash
node -e "
const I18N = (new Function(require('fs').readFileSync('i18n.js','utf8') + '; return I18N;'))();
const hrKeys = new Set(Object.keys(I18N.hr));
['en','it','sl','sr'].forEach(l => {
  const missing = [...hrKeys].filter(k => I18N[l][k] === undefined);
  if (missing.length) console.log('MISSING in ' + l + ':', missing);
});
"
```

### Key i18n conventions

- `pdf.*` – keys used only in PDF generation
- `field.*` – form field labels and hints
- `card.*.title` / `card.*.sub` – card headers
- `chart.*` – chart labels and tooltips
- `route.*` – SVG route diagram texts
- `plan.*` – P&L and resources tables in the Plan tab
- Template variables use `{name}` syntax: `t('pdf.s3.fc3', { n: d.inspectorsNeeded, amount: fmtEurK(i.wageInspector) })`
