// Compare (SPEC § 3.4): growth of 100, metrics + beta, correlation matrix,
// risk/return scatter, relative strength with SMA, rolling correlation.
// Page params: bench, cf (D|W|M), a, b (relative-strength pair), rw (rolling window).

import { api } from "../api.js";
import { corrMatrixOption, createEChart, scatterOption } from "../charts/echarts.js";
import { createSyncGroup } from "../charts/sync.js";
import { resolveColour } from "../charts/theme.js";
import { createTimeChart } from "../charts/timeseries.js";
import { chartCard, staticTable } from "../components/chart-card.js";
import { emptyState, errorState, guard, skeleton } from "../components/feedback.js";
import { mixedKindNote, shortHistoryNote } from "../components/history-tag.js";
import { seriesLegend, tooManySeriesNote } from "../components/legend.js";
import { seriesName } from "../components/series-picker.js";
import { h, icon } from "../dom.js";
import { setPageParams } from "../router.js";
import { format, settings } from "../settings.js";
import { rangeParams, selection, seriesColour, store } from "../store.js";

const FREQ_LABEL = { D: "Daily", W: "Weekly", M: "Monthly" };
const pct = (v, d) => format.pct(v, d == null ? {} : { decimals: d });

function select(label, options, value, onChange) {
  return h("label.field.inline-field", h("span.field-label", label),
    h("select.select", { onchange: (e) => onChange(e.target.value) },
      options.map(([v, text]) => h("option", { value: v, selected: v === value }, text))));
}


export default {
  mount(el, ctx) {
    const controls = h("div.compare-controls.card");
    const body = h("div.page-body");
    el.append(h("header.page-head", h("div", h("h1", "Compare"),
      h("p.page-sub", "Growth, risk and co-movement of the selected series over the same period."))), controls, body);

    let token = 0, disposers = [], sync = null;
    const dispose = () => { sync?.clear(); disposers.forEach((d) => d()); disposers = []; };
    const params = () => store.get().route.params;

    function state() {
      const { series } = selection();
      const p = params();
      const a = settings().analytics;
      const pick = (v, fallback) => (series.includes(v) ? v : fallback);
      const rw = Number(p.rw);
      return {
        series,
        bench: pick(p.bench, series[0]),
        cf: FREQ_LABEL[p.cf] ? p.cf : a.correlation_frequency,
        a: pick(p.a, series[0]),
        b: pick(p.b, series.find((t) => t !== pick(p.a, series[0])) || series[1]),
        rw: Number.isInteger(rw) && rw >= 5 && rw <= 520 ? rw : a.rolling_corr_window,
      };
    }

    const setParam = (patch) => setPageParams({ ...params(), ...patch });

    function renderControls(st) {
      const names = st.series.map((t) => [t, seriesName(t)]);
      controls.replaceChildren(
        select("Benchmark (beta)", names, st.bench, (v) => setParam({ bench: v })),
        h("div.field.inline-field", h("span.field-label", "Return frequency"),
          h("div.segmented", { role: "radiogroup", "aria-label": "Correlation and beta frequency" },
            Object.entries(FREQ_LABEL).map(([k, label]) => h("button.seg", { type: "button", role: "radio",
              "aria-checked": String(st.cf === k), onclick: () => setParam({ cf: k }) }, label)))),
        select("Relative strength A", names, st.a, (v) => setParam({ a: v })),
        select("vs B", names.filter(([t]) => t !== st.a), st.b, (v) => setParam({ b: v })),
        h("label.field.inline-field", h("span.field-label", `Rolling window (${FREQ_LABEL[st.cf].toLowerCase()} periods)`),
          h("input.input.num-input", { type: "number", min: "5", max: "520", value: String(st.rw),
            onchange: (e) => { const v = Math.round(Number(e.target.value)); if (v >= 5 && v <= 520) setParam({ rw: String(v) }); } })));
    }

    async function render() {
      const mine = ++token;
      dispose();
      sync = createSyncGroup();
      const track = (fn) => (mine === token ? disposers.push(fn) : fn());
      const st = state();
      if (st.series.length < 2) {
        controls.hidden = true;
        body.replaceChildren(h("section.card", emptyState({
          icon: "compare", title: st.series.length ? "Add at least one more series" : "Pick two or more series to compare",
          message: "Compare puts several indices side by side over exactly the same period.",
          action: { label: "Add series", onClick: ctx.openPicker },
        })));
        return;
      }
      controls.hidden = false;
      renderControls(st);
      const range = rangeParams();
      let cmp = null;
      const tables = {};

      // ---- growth of 100
      let growthTc = null;
      const growth = chartCard({ title: "Growth of 100", subtitle: "…", filename: "growth-of-100",
        data: () => ({ columns: ["Date", ...st.series.map(seriesName)], rows: cmp.rebased.dates.map((d, i) => [d, ...st.series.map((t) => cmp.rebased.series[t][i])]) }),
        png: () => growthTc.png() });
      growth.el.classList.add("span-12");
      // ---- metrics table
      const metricsBody = h("div.card-pad");
      const metricsCard = h("section.card.span-12", h("header.card-head", h("div.card-titles",
        h("h3.card-title", "Side by side"), h("p.card-sub", `Metrics from Settings → Analytics · beta vs ${seriesName(st.bench)} on ${FREQ_LABEL[st.cf].toLowerCase()} returns`))), metricsBody);
      // ---- correlation + scatter
      let corrChart = null, scatterChart = null;
      const corr = chartCard({ title: "Correlation", subtitle: `${FREQ_LABEL[st.cf]} returns`, filename: "correlation",
        data: () => tables.corr, png: () => corrChart.png() });
      const scatter = chartCard({ title: "Risk vs return", subtitle: "Annual volatility (x) against CAGR (y)", filename: "risk-return",
        data: () => tables.scatter, png: () => scatterChart.png() });
      corr.el.classList.add("span-6");
      scatter.el.classList.add("span-6");
      // ---- relative strength + rolling correlation
      let rsTc = null, rcTc = null, rs = null, rc = null;
      const rsCard = chartCard({ title: `Relative strength: ${seriesName(st.a)} ÷ ${seriesName(st.b)}`,
        subtitle: `Rebased to 100 · rising = ${seriesName(st.a)} outperforming`, filename: "relative-strength",
        data: () => ({ columns: ["Date", "Ratio"], rows: rs.ratio.dates.map((d, i) => [d, rs.ratio.values[i]]) }), png: () => rsTc.png() });
      const rcCard = chartCard({ title: `Rolling correlation: ${seriesName(st.a)} & ${seriesName(st.b)}`,
        subtitle: `${st.rw} ${FREQ_LABEL[st.cf].toLowerCase()} periods`, filename: "rolling-correlation",
        data: () => ({ columns: ["Date", "Correlation"], rows: rc.series.dates.map((d, i) => [d, rc.series.values[i]]) }), png: () => rcTc.png() });
      rsCard.el.classList.add("span-6");
      rcCard.el.classList.add("span-6");

      body.replaceChildren(...[tooManySeriesNote(st.series.length), shortHistoryNote(st.series), mixedKindNote(st.series), h("div.grid", growth.el, metricsCard, corr.el, scatter.el, rsCard.el, rcCard.el)].filter(Boolean));
      metricsBody.replaceChildren(skeleton({ lines: 3 }));

      const main = guard(growth, async () => {
        corr.loading(); scatter.loading();
        metricsBody.replaceChildren(skeleton({ lines: 3 }));
        cmp = await api.get("/analytics/compare", { tickers: st.series, benchmark: st.bench, freq: st.cf, ...range });
        if (mine !== token) return;
        // growth
        const plot = h("div.plot");
        const legend = seriesLegend(st.series, { value: (t) => format.number(cmp.rebased.series[t].at(-1)), label: "Final value of 100" });
        growth.content(h("div", legend, plot));
        growth.el.querySelector(".card-sub").replaceChildren(
          `Rebased to 100 on ${format.date(cmp.rebased.start)}, the first date every series has data, ` +
          `up to ${format.date(cmp.end)}, the last date they all share `,
          h("span.info-tip", { title: cmp.rebased.note, "aria-label": cmp.rebased.note, tabindex: "0", role: "note" }, icon("info", { size: "sm" })));
        growthTc = await createTimeChart(plot, { height: 340 });
        track(() => growthTc.destroy());
        growthTc.setSeries(st.series.map((t) => ({ id: t, type: "line", colour: seriesColour(t), title: st.series.length <= 4 ? seriesName(t) : "",
          data: cmp.rebased.dates.map((d, i) => ({ time: d, value: cmp.rebased.series[t][i] })) })));
        sync.add(growthTc);
        // metrics + beta
        const cols = ["Series", ...cmp.metric_meta.map((m) => m.label), `Beta vs ${seriesName(st.bench)}`];
        const fmtBy = Object.fromEntries(cmp.metric_meta.map((m) => [m.label, (v) => format.metric(v, m.kind)]));
        metricsBody.replaceChildren(staticTable({ label: "Metrics side by side", columns: cols,
          rows: st.series.map((t) => [seriesName(t), ...cmp.metric_ids.map((id) => cmp.metrics[t][id]), cmp.beta[t]]),
          format: { ...fmtBy, [cols.at(-1)]: (v) => format.number(v) } }));
        // correlation matrix
        const names = cmp.correlation.tickers.map(seriesName);
        tables.corr = { columns: ["", ...names], rows: cmp.correlation.matrix.map((r, i) => [names[i], ...r]), format: Object.fromEntries(names.map((n) => [n, (v) => v.toFixed(2)])) };
        const corrPlot = h("div.plot");
        corr.content(h("div", corrPlot, h("p.insight", corrInsight(names, cmp.correlation.matrix))));
        corrChart = await createEChart(corrPlot, (t) => corrMatrixOption(t, { labels: names, matrix: cmp.correlation.matrix }),
          { height: Math.max(240, names.length * 40 + 60) });
        track(() => corrChart.destroy());
        // scatter
        tables.scatter = { columns: ["Series", "Volatility", "CAGR"], rows: cmp.scatter.map((p) => [seriesName(p.ticker), p.ann_vol, p.cagr]), format: { Volatility: pct, CAGR: pct } };
        const scPlot = h("div.plot");
        scatter.content(scPlot);
        scatterChart = await createEChart(scPlot, (t) => scatterOption(t, {
          points: cmp.scatter.map((p) => ({ name: seriesName(p.ticker), x: p.ann_vol, y: p.cagr, colour: resolveColour(seriesColour(p.ticker)) })),
          fmt: (v, d) => pct(v, d ?? 1) }), { height: Math.max(240, names.length * 40 + 60) });
        track(() => scatterChart.destroy());
      }, (e, retry) => {
        // metrics, correlation and scatter all come from the same request: fail them together
        if (mine !== token) return;
        corr.error(e, retry);
        scatter.error(e, retry);
        metricsBody.replaceChildren(errorState(e, { onRetry: retry }));
      });

      const pair = Promise.all([
        guard(rsCard, async () => {
          rs = await api.get("/analytics/relative-strength", { a: st.a, b: st.b, ...range });
          if (mine !== token) return;
          const plot = h("div.plot");
          rsCard.content(plot);
          rsTc = await createTimeChart(plot, { height: 260 });
          track(() => rsTc.destroy());
          rsTc.setSeries([
            { id: "ratio", type: "line", colour: seriesColour(st.a), title: "Ratio", data: rs.ratio.dates.map((d, i) => ({ time: d, value: rs.ratio.values[i] })), priceLines: [{ price: 100, title: "Start" }] },
            rs.sma && { id: "sma", type: "line", colour: "var(--text-2)", dashed: true, width: 1.5, lastValue: false, title: `SMA ${rs.sma_window}`,
              data: rs.sma.dates.map((d, i) => ({ time: d, value: rs.sma.values[i] })) },
          ].filter(Boolean));
          sync.add(rsTc);
        }),
        guard(rcCard, async () => {
          rc = await api.get("/analytics/rolling-correlation", { a: st.a, b: st.b, window: st.rw, freq: st.cf, ...range });
          if (mine !== token) return;
          if (!rc.series.values.length) return rcCard.empty({ icon: "chart", title: "Not enough data", message: "The range is shorter than the rolling window." });
          const plot = h("div.plot");
          rcCard.content(plot);
          rcTc = await createTimeChart(plot, { height: 260, valueFormat: (v) => v.toFixed(2) });
          track(() => rcTc.destroy());
          rcTc.setSeries([{ id: "rc", type: "line", colour: seriesColour(st.a), data: rc.series.dates.map((d, i) => ({ time: d, value: rc.series.values[i] })), priceLines: [{ price: 0, title: "0" }] }]);
          sync.add(rcTc);
        }),
      ]);
      await Promise.all([main, pair]);
    }

    const here = (fn) => () => { if (store.get().route.page === "compare") fn(); };
    const unsubs = [
      store.subscribe((s) => s.selection, here(render)),
      store.subscribe((s) => s.route.params, here(render)),
      store.subscribe((s) => s.settings?.analytics, here(render)),
      store.subscribe((s) => s.settings?.data.source, here(render)),
    ];
    render();
    return () => { unsubs.forEach((u) => u()); token++; dispose(); };
  },
};

function corrInsight(names, m) {
  let hi = null, lo = null;
  for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) {
    if (!hi || m[i][j] > hi[2]) hi = [i, j, m[i][j]];
    if (!lo || m[i][j] < lo[2]) lo = [i, j, m[i][j]];
  }
  if (!hi) return "";
  if (m.length === 2) return `${names[0]} and ${names[1]}: correlation ${hi[2].toFixed(2)}.`;
  return `Most alike: ${names[hi[0]]} & ${names[hi[1]]} (${hi[2].toFixed(2)}). Least alike: ${names[lo[0]]} & ${names[lo[1]]} (${lo[2].toFixed(2)}).`;
}
