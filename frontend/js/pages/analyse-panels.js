// Analyse page panels (SPEC § 3.3). Each panel: card element + async load(),
// with loading / empty / error states, and table view / PNG / CSV via chartCard.
// env = {ticker, range, freq, settings, sync, track(disposer)}.

import { api, enc } from "../api.js";
import { columnLabel } from "../columns.js";
import { chartCard, staticTable } from "../components/chart-card.js";
import { openDrawer } from "../components/drawer.js";
import { emptyState, errorState, skeleton } from "../components/feedback.js";
import { kpiCard } from "../components/kpi-card.js";
import { seriesName } from "../components/series-picker.js";
import { barsOption, createEChart, heatmapOption, histogramOption } from "../charts/echarts.js";
import { chartTokens, resolveColour } from "../charts/theme.js";
import { createTimeChart } from "../charts/timeseries.js";
import { h } from "../dom.js";
import { format } from "../settings.js";
import { seriesColour } from "../store.js";

const pct = (v, decimals) => format.pct(v, decimals == null ? {} : { decimals });
const series = (s) => s.dates.map((time, i) => ({ time, value: s.values[i] }));
const share = (arr, pred) => (arr.length ? arr.filter(pred).length / arr.length : 0);

/** Run load() for a card: skeleton first, error state with retry on failure. */
async function guard(card, load) {
  card.loading();
  try {
    await load();
  } catch (e) {
    if (e.name !== "AbortError") card.error(e, () => guard(card, load));
  }
}

// --------------------------------------------------------------------------
// KPI strip + trailing returns (share the summary/trailing payloads)
// --------------------------------------------------------------------------
export function kpiPanel(env, summary, trailing) {
  const ids = env.settings.analytics.kpi_cards;
  const meta = Object.fromEntries(summary.metrics.map((m) => [m.id, m]));
  const m = summary.series[env.ticker].metrics;
  const firstPeriod = trailing.periods[0];
  const strip = h("div.kpi-strip", { role: "list", "aria-label": `Key figures for ${seriesName(env.ticker)}` });
  for (const id of ids) {
    const card = kpiCard({ label: meta[id]?.label || id, kind: meta[id]?.kind, deltaLabel: id === "end_level" ? firstPeriod : "" });
    card.el.setAttribute("role", "listitem");
    card.update({ value: m[id], ...(id === "end_level" ? { delta: trailing.series[env.ticker][firstPeriod] } : {}) });
    strip.append(card.el);
  }
  return strip;
}

export function trailingPanel(env, trailing) {
  const row = trailing.series[env.ticker];
  return h("section.card.trailing", { "aria-label": "Trailing returns" },
    h("h2.section-title", "Trailing returns", h("span.muted", ` · to ${format.date(trailing.end)} · CAGR for periods over a year`)),
    h("ul.trailing-list", trailing.periods.map((p) => {
      const d = format.delta(row[p]);
      return h("li.trailing-item", h("span.trailing-period", p),
        h("span.trailing-value.mono", { "data-tone": d.tone }, row[p] == null ? "—" : d.text));
    })));
}

export function openAllStats(env, summary) {
  const m = summary.series[env.ticker].metrics;
  return openDrawer({
    title: `All statistics · ${seriesName(env.ticker)}`,
    body: h("div.all-stats",
      h("p.field-hint", `Risk-free rate ${pct(summary.params.rf)} · ${summary.params.trading_days} trading days a year · ${format.date(summary.series[env.ticker].start)} → ${format.date(summary.series[env.ticker].end)}`),
      staticTable({ label: "All statistics", columns: ["Metric", "Value"],
        rows: summary.metrics.map((x) => [x.label, format.metric(m[x.id], x.kind)]) })),
  });
}

// --------------------------------------------------------------------------
// Price chart: line / candle / area, log scale, SMA/EMA overlays, big-move markers
// --------------------------------------------------------------------------
export function pricePanel(env, { state, onState }) {
  const a = env.settings.analytics;
  const overlays = [...a.sma_windows.map((w) => `sma_${w}`), ...a.ema_windows.map((w) => `ema_${w}`)];
  const cols = ["open", "high", "low", "close", ...overlays];
  const ovColour = (i) => `var(--series-${((i + 2) % 8) + 1})`;
  let rows = [], moves = [], tc = null;

  const card = chartCard({
    title: "Price", subtitle: `${env.freq} · drag to pan, scroll to zoom`, filename: `${env.ticker}-price`,
    data: () => ({ columns: ["Date", ...cols.map(columnLabel)], rows }),
    png: () => tc.png(),
  });
  card.el.classList.add("span-12", "price-card");

  const typeGroup = h("div.segmented", { role: "radiogroup", "aria-label": "Chart type" });
  const logBtn = h("button.btn.secondary.sm.toggle", { type: "button", "aria-pressed": "false" }, "Log");
  const ovGroup = h("div.overlay-toggles", { role: "group", "aria-label": "Overlays" });
  const readout = h("p.readout.mono");
  const plot = h("div.plot");

  function renderControls() {
    typeGroup.replaceChildren(...["line", "candle", "area"].map((tp) => h("button.seg", {
      type: "button", role: "radio", "aria-checked": String(state.type === tp),
      onclick: () => update({ type: tp }) }, tp[0].toUpperCase() + tp.slice(1))));
    logBtn.setAttribute("aria-pressed", String(state.log));
    ovGroup.replaceChildren(...overlays.map((id, i) => h("button.chip.chip-toggle", {
      type: "button", "aria-pressed": String(state.overlays.includes(id)),
      onclick: () => update({ overlays: state.overlays.includes(id) ? state.overlays.filter((x) => x !== id) : [...state.overlays, id] }),
    }, h("span.chip-dot", { style: { background: ovColour(i) }, "aria-hidden": "true" }), columnLabel(id))));
  }

  function update(patch) {
    Object.assign(state, patch);
    onState(state);
    renderControls();
    if (tc) draw();
  }
  logBtn.addEventListener("click", () => update({ log: !state.log }));

  function draw() {
    const idx = Object.fromEntries(["date", ...cols].map((c, i) => [c, i]));
    const main = state.type === "candle"
      ? { id: "main", type: "candle", data: rows.map((r) => ({ time: r[0], open: r[idx.open], high: r[idx.high], low: r[idx.low], close: r[idx.close] })) }
      : { id: "main", type: state.type, colour: seriesColour(env.ticker), data: rows.map((r) => ({ time: r[0], value: r[idx.close] })) };
    main.markers = moves;
    const lines = overlays.map((id, i) => state.overlays.includes(id) && {
      id, type: "line", colour: ovColour(i), width: 1.5, lastValue: false,
      data: rows.filter((r) => r[idx[id]] != null).map((r) => ({ time: r[0], value: r[idx[id]] })),
    }).filter(Boolean);
    tc.setSeries([main, ...lines]);
    tc.setLogScale(state.log);
    showReadout(null);
  }

  function showReadout(info) {
    const idx = Object.fromEntries(["date", ...cols].map((c, i) => [c, i]));
    const row = info ? rows.find((r) => r[0] === info.time) : rows.at(-1);
    if (!row) return;
    const ohlc = ["open", "high", "low", "close"].map((c) => h("span", h("span.muted", `${c[0].toUpperCase()} `), format.number(row[idx[c]])));
    const ov = overlays.filter((id) => state.overlays.includes(id) && row[idx[id]] != null)
      .map((id) => h("span", h("span.muted", `${columnLabel(id)} `), format.number(row[idx[id]])));
    readout.replaceChildren(h("span", format.date(row[0])), ...ohlc, ...ov);
  }

  card.content(h("div.price-wrap", h("div.chart-controls", typeGroup, logBtn, ovGroup), readout, plot));
  renderControls();

  return {
    el: card.el,
    load: () => guard(card, async () => {
      const [s, bm] = await Promise.all([
        api.get(`/series/${enc(env.ticker)}`, { ...env.range, freq: env.freq, columns: cols.join(",") }),
        api.get("/analytics/big-moves", { ticker: env.ticker, ...env.range }),
      ]);
      rows = s.rows;
      moves = bigMoveMarkers(bm.moves, rows.map((r) => r[0]));
      card.content(h("div.price-wrap", h("div.chart-controls", typeGroup, logBtn, ovGroup), readout, plot));
      tc = await createTimeChart(plot, { height: 380 });
      env.track(() => tc.destroy());
      tc.onCrosshair((info) => showReadout(info));
      env.sync.add(tc);
      draw();
      card.el.querySelector(".card-sub").textContent =
        `${env.freq} · ${moves.length} big move${moves.length === 1 ? "" : "s"} over ${pct(bm.threshold, 0)} marked · drag to pan, scroll to zoom`;
    }),
  };
}

/** Big daily moves -> markers on the bar that contains each move (any frequency). Largest 60 kept. */
function bigMoveMarkers(moves, barDates) {
  const pick = [...moves].sort((x, y) => Math.abs(y.move) - Math.abs(x.move)).slice(0, 60);
  const byBar = new Map();
  for (const m of pick) {
    const bar = barDates.find((d) => d >= m.date);
    if (!bar) continue;
    const prev = byBar.get(bar);
    if (!prev || Math.abs(m.move) > Math.abs(prev.move)) byBar.set(bar, m);
  }
  return [...byBar.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([time, m]) => ({
    time, position: m.move > 0 ? "belowBar" : "aboveBar", shape: m.move > 0 ? "arrowUp" : "arrowDown",
    colour: m.move > 0 ? "var(--gain)" : "var(--loss)",
  }));
}

// --------------------------------------------------------------------------
// Drawdowns: underwater chart + insight, worst-N table
// --------------------------------------------------------------------------
export function drawdownPanels(env) {
  let payload = null, tc = null;
  const insight = h("p.insight");
  const card = chartCard({
    title: "Drawdown", subtitle: "Percent below the running peak", filename: `${env.ticker}-drawdown`,
    data: () => ({ columns: ["Date", "Drawdown"], rows: payload.underwater.dates.map((d, i) => [d, payload.underwater.values[i]]), format: { Drawdown: pct } }),
    png: () => tc.png(),
  });
  card.el.classList.add("span-7");
  const tableBody = h("div.card-pad");
  const tableCard = h("section.card.span-5.dd-table-card",
    h("header.card-head", h("div.card-titles", h("h3.card-title", `Worst ${env.settings.analytics.drawdown_table_size} drawdowns`),
      h("p.card-sub", "Peak to recovery"))), tableBody);
  tableBody.append(skeleton({ lines: 5 }));

  return {
    els: [card.el, tableCard],
    load: () => guard(card, async () => {
      try {
        payload = await api.get("/analytics/drawdowns", { ticker: env.ticker, ...env.range });
      } catch (e) {
        tableBody.replaceChildren(errorState(e));
        throw e;
      }
      const plot = h("div.plot");
      card.content(h("div", plot, insight));
      tc = await createTimeChart(plot, { height: 240, valueFormat: (v) => pct(v, 1) });
      env.track(() => tc.destroy());
      tc.setSeries([{ id: "dd", type: "underwater", data: series(payload.underwater) }]);
      env.sync.add(tc);
      insight.textContent = drawdownInsight(payload);
      tableBody.replaceChildren(payload.episodes.length
        ? staticTable({ label: "Worst drawdowns", columns: ["Depth", "Peak", "Trough", "Recovered", "Days"],
          rows: payload.episodes.map((e) => [e.depth, format.date(e.peak), format.date(e.trough), e.ongoing ? "Not yet" : format.date(e.recovered), e.total_days]),
          format: { Depth: (v) => pct(v, 1), Days: (v) => format.number(v, { decimals: 0 }) } })
        : emptyState({ icon: "chart", title: "No drawdowns", message: "This series never fell below a previous peak in the range." }));
    }),
  };
}

function drawdownInsight({ underwater, current }) {
  if (current > -0.0005) return `At a new high: no drawdown on ${format.date(underwater.dates.at(-1))}.`;
  const deeper = share(underwater.values, (v) => v > current);
  return `Current drawdown (${pct(current, 1)}) is deeper than ${format.number(deeper * 100, { decimals: 0 })}% of days since ${format.date(underwater.dates[0])}.`;
}

// --------------------------------------------------------------------------
// Calendar views: monthly heatmap, calendar-year bars
// --------------------------------------------------------------------------
export function heatmapPanel(env) {
  let g = null, chart = null;
  const card = chartCard({
    title: "Monthly returns", subtitle: "Diverging colour centred at 0 · the Year column has its own scale",
    filename: `${env.ticker}-monthly`,
    data: () => ({ columns: ["Year", ...g.months, "Year total"], rows: g.years.map((y, i) => [String(y), ...g.values[i], g.year_total[i]]),
      format: Object.fromEntries([...g.months, "Year total"].map((m) => [m, (v) => pct(v, 1)])) }),
    png: () => chart.png(),
  });
  card.el.classList.add("span-12");
  return {
    el: card.el,
    load: () => guard(card, async () => {
      g = await api.get("/analytics/monthly-grid", { ticker: env.ticker, ...env.range });
      const plot = h("div.plot");
      // 13 labelled columns need ~56px each: scroll sideways on narrow screens.
      card.content(h("div.plot-scroll", { tabindex: "0", role: "region", "aria-label": "Monthly returns heatmap (scrolls sideways)" }, plot));
      chart = await createEChart(plot, (t) => heatmapOption(t, { years: g.years, months: g.months, values: g.values,
        yearTotals: g.year_total, fmt: (v) => pct(v, 1) }), { height: Math.max(200, g.years.length * 30 + 48) });
      env.track(() => chart.destroy());
    }),
  };
}

export function yearlyPanel(env) {
  let y = null, chart = null;
  const card = chartCard({
    title: "Calendar-year returns", subtitle: "First and last years may be partial (see tooltip)", filename: `${env.ticker}-yearly`,
    data: () => ({ columns: ["Year", "Return", "From", "To"], rows: y.years.map((r) => [String(r.year), r.return, format.date(r.start), format.date(r.end)]), format: { Return: (v) => pct(v, 1) } }),
    png: () => chart.png(),
  });
  card.el.classList.add("span-6");
  return {
    el: card.el,
    load: () => guard(card, async () => {
      y = await api.get("/analytics/yearly", { ticker: env.ticker, ...env.range });
      const plot = h("div.plot");
      card.content(plot);
      const labels = y.years.map((r) => String(r.year));
      const spans = Object.fromEntries(y.years.map((r) => [String(r.year), `${format.date(r.start)} → ${format.date(r.end)}`]));
      chart = await createEChart(plot, (t) => barsOption(t, { labels, values: y.years.map((r) => r.return),
        fmt: (v, d) => pct(v, d ?? 1), tooltipLabel: (l) => `${l} <span style="opacity:.7">(${spans[l]})</span>` }), { height: 280 });
      env.track(() => chart.destroy());
    }),
  };
}

// --------------------------------------------------------------------------
// Distribution + rolling volatility
// --------------------------------------------------------------------------
export function histogramPanel(env) {
  let d = null, chart = null;
  const card = chartCard({
    title: "Daily returns", subtitle: "Histogram with the matching normal curve", filename: `${env.ticker}-distribution`,
    data: () => ({ columns: ["From", "To", "Days", "Normal"], rows: d.counts.map((c, i) => [d.edges[i], d.edges[i + 1], c, d.normal[i]]),
      format: { From: (v) => pct(v), To: (v) => pct(v), Normal: (v) => format.number(v, { decimals: 1 }) } }),
    png: () => chart.png(),
  });
  card.el.classList.add("span-6");
  const stats = h("p.insight");
  return {
    el: card.el,
    load: () => guard(card, async () => {
      d = await api.get("/analytics/distribution", { ticker: env.ticker, ...env.range });
      const plot = h("div.plot");
      card.content(h("div", plot, stats));
      chart = await createEChart(plot, (t) => histogramOption(t, { ...d, fmt: (v, dec) => pct(v, dec ?? 1),
        colour: resolveColour(seriesColour(env.ticker)) || chartTokens().series[0] }), { height: 280 });
      env.track(() => chart.destroy());
      const tail = d.excess_kurtosis > 1 ? " Fat tails: big days happen more often than a normal curve predicts." : "";
      stats.textContent = `${format.number(d.n, { decimals: 0 })} days · mean ${pct(d.mean, 3)} · daily σ ${pct(d.std)} · skew ${format.number(d.skew)} · excess kurtosis ${format.number(d.excess_kurtosis)}.${tail}`;
    }),
  };
}

export function volPanel(env) {
  let v = null, tc = null;
  const insight = h("p.insight");
  const card = chartCard({
    title: "Rolling volatility", subtitle: `Annualised, ${env.settings.analytics.rolling_vol_window}-day window`, filename: `${env.ticker}-rolling-vol`,
    data: () => ({ columns: ["Date", "Volatility"], rows: v.series.dates.map((d, i) => [d, v.series.values[i]]), format: { Volatility: pct } }),
    png: () => tc.png(),
  });
  card.el.classList.add("span-12");
  return {
    el: card.el,
    load: () => guard(card, async () => {
      v = await api.get("/analytics/rolling-vol", { ticker: env.ticker, ...env.range });
      if (!v.series.values.length) return card.empty({ icon: "chart", title: "Not enough data", message: "The range is shorter than the volatility window." });
      const plot = h("div.plot");
      card.content(h("div", plot, insight));
      tc = await createTimeChart(plot, { height: 220, valueFormat: (x) => pct(x, 0) });
      env.track(() => tc.destroy());
      tc.setSeries([{ id: "vol", type: "line", colour: seriesColour(env.ticker), data: series(v.series) }]);
      env.sync.add(tc);
      const cur = v.series.values.at(-1);
      const lower = share(v.series.values, (x) => x < cur);
      insight.textContent = `Volatility today (${pct(cur, 1)}) is higher than on ${format.number(lower * 100, { decimals: 0 })}% of days in this range.`;
    }),
  };
}
