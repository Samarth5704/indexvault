// Settings: load, apply to <html> (live, no reload), save; plus value formatters.
//
// Theme + mode: each built-in theme has a counterpart in the other scheme
// (Midnight <-> Paper, Terminal <-> Saffron). `appearance.theme` picks the family
// member you chose; `appearance.mode` (light/dark/system) swaps to its counterpart
// when the schemes differ. Custom themes inherit their base theme's scheme.

import { api } from "./api.js";
import { store } from "./store.js";

export const THEMES = {
  midnight: { label: "Midnight", scheme: "dark", pair: "paper" },
  paper: { label: "Paper", scheme: "light", pair: "midnight" },
  terminal: { label: "Terminal", scheme: "dark", pair: "saffron" },
  saffron: { label: "Saffron", scheme: "light", pair: "terminal" },
};

const root = document.documentElement;
const osDark = window.matchMedia("(prefers-color-scheme: dark)");
let appliedTokens = [];

export const settings = () => store.get().settings;

export async function loadSettings() {
  const s = await api.get("/settings", null, { fresh: true });
  store.set({ settings: s });
  applySettings(s);
  return s;
}

/** Resolve which built-in theme to show and any custom token overrides. */
export function resolveTheme(appearance, custom = {}) {
  const customTheme = custom[appearance.theme];
  let name = customTheme ? customTheme.base : appearance.theme in THEMES ? appearance.theme : "midnight";
  const wanted = appearance.mode === "system" ? (osDark.matches ? "dark" : "light") : appearance.mode;
  const swapped = THEMES[name].scheme !== wanted;
  if (swapped) name = THEMES[name].pair;
  return { name, scheme: THEMES[name].scheme, tokens: customTheme && !swapped ? customTheme.tokens : {} };
}

export function applySettings(s) {
  const a = s.appearance;
  const theme = resolveTheme(a, s.custom_themes);
  Object.assign(root.dataset, {
    theme: theme.name, scheme: theme.scheme, density: a.density, radius: a.radius,
    motion: a.motion, gainloss: a.gain_loss,
  });
  root.style.setProperty("--font-scale", a.font_scale);

  for (const t of appliedTokens) root.style.removeProperty(t);
  const tokens = { ...theme.tokens };
  if (a.accent) tokens["--accent"] = a.accent;
  const palette = s.custom_palettes?.[a.chart_palette];
  palette?.forEach((c, i) => { tokens[`--series-${i + 1}`] = c; });
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
  appliedTokens = Object.keys(tokens);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue("--bg").trim();
  document.dispatchEvent(new CustomEvent("iv:themechange", { detail: theme }));
}

osDark.addEventListener("change", () => {
  const s = settings();
  if (s?.appearance.mode === "system") applySettings(s);
});

/**
 * Save part of a section. Appearance changes apply instantly (optimistic) and
 * roll back if the server rejects them. Returns the saved settings.
 */
export async function saveSection(section, patch) {
  const before = settings();
  const optimistic = { ...before, [section]: { ...before[section], ...patch } };
  store.set({ settings: optimistic });
  applySettings(optimistic);
  try {
    const saved = await api.patch(`/settings/${section}`, patch);
    store.set({ settings: saved });
    applySettings(saved);
    api.invalidate("/analytics");
    api.invalidate("/series");
    return saved;
  } catch (e) {
    store.set({ settings: before });
    applySettings(before);
    throw e;
  }
}

/** Flip light/dark (from "system", flip whatever is showing now). */
export function toggleMode() {
  const shown = root.dataset.scheme;
  return saveSection("appearance", { mode: shown === "dark" ? "light" : "dark" });
}

// --------------------------------------------------------------------------
// Formatters — all read the user's formats settings. Inputs: percentages are
// decimals (0.1234 -> "12.34%"); null/undefined/NaN -> "—".
// --------------------------------------------------------------------------
const DASH = "—";
const MINUS = "−";
const nfCache = new Map();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formats() {
  return settings()?.formats || { number_system: "indian", decimals: 2, date_format: "DD-MM-YYYY", currency: "₹" };
}

function nf(decimals, system) {
  const key = `${decimals}|${system}`;
  if (!nfCache.has(key)) {
    nfCache.set(key, new Intl.NumberFormat(system === "indian" ? "en-IN" : "en-US", {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    }));
  }
  return nfCache.get(key);
}

const missing = (v) => v == null || (typeof v === "number" && !Number.isFinite(v));

export const format = {
  /** 12,34,567.89 (Indian) or 1,234,567.89; negatives use a true minus sign. */
  number(v, { decimals = formats().decimals, sign = false } = {}) {
    if (missing(v)) return DASH;
    const text = nf(decimals, formats().number_system).format(Math.abs(v));
    const isZero = Number(text.replace(/[^0-9]/g, "")) === 0;
    if (v < 0 && !isZero) return MINUS + text;
    return sign && v > 0 && !isZero ? `+${text}` : text;
  },

  /** Decimal -> percent: 0.1234 -> "12.34%" (sign: "+12.34%"). */
  pct(v, { decimals = formats().decimals, sign = false } = {}) {
    return missing(v) ? DASH : `${format.number(v * 100, { decimals, sign })}%`;
  },

  /** Money with the user's currency. compact: ₹12.3 L / ₹1.23 Cr (Indian) or ₹1.2M. */
  money(v, { compact = false, decimals } = {}) {
    if (missing(v)) return DASH;
    const { currency, number_system } = formats();
    const neg = v < 0 ? MINUS : "";
    const a = Math.abs(v);
    if (compact && number_system === "indian" && a >= 1e5) {
      const [div, unit] = a >= 1e7 ? [1e7, "Cr"] : [1e5, "L"];
      return `${neg}${currency}${format.number(a / div, { decimals: decimals ?? 2 })} ${unit}`;
    }
    if (compact && a >= 1e3) {
      const text = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: decimals ?? 1 }).format(a);
      return `${neg}${currency}${text}`;
    }
    return `${neg}${currency}${format.number(a, { decimals: decimals ?? 0 })}`;
  },

  /** ISO "YYYY-MM-DD" -> user's date format. */
  date(iso) {
    if (!iso) return DASH;
    const [y, m, d] = String(iso).slice(0, 10).split("-");
    switch (formats().date_format) {
      case "YYYY-MM-DD": return `${y}-${m}-${d}`;
      case "DD MMM YYYY": return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
      default: return `${d}-${m}-${y}`;
    }
  },

  /** Change with arrow + sign so colour is never the only signal. */
  delta(v, { decimals = formats().decimals } = {}) {
    if (missing(v)) return { text: DASH, tone: "flat", arrow: "" };
    const tone = v > 0 ? "gain" : v < 0 ? "loss" : "flat";
    const arrow = tone === "gain" ? "▲" : tone === "loss" ? "▼" : "■";
    return { text: format.pct(v, { decimals, sign: true }), tone, arrow };
  },

  /** Format a metric by its kind (from /analytics/summary `metrics`). */
  metric(v, kind) {
    switch (kind) {
      case "pct": return format.pct(v);
      case "ratio": return format.number(v, { decimals: 2 });
      case "years": return format.number(v, { decimals: 1 });
      case "date": return format.date(v);
      default: return format.number(v);
    }
  },
};
