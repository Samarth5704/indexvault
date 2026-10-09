// Cache (SPEC § 3.9): what's downloaded, how fresh it is, per-row update /
// re-download / delete, "Update all" with live progress, and a ticker health check.
// Deletes always ask first (CLAUDE.md rule 10).

import { api, enc } from "../api.js";
import { confirmDialog } from "../components/confirm.js";
import { csvImportCard } from "../components/csv-import.js";
import { emptyState, errorState, skeleton, statusPill } from "../components/feedback.js";
import { seriesName } from "../components/series-picker.js";
import { runJobWithToast, toast, toastError } from "../components/toast.js";
import { h, icon } from "../dom.js";
import { format, settings } from "../settings.js";
import { store } from "../store.js";

const n0 = (v) => format.number(v, { decimals: 0 });
const size = (kb) => (kb >= 1024 ? `${format.number(kb / 1024, { decimals: 1 })} MB` : `${format.number(kb, { decimals: 0 })} KB`);

export default {
  mount(el, { route }) {
    const locationCard = h("section.card.cache-location");
    const tableCard = h("section.card");
    const checkCard = h("section.card");
    const importer = csvImportCard({ preselect: route.params.import || "", onDone: () => render() });
    el.append(h("header.page-head", h("div", h("h1", "Cache"),
      h("p.page-sub", "Everything IndexVault has downloaded, kept as CSV files on this computer."))),
    h("div.page-body", locationCard, tableCard, importer.el, checkCard));
    if ("import" in route.params) requestAnimationFrame(() => importer.focus()); // from "Import a CSV instead"

    let token = 0;
    const sources = () => store.get().health?.sources || [];
    const sourceLabel = (name) => (sources().find((s) => s.name === name)?.label || name).replace(/\s*\(.*\)$/, ""); // "Demo (synthetic)" -> "Demo"

    async function job(start, title, doneTitle) {
      try {
        await runJobWithToast(start, { title, doneTitle });
      } catch { /* the toast already shows the error */ }
      api.invalidate();
      render();
    }

    async function render() {
      const mine = ++token;
      tableCard.replaceChildren(h("div.card-pad", skeleton({ lines: 5, label: "Loading cache" })));
      let inv;
      try {
        inv = await api.get("/cache", null, { fresh: true });
      } catch (e) {
        if (mine === token) tableCard.replaceChildren(errorState(e, { onRetry: render }));
        return;
      }
      if (mine !== token) return;
      renderLocation(inv);
      renderTable(inv);
      if (!checkCard.childElementCount) renderCheckIntro();
    }

    function renderLocation(inv) {
      const bySource = Object.entries(inv.entries.reduce((acc, e) => ({ ...acc, [e.source]: (acc[e.source] || 0) + 1 }), {}));
      locationCard.replaceChildren(
        h("div.cache-loc-info",
          h("p.field-label", "Cache folder"),
          h("p.mono.cache-path", inv.cache_dir),
          h("p.muted", `${n0(inv.entries.length)} series · ${n0(inv.total_rows)} rows · ${size(inv.total_size_kb)}` +
            (bySource.length ? ` · ${bySource.map(([s, c]) => `${c} ${sourceLabel(s)}`).join(", ")}` : ""))),
        h("div.head-actions",
          h("button.btn.primary.sm", { type: "button", disabled: !inv.entries.length,
            title: "Each series from the source it uses now; left-over files and CSV imports are skipped",
            onclick: () => job(() => api.post("/cache/update", {}), "Updating cache", "Cache updated") },
          icon("refresh", { size: "sm" }), "Update all"),
          h("button.btn.ghost.sm", { type: "button", disabled: !inv.entries.length, onclick: deleteAll }, icon("trash", { size: "sm" }), "Delete all…")));
    }

    function renderTable(inv) {
      if (!inv.entries.length) {
        tableCard.replaceChildren(emptyState({ icon: "database", title: "Nothing cached yet",
          message: "Open any page with a series selected, or use Data Studio, and the data is downloaded and kept here." }));
        return;
      }
      const stale = settings().data.stale_after_hours;
      const rows = inv.entries.map((e) => {
        const ageH = (Date.now() - new Date(e.last_updated).getTime()) / 3.6e6;
        const override = store.get().catalog.source_overrides?.[e.ticker] === e.source;
        return h("tr", { "data-unused": e.in_use ? null : "true" },
          h("td", h("span.source-tag", sourceLabel(e.source))),
          h("td", seriesName(e.ticker), h("span.mono.muted", ` ${e.ticker}`),
            !e.in_use && h("span.cache-note", { title: "Not read by the app; the ticker now comes from another source" },
              ` · not used (now from ${sourceLabel(e.used_source)})`),
            override && h("span.cache-note", " · replaces its usual source ",
              h("button.link-btn", { type: "button", onclick: () => stopOverride(e.ticker) }, "stop"))),
          h("td.num", n0(e.rows)), h("td", format.date(e.first_date)), h("td", format.date(e.last_date)),
          h("td", { title: e.last_updated }, format.ago(e.last_updated), ageH > stale ? h("span.muted", " · stale") : ""),
          h("td.num", size(e.size_kb)),
          h("td.row-actions",
            h("button.btn.ghost.sm", { type: "button", title: "Fetch new rows since the last update",
              onclick: () => job(() => api.post("/cache/update", { source: e.source, tickers: [e.ticker] }), `Updating ${e.ticker}`, `${e.ticker} updated`) },
            icon("refresh", { size: "sm" }), "Update"),
            h("button.btn.ghost.sm", { type: "button", title: "Download the whole history again",
              onclick: () => redownload(e) }, icon("download", { size: "sm" }), "Re-download"),
            h("button.icon-btn.sm", { type: "button", "aria-label": `Delete ${e.ticker} from the ${e.source} cache`, onclick: () => deleteOne(e) },
              icon("trash", { size: "sm" }))));
      });
      tableCard.replaceChildren(h("header.card-head", h("div.card-titles", h("h3.card-title", "Cached series"),
        h("p.card-sub", `"Stale" = not updated in the last ${stale} h (Settings → Data)`))),
      h("div.table-wrap", h("table.data-table.cache-table",
        h("thead", h("tr", ["Source", "Series", "Rows", "From", "To", "Updated", "Size", ""].map((c) => h("th", { scope: "col" }, c)))),
        h("tbody", rows))));
    }

    async function redownload(e) {
      const ok = await confirmDialog({ title: `Re-download ${seriesName(e.ticker)}?`, confirmLabel: "Re-download",
        message: `Fetches every row again from ${sourceLabel(e.source)} (from ${format.date(e.first_date)}) and replaces the cached file. Use it if the data looks wrong.` });
      if (ok) job(() => api.post("/load", { tickers: [e.ticker], source: e.source, start: e.first_date, refresh: true }), `Re-downloading ${e.ticker}`, `${e.ticker} re-downloaded`);
    }

    async function deleteOne(e) {
      const ok = await confirmDialog({ title: `Delete ${seriesName(e.ticker)} from the cache?`, danger: true, confirmLabel: "Delete",
        message: `${n0(e.rows)} rows from ${sourceLabel(e.source)} will be removed from this computer. They'll be downloaded again the next time you use this series.` });
      if (!ok) return;
      try {
        await api.del(`/cache/${enc(e.source)}/${enc(e.ticker)}`);
        api.invalidate();
        toast({ tone: "success", title: `Deleted ${e.ticker}` });
      } catch (err) { toastError(err, "Couldn't delete"); }
      render();
    }

    async function stopOverride(ticker) {
      try {
        await api.del(`/catalog/overrides/${enc(ticker)}`);
        api.invalidate();
        store.set({ catalog: await api.get("/catalog", null, { fresh: true }) });
        toast({ tone: "success", title: `${seriesName(ticker)} uses its usual source again` });
      } catch (err) { toastError(err, "Couldn't change the source"); }
      render();
    }

    async function deleteAll() {
      const ok = await confirmDialog({ title: "Delete the whole cache?", danger: true, confirmLabel: "Delete everything",
        message: "Every cached series from every source will be removed from this computer. CSV imports are kept. Data is downloaded again when you next use it." });
      if (!ok) return;
      try {
        const r = await api.del("/cache", { params: { confirm: "true" } });
        api.invalidate();
        toast({ tone: "success", title: `Deleted ${r.deleted_files} files` });
      } catch (err) { toastError(err, "Couldn't delete"); }
      render();
    }

    // ------------------------------------------------------------ ticker health check
    function renderCheckIntro(result = null) {
      const src = h("select.select", { "aria-label": "Source to check" },
        sources().filter((s) => s.name !== "csv").map((s) => h("option", { value: s.name, selected: s.name === settings().data.source }, s.label)));
      const run = h("button.btn.secondary.sm", { type: "button" }, icon("health", { size: "sm" }), "Check tickers");
      run.addEventListener("click", async () => {
        run.disabled = true;
        const name = sources().find((s) => s.name === src.value);
        const slot = checkCard.querySelector(".check-results");
        slot.replaceChildren(skeleton({ lines: 6, label: name?.offline ? "Checking" : "Checking tickers (about a minute for Yahoo)" }));
        try {
          renderCheckIntro(await api.get("/tickers/check", { source: src.value }, { fresh: true, timeout: 180_000 }));
        } catch (e) {
          slot.replaceChildren(errorState(e));
          run.disabled = false;
        }
      });
      checkCard.replaceChildren(
        h("header.card-head", h("div.card-titles", h("h3.card-title", "Ticker health check"),
          h("p.card-sub", "Asks the source for recent data on every catalogue ticker. Yahoo sometimes renames or retires symbols.")),
        h("div.head-actions", src, run)),
        h("div.check-results.card-pad", result ? checkResults(result) : h("p.muted", "Not run yet.")));
    }

    function checkResults(r) {
      const failed = r.results.filter((x) => !x.ok);
      return h("div",
        h("p.check-summary", statusPill(failed.length ? "warning" : "good", `${r.ok} of ${r.checked} OK`),
          failed.length ? ` ${failed.length} ticker${failed.length > 1 ? "s" : ""} returned no recent data from ${sourceLabel(r.source)}.` : ` Every ticker returned recent data from ${sourceLabel(r.source)}.`),
        h("div.table-wrap.check-table", h("table.data-table",
          h("thead", h("tr", ["Series", "Ticker", "Status", "Details"].map((c) => h("th", { scope: "col" }, c)))),
          h("tbody", [...failed, ...r.results.filter((x) => x.ok)].map((x) => h("tr",
            h("td", x.name), h("td.mono", x.ticker), h("td", statusPill(x.ok ? "good" : "critical", x.ok ? "OK" : "Failed")), h("td.text-2", x.message)))))));
    }

    const here = (fn) => () => { if (store.get().route.page === "cache") fn(); };
    const unsubs = [store.subscribe((s) => s.settings?.data, here(render))];
    render();
    return () => { unsubs.forEach((u) => u()); token++; };
  },
};
