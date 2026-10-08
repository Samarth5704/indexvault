// Market widgets: snapshot card, mini chart, returns heatmap (SPEC § 3.1).

import { api, enc } from "../../api.js";
import { createTimeChart } from "../../charts/timeseries.js";
import { sparkline } from "../../components/kpi-card.js";
import { seriesName } from "../../components/series-picker.js";
import { h } from "../../dom.js";
import { format } from "../../settings.js";
import { groupLabel, groupTickers, loadInto, points } from "./common.js";

const deltaPill = (v) => {
  const d = format.delta(v);
  return h("span.delta-pill", { "data-tone": d.tone }, h("span", { "aria-hidden": "true" }, d.arrow), ` ${d.text}`);
};
const signedPct = (v) => {
  const d = format.delta(v);
  return h("span.mono", { "data-tone": d.tone, class: "signed" }, h("span", { "aria-hidden": "true" }, d.arrow), ` ${d.text}`);
};

// ------------------------------------------------------------------ snapshot
export const snapshot = {
  label: "Market snapshot", icon: "chart", blurb: "Last close, 1D / 1M / YTD change, sparkline and distance from the 52-week high.",
  size: { w: 3, h: 2 }, min: { minW: 2, minH: 2, maxH: 4 },
  fields: [{ key: "ticker", label: "Series", kind: "ticker" }],
  defaults: () => ({ ticker: "^NSEI" }),
  title: (c) => seriesName(c.ticker),
  sub: () => "Snapshot",
  mount(body, cfg, env) {
    loadInto(body, {
      alive: env.alive, sk: { variant: "kpi" },
      load: () => Promise.all([
        api.get("/analytics/trailing", { tickers: cfg.ticker, periods: "1D,1M,YTD" }),
        api.get("/analytics/summary", { tickers: cfg.ticker, period: "1Y" }),
        api.get(`/series/${enc(cfg.ticker)}`, { period: "3M", columns: "close", freq: "Daily" }),
      ]),
      render: ([tr, sum, spark]) => {
        const t = tr.series[cfg.ticker] || {};
        const m = sum.series[cfg.ticker]?.metrics || {};
        env.setSub(`Close ${format.date(sum.series[cfg.ticker]?.end)}`);
        return h("div.snap",
          h("div.snap-main",
            h("p.snap-value.mono", format.number(m.end_level)),
            h("div.snap-day", deltaPill(t["1D"]), h("span.muted", " 1D"))),
          h("div.snap-spark", sparkline(spark.rows.map((r) => r[1])) || ""),
          h("dl.snap-stats",
            stat("1M", signedPct(t["1M"])), stat("YTD", signedPct(t.YTD)),
            stat("From 52w high", signedPct(m.pct_from_52w_high))));
      },
    });
  },
};

const stat = (label, value) => h("div", h("dt", label), h("dd", value));

// ------------------------------------------------------------------ mini chart
const CHART_PERIODS = ["1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "10Y", "Max"];
export const mini_chart = {
  label: "Mini chart", icon: "rolling", blurb: "Any series over any range, as a line or area chart.",
  size: { w: 6, h: 4 }, min: { minW: 3, minH: 3 },
  fields: [
    { key: "ticker", label: "Series", kind: "ticker" },
    { key: "period", label: "Range", kind: "select", options: CHART_PERIODS.map((p) => ({ value: p, label: p })) },
    { key: "style", label: "Style", kind: "select", options: [{ value: "area", label: "Area" }, { value: "line", label: "Line" }] },
  ],
  defaults: () => ({ ticker: "^NSEI", period: "1Y", style: "area" }),
  title: (c) => seriesName(c.ticker),
  sub: (c) => `${c.period} · price`,
  mount(body, cfg, env) {
    let chart = null;
    const long = ["5Y", "10Y", "Max"].includes(cfg.period);
    loadInto(body, {
      alive: env.alive, sk: { variant: "chart" },
      load: () => api.get(`/series/${enc(cfg.ticker)}`, { period: cfg.period, columns: "close", freq: long ? "Weekly" : "Daily" }),
      isEmpty: (s) => !s.rows.length,
      empty: { icon: "chart", title: "No data in this range", message: "Pick a longer range or another series." },
      render: (s) => {
        const plot = h("div.mini-plot");
        const first = s.rows.find((r) => r[1] != null)?.[1];
        const last = s.rows.findLast((r) => r[1] != null)?.[1];
        const change = first ? last / first - 1 : null;
        const wrap = h("div.mini-chart", h("div.mini-head", h("span.mono.mini-last", format.number(last)), deltaPill(change), h("span.muted", ` over ${cfg.period}`)), plot);
        requestAnimationFrame(async () => {
          if (!env.alive()) return;
          chart = await createTimeChart(plot, { height: Math.max(120, plot.clientHeight) });
          if (!env.alive()) { chart.destroy(); return; }
          plot.style.height = "100%"; // follow the widget as it is resized
          const colour = "var(--series-1)";
          chart.setSeries([{ id: "c", type: cfg.style === "line" ? "line" : "area", colour, title: "", data: points(s.rows.map((r) => r[0]), s.rows.map((r) => r[1])) }]);
        });
        return wrap;
      },
    });
    return () => chart?.destroy();
  },
};

// ------------------------------------------------------------------ heatmap
const HEAT_PERIODS = [["1D", "Today"], ["1W", "1W"], ["1M", "1M"]];
export const heatmap = {
  label: "Returns heatmap", icon: "table", blurb: "Today, 1-week and 1-month returns across a group, e.g. the sectoral indices.",
  size: { w: 4, h: 5 }, min: { minW: 3, minH: 3 },
  fields: [{ key: "group", label: "Group", kind: "group" }],
  defaults: () => ({ group: "cat:Sectoral" }),
  title: (c) => groupLabel(c.group),
  sub: () => "Returns heatmap",
  mount(body, cfg, env) {
    const tickers = groupTickers(cfg.group);
    loadInto(body, {
      alive: env.alive, sk: { lines: 8 },
      load: async () => (tickers.length ? api.get("/analytics/trailing", { tickers, periods: HEAT_PERIODS.map((p) => p[0]).join(",") }) : null),
      isEmpty: (d) => !d,
      empty: { icon: "table", title: "Nothing in this group", message: "Choose another group or add tickers to the watchlist." },
      render: (d) => {
        env.setSub(`Returns to ${format.date(d.end)}`);
        const scale = Object.fromEntries(HEAT_PERIODS.map(([p]) => [p, Math.max(1e-9, ...tickers.map((t) => Math.abs(d.series[t]?.[p] ?? 0)))]));
        const hasData = (t) => HEAT_PERIODS.some(([p]) => d.series[t]?.[p] != null);
        const rows = tickers.filter(hasData).sort((a, b) => (d.series[b]?.["1D"] ?? -1) - (d.series[a]?.["1D"] ?? -1));
        return h("div.heat-wrap", h("table.heat", { "aria-label": `${groupLabel(cfg.group)} returns` },
          h("thead", h("tr", h("th", { scope: "col" }, "Index"), HEAT_PERIODS.map(([, l]) => h("th", { scope: "col" }, l)))),
          h("tbody", rows.map((t) => h("tr",
            h("th.truncate", { scope: "row", title: seriesName(t) }, seriesName(t)),
            HEAT_PERIODS.map(([p]) => heatCell(d.series[t]?.[p], scale[p])))))),
        missingNote(tickers.filter((t) => !hasData(t))));
      },
    });
  },
};

/** "3 without recent data: …" — Yahoo sometimes stops serving an index's history. */
export function missingNote(tickers) {
  if (!tickers.length) return null;
  return h("p.widget-note.muted", { title: tickers.map(seriesName).join(", ") },
    `${tickers.length} without recent data from the source (${tickers.map(seriesName).join(", ")}). `,
    h("a", { href: "#/cache" }, "Check tickers"));
}

function heatCell(v, scale) {
  if (v == null) return h("td.heat-cell.muted", "—");
  const strength = Math.round(Math.min(1, Math.abs(v) / scale) * 55); // capped so cell text stays readable
  const pole = v >= 0 ? "var(--div-pos)" : "var(--div-neg)";
  const cell = h("td.heat-cell.mono", format.pct(v, { sign: true }));
  cell.style.background = `color-mix(in oklab, ${pole} ${strength}%, var(--div-mid))`;
  return cell;
}
