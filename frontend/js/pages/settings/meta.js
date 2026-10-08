// Friendlier labels and widget choices layered over the settings JSON schema.
// Anything not listed here still renders from the schema (title + description),
// so a new setting shows up in the UI without touching this file.

import { catalogIndex } from "../../components/series-picker.js";
import { settings } from "../../settings.js";
import { PERIODS, store } from "../../store.js";

const opts = (pairs) => pairs.map(([value, label]) => ({ value, label }));
const pct = (v) => `${+(v * 100).toFixed(1)}%`;

export const ACCENTS = ["#5b8cff", "#2a78d6", "#7c5cff", "#d55181", "#d9630a", "#ffb000", "#1baf7a", "#0f9bb3"];

/** Field overrides per section key: {label, hint, widget, options, suffix, …}. Functions are evaluated at render. */
export const FIELD_META = {
  appearance: {
    theme: { hidden: true }, // the theme picker cards replace this field
    mode: { label: "Mode", hint: "System follows your computer's light/dark setting.", options: opts([["light", "Light"], ["dark", "Dark"], ["system", "System"]]) },
    accent: () => ({ label: "Accent colour", hint: "Buttons, links, focus rings and selections. Overrides the theme's own accent.", swatches: ACCENTS, nullLabel: "Theme default",
      fallback: () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() }),
    chart_palette: () => ({ label: "Chart palette", widget: "select", hint: "Series colours in charts. Build your own in the theme editor below.",
      options: [{ value: "default", label: "Default (validated)" }, ...Object.keys(settings().custom_palettes).map((n) => ({ value: n, label: n }))] }),
    font_scale: { label: "Font size", widget: "range", step: 0.025, format: pct,
      onPreview: (v) => document.documentElement.style.setProperty("--font-scale", v) },
    density: { options: opts([["comfortable", "Comfortable"], ["compact", "Compact"]]) },
    radius: { label: "Corner radius", options: opts([["none", "None"], ["sm", "Small"], ["md", "Medium"], ["lg", "Large"]]) },
    motion: { options: opts([["full", "Full"], ["reduced", "Reduced"], ["off", "Off"]]) },
    sidebar: { label: "Sidebar on load", options: opts([["expanded", "Expanded"], ["collapsed", "Collapsed"]]) },
    gain_loss: { label: "Gain / loss colours", options: opts([["market", "Market (green / red)"], ["colorblind", "Colour-blind safe (blue / red)"]]) },
    market_pulse: { label: "Market pulse strip" },
  },
  formats: {
    number_system: { label: "Number system", options: opts([["indian", "Indian · 12,34,567"], ["international", "International · 1,234,567"]]) },
    decimals: { suffix: "places" },
    date_format: () => {
      const [y, m, d] = new Date().toISOString().slice(0, 10).split("-");
      const mon = new Date().toLocaleString("en-GB", { month: "short" });
      return { label: "Date format", hint: "Shown as today's date.", options: opts([["DD-MM-YYYY", `${d}-${m}-${y}`], ["YYYY-MM-DD", `${y}-${m}-${d}`], ["DD MMM YYYY", `${d} ${mon} ${y}`]]) };
    },
    currency: { label: "Currency symbol", widget: "text" },
  },
  data: {
    source: () => ({ label: "Default source", widget: "select",
      options: (store.get().health?.sources || []).map((s) => ({ value: s.name, label: s.label })) }),
    cache_dir: { label: "Cache folder", mono: true },
    auto_update_on_open: { label: "Update cache when the app opens" },
    stale_after_hours: { label: "Refresh after", suffix: "hours" },
    request_throttle_seconds: { label: "Pause between downloads", suffix: "seconds", step: 0.1 },
    default_period: { widget: "select", options: opts(PERIODS.map((p) => [p, p])) },
    default_series: () => ({ label: "Default series", options: [...catalogIndex().values()].map((i) => ({ value: i.ticker, label: i.name })), ordered: true }),
  },
  analytics: {
    risk_free_rate: { label: "Risk-free rate" },
    trading_days: { label: "Trading days per year", suffix: "days" },
    sma_windows: { label: "SMA windows", placeholder: "e.g. 100", sortNumeric: true, itemLabel: (v) => `${v}d` },
    ema_windows: { label: "EMA windows", placeholder: "e.g. 21", sortNumeric: true, itemLabel: (v) => `${v}d` },
    rolling_windows_years: { label: "Rolling-return windows", placeholder: "years", sortNumeric: true, itemLabel: (v) => `${v}Y` },
    rolling_vol_window: { label: "Rolling volatility window", suffix: "days" },
    rsi_window: { label: "RSI window", suffix: "bars" },
    correlation_frequency: { options: opts([["D", "Daily"], ["W", "Weekly"], ["M", "Monthly"]]) },
    rolling_corr_window: { label: "Rolling correlation window", suffix: "periods" },
    big_move_threshold: { label: "Big-move threshold" },
    seasonality_min_years: { label: "Seasonality minimum history", suffix: "years" },
    quality_gap_days: { label: "Data gap", suffix: "days" },
    drawdown_table_size: { label: "Worst-drawdowns table", suffix: "rows" },
    histogram_bins: { label: "Histogram bins", suffix: "bins" },
    trailing_periods: { label: "Trailing-return periods", free: true, ordered: true, placeholder: "e.g. 2Y", normalise: (v) => v.toUpperCase().replace("MAX", "Max") },
    target_cagr: { label: "Target CAGR" },
    kpi_cards: { label: "KPI cards (Analyse)" },
    compare_metrics: { label: "Compare table metrics" },
  },
  sip: {
    amount: () => ({ label: "Monthly amount", suffix: settings().formats.currency, step: 500 }),
    day: { label: "Investment day", suffix: "of month" },
    step_up: { label: "Annual step-up" },
    sensitivity_min_months: { label: "Shortest SIP in sensitivity strip", suffix: "months" },
  },
  export: {
    default_format: { options: opts([["xlsx", "Excel"], ["csv", "CSV"], ["zip", "CSV zip"], ["json", "JSON"]]) },
    presets: { hidden: true }, // managed in the presets list below the fields
    metadata_sheet: { label: "Metadata sheet in Excel" },
    excel_header_colour: { label: "Excel header colour" },
    excel_freeze_panes: { label: "Freeze header row & date column" },
  },
};

export function fieldMeta(section, key) {
  const m = FIELD_META[section]?.[key];
  return typeof m === "function" ? m() : m || {};
}

/** Section key -> $defs name in the schema. */
export const SECTION_DEFS = { appearance: "Appearance", formats: "Formats", data: "DataSettings", analytics: "Analytics", sip: "Sip", export: "Export" };
