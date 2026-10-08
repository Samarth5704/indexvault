// Backup (SPEC § 3.10 #10): one JSON file with settings, custom themes/palettes,
// shortcuts, dashboard layout, custom indices and watchlists. Restore is
// all-or-nothing on the server; "Reset everything" restores default settings and
// keeps the catalogue (CLAUDE.md rule 10: user data is only deleted on request).

import { api } from "../../api.js";
import { downloadBlob } from "../../components/chart-card.js";
import { confirmDialog } from "../../components/confirm.js";
import { toast, toastError } from "../../components/toast.js";
import { h, icon } from "../../dom.js";
import { adoptSettings, format, resetSection } from "../../settings.js";
import { store } from "../../store.js";
import { fieldMessage, searchText } from "./schema-section.js";

export function backupSection() {
  const fileInput = h("input", { type: "file", accept: "application/json,.json", hidden: true, onchange: () => restore(fileInput.files[0]) });

  async function download() {
    try {
      const res = await api.raw("GET", "/settings/backup");
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || "indexvault-backup.json";
      downloadBlob(name, await res.blob());
      toast({ tone: "success", title: "Backup downloaded", message: name });
    } catch (e) { toastError(e, "Couldn't create the backup"); }
  }

  async function restore(file) {
    fileInput.value = "";
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return toast({ tone: "error", title: "That file isn't valid JSON" });
    }
    if (data?.kind !== "indexvault-backup") return toast({ tone: "error", title: "Not an IndexVault backup", message: "Choose a file made with “Download backup”." });
    const cat = data.catalog || {};
    const ok = await confirmDialog({ title: "Restore this backup?", confirmLabel: "Restore",
      message: `Made ${data.created ? format.date(data.created.slice(0, 10)) : "at an unknown date"}. Your current settings, ` +
        `custom indices and watchlists are replaced by the backup's (${(cat.custom_indices || []).length} indices, ${(cat.watchlists || []).length} watchlists). ` +
        "Download a backup first if you might want today's set-up back." });
    if (!ok) return;
    try {
      const out = await api.post("/settings/restore", data);
      adoptSettings(out.settings);
      store.set({ catalog: out.catalog });
      api.invalidate();
      toast({ tone: "success", title: "Backup restored" });
    } catch (e) { toastError({ message: fieldMessage(e, "") }, "Couldn't restore the backup"); }
  }

  async function resetAll() {
    const ok = await confirmDialog({ title: "Reset every setting?", danger: true, confirmLabel: "Reset everything",
      message: "All settings go back to their defaults, including custom themes, palettes, shortcuts, export presets and the dashboard layout. " +
        "Custom indices, watchlists and cached data are kept." });
    if (!ok) return;
    try {
      await resetSection();
      toast({ tone: "success", title: "Settings reset to defaults" });
    } catch (e) { toastError(e, "Couldn't reset"); }
  }

  return [
    h("div.backup-grid",
      action("download", "Download backup", "Settings, themes, palettes, shortcuts, presets, dashboard, custom indices and watchlists in one JSON file.",
        h("button.btn.primary.sm", { type: "button", onclick: download }, icon("download", { size: "sm" }), "Download backup"), "backup export download json"),
      action("refresh", "Restore from a file", "Replaces everything with a backup's contents. Backups from older versions are upgraded.",
        h("button.btn.secondary.sm", { type: "button", onclick: () => fileInput.click() }, "Choose backup file…"), "restore import upload"),
      action("alert-triangle", "Reset everything", "Every setting back to its default. Your catalogue and cached data stay.",
        h("button.btn.danger.sm", { type: "button", onclick: resetAll }, "Reset everything…"), "reset defaults start over")),
    fileInput,
  ];
}

const action = (iconName, title, text, button, keywords) =>
  h("div.backup-card", { "data-search": searchText(title, text, keywords) },
    h("span.backup-icon", icon(iconName)), h("p.item-name", title), h("p.field-hint", text), button);
