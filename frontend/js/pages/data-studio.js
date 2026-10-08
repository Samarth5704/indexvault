// Data Studio (SPEC § 3.2): OHLCV + derived columns per series at the chosen
// frequency, in a virtual table; column builder; export panel; Markdown copy.
// Page params (linkable): t = active ticker, cols = column ids in display order.

import { api, enc } from "../api.js";
import { copyText } from "../clipboard.js";
import { columnKind, columnLabel, columnsFromParam, DEFAULT_COLUMNS, formatCell } from "../columns.js";
import { openColumnBuilder } from "../components/column-builder.js";
import { dataTable } from "../components/data-table.js";
import { openExportPanel } from "../components/export-panel.js";
import { emptyState, errorState, skeleton } from "../components/feedback.js";
import { seriesName } from "../components/series-picker.js";
import { runJobWithToast, toast } from "../components/toast.js";
import { h, icon } from "../dom.js";
import { setPageParams } from "../router.js";
import { format, settings } from "../settings.js";
import { rangeParams, selection, seriesColour, setSelection, store } from "../store.js";

const MARKDOWN_SOFT_LIMIT = 200;

/** Current view as a GitHub-flavoured Markdown table (formatted like the screen). */
export function toMarkdown({ columns, rows }) {
  const esc = (s) => String(s).replaceAll("|", "\\|");
  const head = `| ${columns.map((c) => esc(c.label)).join(" | ")} |`;
  const align = `|${columns.map((c) => (c.kind === "date" ? " --- " : " ---: ")).join("|")}|`;
  const body = rows.map((r) => `| ${columns.map((c, i) => esc(formatCell(c.id, r[i]))).join(" | ")} |`);
  return [head, align, ...body].join("\n");
}

export default {
  mount(el, ctx) {
    const params = () => store.get().route.params;
    const cols = () => columnsFromParam(params().cols) || [...DEFAULT_COLUMNS];
    const active = () => {
      const { series } = selection();
      return series.includes(params().t) ? params().t : series[0];
    };

    const tabs = h("div.series-tabs", { role: "tablist", "aria-label": "Series" });
    const meta = h("p.studio-meta.text-2", { "aria-live": "polite" });
    const caveats = h("div.caveats");
    const jumpInput = h("input.input", { type: "date", "aria-label": "Jump to date" });
    const jumpForm = h("form.jump", h("label.sr-only", "Jump to date"), jumpInput,
      h("button.btn.secondary.sm", { type: "submit" }, "Go"));
    const tableSlot = h("div.table-slot");
    const table = dataTable({
      label: "Price table",
      formatCell,
      onColumnsChange: (ids) => setPageParams({ ...params(), cols: ids.join(",") }),
    });

    const btn = (label, ic, onclick, extra = {}) =>
      h("button.btn.secondary.sm", { type: "button", onclick, "aria-label": label, ...extra }, icon(ic, { size: "sm" }), h("span.btn-label", label));
    const toolbar = h("div.studio-toolbar",
      jumpForm,
      h("div.studio-actions",
        btn("Columns", "columns", openBuilder, { "aria-haspopup": "dialog" }),
        btn("Copy Markdown", "copy", copyMarkdown),
        btn("Reload", "refresh", () => { loadedKey = null; refresh(); }),
        h("button.btn.primary.sm", { type: "button", onclick: openExport, "aria-haspopup": "dialog", "aria-label": "Export" },
          icon("download", { size: "sm" }), h("span.btn-label", "Export"))));

    el.append(
      h("header.page-head", h("div", h("h1", "Data Studio"),
        h("p.page-sub", "Prices and derived columns at any frequency. Sort, reshape and export exactly what you see."))),
      h("section.card.studio",
        h("div.studio-top", tabs, toolbar),
        h("div.studio-info", meta, caveats),
        tableSlot));

    // ------------------------------------------------------------ data loading
    let loadedKey = null, loading = null, token = 0, hasTable = false;

    /**
     * Make sure every selected series is downloaded for the range (live job toast if slow).
     * Concurrent callers for the same selection share one job, so /series never races it.
     */
    function ensureLoaded() {
      const key = JSON.stringify([selection().series, rangeParams(), settings().data.source]);
      if (key !== loadedKey) {
        loadedKey = key;
        loading = runJobWithToast(() => api.post("/load", { tickers: selection().series, ...rangeParams() }),
          { title: "Loading data", doneTitle: "Data loaded", quiet: true })
          .then(() => api.invalidate("/series"));
      }
      return loading;
    }

    async function refresh() {
      const { series, freq } = selection();
      renderTabs();
      if (!series.length) {
        hasTable = false;
        meta.textContent = "";
        caveats.replaceChildren();
        tableSlot.replaceChildren(emptyState({
          icon: "table", title: "Pick a series to see its data",
          message: "Choose one or more indices in the series picker. Each gets its own tab here.",
          action: { label: "Add series", onClick: ctx.openPicker },
        }));
        return;
      }
      const mine = ++token;
      const ticker = active();
      if (!hasTable) tableSlot.replaceChildren(skeleton({ lines: 8, label: "Loading table" }));
      tableSlot.setAttribute("aria-busy", "true");
      try {
        await ensureLoaded().catch(() => {}); // per-ticker errors are already in the toast
        const data = await api.get(`/series/${enc(ticker)}`, { ...rangeParams(), freq, columns: cols().join(",") });
        if (mine !== token) return;
        table.setData({
          columns: data.columns.map((id) => ({ id, label: columnLabel(id), kind: columnKind(id) })),
          rows: data.rows,
        });
        if (!hasTable) tableSlot.replaceChildren(table.el);
        hasTable = true;
        const m = data.meta;
        meta.textContent = `${seriesName(ticker)} · ${format.number(m.rows, { decimals: 0 })} rows · ${format.date(m.first)} → ${format.date(m.last)} · ${freq}`;
        caveats.replaceChildren(...m.caveats.map((c) => h("span.caveat", icon("info", { size: "sm" }), c)));
        jumpInput.min = m.first;
        jumpInput.max = m.last;
      } catch (e) {
        if (mine !== token) return;
        hasTable = false;
        meta.textContent = "";
        tableSlot.replaceChildren(errorState(e, { onRetry: refresh }));
      } finally {
        if (mine === token) tableSlot.removeAttribute("aria-busy");
      }
    }

    function renderTabs() {
      const { series } = selection();
      const cur = active();
      tabs.replaceChildren(...series.map((t) => h("button.series-tab", {
        type: "button", role: "tab", "aria-selected": String(t === cur), tabindex: t === cur ? "0" : "-1",
        onclick: () => setPageParams({ ...params(), t }),
      }, h("span.chip-dot", { style: { background: seriesColour(t) }, "aria-hidden": "true" }), seriesName(t))));
    }

    tabs.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
      const list = [...tabs.children];
      const i = list.indexOf(document.activeElement);
      const next = list[(i + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length];
      next?.focus();
      next?.click();
      e.preventDefault();
    });

    // ------------------------------------------------------------ actions
    jumpForm.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!jumpInput.value || !hasTable) return;
      const hit = table.scrollToDate(jumpInput.value);
      if (hit && hit !== jumpInput.value) toast({ title: `Nearest row: ${format.date(hit)}`, message: `No row on ${format.date(jumpInput.value)} at ${selection().freq} frequency.` });
    });

    function openBuilder() {
      openColumnBuilder({
        columns: cols(), settings: settings(), freq: selection().freq,
        onChange: (ids) => setPageParams({ ...params(), cols: ids.join(",") }),
      });
    }

    async function copyMarkdown() {
      if (!hasTable) return;
      const view = table.view();
      const how = await copyText(toMarkdown(view), { title: "Copy as Markdown" });
      if (how === "manual") return; // the copy dialog is showing
      const n = view.rows.length;
      toast(n > MARKDOWN_SOFT_LIMIT
        ? { tone: "warning", title: `Copied ${format.number(n, { decimals: 0 })} rows`, message: "That's long for a post. Try Monthly or Yearly frequency, or a shorter range." }
        : { tone: "success", title: `Copied ${n} rows as Markdown` });
    }

    function openExport() {
      openExportPanel({
        state: () => ({ tickers: selection().series, range: rangeParams(), freq: selection().freq, columns: cols() }),
        onApplyPreset: (p) => {
          if (p.tickers.length) setSelection({ series: p.tickers });
          setSelection({ freq: p.frequency });
          setPageParams({ ...params(), cols: p.columns.length ? p.columns.join(",") : undefined, t: undefined });
        },
      });
    }

    /** `export=1` (from the palette's "Export current view") opens the panel once. */
    function checkExportParam() {
      if (!params().export) return;
      setPageParams({ ...params(), export: undefined });
      queueMicrotask(openExport);
    }
    checkExportParam();

    const here = (fn) => () => { if (store.get().route.page === "data") fn(); }; // ignore while navigating away
    const unsubs = [
      store.subscribe((s) => s.selection, here(refresh)),
      store.subscribe((s) => s.route.params, here(() => { checkExportParam(); refresh(); })),
      store.subscribe((s) => s.settings?.data.source, () => { loadedKey = null; refresh(); }),
      store.subscribe((s) => s.settings?.formats, () => { if (hasTable) table.setData(table.view()); }),
    ];
    refresh();
    return () => { unsubs.forEach((u) => u()); table.destroy(); token++; };
  },
};
