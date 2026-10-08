# IndexVault API — response shapes

Base path `/api`. Interactive docs at `/api/docs` when the server runs.

**Conventions**
- Dates are `"YYYY-MM-DD"`. `NaN`/missing values are `null`.
- **Percentages are decimals** (`0.1234` = 12.34%) and **no key contains `%`**.
  Exceptions that are *not* percentages: `rsi_*` (0–100) and `rebased` (starts at 100).
- Range parameters on every data/analytics route: `start`, `end` (dates), or
  `period` (`1M`…`20Y`, `YTD`, `Max`). Explicit `start` beats `period`; with neither,
  `data.default_period` from settings applies. `source` defaults to `data.source`.
- `tickers` is a comma list (max 20). `^` may be sent raw in query strings; in **paths**
  encode it as `%5E` (`/api/series/%5ENSEI`).
- Defaults for windows, thresholds, rf, etc. come from settings; query params override.
- Errors, always:
  `{"error": {"code": "bad_request|not_found|conflict|validation_error|source_error|internal_error", "message": "…", "detail": {…}|[…]|null}}`
  with status 400 / 404 / 409 / 422 / 502 / 500.

Shapes below use `…` for repeated items.

---

## Health, settings, catalogue

| Route | Response |
|---|---|
| `GET /health[?check=true]` | `{status:"ok", version, source, sources:[{name,label,offline}], cache_dir, jobs_running, warnings:[str], source_check?:{ok,message}}` |
| `GET /settings` | the full settings object (see SPEC § 4) |
| `PUT /settings` | body: full settings → saved settings |
| `PATCH /settings/{section}` | body: fields to change → saved settings. `dashboard.layout` widgets must fit 12 columns (`x + w ≤ 12`), have unique ids and ≤ 20 000 characters of config. Dict sections (`custom_themes`, `custom_palettes`, `shortcuts`) are replaced whole. 409 if `data.cache_dir` changes while a job runs |
| `POST /settings/reset[?section=]` | → saved settings |
| `GET /settings/schema` | JSON Schema (`$defs.<Section>.properties.<field>.description/default/minimum/…`) — the Settings UI renders forms from it. UI hints: `x-unit:"pct"` (decimal shown as %), `x-options:[{value,label}]`, `x-ordered:true`, `format:"color"` |
| `GET /settings/backup` | download: `{kind:"indexvault-backup", version:1, created, settings, catalog:{schema_version, custom_indices, watchlists}}` |
| `POST /settings/restore` | body: a backup (older settings schemas are migrated) → `{settings, catalog}` (catalog as in `GET /catalog`) |
| `GET /catalog` | `{categories:[{name, items:[{name, ticker, source, custom, id}]}], watchlists:[{id, name, tickers}]}` |
| `POST\|PUT\|DELETE /catalog/indices/{id}` | body `{name, ticker, category?, source?}` → `{id, name, ticker, category, source}`; DELETE → 204 |
| `POST\|PUT\|DELETE /catalog/watchlists/{id}` | body `{name, tickers}` → `{id, name, tickers}`; DELETE → 204 |
| `PUT /catalog/watchlists/order` | body `{ids:[…]}` → `[watchlist, …]` |

## Data

**`GET /series/{ticker}?freq&columns&…`** — `columns` (comma list, default
`open,high,low,close,adj_close,volume,return`): any of `open high low close adj_close volume
return log_return drawdown rebased sma_<n> ema_<n> rsi_<n> vol_<n>` (n = 2…1000 bars of
`freq`). Windowed columns are warmed up with earlier history, so the first row is filled.
```json
{"ticker":"^NSEI","name":"NIFTY 50","source":"yahoo","freq":"Daily",
 "columns":["date","close","return","rsi_14"],
 "rows":[["2025-10-09",24758.05,0.0017,80.07], …],
 "meta":{"rows":262,"first":"2025-10-09","last":"2026-10-08","has_volume":false,
         "caveats":["Price index: excludes dividends (TRI is ~1–1.5% p.a. higher).", …]}}
```

**`POST /load`** — body `{tickers, start?, end?, period?, refresh?, source?}` → 202 + job.
**`POST /cache/update`** — body `{source?, tickers?}` (default: everything cached) → 202 + job.
**`GET /jobs/{id}`** — job:
```json
{"id":"3f2a…","kind":"load","status":"queued|running|done|failed","created":"2026-10-08T14:02:11",
 "started":"…","finished":"…|null","total":2,"completed":1,"errors":0,"progress":0.5,
 "items":[{"ticker":"^NSEI","status":"done","rows":6512,"first":"2000-01-03","last":"2026-10-08"},
          {"ticker":"^CNXIT","status":"error","message":"…"}]}
```
**`GET /jobs/{id}/stream`** — `text/event-stream`: `event: progress` + job JSON on each
change, then one `event: done` + final job JSON. Works with `EventSource`.

**`POST /import/csv?ticker=MINE&dayfirst=false`** — raw CSV body (Date + Close/Price
required; Open/High/Low/Adj Close/Volume optional; commas in numbers OK) → 201
`{ticker, source:"csv", rows, first, last}`. Then use `source=csv`.

## Cache

| Route | Response |
|---|---|
| `GET /cache` | `{cache_dir, total_rows, total_size_kb, entries:[{source, ticker, rows, first_date, last_date, last_updated, size_kb}]}` |
| `DELETE /cache/{source}/{ticker}` | `{deleted_files}` (404 if not cached) |
| `DELETE /cache?confirm=true[&source=]` | `{deleted_files}` (400 without `confirm=true`) |
| `GET /tickers/check?source` | `{source, checked, ok, results:[{ticker, name, ok, message}]}` |

## Analytics (Analyse page)

| Route | Response |
|---|---|
| `GET /analytics/summary?tickers&rf` | `{params:{rf, trading_days}, metrics:[{id, label, kind:"pct\|ratio\|level\|date\|years"}], kpi_cards:[id], series:{<t>:{name, start, end, metrics:{cagr, ann_vol, sharpe, …}}}}` — metric ids in `api/metrics.py` |
| `GET /analytics/trailing?tickers&end&periods` | `{periods:["1M",…], end, series:{<t>:{"1M":0.012, "3Y":0.114 (CAGR), …}}}` |
| `GET /analytics/drawdowns?ticker&top` | `{ticker, start, end, current, underwater:{dates, values}, episodes:[{peak, trough, recovered\|null, ongoing, depth, peak_to_trough_days, trough_to_recovery_days, total_days}]}` |
| `GET /analytics/monthly-grid?ticker` | `{ticker, start, end, months:["Jan",…], years:[2016,…], values:[[12 × return\|null], …], year_total:[…]}` |
| `GET /analytics/yearly?ticker` | `{ticker, years:[{year, return, start, end}]}` — `start`/`end` reveal partial years |
| `GET /analytics/distribution?ticker&bins` | `{ticker, start, end, edges:[bins+1], counts:[bins], normal:[bins] (expected counts), n, mean, std, skew, excess_kurtosis}` |
| `GET /analytics/rolling-vol?ticker&window` | `{ticker, window, series:{dates, values}}` (annualised) |

## Analytics (Compare, Rolling, Seasonality, Data Health)

| Route | Response |
|---|---|
| `GET /analytics/compare?tickers&benchmark&freq` | `{tickers, names:{<t>:name}, benchmark, frequency, rebased:{start, note, dates, series:{<t>:[…]}}, metric_ids:[…], metrics:{<t>:{<id>:v}}, beta:{<t>:v}, correlation:{tickers, matrix}, scatter:[{ticker, cagr, ann_vol}]}` |
| `GET /analytics/relative-strength?a&b&sma` | `{a, b, ratio:{dates, values}, sma_window, sma:{dates, values}\|null}` |
| `GET /analytics/rolling-correlation?a&b&window&freq` | `{a, b, window, frequency, series:{dates, values}}` |
| `GET /analytics/rolling?tickers&years&target` | `{years:[…], target, series:{<t>:{name, windows:{"5":{observations, min, q1, median, mean, q3, max, latest, pct_negative, pct_above_target, insight, series:{dates, values}}\|null}}}}` — `period` defaults to `Max` |
| `GET /analytics/seasonality?ticker&min_years` | `{ticker, start, end, caution, months:[{month, avg, median, positive, best, worst, years, enough_data}]}` |
| `GET /analytics/weekday?ticker` | `{ticker, start, end, days:[{day, avg, positive, volatility, days}]}` |
| `GET /analytics/quality?tickers` | `{thresholds:{big_move, gap_days}, series:{<t>:{rows, first_date, last_date, coverage, gaps, largest_gap_days, largest_gap_ends, missing_values, duplicate_dates, longest_unchanged_close_run, big_moves, ohlc_inconsistencies, zero_volume_days\|null, status:"good\|warning\|critical", issues:[str]}}}` |
| `GET /analytics/big-moves?ticker&threshold` | `{ticker, threshold, moves:[{date, close, move}]}` (date order) |

## SIP Lab

**`POST /analytics/sip[?sensitivity=true]`** — body
`{ticker, amount?, day?, step_up? (decimal), start?, end?, period?, source?, top_ups?:[{date, amount}]}`:
```json
{"ticker":"^NSEI",
 "params":{"amount":10000,"day":5,"step_up":0.1,"start":"2016-10-10","end":"2026-10-08","top_ups":[]},
 "stats":{"instalments":121,"top_ups":0,"total_invested":1210000,"final_value":1873412.5,
          "absolute_gain":663412.5,"absolute_return":0.548,"xirr":0.0812,"lump_sum_final_value":…,
          "lump_sum_cagr":…,"worst_drawdown":-0.21,"avg_buy_price":…,"last_price":…},
 "ledger":{"columns":["date","price","invested","units","value","gain","lump_sum_value"],"rows":[…monthly…]},
 "sensitivity":[{"start":"2016-11-07","months":120,"invested":…,"final_value":…,"xirr":0.079}, …]}
```

**`POST /analytics/sip/export?format=xlsx|csv`** — same body as `/analytics/sip`; returns the
monthly ledger as a file. Excel: `Summary` (one row, % columns as real % cells) + `Ledger`
sheets, styled per settings. CSV: the ledger only (UTF-8 with BOM).

## Export

**`POST /export`** — body
`{preset?, tickers?, start?, end?, period?, freq?, columns?, format?: "xlsx|csv|zip|json", options?:{date_format?, decimals?, indian_number_format?, metadata_sheet?}, source?}`.
Request fields override the named preset, which overrides settings. Returns a file
(`Content-Disposition: attachment; filename="indexvault_NSEI+1_monthly_20261008.xlsx"`):
- **xlsx** — sheets `Summary` (compare metrics per series), `Closes` (if several series and
  `close` chosen), one sheet per series, `About` (source, range, cache times, caveats; per
  `export.metadata_sheet`). Percent columns are decimals formatted as `0.00%`; header
  colour, freeze panes, Indian grouping and date format follow settings/options.
- **csv** — one series: its table; several: long format with a `Ticker` column. UTF-8 with
  BOM so Excel shows ₹ correctly. Percent columns keep `decimals + 2` places.
- **zip** — one CSV per series. **json** — `{source, freq, series:{<t>:{name, columns, rows, caveats}}}`.
