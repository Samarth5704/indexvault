// Series column ids (as served by GET /series?columns=) -> labels, kinds, formatters.
// Windowed ids carry their window in bars of the chosen frequency: sma_50, ema_20,
// rsi_14, vol_63. Returns / log returns / drawdown / vol are decimals; rsi is 0–100.

import { format } from "./settings.js";

export const BASE = {
  open: "Open", high: "High", low: "Low", close: "Close", adj_close: "Adj Close", volume: "Volume",
  ntr: "NTR (net total return)",
};
export const SIMPLE = {
  return: "Return", log_return: "Log return", drawdown: "Drawdown", rebased: "Rebased (100)",
};
export const WINDOWED = { sma: "SMA", ema: "EMA", rsi: "RSI", vol: "Volatility" };
export const DEFAULT_COLUMNS = ["open", "high", "low", "close", "adj_close", "volume", "return"];
/** Total return series are close-only: gross TRI close, net total return, return. */
export const TRI_COLUMNS = ["close", "ntr", "return"];

const WINDOWED_RE = /^(sma|ema|rsi|vol)_(\d{1,4})$/;

export function parseColumn(id) {
  const m = WINDOWED_RE.exec(id);
  return m ? { kind: m[1], window: Number(m[2]) } : { kind: id, window: null };
}

export function isValidColumn(id) {
  if (id in BASE || id in SIMPLE) return true;
  const { kind, window } = parseColumn(id);
  return kind in WINDOWED && window >= 2 && window <= 1000;
}

export function columnLabel(id) {
  if (id === "date") return "Date";
  if (id in BASE) return BASE[id];
  if (id in SIMPLE) return SIMPLE[id];
  const { kind, window } = parseColumn(id);
  return kind in WINDOWED ? `${WINDOWED[kind]} ${window}` : id;
}

/** "pct" | "price" | "count" | "index" | "date" — drives formatting and alignment. */
export function columnKind(id) {
  if (id === "date") return "date";
  if (id === "volume") return "count";
  const { kind } = parseColumn(id);
  if (["return", "log_return", "drawdown", "vol"].includes(kind)) return "pct";
  if (kind === "rsi") return "index";
  return "price";
}

export function formatCell(id, v) {
  switch (columnKind(id)) {
    case "date": return format.date(v);
    case "pct": return format.pct(v);
    case "count": return format.number(v, { decimals: 0 });
    case "index": return format.number(v, { decimals: 1 });
    default: return format.number(v);
  }
}

/** Default window for a new windowed column, from settings (rule 2: no magic numbers). */
export function defaultWindow(kind, s) {
  const a = s.analytics;
  return { sma: a.sma_windows[0], ema: a.ema_windows[0] ?? a.sma_windows[0], rsi: a.rsi_window, vol: a.rolling_vol_window }[kind] ?? a.rsi_window;
}

/** Columns from a URL param, dropping invalid/duplicate ids; null when absent. */
export function columnsFromParam(raw) {
  if (!raw) return null;
  const cols = [...new Set(raw.split(",").map((c) => c.trim().toLowerCase()))].filter(isValidColumn);
  return cols.length ? cols : null;
}
