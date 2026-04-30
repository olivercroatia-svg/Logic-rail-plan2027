# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Logic Rail – Poslovni plan kalkulator**: A single-page static web app (no framework, no build step, no npm) for a Slovenian freight rail operator. Calculates costs, revenues, projects 24-month cashflow, and generates a 12-page business plan PDF. Route: Dobova (SI/HR border) ↔ Villa Opicina (Italy).

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
i18n.js                – Translation dictionary: I18N object, 5 langs × 486 keys
Inter-Regular-normal.js – Base64-encoded Inter Regular font (auto-registered into jsPDF at load time)
Inter-Bold-bold.js      – Base64-encoded Inter Bold font (auto-registered into jsPDF at load time)
build-fonts.js         – One-shot script: converts Inter TTF → jsPDF font JS files
```

### Data flow

1. User changes input → `oninput="calc()"` → `calc()` computes everything, saves to `lastData`
2. `calc()` calls `calcCashflow()` (writes `lastData.cashflow`), then all renderers: `renderHero()`, `renderResources()`, `renderCosts()`, `renderRevenue()`, `renderPlan()`, `renderCashflow()`, `renderCharts()`
3. All renderers read from `lastData.calc`, `lastData.inputs`, and `lastData.cashflow`; they write translated HTML via `t()` calls
4. PDF button → `exportPDF()` reads `lastData` and builds a 9-page jsPDF document, also fully translated

### Tabs (UI)

| # | Tab | Panel id | Content |
|---|-----|----------|---------|
| 1 | Ulazni podaci | `tab-unos` | All input forms |
| 2 | Resursi | `tab-resursi` | Locomotive/driver/inspector calculations + route SVGs |
| 3 | Troškovi | `tab-troskovi` | Fixed/variable cost tables + cost doughnut chart |
| 4 | Prihodi i marža | `tab-prihodi` | Trasa breakdowns + revenue vs cost chart |
| 5 | Poslovni plan | `tab-plan` | P&L + resources + sensitivity chart + annual projection |
| 6 | Tijek novca (Cashflow) | `tab-cashflow` | 24-month cashflow projection: alert + 4 KPI tiles + mixed chart (bar inflow/outflow + line cumulative) + 25-row table |

### Cashflow model (`calcCashflow()` in [app.js])

- **t=0 (initial outlay):** `3 × locoRent × locoNeeded` — covers 2-month deposit + advance rent for M1, per locomotive
- **Revenue:** collected 30 days after service → revenue earned in month N appears as inflow in month N+1 (M1 inflow = 0)
- **Wages** (drivers + inspectors + mgmt + ops mgr): 10 days after month end → wages for month N paid in month N+1 (M1 wages payment = 0)
- **Loco rent:** paid in advance for current month — M1 already covered by initial outlay, so M1 rent outflow = 0; M2-M24 = `locoRentMonthly`
- **Track access (trasa) + dispatcher:** invoiced after month end with 30-day terms → expensed in N+1
- **Insurance, other fixed, vehicles:** paid in current month
- **2-month deposit stays tied up** (refunded at end of contract — outside the 24-month window)
- Returns `{ initialOutlay, rows[24], minBalance, minMonth, endBalance, breakevenMonth }`

### PDF structure (12 pages)

| Page | Section | Content |
|------|---------|---------|
| 1 | Cover | Brand block, KPIs, executive summary |
| 2 | s1 — Uvod | Company, ops model, technical specs, loco logic + 2 route SVGs |
| 3 | s2 — Resursi | Resources table + loco/driver calculation tables |
| 4 | s3 — Troškovi | Fixed + variable cost tables + trasa breakdown |
| 5 | Cost chart | Doughnut: cost structure |
| 6 | s4 — P&L | Revenue + expense lines + annual projection + per-pair margin |
| 7 | Revenue chart | Bar: revenue vs costs |
| 8 | s5 — Sensitivity | Sensitivity table + risks + conclusion |
| 9 | Sensitivity chart | Bar: profit by trains/month |
| 10 | Cashflow page A | Intro + 4 KPIs (initial, min, breakeven, end) + cashflow chart |
| 11 | Cashflow page B | Assumptions bullets + 25-row cashflow table (initial + 24 months) |
| 12 | s6 — Ulazni params | All input parameter values |

Page numbering uses a `pageNum++` counter — when adding/removing pages, the footer numbers update automatically.

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

### i18n obligation — new text must be translated immediately

**Any time new user-visible text is added to the app — a UI label, card title, hint, tab name, PDF string, chart label, tooltip, or any other copy — it must be added to all 5 language dictionaries in `i18n.js` in the same change.** Never add a new key to only `hr` (or any single language) and leave the rest for later.

Steps for adding a new translatable string:
1. Choose a key following the existing naming convention (e.g. `field.newThing`, `pdf.s3.newLine`, `card.revenue.hint`).
2. Add the key with a value for **all 5 languages**: `hr`, `en`, `it`, `sl`, `sr`.
3. In `index.html`: add `data-i18n="your.key"` attribute to the element (for static HTML text).
4. In `app.js`: use `t('your.key')` or `t('your.key', { var: value })` (for dynamically rendered content).
5. Run the parity check above to confirm no language is missing the key.

### Key i18n conventions

- `pdf.*` – keys used only in PDF generation (sections `pdf.s1` through `pdf.s6` for original chapters, `pdf.s_cf` for cashflow chapter)
- `field.*` – form field labels and hints
- `card.*.title` / `card.*.sub` – card headers
- `chart.*` – chart labels and tooltips
- `route.*` – SVG route diagram texts
- `plan.*` – P&L and resources tables in the Plan tab
- `cf.*` – cashflow tab UI (alert assumptions, KPI tiles, table columns/rows, chart legend)
- Template variables use `{name}` syntax: `t('pdf.s3.fc3', { n: d.inspectorsNeeded, amount: fmtEurK(i.wageInspector) })`
