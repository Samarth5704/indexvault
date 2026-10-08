// Settings (SPEC § 3.10): the customisation centre. Every section is on one page
// with a sticky section nav; the search box filters individual settings. Forms are
// rendered from GET /settings/schema; every change saves and applies at once.

import { api } from "../api.js";
import { confirmDialog } from "../components/confirm.js";
import { emptyState, errorState, skeleton } from "../components/feedback.js";
import { toast, toastError } from "../components/toast.js";
import { h, icon, prefersReducedMotion } from "../dom.js";
import { setPageParams } from "../router.js";
import { applySettings, resetSection, settings } from "../settings.js";
import { store } from "../store.js";
import { appearanceSection } from "./settings/appearance.js";
import { backupSection } from "./settings/backup.js";
import { catalogueSection } from "./settings/catalogue.js";
import { exportPresets, formatsPreview, schemaFields, searchText } from "./settings/schema-section.js";
import { shortcutsSection } from "./settings/shortcuts.js";
import { themeEditorSection } from "./settings/theme-editor.js";

// key = the settings section reset by "Reset section" (null = no reset button).
const SECTIONS = [
  { id: "appearance", label: "Appearance", icon: "sparkle", key: "appearance", blurb: "Theme, colours, type size, density and motion.", render: appearanceSection },
  { id: "theme", label: "Theme editor", icon: "edit", blurb: "Edit theme tokens, build chart palettes, import and export themes.",
    keywords: "tokens palette colour blind cvd import export json custom", render: themeEditorSection },
  { id: "formats", label: "Formats", icon: "table", key: "formats", blurb: "How numbers, money and dates are written.",
    render: (ctx) => [schemaFields(ctx, "formats"), formatsPreview(ctx)] },
  { id: "data", label: "Data", icon: "database", key: "data", blurb: "Where data comes from, how fresh it stays and what opens first.",
    render: (ctx) => schemaFields(ctx, "data") },
  { id: "catalogue", label: "Catalogue & watchlists", icon: "columns", blurb: "Your own indices and tickers, and watchlists for quick picking.",
    keywords: "custom index ticker watchlist import export reorder", render: catalogueSection },
  { id: "analytics", label: "Analytics", icon: "chart", key: "analytics", blurb: "Parameters behind every metric, window and threshold.",
    render: (ctx) => schemaFields(ctx, "analytics") },
  { id: "sip", label: "SIP defaults", icon: "sip", key: "sip", blurb: "Starting values for new SIP Lab scenarios.", render: (ctx) => schemaFields(ctx, "sip") },
  { id: "export", label: "Export", icon: "download", key: "export", blurb: "Default format, Excel styling and saved presets.",
    render: (ctx) => [schemaFields(ctx, "export"), exportPresets(ctx)] },
  { id: "shortcuts", label: "Shortcuts", icon: "rows", key: "shortcuts", blurb: "Keyboard shortcuts for the actions you use most.",
    keywords: "keyboard keys hotkey bind", render: shortcutsSection },
  { id: "backup", label: "Backup", icon: "save", blurb: "Everything in one file: export, restore or start over.",
    keywords: "backup restore import export reset everything json", render: backupSection },
];

export default {
  mount(el, { route }) {
    const unsubs = [];
    const cleanups = [];
    const search = h("input.input.settings-search", { type: "search", placeholder: "Search settings", "aria-label": "Search settings" });
    const body = h("div.settings-body");
    el.append(
      h("header.page-head", h("div", h("h1", "Settings"),
        h("p.page-sub", "Every default, number and colour in IndexVault. Changes save and apply straight away.")),
      h("div.settings-search-wrap", icon("search", { size: "sm" }), search)),
      body);
    body.append(skeleton({ lines: 8, label: "Loading settings" }));

    const ctx = {
      watch: (select, fn) => unsubs.push(store.subscribe((s) => (s.settings ? select(s.settings) : undefined), fn)),
      onCleanup: (fn) => cleanups.push(fn),
    };

    let sectionEls = [];
    let noResults = null;
    async function build() {
      try {
        ctx.schema = await api.get("/settings/schema");
        ctx.defs = ctx.schema.$defs;
      } catch (e) {
        body.replaceChildren(errorState(e, { onRetry: build }));
        return;
      }
      const nav = h("nav.settings-nav", { "aria-label": "Settings sections" },
        SECTIONS.map((s) => h("a.settings-nav-link", { href: `#settings-${s.id}`, "data-id": s.id, onclick: (e) => { e.preventDefault(); goTo(s.id); } },
          icon(s.icon, { size: "sm" }), h("span", s.label))));
      sectionEls = SECTIONS.map((s) => renderSection(s, ctx));
      noResults = h("div.card.settings-none", { hidden: true }, emptyState({ icon: "search", title: "No settings match",
        message: "Try another word, like “rate”, “colour” or “watchlist”.", action: { label: "Clear search", onClick: () => { search.value = ""; filter(); } } }));
      body.replaceChildren(nav, h("div.settings-sections", sectionEls, noResults));
      spy(nav);
      search.addEventListener("input", filter);
      if (route.params.section) requestAnimationFrame(() => goTo(route.params.section, { smooth: false, focus: false }));
    }

    function goTo(id, { smooth = true, focus = true } = {}) {
      const target = sectionEls.find((s) => s.dataset.id === id);
      if (!target) return;
      target.scrollIntoView({ behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto", block: "start" });
      if (focus) target.querySelector("h2")?.focus({ preventScroll: true });
      setPageParams({ section: id });
    }

    // Highlight the nav link of the section at the top of the viewport.
    function spy(nav) {
      const links = [...nav.children];
      let frame = 0;
      const update = () => {
        frame = 0;
        const visible = sectionEls.filter((s) => !s.hidden);
        const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 4; // last sections can't reach the top
        const current = atBottom ? visible.at(-1) : visible.filter((s) => s.getBoundingClientRect().top < 160).at(-1) || visible[0];
        for (const a of links) {
          const on = a.dataset.id === current?.dataset.id;
          a.toggleAttribute("aria-current", on);
          // keep the active chip visible in the sideways-scrolling mobile nav
          if (on && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = a.offsetLeft - nav.clientWidth / 2 + a.offsetWidth / 2;
        }
      };
      const onScroll = () => { frame ||= requestAnimationFrame(update); };
      window.addEventListener("scroll", onScroll, { passive: true });
      cleanups.push(() => window.removeEventListener("scroll", onScroll));
      update();
    }

    function filter() {
      const q = search.value.trim().toLowerCase();
      let any = false;
      for (const sec of sectionEls) {
        const titleHit = !q || sec.dataset.search.includes(q);
        let shown = 0;
        for (const row of sec.querySelectorAll("[data-search]")) {
          const hit = titleHit || row.dataset.search.includes(q);
          row.hidden = !hit;
          if (hit) shown++;
        }
        sec.hidden = !titleHit && !shown;
        any ||= !sec.hidden;
      }
      if (noResults) noResults.hidden = any;
      el.querySelector(".settings-nav")?.toggleAttribute("data-filtered", Boolean(q));
    }

    build();
    return () => {
      unsubs.forEach((u) => u());
      cleanups.forEach((fn) => fn());
      if (settings()) applySettings(settings()); // drop any unsaved live previews
    };
  },
};

function renderSection(s, ctx) {
  const content = h("div.settings-section-body");
  try {
    const out = s.render(ctx);
    content.append(...[out].flat());
  } catch (e) {
    console.error(e);
    content.append(errorState(e));
  }
  const resetBtn = s.key && h("button.btn.ghost.sm", { type: "button", onclick: () => resetOne(s) }, icon("refresh", { size: "sm" }), "Reset section");
  return h("section.card.settings-section", { id: `settings-${s.id}`, "data-id": s.id, "aria-labelledby": `settings-${s.id}-title`,
    "data-search": searchText(s.label, s.blurb, s.keywords) },
  h("header.settings-section-head",
    h("div", h("h2", { id: `settings-${s.id}-title`, tabindex: "-1" }, s.label), h("p.card-sub", s.blurb)),
    resetBtn),
  content);
}

async function resetOne(s) {
  const ok = await confirmDialog({ title: `Reset ${s.label.toLowerCase()}?`, confirmLabel: "Reset",
    message: `Every ${s.label.toLowerCase()} setting goes back to its default. Other sections are not touched.` });
  if (!ok) return;
  try {
    await resetSection(s.key);
    toast({ tone: "success", title: `${s.label} reset to defaults` });
  } catch (e) { toastError(e, `Couldn't reset ${s.label.toLowerCase()}`); }
}
