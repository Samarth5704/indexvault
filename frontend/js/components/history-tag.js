// Series labels shared by pickers, chips, tabs, legends and pages:
// - Price vs TRI (total return, dividends reinvested), so the two are never confused;
// - "< 1 yr" for series with less history than Settings → Data → short history
//   (the catalogue sends each item's cached span; unknown until first downloaded).
// Text + icon, never colour alone.

import { h, icon } from "../dom.js";
import { format } from "../settings.js";
import { store } from "../store.js";

/** The catalogue item for a ticker (with kind, history, used_source), or null. */
export function seriesInfo(ticker) {
  for (const cat of store.get().catalog.categories) {
    const item = cat.items.find((i) => i.ticker === ticker);
    if (item) return item;
  }
  return null;
}

const nameOf = (ticker) => seriesInfo(ticker)?.name || ticker;
export const isTri = (ticker) => seriesInfo(ticker)?.kind === "tri" || ticker.endsWith("-TRI");
export const isShort = (ticker) => Boolean(seriesInfo(ticker)?.history?.short);

/** Price indices that have a TRI twin (or are "^" indices) get a "Price" tag; TRI gets "TRI". */
export function kindTag(ticker) {
  if (isTri(ticker)) {
    return h("span.series-tag", { "data-kind": "tri", title: "Total return index: dividends reinvested (gross of tax)" }, "TRI");
  }
  const hasTwin = Boolean(seriesInfo(`${ticker}-TRI`));
  if (!hasTwin && !ticker.startsWith("^")) return null;
  return h("span.series-tag", { "data-kind": "price", title: "Price index: excludes dividends" }, "Price");
}

function shortText(ticker) {
  const hist = seriesInfo(ticker)?.history;
  return hist ? `Only ${format.number(hist.days, { decimals: 0 })} days of history, since ${format.date(hist.first)}` : "";
}

/** "< 1 yr" tag (null unless the series is short). */
export function historyTag(ticker) {
  if (!isShort(ticker)) return null;
  const years = store.get().catalog.short_history_days / 365;
  const label = years === 1 ? "< 1 yr" : `< ${format.number(store.get().catalog.short_history_days, { decimals: 0 })} d`;
  return h("span.series-tag", { "data-kind": "short", title: shortText(ticker), "aria-label": shortText(ticker) },
    icon("alert-triangle", { size: "sm" }), label);
}

/** Page note when any of `tickers` has short history; null otherwise. */
export function shortHistoryNote(tickers) {
  const short = tickers.filter(isShort);
  if (!short.length) return null;
  const list = short.map((t) => `${nameOf(t)} (${format.date(seriesInfo(t).history.first)})`).join(", ");
  return h("p.series-note", { role: "note", "data-tone": "warning" }, icon("alert-triangle", { size: "sm" }),
    `${short.length === 1 ? "This series has" : "These series have"} under a year of history: ${list}. ` +
    `Long-period figures are blank or unreliable for ${short.length === 1 ? "it" : "them"}. `,
    h("a", { href: "#/cache" }, "Import a longer history"));
}

/** Note when price and total-return series are compared together; null otherwise. */
export function mixedKindNote(tickers) {
  const tri = tickers.filter(isTri);
  if (!tri.length || tri.length === tickers.length) return null;
  return h("p.series-note", { role: "note" }, icon("info", { size: "sm" }),
    "You're comparing price indices with total return (TRI) series. TRI includes reinvested dividends, " +
    "so it grows faster than a price index; compare like with like for a fair read.");
}
