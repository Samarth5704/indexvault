// Generic settings section: one form field per schema property, saved on change.
// Plus the small extras that sit under generic sections (format preview, presets).

import { confirmDialog } from "../../components/confirm.js";
import { formField } from "../../components/form-field.js";
import { toast, toastError } from "../../components/toast.js";
import { h, icon } from "../../dom.js";
import { format, saveSection, settings } from "../../settings.js";
import { fieldMeta, SECTION_DEFS } from "./meta.js";

/** Text a row is found by in the settings search. */
export const searchText = (...parts) => parts.filter(Boolean).join(" ").toLowerCase();

/** Render the fields of `section` (optionally only/skip some keys). */
export function schemaFields(ctx, section, { only = null, skip = [] } = {}) {
  const def = ctx.defs[SECTION_DEFS[section]];
  const rows = [];
  for (const [key, prop] of Object.entries(def.properties)) {
    if ((only && !only.includes(key)) || skip.includes(key)) continue;
    const meta = fieldMeta(section, key);
    if (meta.hidden) continue;
    const field = formField({ schema: prop, value: settings()[section][key], meta, onChange: (v) => saveField(section, key, v) });
    field.el.dataset.search = searchText(meta.label || prop.title, meta.hint ?? prop.description, key.replaceAll("_", " "));
    field.el.dataset.key = `${section}.${key}`;
    ctx.watch((s) => s[section]?.[key], (v) => field.set(v));
    rows.push(field.el);
  }
  return h("div.settings-fields", rows);
}

/** Save one field; turn a 422 into the message for that field. */
export async function saveField(section, key, value) {
  try {
    await saveSection(section, { [key]: value });
  } catch (e) {
    throw new Error(fieldMessage(e, key));
  }
}

export function fieldMessage(e, key) {
  if (Array.isArray(e.detail) && e.detail.length) {
    const hit = e.detail.find((d) => d.loc?.includes(key)) || e.detail[0];
    return String(hit.msg).replace(/^Value error, /, "");
  }
  return e.message;
}

// --------------------------------------------------------------------------
// Formats: a live sample of every formatter
// --------------------------------------------------------------------------
export function formatsPreview(ctx) {
  const el = h("div.format-preview", { "data-search": searchText("preview example sample number money date percent") });
  const today = new Date().toISOString().slice(0, 10);
  const render = () => el.replaceChildren(
    h("p.field-label", "Preview"),
    h("dl.format-samples",
      sample("Number", format.number(1234567.891)),
      sample("Money", format.money(1234567)),
      sample("Compact", format.money(12345678, { compact: true })),
      sample("Percent", format.pct(0.12345, { sign: true })),
      sample("Negative", format.pct(-0.0321)),
      sample("Date", format.date(today))));
  ctx.watch((s) => s.formats, render);
  render();
  return el;
}

const sample = (label, value) => h("div.format-sample", h("dt", label), h("dd.mono", value));

// --------------------------------------------------------------------------
// Export: saved presets (created in Data Studio → Export)
// --------------------------------------------------------------------------
export function exportPresets(ctx) {
  const el = h("div.presets-block", { "data-search": searchText("export presets saved data studio") });
  const FORMAT = { xlsx: "Excel", csv: "CSV", zip: "CSV zip", json: "JSON" };

  async function remove(name) {
    const ok = await confirmDialog({ title: `Delete preset “${name}”?`, danger: true, confirmLabel: "Delete",
      message: "The preset is removed from your settings. Exports you already downloaded are not affected." });
    if (!ok) return;
    try {
      await saveSection("export", { presets: settings().export.presets.filter((p) => p.name !== name) });
      toast({ tone: "success", title: "Preset deleted" });
    } catch (e) { toastError(e, "Couldn't delete the preset"); }
  }

  const render = (presets) => el.replaceChildren(
    h("div.block-head", h("p.field-label", "Saved presets"), h("span.muted", `${presets.length} of 50`)),
    presets.length
      ? h("ul.item-list", presets.map((p) => h("li.item-row",
        h("div.item-main", h("span.item-name", p.name),
          h("span.muted", `${FORMAT[p.format]} · ${p.frequency} · ${p.tickers.length || "current"} series · ${p.columns.length || "default"} columns`)),
        h("button.icon-btn.sm", { type: "button", "aria-label": `Delete preset ${p.name}`, onclick: () => remove(p.name) }, icon("trash", { size: "sm" })))))
      : h("p.muted.block-empty", "No presets yet. Save one from Data Studio → Export."));
  ctx.watch((s) => s.export?.presets, render);
  render(settings().export.presets);
  return el;
}
