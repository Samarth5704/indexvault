// One tab per selected series (dot in its slot colour); arrow keys move between tabs.
// Used by single-series pages (Data Studio, Analyse). The active ticker lives in the
// page param `t`, so a link opens the same tab.

import { h } from "../dom.js";
import { setPageParams } from "../router.js";
import { selection, seriesColour, store } from "../store.js";
import { seriesName } from "./series-picker.js";

/** The active ticker: page param `t` if still selected, else the first selected series. */
export function activeTicker() {
  const { series } = selection();
  const t = store.get().route.params.t;
  return series.includes(t) ? t : series[0];
}

export function seriesTabs() {
  const el = h("div.series-tabs", { role: "tablist", "aria-label": "Series" });

  function render() {
    const cur = activeTicker();
    el.replaceChildren(...selection().series.map((t) => h("button.series-tab", {
      type: "button", role: "tab", "aria-selected": String(t === cur), tabindex: t === cur ? "0" : "-1",
      onclick: () => setPageParams({ ...store.get().route.params, t }),
    }, h("span.chip-dot", { style: { background: seriesColour(t) }, "aria-hidden": "true" }), seriesName(t))));
  }

  el.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const list = [...el.children];
    const i = list.indexOf(document.activeElement);
    const next = list[(i + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length];
    next?.focus();
    next?.click();
    e.preventDefault();
  });

  return { el, render };
}
