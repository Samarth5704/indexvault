// Market pulse: a thin, slowly scrolling strip of last prices and 1-day changes
// for the first watchlist (or the default series). Pauses on hover/focus, sits
// still when motion is reduced/off, and can be turned off in settings (DESIGN § 5).

import { api, enc } from "./api.js";
import { seriesName } from "./components/series-picker.js";
import { h } from "./dom.js";
import { format } from "./settings.js";
import { store } from "./store.js";

function pulseTickers() {
  const s = store.get();
  return s.catalog.watchlists[0]?.tickers?.length ? s.catalog.watchlists[0].tickers : s.settings?.data.default_series || [];
}

async function quote(ticker) {
  const s = await api.get(`/series/${enc(ticker)}`, { period: "1M", columns: "close", freq: "Daily" });
  const rows = s.rows.filter((r) => r[1] != null);
  const [last, prev] = [rows.at(-1), rows.at(-2)];
  return { ticker, last: last?.[1], date: last?.[0], change: prev ? last[1] / prev[1] - 1 : null };
}

function item(q) {
  const d = format.delta(q.change);
  return h("li.pulse-item",
    h("span.pulse-name", seriesName(q.ticker)),
    h("span.pulse-last.mono", format.number(q.last)),
    h("span.pulse-change.mono", { "data-tone": d.tone }, h("span", { "aria-hidden": "true" }, d.arrow), ` ${d.text}`));
}

export function mountPulse(el) {
  let token = 0;

  async function refresh() {
    const s = store.get().settings;
    el.hidden = !s?.appearance.market_pulse;
    if (el.hidden) return;
    const tickers = pulseTickers();
    const mine = ++token;
    el.replaceChildren(h("p.pulse-status.muted", "Loading market pulse…"));
    if (!tickers.length) {
      el.replaceChildren(h("p.pulse-status.muted", "Add a watchlist to see live prices here."));
      return;
    }
    const results = await Promise.allSettled(tickers.map(quote));
    if (mine !== token) return; // a newer refresh started
    const quotes = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    if (!quotes.length) {
      el.replaceChildren(h("p.pulse-status.muted", "Market pulse unavailable. ",
        h("button.link-btn", { type: "button", onclick: refresh }, "Retry")));
      return;
    }
    const asOf = quotes.map((q) => q.date).sort().at(-1);
    const track = h("ul.pulse-track", quotes.map(item));
    // A second, hidden copy makes the loop seamless; screen readers read one list.
    const clone = h("ul.pulse-track", { "aria-hidden": "true" }, quotes.map(item));
    el.replaceChildren(
      h("div.pulse-viewport", { tabindex: "0", "aria-label": `Market pulse, last close ${format.date(asOf)}` },
        h("div.pulse-marquee", { style: { "--pulse-duration": `${Math.max(30, quotes.length * 6)}s` } }, track, clone)));
  }

  store.subscribe((s) => s.settings?.appearance.market_pulse, refresh);
  store.subscribe((s) => s.settings?.data.source, refresh);
  store.subscribe((s) => s.catalog, refresh);
  refresh();
  return { refresh };
}
