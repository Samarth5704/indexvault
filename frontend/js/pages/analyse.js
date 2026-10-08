// Analyse (SPEC § 3.3): single-series deep dive. Tabs pick the series; every chart
// sits in a chart card; time-series charts share a synced crosshair (DESIGN § 5).
// Page params: t = ticker, chart = line|candle|area, log = 1, ov = overlay ids ("none" = off).

import { api } from "../api.js";
import { createSyncGroup } from "../charts/sync.js";
import { emptyState, errorState, skeleton } from "../components/feedback.js";
import { activeTicker, seriesTabs } from "../components/series-tabs.js";
import { h, icon } from "../dom.js";
import { setPageParams } from "../router.js";
import { settings } from "../settings.js";
import { rangeParams, selection, store } from "../store.js";
import {
  drawdownPanels, heatmapPanel, histogramPanel, kpiPanel, openAllStats, pricePanel, trailingPanel, volPanel, yearlyPanel,
} from "./analyse-panels.js";

const CHART_TYPES = ["line", "candle", "area"];

function priceState(params, s) {
  const all = [...s.analytics.sma_windows.map((w) => `sma_${w}`), ...s.analytics.ema_windows.map((w) => `ema_${w}`)];
  const ov = params.ov === "none" ? [] : params.ov ? params.ov.split(",").filter((x) => all.includes(x)) : all;
  return { type: CHART_TYPES.includes(params.chart) ? params.chart : "line", log: params.log === "1", overlays: ov };
}

export default {
  mount(el, ctx) {
    const tabs = seriesTabs();
    const statsBtn = h("button.btn.secondary.sm", { type: "button", disabled: true, "aria-haspopup": "dialog" },
      icon("table", { size: "sm" }), "All statistics");
    const body = h("div.page-body.analyse");
    el.append(
      h("header.page-head",
        h("div", h("h1", "Analyse"), h("p.page-sub", "A deep dive into one series: returns, risk, drawdowns and seasonality.")),
        statsBtn),
      h("div.analyse-tabs", tabs.el),
      body);

    // One sync group per render: a slow panel from a stale render can only join its
    // own (already cleared) group, never the live one.
    let disposers = [], token = 0, summary = null, envNow = null, sync = null;
    const dispose = () => { sync?.clear(); disposers.forEach((d) => d()); disposers = []; };

    statsBtn.addEventListener("click", () => summary && openAllStats(envNow, summary));

    async function render() {
      const mine = ++token;
      dispose();
      tabs.render();
      const ticker = activeTicker();
      statsBtn.disabled = true;
      if (!ticker) {
        body.replaceChildren(h("section.card", emptyState({
          icon: "chart", title: "Pick a series to analyse",
          message: "Choose an index in the series picker. With several selected, switch between them with the tabs.",
          action: { label: "Add series", onClick: ctx.openPicker },
        })));
        return;
      }
      const s = settings();
      sync = createSyncGroup();
      const env = envNow = {
        ticker, range: rangeParams(), freq: selection().freq, settings: s, sync,
        track: (fn) => (mine === token ? disposers.push(fn) : fn()),
      };

      // KPI strip + trailing row first: they share the summary/trailing payloads.
      const top = h("div.analyse-top", skeleton({ variant: "kpi", label: "Loading key figures" }));
      const price = pricePanel(env, {
        state: priceState(store.get().route.params, s),
        onState: (st) => setPageParams({ ...store.get().route.params,
          chart: st.type === "line" ? undefined : st.type, log: st.log ? "1" : undefined,
          ov: st.overlays.length ? st.overlays.join(",") : "none" }),
      });
      const dd = drawdownPanels(env);
      const heat = heatmapPanel(env);
      const yearly = yearlyPanel(env);
      const hist = histogramPanel(env);
      const vol = volPanel(env);
      body.replaceChildren(top, h("div.grid", price.el, ...dd.els, heat.el, yearly.el, hist.el, vol.el));

      const kpis = Promise.all([
        api.get("/analytics/summary", { tickers: ticker, ...env.range }),
        api.get("/analytics/trailing", { tickers: ticker }),
      ]).then(([sum, trailing]) => {
        if (mine !== token) return;
        summary = sum;
        statsBtn.disabled = false;
        top.replaceChildren(kpiPanel(env, sum, trailing), trailingPanel(env, trailing));
      }).catch((e) => { if (mine === token) top.replaceChildren(errorState(e, { onRetry: render })); });

      await Promise.all([kpis, price.load(), dd.load(), heat.load(), yearly.load(), hist.load(), vol.load()]);
    }

    // Re-render on anything that changes the data; chart-type / log / overlay
    // params are handled inside the price panel without a reload.
    let lastT = store.get().route.params.t;
    const here = (fn) => (...a) => { if (store.get().route.page === "analyse") fn(...a); };
    const unsubs = [
      store.subscribe((s) => s.selection, here(render)),
      store.subscribe((s) => s.route.params.t, here((t) => { if (t !== lastT) { lastT = t; render(); } })),
      store.subscribe((s) => s.settings?.analytics, here(render)),
      store.subscribe((s) => s.settings?.data.source, here(render)),
    ];
    render();
    return () => { unsubs.forEach((u) => u()); token++; dispose(); };
  },
};
