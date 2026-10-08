// Chart card: title/subtitle, hover/focus actions (table view, PNG, CSV, fullscreen),
// and loading / empty / error states (DESIGN § 3, CLAUDE.md rules 5–6).

import { h, icon } from "../dom.js";
import { format as fmt } from "../settings.js";
import { emptyState, errorState, skeleton } from "./feedback.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function downloadBlob(filename, blob) {
  const a = h("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

/** {columns, rows} -> CSV text (RFC 4180 quoting). */
export function toCSV({ columns, rows }) {
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [columns, ...rows].map((r) => r.map(cell).join(",")).join("\n");
}

function dataTable({ columns, rows, format = {} }) {
  return h("div.table-wrap", { tabindex: "0", role: "region", "aria-label": "Chart data" },
    h("table.data-table",
      h("thead", h("tr", columns.map((c) => h("th", { scope: "col" }, c)))),
      h("tbody", rows.map((r) => h("tr", r.map((v, i) => {
        const f = format[columns[i]] || (typeof v === "string" && ISO_DATE.test(v) ? fmt.date : null);
        return h(typeof v === "number" ? "td.num" : "td", f ? f(v) : v ?? "—");
      }))))));
}

/**
 * chartCard({title, subtitle, filename, data: () => ({columns, rows, format?}), png: () => Blob|Promise<Blob>})
 * Returns {el, body, loading(), empty(opts), error(err, retry), content(node)}.
 * Table view and CSV use `data`; PNG uses `png` (hidden when not provided).
 */
export function chartCard({ title, subtitle = "", filename = "chart", data = null, png = null }) {
  const body = h("div.chart-body");
  const tableSlot = h("div.chart-table", { hidden: true });
  let tableOn = false;

  const tableBtn = h("button.icon-btn.sm", { type: "button", "aria-pressed": "false", title: "View as table", "aria-label": "View as table",
    onclick: () => setTable(!tableOn) }, icon("table", { size: "sm" }));
  const actions = h("div.card-actions",
    data && tableBtn,
    png && h("button.icon-btn.sm", { type: "button", title: "Download PNG", "aria-label": "Download PNG",
      onclick: async () => downloadBlob(`${filename}.png`, await png()) }, icon("image", { size: "sm" })),
    data && h("button.icon-btn.sm", { type: "button", title: "Download CSV", "aria-label": "Download CSV",
      onclick: () => downloadBlob(`${filename}.csv`, new Blob([toCSV(data())], { type: "text/csv" })) }, icon("download", { size: "sm" })),
    h("button.icon-btn.sm", { type: "button", title: "Full screen", "aria-label": "Full screen",
      onclick: () => (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.()) }, icon("maximize", { size: "sm" })));

  const el = h("section.card.chart-card",
    h("header.card-head",
      h("div.card-titles", h("h3.card-title", title), subtitle && h("p.card-sub", subtitle)),
      actions),
    body, tableSlot);

  function setTable(on) {
    tableOn = on;
    tableBtn.setAttribute("aria-pressed", String(on));
    body.hidden = on;
    tableSlot.hidden = !on;
    if (on) tableSlot.replaceChildren(dataTable(data()));
  }

  const show = (node) => { setTable(false); body.replaceChildren(node); };
  return {
    el, body,
    loading: () => show(skeleton({ variant: "chart", label: `Loading ${title}` })),
    empty: (opts) => show(emptyState(opts)),
    error: (err, retry) => show(errorState(err, { onRetry: retry })),
    content: (node) => show(node),
  };
}
