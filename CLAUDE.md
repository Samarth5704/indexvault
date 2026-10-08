# IndexVault — instructions for Claude Code

IndexVault is a local web app for downloading, caching and analysing Indian
stock-market index data (NIFTY, SENSEX, sectoral indices, India VIX, …).
Owner: Sam. Built for market research and as the data layer for a separate
backtesting engine.

Read these before any non-trivial change:
- `docs/SPEC.md`   — what to build: features, customisation system, API contract, milestones
- `docs/DESIGN.md` — how it looks: tokens, themes, components, motion, chart rules
- `docs/PROMPTS.md` — the milestone plan (Sam pastes one prompt per session)

## Stack (approved — do not change without asking)
- **Backend:** Python 3.11+, FastAPI, Pydantic v2, pandas, numpy, scipy, yfinance, openpyxl
- **Frontend:** plain HTML + CSS + JavaScript (native ES modules). **No framework, no build
  step, no npm.** FastAPI serves `frontend/` as static files.
- **Charts:** TradingView Lightweight Charts (price/time-series) + Apache ECharts
  (heatmaps, bars, histograms, correlation). Vendored as local files in
  `frontend/vendor/` — never loaded from a CDN at runtime.
- **Fonts:** Inter (UI) and JetBrains Mono (numbers), self-hosted in `frontend/fonts/`.

**Adding any other library, framework, tool or service requires Sam's approval first.**
Propose it, explain why, and wait.

## Layout
```
backend/
  indexvault/      core library — pure Python, NO web code
                   (data, sources, analytics, indicators, sip, indices, cli)
  api/             FastAPI app: routers, schemas, settings service
  tests/           pytest — core + API tests
frontend/
  index.html       single-page shell
  css/             tokens.css, base.css, shell.css, components.css, pages/*.css
  js/              app.js, router.js, routes.js, api.js, store.js, settings.js, shell.js,
                   commands.js, pulse.js, dom.js, fuzzy.js, components/, pages/, charts/
                   (frontend/README.md maps every file)
  vendor/ fonts/
config/
  settings.json    user settings (created on first run from defaults; git-ignored)
  catalog.json     user's custom indices & watchlists (git-ignored)
docs/
```

## Rules
1. **Core stays pure.** `backend/indexvault/` never imports FastAPI or anything web. The
   backtester imports it directly. API code calls core; core never calls API.
2. **Everything configurable lives in settings.** No magic numbers in pages: risk-free
   rate, trading days, SMA windows, rolling windows, thresholds, colours, formats, defaults
   all come from the settings model (`SPEC.md` § 4). If you add a tunable, add it to the
   settings schema with a default, a description and validation.
3. **Tokens, not hex.** Frontend styles use CSS custom properties from `tokens.css` only.
   No raw colours or pixel font sizes in component CSS.
4. **Numbers:** display with the user's number format (Indian lakh/crore or international),
   tabular figures for tables/axes. **API responses carry every percentage as a decimal
   (0.12 = 12%) and keys never contain `%`** (e.g. `cagr`, not `CAGR %`). Core keeps its
   existing keys and units (some ×100 with `%` keys) so the backtester doesn't break; the
   API layer converts. The frontend multiplies by 100 only when formatting.
5. **Every async view has loading, empty and error states.** Never a blank panel.
6. **Accessibility:** keyboard reachable, visible focus ring, `prefers-reduced-motion`
   respected, charts have a "view as table" toggle, colour never the only signal.
7. **Tests:** add/extend pytest for every new core function and API route. Run
   `python -m pytest -q` from `backend/` before saying a milestone is done.
8. **Verify the UI by looking at it.** After UI work, run the app and check the page in a
   browser (Playwright screenshot if no browser) in both light and dark themes at 1440px
   and 390px widths.
9. Keep functions small and files under ~400 lines; split pages into components.
10. Don't delete user data in `config/` or `backend/data_cache/` without asking.

## Commands
Sam is on **Windows 11 with PowerShell and Python 3.14**. Use Windows paths and commands.
Call the venv's Python directly (`.venv\Scripts\python`) instead of activating it —
PowerShell activation is often blocked by the script execution policy. Quote tickers
containing `^` (e.g. `"^NSEI"`).
```powershell
cd backend
py -m venv .venv                                              # once
.venv\Scripts\python -m pip install -r requirements.lock       # once / after changes (exact pins)
.venv\Scripts\python -m uvicorn api.main:app --reload --port 8000   # app at http://localhost:8000
.venv\Scripts\python -m pytest -q                             # tests
.venv\Scripts\python -m indexvault.cli list                   # CLI
```

Dependencies: `requirements.txt` holds the loose ranges; `requirements.lock` the exact
versions verified on Sam's machine. After changing requirements.txt, install it, run the
tests, then regenerate the lock (see the header of requirements.lock).

## Data caveats (surface these in the UI where relevant)
- Yahoo index levels are price indices (no dividends); TRI is ~1–1.5% p.a. higher.
- Yahoo is unofficial; tickers can change — the Cache page has a ticker health check.
- Index volume used to be zero on Yahoo; some indices (e.g. ^NSEI) now carry it. The API
  decides per series from the data (`volume_available` in `api/routers/series.py`).
- Yahoo serves only the latest day for some NSE sectoral tickers; widgets name them and
  the cache retries a backfill at most once a day.
