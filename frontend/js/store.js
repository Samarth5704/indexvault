// Tiny observable store + the shared selection (series, range, frequency).
// The selection lives in the URL hash so every view is linkable:
//   #/analyse?s=^NSEI,^NSEBANK&p=10Y&f=M          (preset period)
//   #/analyse?s=^NSEI&from=2015-01-01&to=2020-12-31 (custom range)

export const PERIODS = ["1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "10Y", "15Y", "20Y", "Max"];
export const FREQS = { D: "Daily", W: "Weekly", M: "Monthly", Q: "Quarterly", Y: "Yearly" };
const FREQ_CODE = Object.fromEntries(Object.entries(FREQS).map(([k, v]) => [v, k]));
export const MAX_SERIES = 20;
export const SERIES_COLOURS = 8; // slots 9+ fold into grey (DESIGN § 7)

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    /** Shallow-merge a patch (or the result of fn(state)) into the state. */
    set(patch) {
      const next = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...next };
      for (const s of subs) s();
    },
    /** Call fn(value, prev) whenever select(state) changes (compared with Object.is). */
    subscribe(select, fn) {
      let prev = select(state);
      const sub = () => {
        const value = select(state);
        if (!Object.is(value, prev)) {
          const old = prev;
          prev = value;
          fn(value, old);
        }
      };
      subs.add(sub);
      return () => subs.delete(sub);
    },
  };
}

export const store = createStore({
  route: { page: "dashboard", params: {} },
  selection: { series: [], period: "10Y", start: null, end: null, freq: "Daily" },
  settings: null,
  catalog: { categories: [], watchlists: [] },
  health: null,
});

// --------------------------------------------------------------------------
// Selection helpers
// --------------------------------------------------------------------------
export const selection = () => store.get().selection;

export function setSelection(patch) {
  store.set((s) => ({ selection: { ...s.selection, ...patch } }));
}

export function addSeries(ticker) {
  const { series } = selection();
  if (series.includes(ticker) || series.length >= MAX_SERIES) return false;
  setSelection({ series: [...series, ticker] });
  rememberRecent(ticker);
  return true;
}

export function removeSeries(ticker) {
  setSelection({ series: selection().series.filter((t) => t !== ticker) });
}

/** CSS colour for a series by its selection order (stable slot, never cycled). */
export function seriesColour(ticker) {
  const i = selection().series.indexOf(ticker);
  return i >= 0 && i < SERIES_COLOURS ? `var(--series-${i + 1})` : "var(--series-other)";
}

/** API range params for the current selection: {start,end} or {period}. */
export function rangeParams(sel = selection()) {
  return sel.start ? { start: sel.start, end: sel.end || undefined } : { period: sel.period };
}

// --------------------------------------------------------------------------
// URL <-> selection
// --------------------------------------------------------------------------
export function selectionFromQuery(params, fallback) {
  const out = { ...fallback };
  if (params.has("s")) out.series = params.get("s").split(",").map((t) => t.trim()).filter(Boolean).slice(0, MAX_SERIES);
  if (params.has("from")) {
    out.start = params.get("from");
    out.end = params.get("to") || null;
  } else if (params.has("p") && PERIODS.includes(params.get("p"))) {
    out.period = params.get("p");
    out.start = out.end = null;
  }
  if (params.has("f") && FREQS[params.get("f")]) out.freq = FREQS[params.get("f")];
  return out;
}

export function selectionToQuery(sel) {
  const q = new URLSearchParams();
  if (sel.series.length) q.set("s", sel.series.join(","));
  if (sel.start) {
    q.set("from", sel.start);
    if (sel.end) q.set("to", sel.end);
  } else {
    q.set("p", sel.period);
  }
  q.set("f", FREQ_CODE[sel.freq] || "D");
  // keep ^ and , readable in the address bar
  return q.toString().replaceAll("%5E", "^").replaceAll("%2C", ",");
}

// --------------------------------------------------------------------------
// Recent picks (per-browser convenience only; safe if storage is unavailable)
// --------------------------------------------------------------------------
const RECENT_KEY = "iv.recentSeries";

export function recentSeries() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
}

function rememberRecent(ticker) {
  try {
    const next = [ticker, ...recentSeries().filter((t) => t !== ticker)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* storage blocked: recents just aren't remembered */ }
}
