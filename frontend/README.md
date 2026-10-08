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
| `js/settings.js` | Applies settings to `<html>` live; `format.number/pct/money/date/delta/metric` |
| `js/shell.js` · `js/pulse.js` | Rail, top bar, mobile sheets; market-pulse strip |
| `js/commands.js` | Command-palette commands + global keyboard shortcuts (from settings) |
| `js/dom.js` · `js/fuzzy.js` | `h()` element helper, `icon()`, focus trap; fuzzy matching |
| `js/components/` | `series-picker`, `date-range` (+ `freqSelect`), `command-palette`, `toast`, `kpi-card`, `chart-card`, `feedback` (skeleton, empty/error state, status pill, `asyncView`) |
| `js/pages/` | One module per page: `export default { mount(el, ctx) -> cleanup? }` |
| `vendor/` · `fonts/` | Lightweight Charts, ECharts, Inter, JetBrains Mono — see `vendor/VERSIONS.md` |

## Conventions
- Styles use tokens only (`var(--…)`): no raw colours or pixel font sizes in component CSS.
- API percentages are decimals; format with `format.pct()` (never multiply by 100 by hand).
- Every async view uses `asyncView()` / `chartCard().loading|empty|error` — never a blank panel.
- Series colour = selection order (`seriesColour(ticker)`); 9+ are grey.
- Page modules clean up their store subscriptions in the function `mount` returns.
