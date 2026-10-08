// Chart-palette editor with the colour-blind check from DESIGN § 7: adjacent colours
// are compared in OKLab under simulated protan/deutan/tritan vision (warn < 8),
// normal vision (warn < 15), and each colour's contrast on --surface (warn < 3:1).
// Warnings are shown inline; saving is still allowed.

import { confirmDialog } from "../../components/confirm.js";
import { toast, toastError } from "../../components/toast.js";
import { h, icon } from "../../dom.js";
import { checkPalette, cssToHex, LIMITS, simulateHex, VISIONS } from "../../colour.js";
import { saveSection, settings } from "../../settings.js";
import { searchText } from "./schema-section.js";

const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MIN = 2, MAX = 12;
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** The theme's own series colours (read from a probe, so a custom palette in use doesn't leak in). */
function themeSeries() {
  const probe = h("span", { "data-theme": document.documentElement.dataset.theme, hidden: true });
  document.body.append(probe);
  const cs = getComputedStyle(probe);
  const out = Array.from({ length: 8 }, (_, i) => cssToHex(cs.getPropertyValue(`--series-${i + 1}`).trim()) || "#888888");
  probe.remove();
  return out;
}

export function paletteEditor(ctx) {
  let colours = startingColours();
  let name = settings().appearance.chart_palette !== "default" ? settings().appearance.chart_palette : "";
  const el = h("div.palette-editor", { "data-search": searchText("chart palette colour blind cvd protanopia deuteranopia tritanopia contrast series colours") });

  function startingColours() {
    const s = settings();
    return [...(s.custom_palettes[s.appearance.chart_palette] || themeSeries())];
  }

  const set = (next) => { colours = next; render(); };

  function render() {
    const report = checkPalette(colours, cssToHex(css("--surface")) || "#ffffff");
    const nameInput = h("input.input", { value: name, placeholder: "palette-name", maxlength: 32, "aria-label": "Palette name", oninput: () => { name = nameInput.value.trim(); } });
    el.replaceChildren(...[ // falsy entries (optional blocks) are dropped
      h("div.block-head", h("div", h("p.field-label", "Chart palette"),
        h("p.field-hint", "Series colours in selection order. Checked for colour-blind separation as you edit.")),
      h("div.head-actions",
        h("button.btn.ghost.sm", { type: "button", onclick: () => set(themeSeries()) }, "Start from theme colours"))),
      h("ol.palette-swatches", colours.map((c, i) => swatch(c, i))),
      colours.length < MAX && h("button.btn.secondary.sm.palette-add", { type: "button", onclick: () => set([...colours, nextColour(colours)]) }, icon("plus", { size: "sm" }), "Add colour"),
      simulations(),
      checkTable(report),
      report.warnings.length
        ? h("ul.palette-warnings", { role: "status" }, report.warnings.map((w) => h("li", icon("alert-triangle", { size: "sm" }), w)))
        : h("p.palette-ok", { role: "status" }, icon("check-circle", { size: "sm" }), "All checks pass: adjacent colours stay apart for every type of colour vision."),
      h("div.palette-save", nameInput,
        h("button.btn.primary.sm", { type: "button", onclick: () => save(true) }, icon("save", { size: "sm" }), "Save & use"),
        h("button.btn.secondary.sm", { type: "button", onclick: () => save(false) }, "Save")),
      savedList()].filter(Boolean));
  }

  function swatch(c, i) {
    const picker = h("input.colour-input", { type: "color", value: c, "aria-label": `Colour ${i + 1}` });
    picker.addEventListener("change", () => set(colours.map((x, j) => (j === i ? picker.value : x))));
    return h("li.palette-swatch",
      h("span.palette-n.mono", String(i + 1)), picker, h("span.mono.palette-hex", c),
      h("div.palette-swatch-actions",
        h("button.chip-x", { type: "button", disabled: i === 0, "aria-label": `Move colour ${i + 1} earlier`, onclick: () => set(swap(colours, i, i - 1)) }, icon("chevron-left", { size: "sm" })),
        h("button.chip-x", { type: "button", disabled: i === colours.length - 1, "aria-label": `Move colour ${i + 1} later`, onclick: () => set(swap(colours, i, i + 1)) }, icon("chevron-right", { size: "sm" })),
        h("button.chip-x", { type: "button", disabled: colours.length <= MIN, "aria-label": `Remove colour ${i + 1}`, onclick: () => set(colours.filter((_, j) => j !== i)) }, icon("x", { size: "sm" }))));
  }

  function simulations() {
    return h("div.palette-sims", Object.entries(VISIONS).map(([v, label]) => h("div.palette-sim",
      h("span.palette-sim-label", label),
      h("span.palette-strip", { role: "img", "aria-label": `${label} simulation` }, colours.map((c) => {
        const cell = h("span");
        cell.style.background = v === "normal" ? c : simulateHex(c, v);
        return cell;
      })))));
  }

  function checkTable(report) {
    const cell = (v, limit) => h("td.num", { "data-ok": String(v >= limit) }, v >= limit ? "" : icon("alert-triangle", { size: "sm" }), v.toFixed(1));
    return h("details.palette-details",
      h("summary", "ΔE and contrast details"),
      h("div.table-wrap", h("table.data-table.palette-table",
        h("thead", h("tr", h("th", "Pair"), h("th", `Normal (≥ ${LIMITS.normal})`), ...["protan", "deutan", "tritan"].map((v) => h("th", `${VISIONS[v]} (≥ ${LIMITS.cvd})`)))),
        h("tbody", report.pairs.map((p) => h("tr", h("td", `${p.a + 1} → ${p.b + 1}`),
          cell(p.normal, LIMITS.normal), cell(p.protan, LIMITS.cvd), cell(p.deutan, LIMITS.cvd), cell(p.tritan, LIMITS.cvd)))))),
      h("p.field-hint", "Contrast on the chart surface: ",
        report.contrasts.map((r, i) => h("span.contrast-badge.mono", { "data-ok": String(r >= LIMITS.contrast) }, `${i + 1}: ${r.toFixed(1)}:1`))));
  }

  async function save(use) {
    const s = settings();
    if (!SLUG.test(name)) return toast({ tone: "error", title: "Name the palette", message: "Use 1–32 lowercase letters, digits or hyphens, e.g. high-contrast." });
    if (name === "default") return toast({ tone: "error", title: "“default” is the built-in palette", message: "Pick another name." });
    if (s.custom_palettes[name] && name !== s.appearance.chart_palette &&
      !(await confirmDialog({ title: `Replace palette “${name}”?`, confirmLabel: "Replace", message: "A palette with this name already exists." }))) return;
    try {
      await saveSection("custom_palettes", { ...s.custom_palettes, [name]: colours });
      if (use) await saveSection("appearance", { chart_palette: name });
      toast({ tone: "success", title: `Saved palette “${name}”`, message: use ? "Charts now use it." : "" });
    } catch (e) { toastError(e, "Couldn't save the palette"); }
  }

  function savedList() {
    const s = settings();
    const entries = Object.entries(s.custom_palettes);
    if (!entries.length) return null;
    return h("ul.item-list.palette-list", entries.map(([n, cols]) => h("li.item-row",
      h("span.palette-strip.small", { "aria-hidden": "true" }, cols.map((c) => { const x = h("span"); x.style.background = c; return x; })),
      h("div.item-main", h("span.item-name", n), h("span.muted", `${cols.length} colours`)),
      h("div.row-actions",
        s.appearance.chart_palette === n
          ? h("button.btn.ghost.sm", { type: "button", onclick: () => use("default") }, "Stop using")
          : h("button.btn.ghost.sm", { type: "button", onclick: () => use(n) }, "Use"),
        h("button.btn.ghost.sm", { type: "button", onclick: () => { name = n; set([...cols]); } }, icon("edit", { size: "sm" }), "Edit"),
        h("button.icon-btn.sm", { type: "button", "aria-label": `Delete palette ${n}`, onclick: () => remove(n) }, icon("trash", { size: "sm" }))))));
  }

  const use = (n) => saveSection("appearance", { chart_palette: n }).catch((e) => toastError(e, "Couldn't switch palette"));

  async function remove(n) {
    const ok = await confirmDialog({ title: `Delete palette “${n}”?`, danger: true, confirmLabel: "Delete", message: "Charts using it switch back to the default palette." });
    if (!ok) return;
    try {
      if (settings().appearance.chart_palette === n) await saveSection("appearance", { chart_palette: "default" });
      const rest = { ...settings().custom_palettes };
      delete rest[n];
      await saveSection("custom_palettes", rest);
    } catch (e) { toastError(e, "Couldn't delete the palette"); }
  }

  ctx.watch((s) => s.custom_palettes, render);
  ctx.watch((s) => s.appearance.chart_palette, render);
  render();
  return el;
}

const swap = (arr, i, j) => { const a = [...arr]; [a[i], a[j]] = [a[j], a[i]]; return a; };

/** A starting colour for a new slot: the first theme series colour not used yet. */
function nextColour(colours) {
  return themeSeries().find((c) => !colours.includes(c)) || "#888888";
}
