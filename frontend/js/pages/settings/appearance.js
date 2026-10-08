// Appearance: theme cards, the schema-driven appearance fields and a live preview
// panel. Theme cards render inside their own [data-theme] scope, so each shows its
// real tokens without switching the app.

import { toastError } from "../../components/toast.js";
import { h, icon } from "../../dom.js";
import { format, resolveTheme, saveSection, settings, THEMES } from "../../settings.js";
import { schemaFields, searchText } from "./schema-section.js";

const osDark = () => matchMedia("(prefers-color-scheme: dark)").matches;

export function appearanceSection(ctx) {
  return h("div.appearance-grid",
    h("div.appearance-main", themePicker(ctx), schemaFields(ctx, "appearance")),
    h("aside.appearance-preview", { "aria-label": "Live preview" }, preview(ctx)));
}

// --------------------------------------------------------------------------
// Theme picker
// --------------------------------------------------------------------------
function themeChoices(s) {
  const builtIn = Object.entries(THEMES).map(([id, t]) => ({ id, label: t.label, base: id, scheme: t.scheme, tokens: {} }));
  const custom = Object.entries(s.custom_themes).map(([id, t]) => ({ id, label: id, base: t.base, scheme: THEMES[t.base].scheme, tokens: t.tokens, custom: true }));
  return [...builtIn, ...custom];
}

/** Pick a theme; switch the mode to its scheme unless "system" already shows it. */
export async function useTheme(id, scheme) {
  const a = settings().appearance;
  const keepSystem = a.mode === "system" && (osDark() ? "dark" : "light") === scheme;
  try {
    await saveSection("appearance", { theme: id, mode: keepSystem ? "system" : scheme });
  } catch (e) { toastError(e, "Couldn't switch theme"); }
}

function themeCard(t, active) {
  const swatch = h("span.theme-swatch", { "data-theme": t.base, "aria-hidden": "true" },
    h("span.ts-bar"),
    h("span.ts-card", h("span.ts-line", { style: { background: "var(--text-2)" } }), h("span.ts-line.short", { style: { background: "var(--text-muted)" } }),
      h("span.ts-dots", [1, 2, 3, 4].map((i) => h("span", { style: { background: `var(--series-${i})` } })))),
    h("span.ts-accent"));
  for (const [k, v] of Object.entries(t.tokens)) swatch.style.setProperty(k, v); // custom tokens, scoped to the card
  return h("button.theme-card", { type: "button", role: "radio", "aria-checked": String(active), "data-id": t.id, onclick: () => useTheme(t.id, t.scheme) },
    swatch,
    h("span.theme-card-foot",
      h("span.theme-card-name", t.label, t.custom && h("span.source-tag", "Custom")),
      h("span.muted", t.scheme === "dark" ? "Dark" : "Light"),
      active && h("span.theme-check", icon("check", { size: "sm" }))));
}

function themePicker(ctx) {
  const grid = h("div.theme-grid", { role: "radiogroup", "aria-labelledby": "theme-picker-label" });
  const note = h("p.field-hint");
  const render = () => {
    const s = settings();
    grid.replaceChildren(...themeChoices(s).map((t) => themeCard(t, s.appearance.theme === t.id)));
    const shown = resolveTheme(s.appearance, s.custom_themes);
    const picked = s.custom_themes[s.appearance.theme]?.base || s.appearance.theme;
    note.textContent = shown.name !== picked
      ? `Showing ${THEMES[shown.name].label}, the ${shown.scheme} partner of your theme, because mode is “${s.appearance.mode}”.`
      : "Each theme has a partner in the other mode: Midnight ↔ Paper, Terminal ↔ Saffron.";
  };
  grid.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    const cards = [...grid.children];
    const i = cards.indexOf(document.activeElement);
    cards[(i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1) + cards.length) % cards.length]?.focus();
    e.preventDefault();
  });
  ctx.watch((s) => s.appearance, render);
  ctx.watch((s) => s.custom_themes, render);
  render();
  return h("div.setting.setting-wide", { "data-search": searchText("theme preset midnight paper terminal saffron dark light custom") },
    h("div.setting-text", h("span.setting-label#theme-picker-label", "Theme"), note),
    grid);
}

// --------------------------------------------------------------------------
// Live preview: built only from tokens, so it follows every change instantly
// --------------------------------------------------------------------------
const PREVIEW_SERIES = [
  [62, 58, 60, 52, 54, 46, 48, 40, 36, 30],
  [70, 68, 64, 66, 60, 62, 56, 58, 52, 50],
  [80, 76, 78, 74, 76, 72, 70, 72, 66, 64],
];

function preview(ctx) {
  const el = h("div.preview-card.card");
  const render = () => {
    const d1 = format.delta(0.0142);
    const d2 = format.delta(-0.0087);
    el.replaceChildren(
      h("div.preview-head", h("span.field-label", "Preview"), h("span.muted", "updates as you change settings")),
      h("div.preview-kpi",
        h("span.kpi-label", "NIFTY 50 · End level"),
        h("span.kpi-value.mono", format.number(24871.35)),
        h("span.delta-pill", { "data-tone": d1.tone }, d1.arrow, " ", d1.text)),
      chartSvg(),
      h("ul.legend.preview-legend", ["NIFTY 50", "NIFTY BANK", "NIFTY IT"].map((n, i) =>
        h("li", h("span.chip-dot", { style: { background: `var(--series-${i + 1})` } }), n))),
      h("table.data-table.preview-table",
        h("thead", h("tr", h("th", "Series"), h("th", "1D"), h("th", "CAGR"))),
        h("tbody",
          h("tr", h("td", "NIFTY 50"), h("td.num.gain", `${d1.arrow} ${d1.text}`), h("td.num", format.pct(0.1261))),
          h("tr", h("td", "NIFTY BANK"), h("td.num.loss", `${d2.arrow} ${d2.text}`), h("td.num", format.pct(0.1418))))),
      h("div.preview-actions",
        h("button.btn.primary.sm", { type: "button", tabindex: "-1" }, "Primary"),
        h("button.btn.secondary.sm", { type: "button", tabindex: "-1" }, "Secondary"),
        h("span.status-pill", { "data-status": "good" }, icon("check-circle", { size: "sm" }), "Fresh")));
  };
  ctx.watch((s) => s.formats, render);
  render();
  return el;
}

function chartSvg() {
  const W = 300, H = 110;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "preview-chart-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Sample chart with three series");
  const parts = [0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${W}" y1="${H * f}" y2="${H * f}" stroke="var(--grid)" stroke-width="1"/>`);
  PREVIEW_SERIES.forEach((ys, i) => {
    const pts = ys.map((y, j) => `${(j / (ys.length - 1)) * W},${(y / 90) * H}`).join(" ");
    parts.push(`<polyline points="${pts}" fill="none" stroke="var(--series-${i + 1})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
  });
  svg.innerHTML = parts.join("");
  return svg;
}
