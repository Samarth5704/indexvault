// App chrome: collapsible rail, sticky top bar, mobile bottom sheets (DESIGN § 2).

import { dateRange, freqSelect } from "./components/date-range.js";
import { seriesPicker } from "./components/series-picker.js";
import { toastError } from "./components/toast.js";
import { h, icon, trapFocus } from "./dom.js";
import { hrefFor } from "./router.js";
import { ROUTES } from "./routes.js";
import { saveSection, settings, toggleMode } from "./settings.js";
import { store } from "./store.js";
import { shortcutLabel } from "./commands.js";

const app = () => document.querySelector(".app");
const mobile = window.matchMedia("(max-width: 767px)");

// --------------------------------------------------------------------------
// Rail
// --------------------------------------------------------------------------
function navLinks(onNavigate) {
  const links = ROUTES.map((r) => h("a.nav-link", { href: hrefFor(r.id), "data-page": r.id, title: r.label, onclick: onNavigate },
    icon(r.icon), h("span.nav-label", r.label)));
  const sync = () => {
    const { page } = store.get().route;
    links.forEach((a) => {
      a.href = hrefFor(a.dataset.page);
      if (a.dataset.page === page) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  };
  const unsubs = [store.subscribe((s) => s.route, sync), store.subscribe((s) => s.selection, sync)];
  sync();
  return { links, destroy: () => unsubs.forEach((u) => u()) };
}

export function mountRail(el) {
  const toggle = h("button.icon-btn.rail-toggle", { type: "button", onclick: toggleSidebar },
    icon("sidebar"), h("span.nav-label", "Collapse"));
  el.replaceChildren(
    h("div.rail-head", h("a.brand", { href: "#/dashboard", "aria-label": "IndexVault home" },
      h("span.brand-mark", icon("logo")), h("span.brand-name", "IndexVault"))),
    h("nav.rail-nav", { "aria-label": "Pages" }, navLinks().links),
    h("div.rail-foot", toggle));
  const sync = () => {
    const collapsed = settings()?.appearance.sidebar === "collapsed";
    app().dataset.rail = collapsed ? "collapsed" : "expanded";
    toggle.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.querySelector(".nav-label").textContent = collapsed ? "Expand" : "Collapse";
  };
  store.subscribe((s) => s.settings?.appearance.sidebar, sync);
  sync();
}

export function toggleSidebar() {
  if (mobile.matches) return openNavSheet();
  const next = settings().appearance.sidebar === "collapsed" ? "expanded" : "collapsed";
  saveSection("appearance", { sidebar: next }).catch((e) => toastError(e, "Couldn't save the sidebar state"));
}

// --------------------------------------------------------------------------
// Top bar
// --------------------------------------------------------------------------
export function mountTopbar(el, { openPalette }) {
  const picker = seriesPicker();
  const range = dateRange();
  const freq = freqSelect();
  const sourceBadge = h("button.source-badge", { type: "button", onclick: () => openPalette("Use ") });
  const themeBtn = h("button.icon-btn.theme-toggle", { type: "button", onclick: () => toggleMode().catch((e) => toastError(e)) });
  const searchBtn = h("button.btn.secondary.sm.search-btn", { type: "button", onclick: () => openPalette() },
    icon("search", { size: "sm" }), h("span.search-label", "Search"), h("kbd.kbd"));

  el.replaceChildren(
    h("button.icon-btn.menu-btn", { type: "button", "aria-label": "Open navigation", onclick: openNavSheet }, icon("menu")),
    h("a.brand.brand-mobile", { href: "#/dashboard", "aria-label": "IndexVault home" }, h("span.brand-mark", icon("logo"))),
    h("div.topbar-selection", picker.el, h("div.topbar-controls", range.el, freq.el)),
    h("button.btn.secondary.sm.selection-btn", { type: "button", onclick: openSelectionSheet }, icon("sliders", { size: "sm" }), h("span.selection-count")),
    h("div.topbar-end", searchBtn, sourceBadge, themeBtn));

  const sync = () => {
    const s = store.get();
    const src = s.health?.sources?.find((x) => x.name === s.settings?.data.source);
    sourceBadge.textContent = src ? src.label.replace(" (synthetic)", "") : s.settings?.data.source || "…";
    sourceBadge.dataset.tone = src?.name === "demo" ? "warning" : "neutral";
    sourceBadge.title = src?.name === "demo" ? "Synthetic demo data — not real prices. Click to switch." : "Data source. Click to switch.";
    sourceBadge.setAttribute("aria-label", `Data source: ${sourceBadge.textContent}. Switch source`);
    const dark = document.documentElement.dataset.scheme === "dark";
    themeBtn.replaceChildren(icon(dark ? "sun" : "moon"));
    themeBtn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    themeBtn.title = `${dark ? "Light" : "Dark"} mode (${shortcutLabel(s.settings?.shortcuts.toggle_theme)})`;
    searchBtn.querySelector(".kbd").textContent = shortcutLabel(s.settings?.shortcuts.palette);
    const n = s.selection.series.length;
    el.querySelector(".selection-count").textContent = `${n} series · ${s.selection.start ? "Custom" : s.selection.period}`;
  };
  store.subscribe((s) => s.settings, sync);
  store.subscribe((s) => s.health, sync);
  store.subscribe((s) => s.selection, sync);
  document.addEventListener("iv:themechange", sync);
  sync();
  return { openPicker: () => (mobile.matches ? openSelectionSheet() : picker.open()) };
}

// --------------------------------------------------------------------------
// Mobile bottom sheets
// --------------------------------------------------------------------------
export function openSheet(title, content, { onClose } = {}) {
  const root = document.getElementById("sheet-root");
  const closeBtn = h("button.icon-btn", { type: "button", "aria-label": "Close", onclick: () => close() }, icon("x"));
  const sheet = h("div.sheet", { role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div.sheet-grip", { "aria-hidden": "true" }),
    h("header.sheet-head", h("h2", title), closeBtn),
    h("div.sheet-body", content));
  const overlay = h("div.overlay.sheet-overlay", { onpointerdown: (e) => { if (e.target === overlay) close(); } }, sheet);
  const lastFocus = document.activeElement;
  const untrap = trapFocus(sheet);
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  root.append(overlay);
  closeBtn.focus();

  function close() {
    untrap();
    document.removeEventListener("keydown", onKey);
    overlay.remove();
    onClose?.();
    lastFocus?.focus?.();
  }
  return close;
}

function openNavSheet() {
  let close = () => {};
  const nav = navLinks(() => close());
  close = openSheet("Pages", h("nav.sheet-nav", { "aria-label": "Pages" }, nav.links), { onClose: nav.destroy });
}

function openSelectionSheet() {
  const picker = seriesPicker({ inSheet: true });
  const range = dateRange({ presets: ["1M", "6M", "YTD", "1Y", "3Y", "5Y", "10Y", "Max"] });
  const freq = freqSelect();
  openSheet("Selection", h("div.selection-sheet",
    h("section", h("h3.sheet-label", "Series"), picker.el),
    h("section", h("h3.sheet-label", "Date range"), range.el),
    h("label.field", h("span.sheet-label", "Frequency"), freq.el)),
  { onClose: () => [picker, range, freq].forEach((c) => c.destroy()) });
  picker.open();
}
