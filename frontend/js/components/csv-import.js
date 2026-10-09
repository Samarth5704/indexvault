// "Import a CSV" card (Cache page): for indices no automatic source can supply, or
// when niftyindices.com is down. Accepts niftyindices.com "Historical Data" downloads
// (price or total return files) and any Date + Close CSV. After importing, the file
// can replace the index's normal source (a per-ticker override).

import { api, ApiError, enc } from "../api.js";
import { h, icon, nextId } from "../dom.js";
import { format } from "../settings.js";
import { store } from "../store.js";
import { seriesInfo } from "./history-tag.js";
import { toast } from "./toast.js";

const OTHER = "__other__";

async function refreshCatalog() {
  api.invalidate("/catalog");
  store.set({ catalog: await api.get("/catalog", null, { fresh: true }) });
}

async function upload(ticker, file, dayfirst) {
  const q = new URLSearchParams({ ticker, dayfirst: String(dayfirst) });
  let res;
  try {
    res = await fetch(`/api/import/csv?${q}`, { method: "POST", headers: { "Content-Type": "text/csv" }, body: file });
  } catch {
    throw new ApiError({ message: "Can't reach the IndexVault server. Is it running?" });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError({ status: res.status, ...(body.error || {}), message: body.error?.message || res.statusText });
  return body;
}

/** csvImportCard({preselect, onDone}) -> {el, focus()} */
export function csvImportCard({ preselect = "", onDone = () => {} } = {}) {
  const ids = { target: nextId("imp"), other: nextId("imp"), file: nextId("imp") };
  const target = h("select.select", { id: ids.target },
    store.get().catalog.categories.map((c) => h("optgroup", { label: c.name },
      c.items.map((i) => h("option", { value: i.ticker, selected: i.ticker === preselect }, `${i.name} · ${i.ticker}`)))),
    h("option", { value: OTHER, selected: Boolean(preselect) && !seriesInfo(preselect) }, "Another ticker…"));
  const other = h("input.input.mono", { id: ids.other, placeholder: "e.g. MYINDEX", maxlength: 40, value: seriesInfo(preselect) ? "" : preselect });
  const otherField = h("div.field", h("label.field-label", { for: ids.other }, "Ticker"), other);
  const file = h("input.input", { id: ids.file, type: "file", accept: ".csv,text/csv" });
  const dayfirst = h("input", { type: "checkbox", checked: true });
  const useIt = h("input", { type: "checkbox", checked: true });
  const useLabel = h("span");
  const result = h("div.import-result", { "aria-live": "polite" });
  const go = h("button.btn.primary.sm", { type: "button" }, icon("download", { size: "sm" }), "Import");

  const ticker = () => (target.value === OTHER ? other.value.trim().toUpperCase() : target.value);
  const sync = () => {
    otherField.hidden = target.value !== OTHER;
    const name = seriesInfo(ticker())?.name || ticker() || "this ticker";
    useLabel.textContent = `Use this file for ${name} instead of its usual source`;
  };
  target.addEventListener("change", sync);
  other.addEventListener("input", sync);
  sync();

  go.addEventListener("click", async () => {
    const t = ticker();
    if (!/^[A-Za-z0-9^=._&-]{1,40}$/.test(t)) return showError("Pick an index, or type a ticker (letters, digits, ^ . _ - & =).");
    if (!file.files[0]) return showError("Choose the CSV file first.");
    go.disabled = true;
    result.replaceChildren(h("p.muted", "Importing…"));
    try {
      const r = await upload(t, file.files[0], dayfirst.checked);
      if (useIt.checked) await api.put(`/catalog/overrides/${enc(t)}`, { source: "csv" });
      await refreshCatalog();
      api.invalidate("/series"); api.invalidate("/analytics");
      const days = Math.round((new Date(r.last) - new Date(r.first)) / 864e5);
      const short = days < store.get().catalog.short_history_days;
      result.replaceChildren(h("p", { class: short ? "import-warn" : "import-ok" },
        icon(short ? "alert-triangle" : "check-circle", { size: "sm" }),
        ` Imported ${format.number(r.rows, { decimals: 0 })} rows for ${seriesInfo(t)?.name || t}, ${format.date(r.first)} → ${format.date(r.last)}.`,
        short ? " That's under a year of history, so it's marked as short." : "",
        useIt.checked ? " It's now the source for this ticker." : " Its normal source is unchanged (use ?source=csv to read it)."));
      toast({ tone: "success", title: "CSV imported", message: `${r.rows} rows for ${t}` });
      file.value = "";
      onDone(t);
    } catch (e) {
      showError(e.message || String(e));
    } finally {
      go.disabled = false;
    }
  });

  function showError(msg) {
    result.replaceChildren(h("p.field-error", { role: "alert" }, msg));
  }

  const el = h("section.card.import-card", { id: "csv-import" },
    h("header.card-head", h("div.card-titles", h("h3.card-title", "Import a CSV"),
      h("p.card-sub", "For indices no source can supply, or when niftyindices.com is down: on niftyindices.com open ",
        h("b", "Reports → Historical Data"), ", download the index (price or total return), then import the file here. Any CSV with a Date and Close column works."))),
    h("div.card-pad.import-form",
      h("div.form-row",
        h("div.field", h("label.field-label", { for: ids.target }, "Index"), target),
        otherField),
      h("div.field", h("label.field-label", { for: ids.file }, "CSV file"), file),
      h("label.check", dayfirst, h("span", "Dates are day first (01-02-2026 = 1 Feb). niftyindices.com dates like \"01 Feb 2026\" work either way.")),
      h("label.check", useIt, useLabel),
      h("div.import-actions", go),
      result));
  return { el, focus: () => { el.scrollIntoView({ block: "start" }); target.focus({ preventScroll: true }); } };
}
