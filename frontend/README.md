# Frontend

Plain HTML + CSS + native ES modules. No framework, no build step, no npm. FastAPI serves
this folder at `/` (with `Cache-Control: no-cache`, so edited modules are never stale).
Design rules: `docs/DESIGN.md`. API shapes: `docs/API.md`.

## Structure
| Path | What it does |
|---|---|
| `index.html` | Shell markup + the inline SVG icon sprite (`#i-<name>`) |
| `css/tokens.css` | Fonts and all design tokens: 4 themes, density, radius, motion |
| `css/base.css` | Reset, typography, focus ring, motion rules, utilities |
| `css/shell.css` | Rail, top bar, market pulse, page container, mobile sheets |
| `css/components.css` | Buttons, inputs, picker, palette, toasts, cards, tables, states |
| `css/pages/*.css` | Page layouts (grid, KPI strip, …) |
| `js/app.js` | Boot: load settings/catalogue/health, draw shell, start router, mount pages |
| `js/router.js` · `js/routes.js` | Hash router (`#/<page>?<selection>&<page params>`) and the page list |
| `js/store.js` | Observable store; shared selection (series/range/frequency) synced to the URL |
| `js/api.js` | `fetch` wrapper: timeouts, `ApiError`, GET cache, `followJob()` (SSE → polling fallback) |
| `js/settings.js` | Applies settings to `<html>` live; `saveSection` / `resetSection` / `adoptSettings`; `format.number/pct/money/date/delta/metric` |
| `js/shell.js` · `js/pulse.js` | Rail, top bar, mobile sheets; market-pulse strip |
| `js/commands.js` | Command-palette commands + global keyboard shortcuts (from settings) |
| `js/dom.js` · `js/fuzzy.js` · `js/clipboard.js` | `h()` element helper, `icon()`, focus trap; fuzzy matching; copy with fallbacks |
| `js/columns.js` | Series column ids (`close`, `sma_50`, …) → labels, kinds, cell formatting, defaults |
| `js/grid-layout.js` | Dashboard layout maths (no DOM): compact (gravity), move/resize with swap-or-push, `findSpot`, `keyboardMove` |
| `js/markdown.js` | Tiny safe Markdown → DOM renderer (notes widget) |
| `js/colour.js` | Colour maths for the theme editor: parse, OKLab ΔE, colour-blind simulation (Machado 2009), WCAG contrast, `checkPalette()` |
| `js/components/` | `series-picker`, `date-range` (+ `freqSelect`), `command-palette`, `toast`, `kpi-card`, `chart-card`, `feedback` (skeleton, empty/error state, status pill, `asyncView`, `guard` for chart cards), `data-table` (virtual scroll, sort, column menu), `drawer`, `column-builder`, `export-panel`, `form-field` (settings), `widget-grid` (dashboard: 12-column grid, drag/resize/keyboard) |
| `js/charts/` | `vendor.js` (lazy-loads the libraries), `theme.js` (tokens → chart colours), `timeseries.js` (Lightweight Charts: line/area/candle/underwater, markers, log, PNG), `echarts.js` (host + heatmap/bars/histogram builders), `sync.js` (crosshair sync), `lttb.js` (LTTB downsampling for long series, memoised; extremes and marker dates kept) |
| `js/components/legend.js` | Series legend in slot colours + the "too many series" note |
| `js/pages/` | One module per page: `export default { mount(el, ctx) -> cleanup? }` |
| `js/components/history-tag.js` | Series labels: Price/TRI tag, "< 1 yr" short-history tag, page notes for short history and mixed price/TRI |
| `js/components/csv-import.js` | Cache page "Import a CSV" card (niftyindices.com downloads or any Date+Close CSV), optional per-ticker override |
| `js/components/form-field.js` | One settings field rendered from a JSON-schema property (`x-unit`, `x-options`, `x-ordered` hints): segmented, select, switch, number, percent, range, colour, text, list |
| `js/pages/dashboard/` | Dashboard widgets: `widgets.js` (registry, card chrome, add/configure drawer, default layout), `widgets-market.js` (snapshot, mini chart, heatmap), `widgets-risk.js` (VIX gauge, drawdown monitor, rolling snapshot, notes), `common.js` |
| `js/pages/settings/` | Settings sections: `meta.js` (labels/widgets over the schema), `schema-section.js` (generic fields, formats preview, presets), `appearance.js`, `theme-editor.js`, `palette-editor.js`, `catalogue.js`, `shortcuts.js`, `backup.js` |
| `vendor/` · `fonts/` | Lightweight Charts, ECharts, Inter, JetBrains Mono — see `vendor/VERSIONS.md` |

## Conventions
- Styles use tokens only (`var(--…)`): no raw colours or pixel font sizes in component CSS.
- API percentages are decimals; format with `format.pct()` (never multiply by 100 by hand).
- Every async view uses `asyncView()` / `chartCard().loading|empty|error` — never a blank panel.
- Series colour = selection order (`seriesColour(ticker)`); 9+ are grey.
- Page modules clean up their store subscriptions in the function `mount` returns.
