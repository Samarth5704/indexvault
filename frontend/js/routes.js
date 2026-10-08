// Every page in the left rail (SPEC § 3). `load` imports the page module lazily.
// A page module default-exports { mount(el, ctx) -> cleanup? }.

export const ROUTES = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard", milestone: 8,
    blurb: "Your customisable home: market snapshot, heatmaps, VIX and drawdown monitors.",
    load: () => import("./pages/dashboard.js") },
  { id: "data", label: "Data Studio", icon: "table", milestone: 3,
    blurb: "Browse OHLCV tables, build derived columns and export to Excel, CSV or JSON.",
    load: () => import("./pages/data-studio.js") },
  { id: "analyse", label: "Analyse", icon: "chart", milestone: 4,
    blurb: "Deep-dive one series: KPIs, price chart, drawdowns, monthly returns and more.",
    load: () => import("./pages/analyse.js") },
  { id: "compare", label: "Compare", icon: "compare", milestone: 5,
    blurb: "Growth of 100, side-by-side metrics, correlation and relative strength.",
    load: () => import("./pages/compare.js") },
  { id: "rolling", label: "Rolling", icon: "rolling", milestone: 5,
    blurb: "Rolling CAGR across holding periods, with hit rates against your target.",
    load: () => import("./pages/rolling.js") },
  { id: "sip", label: "SIP Lab", icon: "sip", milestone: 6,
    blurb: "Backtest monthly SIPs with step-ups and top-ups, and compare scenarios.",
    load: () => import("./pages/sip.js") },
  { id: "seasonality", label: "Seasonality", icon: "calendar", milestone: 6,
    blurb: "Month-of-year and day-of-week patterns (with a healthy dose of caution).",
    load: () => import("./pages/seasonality.js") },
  { id: "health", label: "Data Health", icon: "health", milestone: 6,
    blurb: "Gaps, stale runs, OHLC inconsistencies and big moves for each series.",
    load: () => import("./pages/health.js") },
  { id: "cache", label: "Cache", icon: "database", milestone: 6,
    blurb: "What's downloaded, how fresh it is, and ticker health checks.",
    load: () => import("./pages/cache.js") },
  { id: "settings", label: "Settings", icon: "settings", milestone: 7,
    blurb: "Themes, formats, data defaults, analytics parameters, shortcuts and backup.",
    load: () => import("./pages/settings.js") },
];

export const ROUTE_BY_ID = Object.fromEntries(ROUTES.map((r) => [r.id, r]));

export function loadPage(id) {
  const route = ROUTE_BY_ID[id];
  return route.load ? route.load() : import("./pages/placeholder.js");
}
