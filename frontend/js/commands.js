// Everything the command palette can do, plus global keyboard shortcuts
// (bindings come from settings.shortcuts; "mod" = Ctrl, or ⌘ on a Mac).

import { api } from "./api.js";
import { copyText } from "./clipboard.js";
import { catalogIndex } from "./components/series-picker.js";
import { runJobWithToast, toast, toastError } from "./components/toast.js";
import { navigate } from "./router.js";
import { ROUTES } from "./routes.js";
import { saveSection, settings, THEMES, toggleMode } from "./settings.js";
import { addSeries, removeSeries, selection, store } from "./store.js";

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const SETTINGS_SECTIONS = [["appearance", "Appearance"], ["theme", "Theme editor"], ["formats", "Formats"],
  ["data", "Data"], ["catalogue", "Catalogue & watchlists"], ["analytics", "Analytics"], ["sip", "SIP defaults"],
  ["export", "Export"], ["shortcuts", "Shortcuts"], ["backup", "Backup"]];

/** "mod+shift+l" -> "Ctrl Shift L" / "⌘⇧L" for display. */
export function shortcutLabel(combo) {
  if (!combo) return "";
  return combo.split(" ").map((chord) => chord.split("+").map((k) => {
    if (k === "mod") return IS_MAC ? "⌘" : "Ctrl";
    if (k === "shift") return IS_MAC ? "⇧" : "Shift";
    if (k === "alt") return IS_MAC ? "⌥" : "Alt";
    if (k === "ctrl") return IS_MAC ? "⌃" : "Ctrl";
    return k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1);
  }).join(IS_MAC ? "" : " ")).join(" then ");
}

const hint = (action) => shortcutLabel(settings()?.shortcuts?.[action]);

async function setSetting(section, patch, label) {
  try {
    await saveSection(section, patch);
  } catch (e) {
    toastError(e, `Couldn't change ${label}`);
  }
}

/** Build the current command list. `ui` exposes shell actions (sidebar, picker). */
export function commandProvider(ui) {
  return () => {
    const s = settings();
    const sel = selection();
    const cmds = [];
    for (const r of ROUTES) {
      cmds.push({ id: `go:${r.id}`, group: "Pages", label: `Go to ${r.label}`, icon: r.icon, keywords: [r.label], run: () => navigate(r.id) });
    }
    cmds.push(
      { id: "theme:toggle", group: "Actions", label: "Toggle light / dark", icon: "moon", hint: hint("toggle_theme"), keywords: ["theme", "mode"], run: () => toggleMode().catch((e) => toastError(e)) },
      { id: "sidebar", group: "Actions", label: "Toggle sidebar", icon: "sidebar", hint: hint("toggle_sidebar"), run: ui.toggleSidebar },
      { id: "series:focus", group: "Actions", label: "Add series…", icon: "plus", hint: hint("focus_series_picker"), run: ui.openPicker },
      { id: "cache:update", group: "Actions", label: "Update cache", icon: "refresh", keywords: ["download", "refresh", "fetch"],
        run: () => runJobWithToast(() => api.post("/cache/update", {}), { title: "Updating cache", doneTitle: "Cache updated" })
          .then(() => api.invalidate()).catch(() => {}) },
      { id: "export", group: "Actions", label: "Export current view", icon: "download", keywords: ["excel", "csv", "download"],
        run: () => navigate("data", { ...(store.get().route.page === "data" ? store.get().route.params : {}), export: "1" }) },
      { id: "link", group: "Actions", label: "Copy link to this view", icon: "link",
        run: () => copyText(location.href, { title: "Copy link" }).then((how) => { if (how === "copied") toast({ tone: "success", title: "Link copied" }); }) },
    );
    for (const src of store.get().health?.sources || []) {
      if (src.name === s.data.source || src.name === "csv") continue;
      cmds.push({ id: `source:${src.name}`, group: "Actions", label: `Use ${src.label} data`, icon: "database", keywords: ["source"],
        run: () => setSetting("data", { source: src.name }, "the data source").then(() => api.invalidate()) });
    }
    for (const [id, t] of Object.entries(THEMES)) {
      cmds.push({ id: `theme:${id}`, group: "Appearance", label: `Theme: ${t.label} (${t.scheme})`, icon: t.scheme === "dark" ? "moon" : "sun",
        keywords: ["theme", id], run: () => setSetting("appearance", { theme: id, mode: t.scheme }, "the theme") });
    }
    const other = s.appearance.density === "compact" ? "comfortable" : "compact";
    cmds.push({ id: "density", group: "Appearance", label: `Density: ${other}`, icon: "rows", keywords: ["density", "compact"],
      run: () => setSetting("appearance", { density: other }, "density") });
    for (const m of ["full", "reduced", "off"].filter((m) => m !== s.appearance.motion)) {
      cmds.push({ id: `motion:${m}`, group: "Appearance", label: `Motion: ${m}`, icon: "sparkle", keywords: ["animation", "motion"],
        run: () => setSetting("appearance", { motion: m }, "motion") });
    }
    for (const [id, label] of SETTINGS_SECTIONS) {
      cmds.push({ id: `settings:${id}`, group: "Settings", label: `Settings: ${label}`, icon: "settings", run: () => navigate("settings", { section: id }) });
    }
    for (const item of catalogIndex().values()) {
      const on = sel.series.includes(item.ticker);
      cmds.push({ id: `series:${item.ticker}`, group: "Series", label: `${on ? "Remove" : "Add"} ${item.name}`,
        icon: on ? "minus" : "plus", keywords: [item.ticker, item.category], searchOnly: !on,
        run: () => (on ? removeSeries(item.ticker) : addSeries(item.ticker)) });
    }
    return cmds;
  };
}

// --------------------------------------------------------------------------
// Global shortcuts
// --------------------------------------------------------------------------
function chordMatches(chord, e) {
  const parts = chord.split("+");
  const key = parts.pop();
  const want = new Set(parts.map((p) => (p === "mod" ? (IS_MAC ? "meta" : "ctrl") : p)));
  const has = { ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey };
  if (Object.entries(has).some(([m, down]) => down !== want.has(m))) return false;
  return e.key.toLowerCase() === key || e.code === `Key${key.toUpperCase()}`;
}

const isTyping = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/** handlers: {actionName: fn}. Two-key sequences ("g d") must be typed within 1 s. */
export function bindShortcuts(handlers) {
  let pending = null, timer;
  document.addEventListener("keydown", (e) => {
    const bindings = settings()?.shortcuts || {};
    for (const [action, combo] of Object.entries(bindings)) {
      const fn = handlers[action];
      if (!fn) continue;
      const chords = combo.split(" ");
      const plainKey = !/(mod|ctrl|meta|alt)\+/.test(chords[0]);
      if (plainKey && isTyping(e.target)) continue; // "/" in a text box types a slash
      const idx = chords.length === 2 && pending === chords[0] ? 1 : 0;
      if (!chordMatches(chords[idx], e)) continue;
      if (chords.length === 2 && idx === 0) {
        pending = chords[0];
        clearTimeout(timer);
        timer = setTimeout(() => { pending = null; }, 1000);
      } else {
        pending = null;
        fn();
      }
      e.preventDefault();
      return;
    }
  });
}
