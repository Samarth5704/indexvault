// Shared helpers for dashboard widgets: loading states and ticker groups.

import { errorState, emptyState, skeleton } from "../../components/feedback.js";
import { store } from "../../store.js";

/**
 * Load-and-render with the standard states (CLAUDE.md rule 5). Re-entrant: a newer
 * call wins, and nothing renders after the widget is destroyed (`alive()` false).
 */
export async function loadInto(body, { load, render, isEmpty = () => false, empty, sk = { lines: 3 }, alive = () => true }) {
  body.replaceChildren(skeleton(sk));
  body.setAttribute("aria-busy", "true");
  const token = (body.dataset.token = String(Number(body.dataset.token || 0) + 1));
  try {
    const data = await load();
    if (!alive() || body.dataset.token !== token) return;
    body.replaceChildren(isEmpty(data) ? emptyState(empty) : render(data));
  } catch (e) {
    if (!alive() || body.dataset.token !== token) return;
    body.replaceChildren(errorState(e, { onRetry: () => loadInto(body, { load, render, isEmpty, empty, sk, alive }) }));
  } finally {
    body.removeAttribute("aria-busy");
  }
}

/** Ticker groups a widget can follow: catalogue categories and watchlists. */
export function groupOptions() {
  const { categories, watchlists } = store.get().catalog;
  return [
    ...watchlists.map((w) => ({ value: `wl:${w.id}`, label: `Watchlist: ${w.name}` })),
    ...categories.map((c) => ({ value: `cat:${c.name}`, label: c.name })),
  ];
}

export function groupTickers(group) {
  const { categories, watchlists } = store.get().catalog;
  const [kind, id] = String(group || "").split(/:(.*)/s);
  const list = kind === "wl" ? watchlists.find((w) => w.id === id)?.tickers
    : categories.find((c) => c.name === id)?.items.map((i) => i.ticker);
  return (list || []).slice(0, 20); // API limit per call
}

export const groupLabel = (group) => groupOptions().find((o) => o.value === group)?.label.replace(/^Watchlist: /, "") || "Group";

/** {dates, values} -> Lightweight Charts points (nulls dropped). */
export const points = (dates, values) => dates.map((d, i) => ({ time: d, value: values[i] })).filter((p) => p.value != null);
