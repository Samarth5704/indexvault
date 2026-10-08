// Series legend: dot in the series' stable slot colour + name + optional value.
// DESIGN § 7: light-theme charts must keep a legend (some slot colours are low contrast).

import { h } from "../dom.js";
import { SERIES_COLOURS, seriesColour } from "../store.js";
import { seriesName } from "./series-picker.js";

/** seriesLegend(tickers, {value: (ticker) => string, label: "Series"}) */
export function seriesLegend(tickers, { value = null, label = "Legend" } = {}) {
  return h("ul.legend", { "aria-label": label }, tickers.map((t) => h("li",
    h("span.chip-dot", { style: { background: seriesColour(t) }, "aria-hidden": "true" }),
    seriesName(t),
    value && h("span.mono.muted", value(t)))));
}

/** DESIGN § 7: series 9+ fold into grey and the UI suggests using fewer. Null when ≤ 8. */
export function tooManySeriesNote(count) {
  if (count <= SERIES_COLOURS) return null;
  return h("p.series-note", { role: "note" },
    `${count} series selected: only ${SERIES_COLOURS} get their own colour, the rest are grey. Charts read better with fewer series.`);
}
