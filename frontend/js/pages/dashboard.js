// Dashboard (M2 preview). The widget grid arrives in M8; for now this page shows
// the building blocks working on live data for the current selection.

import { api, enc } from "../api.js";
import { chartCard } from "../components/chart-card.js";
import { asyncView, emptyState, statusPill } from "../components/feedback.js";
import { kpiCard } from "../components/kpi-card.js";
import { seriesName } from "../components/series-picker.js";
import { h } from "../dom.js";
import { format, settings } from "../settings.js";
import { rangeParams, selection, seriesColour, store } from "../store.js";

function head() {
  return h("header.page-head",
    h("div", h("h1", "Dashboard"),
      h("p.page-sub", "A live preview of the building blocks. The customisable widget grid arrives in Milestone 8.")));
}

/** KPI strip for the first selected series, cards chosen in settings (analytics.kpi_cards). */
function kpiStrip(ticker) {
  const strip = h("div.kpi-strip", { role: "list", "aria-label": `Key figures for ${seriesName(ticker)}` });
  const ids = settings().analytics.kpi_cards;
  const cards = ids.map((id) => kpiCard({ label: "…", deltaLabel: id === "end_level" ? "1M" : "" }));
  cards.forEach((c) => { c.el.setAttribute("role", "listitem"); strip.append(c.el); });
  const wrap = h("section.kpi-section", h("h2.section-title", seriesName(ticker)), strip);
  return {
    el: wrap,
    async load() {
      const [sum, spark, trailing] = await Promise.all([
        api.get("/analytics/summary", { tickers: ticker, ...rangeParams() }),
        api.get(`/series/${enc(ticker)}`, { ...rangeParams(), freq: "Weekly", columns: "close" }),
        api.get("/analytics/trailing", { tickers: ticker, periods: "1M" }),
      ]);
      const meta = Object.fromEntries(sum.metrics.map((m) => [m.id, m]));
      const values = sum.series[ticker].metrics;
      const closes = spark.rows.map((r) => r[1]);
      cards.forEach((card, i) => {
        const id = ids[i];
        card.el.querySelector(".kpi-label").textContent = meta[id]?.label || id;
        card.update({ value: values[id], kind: meta[id]?.kind });
        if (id === "end_level") card.update({ delta: trailing.series[ticker]["1M"], spark: closes });
      });
      return sum;
    },
  };
}

function growthCard(tickers) {
  let payload = null;
  const card = chartCard({
    title: "Growth of 100", subtitle: "Rebased to the first common date · preview chart",
    filename: "growth-of-100",
    data: () => ({
      columns: ["Date", ...tickers.map(seriesName)],
      rows: payload.rebased.dates.map((d, i) => [d, ...tickers.map((t) => payload.rebased.series[t][i])]),
      format: Object.fromEntries(tickers.map((t) => [seriesName(t), (v) => format.number(v)])),
    }),
  });
  card.el.classList.add("span-8");
  return {
    card,
    async load() {
      card.loading();
      try {
        payload = await api.get("/analytics/compare", { tickers, ...rangeParams() });
        card.content(sparkLines(payload, tickers));
      } catch (e) {
        card.error(e, () => this.load());
      }
    },
  };
}

/** Minimal SVG lines until the real chart wrappers land in M4. */
function sparkLines(payload, tickers) {
  const all = tickers.flatMap((t) => payload.rebased.series[t]);
  const min = Math.min(...all), max = Math.max(...all), span = max - min || 1;
  const n = payload.rebased.dates.length;
  const lines = tickers.map((t) => {
    const pts = payload.rebased.series[t].map((v, i) => `${((i / (n - 1)) * 600).toFixed(1)},${(190 - ((v - min) / span) * 180).toFixed(1)}`);
    return `<polyline points="${pts.join(" ")}" fill="none" stroke="${seriesColour(t)}" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  }).join("");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 600 200");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "preview-lines");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Growth of 100 for ${tickers.map(seriesName).join(", ")}. Use the table view for values.`);
  svg.innerHTML = lines;
  const legend = h("ul.legend", tickers.map((t) => h("li",
    h("span.chip-dot", { style: { background: seriesColour(t) } }), seriesName(t),
    h("span.mono.muted", format.number(payload.rebased.series[t].at(-1))))));
  return h("div.preview-chart", legend, svg);
}

function healthCard(tickers) {
  const body = h("div.card-pad");
  const el = h("section.card.span-4", h("header.card-head", h("div.card-titles", h("h3.card-title", "Data health"),
    h("p.card-sub", "Status pills from the quality checks"))), body);
  return {
    el,
    load: () => asyncView(body, {
      load: () => api.get("/analytics/quality", { tickers, ...rangeParams() }),
      render: (q) => h("ul.health-list", tickers.map((t) => h("li",
        h("span.truncate", seriesName(t)), statusPill(q.series[t].status),
        q.series[t].issues.length ? h("p.muted.health-issue", q.series[t].issues.join(" · ")) : null))),
      skeleton: { lines: tickers.length },
    }),
  };
}

export default {
  mount(el, ctx) {
    el.append(head());
    const body = h("div.page-body");
    el.append(body);

    function render() {
      const { series } = selection();
      body.replaceChildren();
      if (!series.length) {
        body.append(h("section.card", emptyState({
          icon: "chart", title: "Pick a series to get started",
          message: "Choose an index like NIFTY 50 from the series picker. Your selection follows you to every page.",
          action: { label: "Add series", onClick: ctx.openPicker },
        })));
        return;
      }
      const kpis = kpiStrip(series[0]);
      const growth = growthCard(series);
      const health = healthCard(series);
      body.append(kpis.el, h("div.grid", growth.card.el, health.el));
      kpis.load().catch((e) => kpis.el.replaceChildren(emptyState({ icon: "alert-octagon", title: "Couldn't load key figures", message: e.message })));
      growth.load();
      health.load();
    }

    const unsubs = [
      store.subscribe((s) => s.selection, render),
      store.subscribe((s) => s.settings?.analytics, render),
      store.subscribe((s) => s.settings?.data.source, render),
    ];
    render();
    return () => unsubs.forEach((u) => u());
  },
};
