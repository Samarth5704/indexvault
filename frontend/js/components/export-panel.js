// Export panel: format, options (defaults from settings), saved presets, download.
// Exports exactly what the Data Studio shows: selected series, range, frequency, columns.

import { api } from "../api.js";
import { columnLabel } from "../columns.js";
import { h, icon } from "../dom.js";
import { saveSection, settings } from "../settings.js";
import { downloadBlob } from "./chart-card.js";
import { openDrawer } from "./drawer.js";
import { seriesName } from "./series-picker.js";
import { toast, toastError } from "./toast.js";

const FORMATS = [
  ["xlsx", "Excel", "Summary, combined closes, one sheet per series"],
  ["csv", "CSV", "One file; several series in long format"],
  ["zip", "CSV zip", "One CSV per series"],
  ["json", "JSON", "Columns + rows per series"],
];
const DATE_FORMATS = ["DD-MM-YYYY", "YYYY-MM-DD", "DD MMM YYYY"];

const filenameFrom = (res, fallback) =>
  /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || fallback;

/**
 * openExportPanel({state: () => ({tickers, range, freq, columns}), onApplyPreset(preset)})
 * `state` is read at download time so the panel always exports the current view.
 */
export function openExportPanel({ state, onApplyPreset }) {
  const s = settings();
  const fmt = h("div.radio-cards", { role: "radiogroup", "aria-label": "Format" },
    FORMATS.map(([id, label, hint]) => h("label.radio-card",
      h("input", { type: "radio", name: "export-format", value: id, checked: id === s.export.default_format }),
      h("span.radio-title", label), h("span.radio-hint", hint))));
  const dateSel = h("select.select", { "aria-label": "Date format" }, DATE_FORMATS.map((f) => h("option", { value: f }, f)));
  const decimals = h("input.input", { type: "number", min: "0", max: "8", step: "1", "aria-label": "Decimal places" });
  const indian = h("input", { type: "checkbox" });
  const meta = h("input", { type: "checkbox" });
  const seriesBox = h("fieldset.series-checks", h("legend.field-label", "Series"));
  const summary = h("p.export-summary.text-2");
  const xlsxOnly = h("div.xlsx-only",
    h("label.check", indian, "Indian number format (12,34,567.89) in Excel"),
    h("label.check", meta, "Add an About sheet (source, fetch time, caveats)"));

  function setOptions(o = {}) {
    dateSel.value = o.date_format || s.formats.date_format;
    decimals.value = String(o.decimals ?? s.formats.decimals);
    indian.checked = o.indian_number_format ?? s.formats.number_system === "indian";
    meta.checked = o.metadata_sheet ?? s.export.metadata_sheet;
  }

  function currentFormat() {
    return fmt.querySelector("input:checked")?.value || "xlsx";
  }

  function renderScope() {
    const st = state();
    seriesBox.replaceChildren(h("legend.field-label", "Series"), ...st.tickers.map((t) =>
      h("label.check", h("input", { type: "checkbox", value: t, checked: true }), seriesName(t))));
    const range = st.range.start ? `${st.range.start} → ${st.range.end || "today"}` : st.range.period;
    summary.textContent = `${range} · ${st.freq} · ${st.columns.length} columns (${st.columns.map(columnLabel).join(", ")})`;
  }

  const syncFormat = () => { xlsxOnly.hidden = currentFormat() !== "xlsx"; };
  fmt.addEventListener("change", syncFormat);

  // ---------------------------------------------------------------- download
  const downloadBtn = h("button.btn.primary", { type: "button" }, icon("download", { size: "sm" }), "Download");
  downloadBtn.addEventListener("click", async () => {
    const st = state();
    const tickers = [...seriesBox.querySelectorAll("input:checked")].map((i) => i.value);
    if (!tickers.length) return toast({ tone: "warning", title: "Choose at least one series" });
    const d = Number(decimals.value);
    if (!Number.isInteger(d) || d < 0 || d > 8) return toast({ tone: "warning", title: "Decimal places must be 0–8" });
    const body = {
      tickers, ...st.range, freq: st.freq, columns: st.columns, format: currentFormat(),
      options: { date_format: dateSel.value, decimals: d, indian_number_format: indian.checked, metadata_sheet: meta.checked },
    };
    downloadBtn.disabled = true;
    downloadBtn.lastChild.textContent = "Preparing…";
    try {
      const res = await api.raw("POST", "/export", { body, timeout: 120_000 });
      const name = filenameFrom(res, `indexvault.${body.format}`);
      downloadBlob(name, await res.blob());
      toast({ tone: "success", title: "Export ready", message: name });
    } catch (e) {
      toastError(e, "Export failed");
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.lastChild.textContent = "Download";
    }
  });

  // ---------------------------------------------------------------- presets
  const presetSel = h("select.select", { "aria-label": "Saved presets" });
  const presetName = h("input.input", { type: "text", maxlength: "60", placeholder: "e.g. Sector closes, monthly", "aria-label": "Preset name" });

  function renderPresets() {
    const presets = settings().export.presets;
    presetSel.replaceChildren(h("option", { value: "" }, presets.length ? "Choose a preset…" : "No presets yet"),
      ...presets.map((p) => h("option", { value: p.name }, p.name)));
    presetSel.disabled = !presets.length;
  }

  async function savePresets(presets, message) {
    try {
      await saveSection("export", { presets });
      renderPresets();
      toast({ tone: "success", title: message });
    } catch (e) {
      toastError(e, "Couldn't save presets");
    }
  }

  const applyBtn = h("button.btn.secondary.sm", { type: "button", onclick: () => {
    const p = settings().export.presets.find((x) => x.name === presetSel.value);
    if (!p) return;
    onApplyPreset(p);
    fmt.querySelector(`input[value="${p.format}"]`).checked = true;
    setOptions(p.options);
    syncFormat();
    renderScope();
    toast({ title: `Applied “${p.name}”` });
  } }, "Apply");
  const deleteBtn = h("button.btn.ghost.sm", { type: "button", onclick: () => {
    const name = presetSel.value;
    if (name) savePresets(settings().export.presets.filter((x) => x.name !== name), `Deleted “${name}”`);
  } }, icon("trash", { size: "sm" }), "Delete");
  const saveBtn = h("button.btn.secondary.sm", { type: "button", onclick: () => {
    const name = presetName.value.trim();
    if (!name) { presetName.focus(); return toast({ tone: "warning", title: "Give the preset a name" }); }
    const st = state();
    const preset = {
      name, tickers: [...seriesBox.querySelectorAll("input:checked")].map((i) => i.value),
      frequency: st.freq, columns: st.columns, format: currentFormat(),
      options: { date_format: dateSel.value, decimals: Number(decimals.value), indian_number_format: indian.checked, metadata_sheet: meta.checked },
    };
    const others = settings().export.presets.filter((x) => x.name !== name);
    const replaced = others.length !== settings().export.presets.length;
    savePresets([...others, preset], replaced ? `Updated “${name}”` : `Saved “${name}”`);
    presetName.value = "";
  } }, icon("save", { size: "sm" }), "Save");

  setOptions();
  renderScope();
  renderPresets();
  syncFormat();

  return openDrawer({
    title: "Export",
    body: h("div.export-panel",
      h("section", summary, seriesBox),
      h("section", h("h3.section-title", "Format"), fmt),
      h("section.export-options", h("h3.section-title", "Options"),
        h("div.option-row",
          h("label.field", h("span.field-label", "Date format"), dateSel),
          h("label.field", h("span.field-label", "Decimals"), decimals)),
        xlsxOnly),
      h("section", h("h3.section-title", "Presets"),
        h("div.preset-row", presetSel, applyBtn, deleteBtn),
        h("div.preset-row", presetName, saveBtn))),
    footer: h("div.drawer-actions", downloadBtn),
  });
}
