// Bootstrap: load settings/catalogue/health, draw the shell, start the router,
// mount pages on navigation.

import { api } from "./api.js";
import { bindShortcuts, commandProvider } from "./commands.js";
import { createPalette } from "./components/command-palette.js";
import { errorState } from "./components/feedback.js";
import { runJobWithToast, toast } from "./components/toast.js";
import { h } from "./dom.js";
import { mountPulse } from "./pulse.js";
import { startRouter } from "./router.js";
import { loadPage, ROUTE_BY_ID } from "./routes.js";
import { loadSettings, toggleMode } from "./settings.js";
import { mountRail, mountTopbar, toggleSidebar } from "./shell.js";
import { store } from "./store.js";

const view = document.getElementById("view");
let current = { key: null, cleanup: null };
let navToken = 0;

// Pages remount only when the page changes; param changes (e.g. #/data?cols=…)
// reach the mounted page through store.subscribe((s) => s.route.params, …).
async function showPage(route, ctx, { focus }) {
  const key = route.page;
  if (key === current.key) return;
  current.key = key;
  const mine = ++navToken;
  const meta = ROUTE_BY_ID[route.page];
  document.title = `${meta.label} · IndexVault`;
  let mod;
  try {
    mod = await loadPage(route.page);
  } catch (e) {
    view.replaceChildren(errorState(e, { onRetry: () => location.reload() }));
    return;
  }
  if (mine !== navToken) return; // user navigated again while loading
  current.cleanup?.();
  const page = h("div.page.page-enter", { "data-page": route.page });
  view.replaceChildren(page);
  current.cleanup = mod.default.mount(page, { ...ctx, route }) || null;
  if (focus) {
    window.scrollTo(0, 0); // a new page starts at the top
    view.focus({ preventScroll: true });
  }
}

function seedSelection(settings) {
  const d = settings.data;
  store.set({ selection: { series: d.default_series, period: d.default_period, start: null, end: null, freq: d.default_frequency } });
}

async function maybeAutoUpdate(settings) {
  if (!settings.data.auto_update_on_open) return;
  try {
    if (sessionStorage.getItem("iv.autoUpdated")) return;
    sessionStorage.setItem("iv.autoUpdated", "1");
  } catch { /* storage blocked: update every load */ }
  const { entries } = await api.get("/cache", null, { fresh: true });
  if (!entries.some((e) => e.source === settings.data.source)) return;
  runJobWithToast(() => api.post("/cache/update", {}), { title: "Updating cached data", doneTitle: "Data up to date" })
    .then(() => api.invalidate("/series"))
    .catch(() => {});
}

async function boot() {
  let settings;
  try {
    const [s, catalog, health] = await Promise.all([loadSettings(), api.get("/catalog"), api.get("/health")]);
    settings = s;
    store.set({ catalog, health });
  } catch (e) {
    view.replaceChildren(h("div.page", errorState(e, { onRetry: () => location.reload() })));
    return;
  }
  seedSelection(settings);

  let topbar;
  const palette = createPalette(commandProvider({
    toggleSidebar,
    openPicker: () => topbar.openPicker(),
  }));
  const ctx = { openPalette: palette.open, openPicker: () => topbar.openPicker() };
  mountRail(document.getElementById("rail"));
  topbar = mountTopbar(document.getElementById("topbar"), { openPalette: palette.open });
  mountPulse(document.getElementById("pulse"));
  bindShortcuts({
    palette: palette.toggle,
    toggle_theme: () => toggleMode().catch(() => {}),
    toggle_sidebar: toggleSidebar,
    focus_series_picker: ctx.openPicker,
  });

  let first = true;
  store.subscribe((s) => s.route, (route) => showPage(route, ctx, { focus: !first }));
  startRouter();
  showPage(store.get().route, ctx, { focus: false });
  first = false;

  for (const w of store.get().health.warnings) toast({ tone: "warning", title: "Settings notice", message: w, duration: 0 });
  maybeAutoUpdate(settings);
  document.documentElement.dataset.ready = "true";
}

boot();
