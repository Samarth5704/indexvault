// Theme editor (SPEC § 3.10 #2): edit any colour token of the theme on screen,
// preview it live across the whole app, save it as a named theme, import/export
// theme JSON. The chart-palette editor (with the colour-blind check) sits below.

import { downloadBlob } from "../../components/chart-card.js";
import { confirmDialog } from "../../components/confirm.js";
import { toast, toastError } from "../../components/toast.js";
import { h, icon } from "../../dom.js";
import { contrast, cssToHex, opaqueHex, parseColour } from "../../colour.js";
import { applySettings, resolveTheme, saveSection, settings, THEMES } from "../../settings.js";
import { useTheme } from "./appearance.js";
import { paletteEditor } from "./palette-editor.js";
import { searchText } from "./schema-section.js";

const root = document.documentElement;
const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();
const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const THEME_KIND = "indexvault-theme";

// [group, [[token, label, contrast-against, minimum ratio]…]]
const GROUPS = [
  ["Surfaces", [["--bg", "Background"], ["--surface", "Surface (cards)"], ["--surface-2", "Surface 2 (inputs, hover)"], ["--surface-3", "Surface 3 (selected)"], ["--border", "Border"]]],
  ["Text", [["--text", "Text", "--surface", 4.5], ["--text-2", "Secondary text", "--surface", 4.5], ["--text-muted", "Muted text", "--surface", 3]]],
  ["Interactive", [["--accent", "Accent", "--surface", 3], ["--accent-fg", "Text on accent", "--accent", 4.5], ["--focus", "Focus ring", "--bg", 3]]],
  ["Data", [["--gain-market", "Gain", "--surface", 3], ["--loss", "Loss", "--surface", 3], ["--div-neg", "Heatmap negative"], ["--div-mid", "Heatmap midpoint"], ["--div-pos", "Heatmap positive"]]],
  ["Chart", [["--grid", "Gridlines"], ["--axis", "Axis lines"]]],
];
const TOKENS = GROUPS.flatMap(([, rows]) => rows);

export function themeEditorSection(ctx) {
  const draft = new Map(); // token -> value (unsaved, applied live on <html>)
  let identity = "";
  const head = h("div.theme-editor-head");
  const tokensEl = h("div.token-groups");
  const bar = h("div.draft-bar", { role: "region", "aria-label": "Unsaved theme changes" });
  const customList = h("div.custom-themes");
  const fileInput = h("input", { type: "file", accept: "application/json,.json", hidden: true, onchange: () => importFile(fileInput.files[0]) });

  const current = () => {
    const s = settings();
    const shown = resolveTheme(s.appearance, s.custom_themes);
    // a custom theme is being edited only while it's on screen (not swapped for its partner by the mode)
    const custom = s.custom_themes[s.appearance.theme]?.base === shown.name ? s.appearance.theme : null;
    return { base: shown.name, custom, saved: custom ? s.custom_themes[custom].tokens : {} };
  };

  function applyDraft() { for (const [k, v] of draft) root.style.setProperty(k, v); }
  function discard() {
    for (const k of draft.keys()) root.style.removeProperty(k);
    draft.clear();
    applySettings(settings());
  }

  function render() {
    const cur = current();
    head.replaceChildren(
      h("p", "Editing ", h("strong", cur.custom || THEMES[cur.base].label),
        cur.custom ? h("span.muted", ` · based on ${THEMES[cur.base].label}`) : h("span.muted", " · built-in, so changes save as a new theme")),
      h("p.field-hint", "Changes preview across the whole app straight away. They're kept only when you save." +
        (settings().appearance.accent ? " Note: the accent override in Appearance is on and wins over this theme's accent." : "")));
    tokensEl.replaceChildren(...GROUPS.map(([group, rows]) => h("div.token-group",
      h("p.token-group-title", group),
      rows.map((r) => tokenRow(r)))));
    renderBar();
    renderCustomList();
  }

  function tokenRow([token, label, against, min]) {
    const value = draft.get(token) ?? css(token);
    const hex = opaqueHex(value, css("--surface")) || "#000000";
    const picker = h("input.colour-input", { type: "color", value: hex, "aria-label": `${label} colour` });
    const text = h("input.input.mono.token-text", { value, spellcheck: "false", maxlength: 64, "aria-label": `${label} value` });
    const badge = against && contrastBadge(draft.get(token) ?? value, draft.get(against) ?? css(against), min);
    const set = (v) => {
      if (!v || /[;{}<>]/.test(v) || !cssToHex(v)) { text.setAttribute("aria-invalid", "true"); return; }
      text.removeAttribute("aria-invalid");
      draft.set(token, v);
      root.style.setProperty(token, v);
      renderBar();
    };
    picker.addEventListener("input", () => { text.value = picker.value; set(picker.value); });
    picker.addEventListener("change", render); // refresh contrast badges
    text.addEventListener("change", () => { set(text.value.trim()); render(); });
    const undo = draft.has(token) && h("button.icon-btn.sm", { type: "button", "aria-label": `Undo ${label} change`, title: "Undo",
      onclick: () => { draft.delete(token); root.style.removeProperty(token); applySettings(settings()); applyDraft(); render(); } }, icon("refresh", { size: "sm" }));
    return h("div.token-row", { "data-search": searchText(label, token, "token colour theme editor") , "data-changed": draft.has(token) ? "true" : null },
      picker, h("div.token-name", h("span", label), h("span.mono.muted", token)), text, badge || h("span"), undo || h("span"));
  }

  function renderBar() {
    const cur = current();
    const nameInput = h("input.input", { placeholder: "new-theme-name", "aria-label": "Name for the new theme", maxlength: 32, value: suggestName(cur) });
    bar.hidden = !draft.size;
    if (!draft.size) return bar.replaceChildren();
    bar.replaceChildren(
      h("span.draft-count", icon("edit", { size: "sm" }), `${draft.size} unsaved change${draft.size > 1 ? "s" : ""}`),
      h("div.draft-actions",
        cur.custom && h("button.btn.primary.sm", { type: "button", onclick: () => save(cur.custom, cur) }, icon("save", { size: "sm" }), `Update ${cur.custom}`),
        nameInput,
        h(cur.custom ? "button.btn.secondary.sm" : "button.btn.primary.sm", { type: "button", onclick: () => save(nameInput.value.trim(), cur, true) }, "Save as new theme"),
        h("button.btn.ghost.sm", { type: "button", onclick: () => { discard(); render(); } }, "Discard")));
  }

  async function save(name, cur, isNew = false) {
    const s = settings();
    if (!SLUG.test(name)) return toast({ tone: "error", title: "Pick another name", message: "Use 1–32 lowercase letters, digits or hyphens, e.g. my-midnight." });
    if (THEMES[name]) return toast({ tone: "error", title: "That name is taken", message: `${THEMES[name].label} is a built-in theme.` });
    if (isNew && s.custom_themes[name] && !(await confirmDialog({ title: `Replace theme “${name}”?`, confirmLabel: "Replace", message: "A custom theme with this name already exists." }))) return;
    const tokens = { ...cur.saved, ...Object.fromEntries(draft) };
    try {
      await saveSection("custom_themes", { ...s.custom_themes, [name]: { base: cur.base, tokens } });
      for (const k of draft.keys()) root.style.removeProperty(k);
      draft.clear();
      await useTheme(name, THEMES[cur.base].scheme);
      toast({ tone: "success", title: `Saved theme “${name}”` });
    } catch (e) { toastError(e, "Couldn't save the theme"); }
  }

  // ---------------------------------------------------------------- custom themes
  function renderCustomList() {
    const themes = Object.entries(settings().custom_themes);
    customList.replaceChildren(
      h("div.block-head", h("p.field-label", "Your themes"),
        h("div.head-actions",
          h("button.btn.secondary.sm", { type: "button", onclick: () => fileInput.click() }, icon("download", { size: "sm" }), "Import JSON"),
          h("button.btn.secondary.sm", { type: "button", onclick: exportCurrent }, icon("copy", { size: "sm" }), "Export current"))),
      themes.length
        ? h("ul.item-list", themes.map(([name, t]) => h("li.item-row",
          h("span.theme-mini", { "data-theme": t.base, "aria-hidden": "true" }, ...["--bg", "--surface", "--accent", "--gain-market", "--loss"].map((k) => {
            const dot = h("span");
            dot.style.background = t.tokens[k] || `var(${k})`;
            return dot;
          })),
          h("div.item-main", h("span.item-name", name), h("span.muted", `${THEMES[t.base].label} · ${Object.keys(t.tokens).length} tokens changed`)),
          h("div.row-actions",
            settings().appearance.theme === name ? h("span.status-pill", { "data-status": "good" }, icon("check", { size: "sm" }), "In use")
              : h("button.btn.ghost.sm", { type: "button", onclick: () => useTheme(name, THEMES[t.base].scheme) }, "Use"),
            h("button.icon-btn.sm", { type: "button", "aria-label": `Export ${name}`, title: "Export JSON", onclick: () => exportTheme(name, t) }, icon("download", { size: "sm" })),
            h("button.icon-btn.sm", { type: "button", "aria-label": `Delete ${name}`, title: "Delete", onclick: () => remove(name, t) }, icon("trash", { size: "sm" }))))))
        : h("p.muted.block-empty", "No custom themes yet. Change a token above and save it, or import a theme file."),
      fileInput);
  }

  function exportTheme(name, t) {
    const json = JSON.stringify({ kind: THEME_KIND, version: 1, name, base: t.base, tokens: t.tokens }, null, 2);
    downloadBlob(`indexvault-theme-${name}.json`, new Blob([json], { type: "application/json" }));
  }

  function exportCurrent() {
    const cur = current();
    exportTheme(cur.custom || `${cur.base}-copy`, { base: cur.base, tokens: { ...cur.saved, ...Object.fromEntries(draft) } });
  }

  async function importFile(file) {
    fileInput.value = "";
    if (!file) return;
    try {
      const t = validateThemeFile(JSON.parse(await file.text()));
      const s = settings();
      let name = t.name;
      for (let i = 2; s.custom_themes[name] || THEMES[name]; i++) name = `${t.name.slice(0, 28)}-${i}`;
      await saveSection("custom_themes", { ...s.custom_themes, [name]: { base: t.base, tokens: t.tokens } });
      discard();
      await useTheme(name, THEMES[t.base].scheme);
      toast({ tone: "success", title: `Imported theme “${name}”` });
    } catch (e) { toastError(e, "Couldn't import the theme"); }
  }

  async function remove(name, t) {
    const ok = await confirmDialog({ title: `Delete theme “${name}”?`, danger: true, confirmLabel: "Delete",
      message: "The theme is removed from your settings. Export it first if you might want it back." });
    if (!ok) return;
    try {
      if (settings().appearance.theme === name) await saveSection("appearance", { theme: t.base });
      const rest = { ...settings().custom_themes };
      delete rest[name];
      await saveSection("custom_themes", rest);
      toast({ tone: "success", title: `Deleted theme “${name}”` });
    } catch (e) { toastError(e, "Couldn't delete the theme"); }
  }

  // Re-read token values whenever the applied theme changes (after it's applied).
  const onTheme = () => {
    const cur = current();
    const id = `${cur.base}|${cur.custom}`;
    if (id !== identity && draft.size) { for (const k of draft.keys()) root.style.removeProperty(k); draft.clear(); }
    identity = id;
    applyDraft();
    if (!tokensEl.contains(document.activeElement)) render();
  };
  document.addEventListener("iv:themechange", onTheme);
  ctx.onCleanup(() => document.removeEventListener("iv:themechange", onTheme));
  identity = `${current().base}|${current().custom}`;
  render();

  return [
    h("div.theme-editor", { "data-search": searchText("theme editor tokens colours") }, head, tokensEl, bar),
    customList,
    paletteEditor(ctx),
  ];
}

function suggestName(cur) {
  const taken = settings().custom_themes;
  const stem = `my-${cur.base}`;
  let name = stem;
  for (let i = 2; taken[name]; i++) name = `${stem}-${i}`;
  return name;
}

function contrastBadge(fg, bg, min) {
  if (!parseColour(cssToHex(fg) || "") || !parseColour(cssToHex(bg) || "")) return null;
  const r = contrast(cssToHex(fg), cssToHex(bg));
  const ok = r >= min;
  return h("span.contrast-badge.mono", { "data-ok": String(ok), title: `Contrast ${r.toFixed(2)}:1 (want ≥ ${min}:1)` },
    icon(ok ? "check" : "alert-triangle", { size: "sm" }), `${r.toFixed(1)}:1`);
}

/** Check an imported theme file; returns {name, base, tokens}. */
export function validateThemeFile(data) {
  if (!data || typeof data !== "object") throw new Error("The file isn't a theme.");
  const base = data.base;
  if (!THEMES[base]) throw new Error(`“base” must be one of ${Object.keys(THEMES).join(", ")}.`);
  const tokens = {};
  for (const [k, v] of Object.entries(data.tokens || {})) {
    if (!/^--[a-z0-9-]{1,48}$/.test(k) || typeof v !== "string" || v.length > 64 || /[;{}<>]/.test(v)) throw new Error(`Token ${k} has an invalid value.`);
    tokens[k] = v;
  }
  const name = String(data.name || "imported").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "imported";
  return { name, base, tokens };
}
