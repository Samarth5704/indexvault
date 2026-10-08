# IndexVault — Product Spec (v2)

## 1. Vision
A fast, beautiful local web app that turns free Indian market data into
research-grade tables, charts and exports. It should feel like a premium
fintech product (think Linear × Bloomberg terminal × Zerodha Console) and
let the user **customise every default, every number and every visual**.

**Users:** Sam first (market research and backtesting). Designed
so that other students could clone it from GitHub and run it.

**Non-goals (v2):** live tick streaming, order placement, user accounts, cloud hosting.

---

## 2. What already exists
`backend/indexvault/` is a working, tested core library from the prototype:

| Module | Contents |
|---|---|
| `indices.py` | Catalogue of ~35 Yahoo tickers grouped by category |
| `data.py` | `get_data()` with CSV cache, incremental update & backfill; `resample()` (D/W/M/Q/Y, OHLC-correct, labelled by last trading day); Excel/CSV-zip export; `cache_inventory()`, `clear_cache()`, `check_ticker()`; synthetic `demo` source |
| `analytics.py` | CAGR, vol, drawdown series + episode table, `summary_metrics()` (Sharpe, Sortino, Calmar, VaR, CVaR, skew, kurtosis, best/worst, 52w), trailing returns, monthly-returns grid, seasonality, weekday stats, rolling CAGR + summary, rolling vol, SMAs, rebase, correlation (weekly), rolling correlation, beta, relative strength, XIRR, SIP backtest with step-up + lump-sum comparison, data-quality report, big moves |
| `cli.py` | `list`, `fetch`, `update`, `stats` |

The Streamlit prototype (`legacy/streamlit_app.py`) was the behavioural reference
during the build; it was removed in Milestone 9 and lives on in git history.

Refactors needed in core (Milestone 1):
- Replace hard-coded constants (`TD = 252`, `rf=0.065`, SMA `(50, 200)`, rolling
  windows, thresholds) with function parameters whose defaults come from settings.
- `CACHE_ROOT` must be settable at runtime (from settings), not only via env var.
- Catalogue must merge built-in `indices.CATALOG` with the user's `config/catalog.json`.
- Add a pluggable source registry so new sources (CSV import now, NSE later) plug in
  with the same `fetch(ticker, start, end) -> DataFrame` signature.

---

## 3. Pages & features

Global chrome (on every page):
- **Left rail** (collapsible to icons): Dashboard, Data Studio, Analyse, Compare,
  Rolling, SIP Lab, Seasonality, Data Health, Cache, Settings.
- **Top bar:** global *Series picker* (chips, grouped search, watchlists), *date-range
  control* (presets 1M…Max + custom), *frequency* selector, data-source badge (Yahoo /
  Demo / CSV) and a theme toggle. Selections are shared across pages and reflected
  in the URL (`#/analyse?s=^NSEI,^NSEBANK&p=10Y&f=M`) so every view is linkable.
- **Command palette** (`Ctrl/⌘+K`): jump to page, add/remove series, switch theme,
  run "Update cache", open settings sections, export current view.
- **Toasts** for background jobs (download progress per ticker, export ready, errors).

### 3.1 Dashboard (customisable home)
A grid of widgets the user can **add, remove, resize and drag** (layout saved in
settings). Widget types:
- Market snapshot card per index (last, 1D/1M/YTD change, sparkline, % from 52w high)
- Mini chart (any series, any range)
- Heatmap tile: today/1W/1M returns across all sectoral indices
- India VIX gauge with historical percentile
- Drawdown monitor (current drawdown for watchlist)
- Rolling-return snapshot (e.g. "5Y rolling CAGR today vs median")
- Notes widget (markdown, stored locally)
Ship with a sensible default layout; "Reset layout" restores it.

### 3.2 Data Studio (download & export)
- Table of OHLCV + Return % at chosen frequency; virtual scrolling for 10k+ rows;
  sortable; column show/hide & reorder; sticky header; search by date.
- Column builder: add derived columns — returns (simple/log), SMA(n), EMA(n), rolling
  vol(n), RSI(n), drawdown, rebased-to-100. Parameters editable.
- **Export presets** (saved in settings): name, series set, frequency, columns, format.
  Formats: Excel (formatted: summary sheet, combined closes, one sheet per series),
  CSV, CSV-zip, JSON. Options: date format, decimal places, Indian number format in
  Excel, include metadata sheet (source, fetched-at, caveats).
- "Copy as Markdown table" for blog posts and reports.

### 3.3 Analyse (single series deep-dive)
- KPI strip — **user chooses which metrics and their order** (from all of
  `summary_metrics`).
- Trailing returns row (periods configurable).
- Price chart: line / candle / area; log toggle; overlays from settings (SMA/EMA
  windows, colours); crosshair with OHLC readout; range brush; event markers (big moves
  over threshold).
- Underwater drawdown chart + worst-N drawdowns table (N configurable).
- Monthly-returns heatmap (year × month + year column), calendar-year bars, daily
  return histogram with normal-curve overlay, rolling volatility (window configurable).
- "All statistics" drawer. Every chart has: PNG export, CSV of its data, "view as table".

### 3.4 Compare
- Rebased growth-of-100 from the common start date (explain why in a tooltip).
- Side-by-side metrics table (metric set configurable), beta vs chosen benchmark.
- Correlation matrix (return frequency configurable: daily/weekly/monthly).
- Relative-strength ratio (A/B) with its own SMA; rolling correlation (window configurable).
- Scatter: risk (vol) vs return (CAGR) for all selected series.

### 3.5 Rolling returns
- Holding-period chips (configurable list), target CAGR input.
- Rolling CAGR lines; distribution view (box/violin per series); table with min / median /
  max / % negative / % ≥ target / latest.
- Plain-English insight line: "Over 5,671 five-year periods, NIFTY 50 lost money 3.1% of
  the time."

### 3.6 SIP Lab
- Inputs: series, monthly amount, SIP day, step-up %, start/end, optional lump-sum top-ups.
- Output: invested vs value vs lump-sum line; XIRR, absolute return, worst point vs
  invested; ₹ in lakh/crore.
- **Scenario compare:** save up to 4 SIP scenarios and compare side by side.
- "Start-date sensitivity": XIRR for every possible start month (heat strip).
- Export ledger (monthly) to CSV/Excel.

### 3.7 Seasonality
Month-of-year and day-of-week stats + charts; toggle mean/median; min-years filter; a
caution note about noise.

### 3.8 Data Health
Quality report per series (gaps, stale runs, OHLC inconsistencies, duplicates, big
moves over threshold). Status pills (good / warning / critical) with icon + label.

### 3.9 Cache
Inventory table (source, ticker, rows, first/last date, updated, size), per-row actions
(update, re-download, delete), "Update all" with progress, ticker health check across
the catalogue, cache location display.

### 3.10 Settings (the customisation centre)
Sections, searchable, each with "Reset section":
1. **Appearance** — theme preset, light/dark/system, accent colour, chart palette preset,
   font scale, density (comfortable/compact), corner radius, motion (full/reduced/off),
   sidebar default state. Live preview panel.
2. **Theme editor** — edit any token of the current theme; save as a new named theme;
   import/export theme JSON. Custom chart palettes run the CVD check (see DESIGN § 7) and
   warn if colours are too close.
3. **Formats** — number system (Indian/International), decimals, date format
   (DD-MM-YYYY / YYYY-MM-DD / DD MMM YYYY), currency symbol, percent style.
4. **Data** — default source, cache folder, auto-update on open, refresh staleness
   (hours), request throttle, default period & frequency, default series.
5. **Catalogue & watchlists** — add/edit/delete custom indices (name, ticker, category,
   source); create watchlists (e.g. "Sectors I track"); reorder; import/export.
6. **Analytics** — risk-free rate, trading days/year, SMA/EMA windows, rolling windows,
   rolling vol window, correlation frequency, big-move threshold, drawdown table size,
   trailing-return periods, target CAGR, KPI cards shown & order, metrics shown in
   Compare.
7. **SIP defaults** — amount, day, step-up.
8. **Export** — presets, default format, Excel styling (header colour, freeze panes),
   metadata sheet on/off.
9. **Shortcuts** — view and rebind keyboard shortcuts.
10. **Backup** — export all settings/catalogue/watchlists/dashboard as one JSON; import;
    reset everything.

---

## 4. Settings model
Single source of truth: `api/settings.py` defines a Pydantic `Settings` model with
defaults, descriptions and validation; `api/settings_store.py` loads, migrates and saves
it. Stored in `config/settings.json` (created on first run). Includes `schema_version`
with migrations so old files upgrade cleanly (the old file is kept as
`settings.v<n>-<stamp>.json`; an unusable file is renamed `settings.invalid-<stamp>.json`,
never deleted). `GET /settings/schema` is `Settings.model_json_schema()`.

Conventions (decided in M0): percentages are decimals and no key contains `%`; metrics
are referenced by id from `api/metrics.py` (`cagr`, `ann_vol`, `max_drawdown`, …).
`PATCH` on a model section merges fields; on a dict section (`custom_themes`,
`custom_palettes`, `shortcuts`) it replaces the whole dict.

```jsonc
{
  "schema_version": 1,
  "appearance": {
    "theme": "midnight",            // midnight | paper | terminal | saffron | <custom>
    "mode": "system",               // light | dark | system
    "accent": null,                 // hex override or null = theme default
    "chart_palette": "default",     // validated preset name or custom
    "font_scale": 1.0,              // 0.875 – 1.25
    "density": "comfortable",       // comfortable | compact
    "radius": "md",                 // none | sm | md | lg
    "motion": "full",               // full | reduced | off
    "sidebar": "expanded",          // expanded | collapsed
    "gain_loss": "market",          // market (green/red) | colorblind (blue/red)  — DESIGN § 1.2
    "market_pulse": true            // ticker strip under the top bar               — DESIGN § 5
  },
  "custom_themes": {},              // name -> {base: <built-in>, tokens: {"--accent": "#…"}}
  "custom_palettes": {},            // name -> ["#hex", …] (2–12 colours)
  "formats": {
    "number_system": "indian",      // indian | international
    "decimals": 2,
    "date_format": "DD-MM-YYYY",
    "currency": "₹"
  },
  "data": {
    "source": "yahoo",
    "cache_dir": "backend/data_cache",
    "auto_update_on_open": true,
    "stale_after_hours": 3,
    "request_throttle_seconds": 0.5,  // pause between downloads in bulk jobs
    "default_period": "10Y",
    "default_frequency": "Daily",
    "default_series": ["^NSEI", "^NSEBANK"]
  },
  "analytics": {
    "risk_free_rate": 0.065,
    "trading_days": 252,
    "sma_windows": [50, 200],
    "ema_windows": [],
    "rolling_windows_years": [1, 3, 5, 7, 10],
    "rolling_vol_window": 63,
    "rsi_window": 14,
    "correlation_frequency": "W",   // D | W | M (also used for beta)
    "rolling_corr_window": 52,      // periods of correlation_frequency
    "big_move_threshold": 0.05,     // also the Data Health big-move threshold
    "seasonality_min_years": 5,     // flag months/days with fewer years of data
    "quality_gap_days": 5,
    "drawdown_table_size": 5,
    "histogram_bins": 50,
    "trailing_periods": ["1M","3M","6M","YTD","1Y","3Y","5Y","10Y"],
    "target_cagr": 0.12,
    "kpi_cards": ["end_level","cagr","ann_vol","max_drawdown","sharpe","pct_from_52w_high"],
    "compare_metrics": ["cagr","ann_vol","sharpe","sortino","max_drawdown","calmar"]
  },
  "sip": { "amount": 10000, "day": 5, "step_up": 0.0, "sensitivity_min_months": 12 },
  "export": { "default_format": "xlsx", "presets": [], "metadata_sheet": true,
              "excel_header_colour": "#1c5cab", "excel_freeze_panes": true },
  "dashboard": { "layout": [ /* {id, widget, x, y, w, h, config} */ ] },
  "shortcuts": { "palette": "mod+k", "toggle_theme": "mod+shift+l",
                 "toggle_sidebar": "mod+b", "focus_series_picker": "/" }
}
```
`config/catalog.json` holds `custom_indices` (`{id, name, ticker, category, source}`) and
`watchlists` (`{id, name, tickers}`), managed by `api/catalog.py`.

---

## 5. API contract (FastAPI, prefix `/api`)
All responses JSON unless a file. Dates ISO `YYYY-MM-DD`. Errors:
`{ "error": { "code": "...", "message": "...", "detail": {...} } }`.

| Method & path | Purpose |
|---|---|
| `GET /health` | status, version, data source reachability |
| `GET /settings` · `PUT /settings` · `PATCH /settings/{section}` · `POST /settings/reset?section=` | read / write / reset settings (validated) |
| `GET /settings/schema` | JSON schema with descriptions — the Settings UI renders forms from it |
| `GET /settings/backup` · `POST /settings/restore` | full backup / restore |
| `GET /catalog` | built-in + custom indices, grouped; watchlists |
| `POST/PUT/DELETE /catalog/indices/{id}` · `.../watchlists/{id}` | manage custom entries (POST = create, 409 if it exists; PUT = upsert) |
| `PUT /catalog/watchlists/order` | body `{ids}` → reorder watchlists |
| `GET /series/{ticker}?start&end&freq&columns` | OHLCV (+ derived columns) as `{columns, rows}` |
| `POST /load` | body `{tickers, start, end, refresh}` → job id |
| `GET /jobs/{id}` (or SSE `GET /jobs/{id}/stream`) | per-ticker progress / errors |
| `GET /analytics/summary?tickers&start&end` | metrics per ticker |
| `GET /analytics/trailing` · `/drawdowns` · `/monthly-grid` · `/yearly` · `/distribution` · `/rolling-vol` | Analyse page data |
| `GET /analytics/compare?tickers&benchmark` | rebased, metrics, beta, correlation |
| `GET /analytics/relative-strength?a&b` · `/rolling-correlation?a&b&window` | pair tools |
| `GET /analytics/rolling?tickers&years&target` | rolling CAGR series + stats |
| `POST /analytics/sip` | SIP inputs → ledger (monthly) + stats; `?sensitivity=true` adds start-date strip |
| `GET /analytics/seasonality?ticker` · `/weekday?ticker` | seasonality |
| `GET /analytics/quality?tickers` · `/big-moves?ticker&threshold` | data health |
| `POST /export` | `{tickers, start, end, freq, columns, format, options}` → file download |
| `GET /cache` · `POST /cache/update` · `DELETE /cache/{source}/{ticker}` · `DELETE /cache?confirm=true` | cache mgmt (`/cache/update` returns a job) |
| `POST /import/csv?ticker&dayfirst` | raw CSV body (no multipart dependency) → stored as source `csv` |
| `GET /tickers/check?source` | catalogue health check |

Analytics endpoints read parameter defaults from settings; query params override.
Heavy calls are memoised in-process keyed on (ticker, range, cache mtime).
Full response shapes: `docs/API.md`. Interactive docs: `/api/docs`.

---

## 6. Frontend architecture
- `index.html` — shell: rail, top bar, `<main id="view">`, palette, toast region.
- `js/router.js` — hash router; each page module exports `mount(el, ctx)` / `unmount()`.
- `js/store.js` — tiny observable store: selection (series, range, freq), settings,
  catalogue. Persists selection to the URL.
- `js/api.js` — fetch wrapper with timeouts, error normalisation, in-memory cache.
- `js/settings.js` — loads settings, applies them as CSS variables / `data-*` attributes
  on `<html>`, exposes `format.number()`, `format.inr()`, `format.date()`, `format.pct()`.
- `js/components/` — `series-picker`, `date-range`, `kpi-card`, `data-table` (virtual
  scroll), `chart-card` (title, actions: PNG/CSV/table/fullscreen), `tabs`, `drawer`,
  `modal`, `toast`, `command-palette`, `skeleton`, `empty-state`, `status-pill`,
  `form-field` (renders from JSON schema), `widget-grid`.
- `js/charts/` — thin wrappers: `lineChart`, `candleChart`, `areaChart` (Lightweight
  Charts); `heatmap`, `bars`, `histogram`, `corrMatrix`, `scatter`, `boxplot` (ECharts).
  All read colours from CSS tokens and re-theme live when settings change.
- `css/tokens.css` — all design tokens per theme (see DESIGN.md).

---

## 7. Milestones
| # | Milestone | Done when |
|---|---|---|
| 0 | Setup & read-in | venv works, tests pass, Claude summarises the codebase and plan |
| 1 | Settings service + core refactor + API | all § 5 endpoints return correct data; pytest covers them |
| 2 | Design system & app shell | tokens, 4 themes, rail, top bar, router, palette, toasts; themes switch live |
| 3 | Data Studio | table, column builder, export presets, all formats download correctly |
| 4 | Analyse | all charts & tables, configurable KPIs, chart-card actions |
| 5 | Compare + Rolling | all views; insight sentence; scatter |
| 6 | SIP Lab + Seasonality + Data Health + Cache | all views incl. scenario compare & sensitivity |
| 7 | Settings UI | every setting editable, live preview, theme editor, backup/restore |
| 8 | Dashboard | widget grid, drag/resize, persisted layout, default layout |
| 9 | Polish & ship | a11y pass, mobile layout, perf, empty/error states, README with screenshots, GitHub-ready |

---

## 8. Quality bar
- First meaningful paint < 1 s on localhost; page switches < 150 ms with cached data.
- 20 series × 25 years daily loads without freezing the UI (virtual table, downsampled
  charts via LTTB for > 5k points).
- No console errors. Lighthouse accessibility ≥ 95.
- Works in latest Chrome, Edge, Firefox, Safari; 390 px mobile width usable.
