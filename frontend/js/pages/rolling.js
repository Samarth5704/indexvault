// Rolling returns (SPEC § 3.5): holding-period chips, target CAGR, rolling CAGR
// lines, distribution (box plots), stats table and plain-English insight lines.
// Page params: y = holding period in years, target = target CAGR (decimal).

import { api } from "../api.js";
import { boxplotOption, createEChart } from "../charts/echarts.js";
import { resolveColour } from "../charts/theme.js";
import { createTimeChart } from "../charts/timeseries.js";
import { chartCard, staticTable } from "../components/chart-card.js";
import { emptyState, errorState, skeleton } from "../components/feedback.js";
import { seriesLegend, tooManySeriesNote } from "../components/legend.js";
import { seriesName } from "../components/series-picker.js";
import { h, icon } from "../dom.js";
import { setPageParams } from "../router.js";
import { format, settings } from "../settings.js";
import { rangeParams, selection, seriesColour, setSelection, store } from "../store.js";

const pct = (v, d) => format.pct(v, d == null ? {} : { decimals: d });

export default {
  mount(el, ctx) {
    const controls = h("div.compare-controls.card");
    const insights = h("section.card.insights", { "aria-live": "polite" });
    const body = h("div.page-body");
    el.append(h("header.page-head", h("div", h("h1", "Rolling returns"),
      h("p.page-sub", "Every possible holding period of the same length: how often did it pay off?"))), controls, insights, body);

    let token = 0, disposers = [];
    const dispose = () => { disposers.forEach((d) => d()); disposers = []; };
    const params = () => store.get().route.params;

    function state() {
      const a = settings().analytics;
      const y = Number(params().y);
      const target = Number(params().target);
      return {
        series: selection().series,
        years: a.rolling_windows_years.includes(y) ? y : (a.rolling_windows_years.includes(5) ? 5 : a.rolling_windows_years[0]),
        target: params().target != null && Number.isFinite(target) && target >= -0.5 && target <= 1 ? target : a.target_cagr,
      };
    }

    function renderControls(st) {
      const targetInput = h("input.input.num-input", { type: "number", step: "0.5", min: "-50", max: "100",
        value: String(+(st.target * 100).toFixed(2)), "aria-label": "Target CAGR in percent" });
      targetInput.addEventListener("change", () => {
        const v = Number(targetInput.value);
        if (Number.isFinite(v) && v >= -50 && v <= 100) setPageParams({ ...params(), target: String(v / 100) });
      });
      const sel = selection();
      controls.replaceChildren(...[
        h("div.field.inline-field", h("span.field-label", "Holding period"),
          h("div.segmented", { role: "radiogroup", "aria-label": "Holding period" },
            settings().analytics.rolling_windows_years.map((y) => h("button.seg", { type: "button", role: "radio",
              "aria-checked": String(y === st.years), onclick: () => setPageParams({ ...params(), y: String(y) }) }, `${y} yr${y === 1 ? "" : "s"}`)))),
        h("label.field.inline-field", h("span.field-label", "Target CAGR %"), targetInput),
        !sel.start && sel.period === "Max" ? null : h("div.range-hint",
          icon("info", { size: "sm" }),
          h("span", "Rolling returns use the selected range. More history gives more periods. "),
          h("button.link-btn", { type: "button", onclick: () => setSelection({ period: "Max", start: null, end: null }) }, "Use full history")),
      ].filter(Boolean)); // native replaceChildren would print `null` as text
    }

    async function render() {
      const mine = ++token;
      dispose();
      const track = (fn) => (mine === token ? disposers.push(fn) : fn());
      const st = state();
      if (!st.series.length) {
        controls.hidden = true;
        insights.hidden = true;
        body.replaceChildren(h("section.card", emptyState({ icon: "rolling", title: "Pick a series",
          message: "Rolling returns show every possible holding period of the same length, not just one start date.",
          action: { label: "Add series", onClick: ctx.openPicker } })));
        return;
      }
      controls.hidden = false;
      insights.hidden = false;
      renderControls(st);
      insights.replaceChildren(skeleton({ lines: Math.min(3, st.series.length), label: "Loading insights" }));

      let data = null, linesTc = null, boxChart = null;
      const label = `${st.years}-year`;
      const lines = chartCard({ title: `${label} rolling CAGR`, subtitle: `Each point: the annualised return of the ${st.years} years ending that day`,
        filename: `rolling-${st.years}y`, png: () => linesTc.png(),
        data: () => {
          const withData = st.series.filter((t) => data.series[t].windows[st.years]);
          const dates = [...new Set(withData.flatMap((t) => data.series[t].windows[st.years].series.dates))].sort();
          const maps = withData.map((t) => { const w = data.series[t].windows[st.years].series; return new Map(w.dates.map((d, i) => [d, w.values[i]])); });
          return { columns: ["Date", ...withData.map(seriesName)], rows: dates.map((d) => [d, ...maps.map((m) => m.get(d) ?? null)]) };
        } });
      lines.el.classList.add("span-12");
      const dist = chartCard({ title: "Distribution", subtitle: "Min, 25%, median, 75%, max · ◆ latest · dashed = target",
        filename: `rolling-${st.years}y-distribution`, png: () => boxChart.png(), data: () => statsTable(data, st) });
      dist.el.classList.add("span-6");
      const tableBody = h("div.card-pad", skeleton({ lines: 4 }));
      const tableCard = h("section.card.span-6", h("header.card-head", h("div.card-titles", h("h3.card-title", "Summary"),
        h("p.card-sub", `${label} periods · target ${pct(st.target, 1)} a year`))), tableBody);
      body.replaceChildren(...[tooManySeriesNote(st.series.length), h("div.grid", lines.el, dist.el, tableCard)].filter(Boolean));
      lines.loading();
      dist.loading();

      try {
        data = await api.get("/analytics/rolling", { tickers: st.series, years: st.years, target: st.target, ...rangeParams() });
      } catch (e) {
        if (mine !== token) return;
        const retry = () => render();
        [lines, dist].forEach((c) => c.error(e, retry));
        insights.replaceChildren(errorState(e, { onRetry: retry }));
        tableBody.replaceChildren(errorState(e));
        return;
      }
      if (mine !== token) return;
      const ok = st.series.filter((t) => data.series[t].windows[st.years]);
      const short = st.series.filter((t) => !data.series[t].windows[st.years]);

      insights.replaceChildren(h("h2.section-title", "In plain English"),
        h("ul.insight-list", ok.map((t) => h("li", h("span.chip-dot", { style: { background: seriesColour(t) }, "aria-hidden": "true" }),
          data.series[t].windows[st.years].insight)),
        short.map((t) => h("li.muted", h("span.chip-dot", { style: { background: seriesColour(t) }, "aria-hidden": "true" }),
          `${seriesName(t)}: less than ${st.years} years of data in this range.`))));
      tableBody.replaceChildren(staticTable(statsTable(data, st)));

      if (!ok.length) {
        const msg = { icon: "rolling", title: `No ${label} periods yet`, message: "Pick a shorter holding period or a longer date range." };
        lines.empty(msg);
        dist.empty(msg);
        return;
      }
      const plot = h("div.plot");
      lines.content(h("div", seriesLegend(ok, { value: (t) => `now ${pct(data.series[t].windows[st.years].latest, 1)}` }), plot));
      linesTc = await createTimeChart(plot, { height: 320, valueFormat: (v) => pct(v, 0) });
      track(() => linesTc.destroy());
      linesTc.setSeries(ok.map((t, i) => {
        const w = data.series[t].windows[st.years];
        return { id: t, type: "line", colour: seriesColour(t), width: ok.length > 4 ? 1.5 : 2, title: ok.length <= 4 ? seriesName(t) : "",
          data: w.series.dates.map((d, k) => ({ time: d, value: w.series.values[k] })),
          priceLines: i === 0 ? [{ price: st.target, title: "Target" }, { price: 0 }] : [] };
      }));

      const bplot = h("div.plot");
      dist.content(bplot);
      boxChart = await createEChart(bplot, (t) => boxplotOption(t, {
        names: ok.map(seriesName),
        boxes: ok.map((tk) => { const w = data.series[tk].windows[st.years]; return [w.min, w.q1, w.median, w.q3, w.max]; }),
        colours: ok.map((tk) => resolveColour(seriesColour(tk)) || t.series[0]),
        latest: ok.map((tk) => data.series[tk].windows[st.years].latest),
        target: st.target, fmt: (v, d) => pct(v, d ?? 1),
      }), { height: 320 });
      track(() => boxChart.destroy());
    }

    const here = (fn) => () => { if (store.get().route.page === "rolling") fn(); };
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

function statsTable(data, st) {
  const cols = ["Series", "Periods", "Min", "Median", "Max", "% negative", "% > target", "Latest"];
  const rows = st.series.map((t) => {
    const w = data.series[t].windows[st.years];
    return w ? [seriesName(t), w.observations, w.min, w.median, w.max, w.pct_negative, w.pct_above_target, w.latest]
      : [seriesName(t), 0, null, null, null, null, null, null];
  });
  const p1 = (v) => pct(v, 1);
  return { label: "Rolling return summary", columns: cols, rows,
    format: { Periods: (v) => format.number(v, { decimals: 0 }), Min: p1, Median: p1, Max: p1, "% negative": p1, "% > target": p1, Latest: p1 } };
}
