# Building IndexVault with Claude Code — milestone prompts

## How to run a session
1. Open a terminal in the project folder and run `claude`.
2. For each milestone, switch to **plan mode** (press `Shift+Tab` until it says "plan mode"),
   then paste the prompt. Review Claude's plan, tweak it and approve it.
3. When it's done, check the result yourself (run the app and click around), then commit:
   `git add -A && git commit -m "M<n>: <title>"`.
4. Run `/clear` before starting the next milestone. `CLAUDE.md` and the docs carry the
   context forward, so you don't need the old chat.
5. If something looks off, say exactly what you see ("the KPI values overlap at 390px
   width") rather than "fix the UI".

Tip: keep one extra terminal running `uvicorn api.main:app --reload --port 8000`
from `backend/` so you can see changes live.

---

### M0 — Setup & read-in
```
Read CLAUDE.md, docs/SPEC.md, docs/DESIGN.md and all code in backend/indexvault and legacy/.
Then:
1. Initialise git with a sensible .gitignore (venv, __pycache__, data_cache, config/*.json, exports).
2. Create the venv, install backend/requirements.txt, run pytest and show me the result.
3. Give me a short summary of what the core library already does, anything in SPEC.md you
   think is unclear or risky, and your plan for Milestone 1.
Do not write feature code yet.
```

M1 is split into two sessions (agreed in M0). Commit after each.

### M1a — Settings service + core refactor
```
Build Milestone 1a from docs/SPEC.md (§2 refactors, §4 settings model). No API routes yet.
- api/settings.py: Pydantic Settings model exactly as in §4 with defaults, descriptions,
  validation, schema_version + migration, atomic load/save to config/settings.json, and a
  catalog service for config/catalog.json. Resolve relative paths (cache_dir) against the
  project root, not the working directory.
- Refactor backend/indexvault so every tunable is a parameter. Besides 252, 0.065 and SMA
  windows this includes: the 3h staleness check in get_data, trailing-return periods,
  the 10%/15% rolling-summary thresholds (use target_cagr), the 8% data_quality move
  threshold, and the beta / rolling-correlation frequency (map settings "W" -> "W-FRI").
  Add set_cache_root(), a register_source() registry (keep SOURCES working), the
  built-in + custom catalogue merge, and per-ticker locks around cache writes.
- New core functions: EMA, RSI, log returns, SIP lump-sum top-ups, SIP start-date
  sensitivity.
- Keep the existing tests passing and core free of web imports. Add tests for the
  settings model (defaults, validation, migration) and every new/changed core function.
```

### M1b — API
```
Build Milestone 1b from docs/SPEC.md §5 on top of M1a.
- api/main.py + routers for every endpoint in §5: consistent error envelope, a NaN-safe
  JSON serialiser (NaN -> null, numpy/date types), and in-process memoisation keyed on
  (ticker, range, params, cache mtime).
- Percent convention (CLAUDE.md rule 4): every percentage in a response is a decimal and
  no key contains "%". Convert from core's keys in the API layer.
- /load runs as a thread-pool job: GET /jobs/{id} for polling plus SSE at
  /jobs/{id}/stream (stdlib only, no new dependency).
- FastAPI serves frontend/ as static files at / (a placeholder index.html is fine for now).
- Tests: every route via TestClient using the demo source (never hit Yahoo in tests).
Finish by running pytest and listing each endpoint with a sample response shape.
```

### M2 — Design system & app shell
```
Build Milestone 2: the design system and the app shell, following docs/DESIGN.md exactly.
- Vendor TradingView Lightweight Charts and Apache ECharts (latest stable, minified) into
  frontend/vendor/, and Inter + JetBrains Mono (woff2) into frontend/fonts/. Note the
  versions in frontend/vendor/VERSIONS.md.
- css/tokens.css with all four themes (Midnight, Paper, Terminal, Saffron), density,
  radius and motion variants; base.css; components.css.
- index.html shell: collapsible rail with the SVG icon sprite, sticky top bar (series
  picker, date range, frequency, source badge, theme toggle), market-pulse strip,
  main view, command palette (Ctrl/⌘+K), toast region.
- js/: app.js, router.js (hash routes for all pages in SPEC §3, placeholder pages for now),
  store.js (selection synced to URL), api.js, settings.js (applies settings to <html>,
  exposes formatters incl. Indian lakh/crore), components: series-picker, date-range,
  command-palette, toast, skeleton, empty-state, status-pill, kpi-card, chart-card.
- Themes and density must switch live with no reload.
Verify by screenshotting the shell in all 4 themes at 1440px and 390px, then show me.
```

### M3 — Data Studio
```
Build the Data Studio page (SPEC §3.2).
- Virtual-scrolling data-table component (sortable, column menu: hide/reorder, sticky
  header, date search), used for OHLCV + derived columns at the chosen frequency.
- Column builder for derived columns (returns simple/log, SMA, EMA, rolling vol, RSI,
  drawdown, rebased) — computed in core, served via /series?columns=.
- Export panel: formats xlsx/csv/csv-zip/json, options from settings, save/load export
  presets, "Copy as Markdown table".
- Loading uses /load with live per-ticker progress toasts.
Test exports by opening each downloaded file programmatically. Screenshot light + dark.
```

### M4 — Analyse
```
Build the Analyse page (SPEC §3.3) using chart-card for every chart.
- KPI strip driven by settings.analytics.kpi_cards, trailing returns row.
- Price chart (line/candle/area, log, SMA/EMA overlays from settings, crosshair OHLC
  readout, big-move markers), underwater drawdown + worst-N table, monthly heatmap,
  calendar-year bars, histogram with normal overlay, rolling volatility.
- Crosshair sync across time-series charts on the page (DESIGN §5).
- Every chart: table view, PNG, CSV, fullscreen. Contextual insight line under drawdown.
Check against DESIGN §7 chart rules. Screenshot in Midnight and Paper.
```

### M5 — Compare & Rolling
```
Build Compare (SPEC §3.4) and Rolling returns (SPEC §3.5).
Include the risk/return scatter, relative-strength with SMA, rolling correlation,
configurable correlation frequency, rolling distribution (box plots), and the
plain-English insight sentence. Series colours must stay stable when series are added
or removed. Screenshot with 2, 5 and 9 series.
```

### M6 — SIP Lab, Seasonality, Data Health, Cache
```
Build SIP Lab (with scenario compare up to 4 and start-date sensitivity strip),
Seasonality, Data Health (status pills with icon + label) and Cache (per-row actions,
update all with progress, ticker health check) per SPEC §3.6–3.9.
Money always formatted with the user's number system (lakh/crore by default).
```

### M7 — Settings (customisation centre)
```
Build the Settings page (SPEC §3.10). Render forms from GET /settings/schema so every
setting is editable without hand-writing each field. Searchable sections, per-section
reset, live preview panel for Appearance, theme editor (edit tokens, save named theme,
import/export JSON, colour-blind palette check per DESIGN §7), catalogue & watchlist
manager, shortcut rebinding, and full backup/restore. All changes apply live.
Prove it: change 10 different settings and screenshot the effect of each.
```

### M8 — Dashboard
```
Build the Dashboard (SPEC §3.1): a 12-column widget grid with add/remove, drag to move,
resize handles, keyboard-accessible move/resize, layout persisted to settings, "Reset
layout". Implement all widget types listed. Ship a beautiful default layout.
Write the grid yourself — no new library.
```

### M9 — Polish & ship
```
Milestone 9 — polish for GitHub.
- Audit every page for loading/empty/error states, keyboard access, focus rings,
  reduced motion, 390px layout, console errors. Fix what you find.
- Performance: LTTB downsampling for long series, memoisation, lazy-load ECharts per page.
- README.md: hero screenshot, feature list, setup, CLI, "use as a library", data caveats,
  customisation guide, screenshots of all themes. Add LICENSE (MIT).
- Delete legacy/. Final pytest run. Give me a checklist of anything left unfinished.
```

---

## Handy follow-up prompts
- "Review the UI of <page> like a senior product designer. List the 10 weakest details, then fix them."
- "Add a new setting for <X>: schema, default, validation, UI, and use it in <page>."
- "Add a new index source that reads a CSV I drop into config/imports/."
- "Write tests for <function> including edge cases (empty data, one row, NaNs, holidays)."
