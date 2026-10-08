// Seasonality (SPEC § 3.7): month-of-year and day-of-week returns for one series,
// mean/median toggle, min-years filter and a caution note about noise.
// Page params: t = ticker, stat = mean|median, my = min years.

import { api } from "../api.js";
import { barsOption, createEChart } from "../charts/echarts.js";
import { chartCard, staticTable } from "../components/chart-card.js";
import { emptyState } from "../components/feedback.js";
import { seriesName } from "../components/series-picker.js";
import { activeTicker, seriesTabs } from "../components/series-tabs.js";
import { h, icon } from "../dom.js";
import { setPageParams } from "../router.js";
import { format, settings } from "../settings.js";
import { rangeParams, selection, store } from "../store.js";

const pct = (v, d) => format.pct(v, d == null ? {} : { decimals: d });

async function guard(card, fn) {
  card.loading();
  try { await fn(); } catch (e) { card.error(e, () => guard(card, fn)); }
}

export default {
  mount(el, ctx) {
    const tabs = seriesTabs();
    const controls = h("div.compare-controls.card");
    const body = h("div.page-body");
    el.append(h("header.page-head", h("div", h("h1", "Seasonality"),
      h("p.page-sub", "Do some months or weekdays tend to do better? Useful context, weak evidence."))),
    h("div.analyse-tabs", tabs.el), controls, body);

    let token = 0, disposers = [];
    const dispose = () => { disposers.forEach((d) => d()); disposers = []; };
    const params = () => store.get().route.params;

    function state() {
      const my = Number(params().my);
      return { ticker: activeTicker(), stat: params().stat === "median" ? "median" : "mean",
        minYears: Number.isInteger(my) && my >= 1 && my <= 50 ? my : settings().analytics.seasonality_min_years };
    }

    function renderControls(st) {
      const minInput = h("input.input.num-input", { type: "number", min: "1", max: "50", step: "1", value: String(st.minYears), "aria-label": "Minimum years" });
      minInput.addEventListener("change", () => {
        const v = Math.round(Number(minInput.value));
        if (v >= 1 && v <= 50) setPageParams({ ...params(), my: String(v) });
      });
      controls.replaceChildren(
        h("div.field.inline-field", h("span.field-label", "Monthly statistic"),
          h("div.segmented", { role: "radiogroup", "aria-label": "Statistic" }, [["mean", "Mean"], ["median", "Median"]].map(([k, label]) =>
            h("button.seg", { type: "button", role: "radio", "aria-checked": String(st.stat === k), onclick: () => setPageParams({ ...params(), stat: k }) }, label)))),
        h("label.field.inline-field", h("span.field-label", "Flag months with fewer years than"), minInput));
    }

    async function render() {
      const mine = ++token;
      dispose();
      const track = (fn) => (mine === token ? disposers.push(fn) : fn());
      tabs.render();
      const st = state();
      if (!st.ticker) {
        controls.hidden = true;
        body.replaceChildren(h("section.card", emptyState({ icon: "calendar", title: "Pick a series",
          message: "Seasonality looks at one series at a time; switch between selected series with the tabs.", action: { label: "Add series", onClick: ctx.openPicker } })));
        return;
      }
      controls.hidden = false;
      renderControls(st);
      const range = rangeParams();
      let m = null, w = null, mChart = null, wChart = null;
      const key = st.stat === "median" ? "median" : "avg";
      const label = st.stat === "median" ? "Median" : "Mean";

      const caution = h("section.card.caution", { role: "note" }, icon("alert-triangle"),
        h("div", h("p.caution-title", "Treat these patterns with caution"),
          h("p.text-2", "Each month has only one value per year, so a single crash or rally can dominate. Patterns that look strong over 10–20 years are often noise and rarely persist. Months with fewer years than your threshold are greyed and marked with *.")));
      const months = chartCard({ title: `${label} return by month`, subtitle: `Monthly returns of ${seriesName(st.ticker)} grouped by calendar month`,
        filename: `${st.ticker}-seasonality`, png: () => mChart.png(),
        data: () => ({ columns: ["Month", "Mean", "Median", "Positive", "Best", "Worst", "Years"],
          rows: m.months.map((r) => [r.month, r.avg, r.median, r.positive, r.best, r.worst, r.years]),
          format: { Mean: (v) => pct(v), Median: (v) => pct(v), Positive: (v) => pct(v, 0), Best: (v) => pct(v, 1), Worst: (v) => pct(v, 1) } }) });
      months.el.classList.add("span-7");
      const tableBody = h("div.card-pad");
      const tableCard = h("section.card.span-5", h("header.card-head", h("div.card-titles", h("h3.card-title", "Month by month"),
        h("p.card-sub", "Hit rate = share of years the month was positive"))), tableBody);
      const days = chartCard({ title: "Mean return by weekday", subtitle: "Daily returns grouped by day of the week", filename: `${st.ticker}-weekday`,
        png: () => wChart.png(),
        data: () => ({ columns: ["Day", "Mean", "Positive", "Volatility", "Days"], rows: w.days.map((r) => [r.day, r.avg, r.positive, r.volatility, r.days]),
          format: { Mean: (v) => pct(v, 3), Positive: (v) => pct(v, 1), Volatility: (v) => pct(v), Days: (v) => format.number(v, { decimals: 0 }) } }) });
      days.el.classList.add("span-12");
      body.replaceChildren(caution, h("div.grid", months.el, tableCard, days.el));
      tableBody.replaceChildren(h("div.skeleton", h("div.sk-line"), h("div.sk-line"), h("div.sk-line")));

      await Promise.all([
        guard(months, async () => {
          m = await api.get("/analytics/seasonality", { ticker: st.ticker, min_years: st.minYears, ...range });
          if (mine !== token) return;
          const plot = h("div.plot");
          const thin = m.months.filter((r) => !r.enough_data).length;
          const best = [...m.months].sort((a, b) => b[key] - a[key])[0];
          months.content(h("div", plot, h("p.insight", `${best.month} has the highest ${label.toLowerCase()} (${pct(best[key], 2)}), positive in ${pct(best.positive, 0)} of ${best.years} years.` +
            (thin ? ` ${thin} month${thin > 1 ? "s have" : " has"} fewer than ${st.minYears} years of data.` : ""))));
          mChart = await createEChart(plot, (t) => barsOption(t, { labels: m.months.map((r) => r.month), values: m.months.map((r) => r[key]),
            muted: m.months.map((r) => !r.enough_data), fmt: (v, d) => pct(v, d ?? 1),
            tooltipLabel: (l) => { const r = m.months.find((x) => x.month === l); return `${l} · ${r.years} years · positive ${pct(r.positive, 0)}`; } }), { height: 280 });
          track(() => mChart.destroy());
          tableBody.replaceChildren(staticTable({ label: "Seasonality by month", columns: ["Month", label, "Hit rate", "Best", "Worst", "Years"],
            rows: m.months.map((r) => [r.enough_data ? r.month : `${r.month}*`, r[key], r.positive, r.best, r.worst, r.years]),
            format: { [label]: (v) => pct(v), "Hit rate": (v) => pct(v, 0), Best: (v) => pct(v, 1), Worst: (v) => pct(v, 1) } }));
        }).catch(() => {}),
        guard(days, async () => {
          w = await api.get("/analytics/weekday", { ticker: st.ticker, ...range });
          if (mine !== token) return;
          const plot = h("div.plot");
          days.content(h("div", plot, h("p.insight", "Weekday averages come from thousands of days but are tiny next to daily noise; differences of a few hundredths of a percent are rarely meaningful.")));
          wChart = await createEChart(plot, (t) => barsOption(t, { labels: w.days.map((r) => r.day), values: w.days.map((r) => r.avg),
            fmt: (v, d) => pct(v, d ?? 3), tooltipLabel: (l) => { const r = w.days.find((x) => x.day === l); return `${l} · ${format.number(r.days, { decimals: 0 })} days · positive ${pct(r.positive, 1)}`; } }), { height: 240 });
          track(() => wChart.destroy());
        }),
      ]);
    }

    const here = (fn) => () => { if (store.get().route.page === "seasonality") fn(); };
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
