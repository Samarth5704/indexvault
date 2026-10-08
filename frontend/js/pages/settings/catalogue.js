// Catalogue & watchlists (SPEC § 3.10 #5): custom indices (add/edit/delete, test the
// ticker), watchlists (create, edit, reorder, delete) and JSON import/export.

import { api, enc } from "../../api.js";
import { downloadBlob } from "../../components/chart-card.js";
import { confirmDialog } from "../../components/confirm.js";
import { openDrawer } from "../../components/drawer.js";
import { seriesName } from "../../components/series-picker.js";
import { toast, toastError } from "../../components/toast.js";
import { h, icon, nextId } from "../../dom.js";
import { format } from "../../settings.js";
import { store } from "../../store.js";
import { fieldMessage, searchText } from "./schema-section.js";

const KIND = "indexvault-catalog";

const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "item";
const uniqueId = (stem, taken) => { let id = stem; for (let i = 2; taken.has(id); i++) id = `${stem.slice(0, 28)}-${i}`; return id; };
const customIndices = () => store.get().catalog.categories.flatMap((c) => c.items.filter((i) => i.custom).map((i) => ({ ...i, category: c.name })));
const sources = () => store.get().health?.sources || [];

async function refreshCatalog() {
  api.invalidate("/catalog");
  store.set({ catalog: await api.get("/catalog", null, { fresh: true }) });
}

export function catalogueSection(ctx) {
  const indicesEl = h("div.catalogue-block", { "data-search": searchText("custom indices index ticker add category source") });
  const watchEl = h("div.catalogue-block", { "data-search": searchText("watchlists watchlist reorder tickers market pulse") });
  const ioEl = h("div.catalogue-io", { "data-search": searchText("import export catalogue json") });
  const fileInput = h("input", { type: "file", accept: "application/json,.json", hidden: true, onchange: () => importFile(fileInput.files[0]) });

  function render() {
    renderIndices();
    renderWatchlists();
  }

  // ------------------------------------------------------------ custom indices
  function renderIndices() {
    const items = customIndices();
    indicesEl.replaceChildren(
      h("div.block-head", h("div", h("p.field-label", "Custom indices"), h("p.field-hint", "Any Yahoo ticker (stocks, ETFs, other indices) or a CSV import, listed in the series picker.")),
        h("button.btn.secondary.sm", { type: "button", onclick: () => editIndex() }, icon("plus", { size: "sm" }), "Add index")),
      items.length
        ? h("div.table-wrap", h("table.data-table.catalogue-table",
          h("thead", h("tr", ["Name", "Ticker", "Category", "Source", ""].map((c) => h("th", { scope: "col" }, c)))),
          h("tbody", items.map((i) => h("tr",
            h("td", i.name), h("td.mono", i.ticker), h("td", i.category), h("td", h("span.source-tag", i.source)),
            h("td.row-actions",
              h("button.icon-btn.sm", { type: "button", "aria-label": `Edit ${i.name}`, onclick: () => editIndex(i) }, icon("edit", { size: "sm" })),
              h("button.icon-btn.sm", { type: "button", "aria-label": `Delete ${i.name}`, onclick: () => deleteIndex(i) }, icon("trash", { size: "sm" }))))))))
        : h("p.muted.block-empty", "No custom indices yet. The built-in catalogue has about 35 Indian indices."));
  }

  function editIndex(item = null) {
    const categories = [...new Set(store.get().catalog.categories.map((c) => c.name))];
    const f = {
      name: h("input.input", { value: item?.name || "", maxlength: 60, placeholder: "e.g. Nippon India ETF Nifty BeES" }),
      ticker: h("input.input.mono", { value: item?.ticker || "", maxlength: 40, placeholder: "e.g. NIFTYBEES.NS", spellcheck: "false" }),
      category: h("input.input", { value: item?.category || "Custom", maxlength: 40, list: "cat-options" }),
      source: h("select.select", sources().map((s) => h("option", { value: s.name, selected: s.name === (item?.source || "yahoo") }, s.label))),
    };
    const error = h("p.field-error", { role: "alert" });
    const testOut = h("p.field-hint", { "aria-live": "polite" });
    const field = (label, input, hint) => { const id = nextId("ci"); input.id = id; return h("div.field", h("label.field-label", { for: id }, label), input, hint && h("p.field-hint", hint)); };
    const testBtn = h("button.btn.secondary.sm", { type: "button", onclick: test }, icon("health", { size: "sm" }), "Test ticker");
    async function test() {
      const t = f.ticker.value.trim();
      if (!t) return;
      testBtn.disabled = true;
      testOut.textContent = "Checking…";
      try {
        const s = await api.get(`/series/${enc(t)}`, { period: "1M", columns: "close", source: f.source.value }, { fresh: true, timeout: 60_000 });
        const last = s.rows.filter((r) => r[1] != null).at(-1);
        testOut.textContent = last ? `✓ Found: last close ${format.number(last[1])} on ${format.date(last[0])}.` : "No recent rows for this ticker.";
      } catch (e) { testOut.textContent = `✗ ${e.message}`; }
      testBtn.disabled = false;
    }
    const save = h("button.btn.primary", { type: "button" }, item ? "Save changes" : "Add index");
    const close = openDrawer({
      title: item ? `Edit ${item.name}` : "Add a custom index",
      body: h("form.drawer-form", { onsubmit: (e) => { e.preventDefault(); save.click(); } },
        field("Name", f.name), field("Ticker", f.ticker, "Yahoo symbol. NSE stocks end in .NS, BSE in .BO; indices start with ^."),
        h("div", testBtn, testOut), field("Category", f.category, "Groups it in the series picker."),
        h("datalist#cat-options", categories.map((c) => h("option", { value: c }))), field("Source", f.source), error,
        h("button", { type: "submit", hidden: true })),
      footer: h("div.drawer-actions", h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"), save),
    });
    save.addEventListener("click", async () => {
      const body = { name: f.name.value.trim(), ticker: f.ticker.value.trim(), category: f.category.value.trim() || "Custom", source: f.source.value };
      if (!body.name || !body.ticker) { error.textContent = "Name and ticker are required."; return; }
      save.disabled = true;
      try {
        const taken = new Set(customIndices().map((i) => i.id));
        if (item) await api.put(`/catalog/indices/${enc(item.id)}`, body);
        else await api.post(`/catalog/indices/${enc(uniqueId(slugify(body.name), taken))}`, body);
        await refreshCatalog();
        close();
        toast({ tone: "success", title: item ? "Index updated" : `Added ${body.name}` });
      } catch (e) {
        error.textContent = fieldMessage(e, "ticker");
        save.disabled = false;
      }
    });
  }

  async function deleteIndex(i) {
    const ok = await confirmDialog({ title: `Delete ${i.name}?`, danger: true, confirmLabel: "Delete",
      message: "It's removed from the catalogue. Cached data for the ticker stays on disk (clear it from the Cache page)." });
    if (!ok) return;
    try {
      await api.del(`/catalog/indices/${enc(i.id)}`);
      await refreshCatalog();
    } catch (e) { toastError(e, "Couldn't delete"); }
  }

  // ------------------------------------------------------------ watchlists
  function renderWatchlists() {
    const lists = store.get().catalog.watchlists;
    watchEl.replaceChildren(
      h("div.block-head", h("div", h("p.field-label", "Watchlists"), h("p.field-hint", "Quick-pick tabs in the series picker. The first one feeds the market-pulse strip.")),
        h("button.btn.secondary.sm", { type: "button", onclick: () => editWatchlist() }, icon("plus", { size: "sm" }), "New watchlist")),
      lists.length
        ? h("ol.item-list.watchlists", lists.map((w, i) => h("li.item-row",
          h("div.order-btns",
            h("button.icon-btn.sm", { type: "button", disabled: i === 0, "aria-label": `Move ${w.name} up`, onclick: () => reorder(i, -1) }, icon("arrow-up", { size: "sm" })),
            h("button.icon-btn.sm", { type: "button", disabled: i === lists.length - 1, "aria-label": `Move ${w.name} down`, onclick: () => reorder(i, 1) }, icon("arrow-down", { size: "sm" }))),
          h("div.item-main", h("span.item-name", w.name, i === 0 && h("span.source-tag", "Market pulse")),
            h("span.muted.truncate", w.tickers.length ? w.tickers.map(seriesName).join(" · ") : "Empty")),
          h("div.row-actions",
            h("button.icon-btn.sm", { type: "button", "aria-label": `Edit ${w.name}`, onclick: () => editWatchlist(w) }, icon("edit", { size: "sm" })),
            h("button.icon-btn.sm", { type: "button", "aria-label": `Delete ${w.name}`, onclick: () => deleteWatchlist(w) }, icon("trash", { size: "sm" }))))))
        : h("p.muted.block-empty", "No watchlists yet. Group the series you check most, e.g. “Sectors I track”."));
  }

  async function reorder(i, d) {
    const ids = store.get().catalog.watchlists.map((w) => w.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    try {
      await api.put("/catalog/watchlists/order", { ids });
      await refreshCatalog();
    } catch (e) { toastError(e, "Couldn't reorder"); }
  }

  function editWatchlist(w = null) {
    const chosen = new Set(w?.tickers || []);
    const order = [...(w?.tickers || [])];
    const nameIn = h("input.input#wl-name", { value: w?.name || "", maxlength: 60, placeholder: "e.g. Sectors I track" });
    const filterIn = h("input.input", { type: "search", placeholder: "Filter series", "aria-label": "Filter series" });
    const count = h("span.muted");
    const list = h("div.wl-options");
    const error = h("p.field-error", { role: "alert" });
    const renderList = () => {
      const q = filterIn.value.trim().toLowerCase();
      count.textContent = `${chosen.size} of 50 selected`;
      list.replaceChildren(...store.get().catalog.categories.map((c) => {
        const items = c.items.filter((i) => !q || `${i.name} ${i.ticker}`.toLowerCase().includes(q));
        return items.length ? h("fieldset.wl-group", h("legend", c.name), items.map((i) => h("label.check",
          h("input", { type: "checkbox", checked: chosen.has(i.ticker), onchange: (e) => {
            if (e.target.checked) { chosen.add(i.ticker); order.push(i.ticker); } else { chosen.delete(i.ticker); order.splice(order.indexOf(i.ticker), 1); }
            count.textContent = `${chosen.size} of 50 selected`;
          } }), h("span", i.name), h("span.mono.muted", i.ticker)))) : null;
      }).filter(Boolean));
      if (!list.childElementCount) list.append(h("p.muted", "No series match."));
    };
    filterIn.addEventListener("input", renderList);
    renderList();
    const save = h("button.btn.primary", { type: "button" }, w ? "Save changes" : "Create watchlist");
    const close = openDrawer({
      title: w ? `Edit ${w.name}` : "New watchlist",
      body: h("div.drawer-form", h("div.field", h("label.field-label", { for: "wl-name" }, "Name"), nameIn),
        h("div.block-head", filterIn, count), list, error),
      footer: h("div.drawer-actions", h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"), save),
    });
    save.addEventListener("click", async () => {
      const body = { name: nameIn.value.trim(), tickers: order };
      if (!body.name) { error.textContent = "Give the watchlist a name."; return; }
      save.disabled = true;
      try {
        const taken = new Set(store.get().catalog.watchlists.map((x) => x.id));
        if (w) await api.put(`/catalog/watchlists/${enc(w.id)}`, body);
        else await api.post(`/catalog/watchlists/${enc(uniqueId(slugify(body.name), taken))}`, body);
        await refreshCatalog();
        close();
        toast({ tone: "success", title: w ? "Watchlist saved" : `Created “${body.name}”` });
      } catch (e) {
        error.textContent = fieldMessage(e, "tickers");
        save.disabled = false;
      }
    });
  }

  async function deleteWatchlist(w) {
    const ok = await confirmDialog({ title: `Delete “${w.name}”?`, danger: true, confirmLabel: "Delete", message: "Only the list is deleted; the series and their data stay." });
    if (!ok) return;
    try {
      await api.del(`/catalog/watchlists/${enc(w.id)}`);
      await refreshCatalog();
    } catch (e) { toastError(e, "Couldn't delete"); }
  }

  // ------------------------------------------------------------ import / export
  function exportCatalogue() {
    const custom_indices = customIndices().map(({ id, name, ticker, category, source }) => ({ id, name, ticker, category, source }));
    const json = JSON.stringify({ kind: KIND, version: 1, custom_indices, watchlists: store.get().catalog.watchlists }, null, 2);
    downloadBlob("indexvault-catalogue.json", new Blob([json], { type: "application/json" }));
  }

  async function importFile(file) {
    fileInput.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const src = data.kind === "indexvault-backup" ? data.catalog : data; // a full backup works too
      const indices = Array.isArray(src?.custom_indices) ? src.custom_indices : [];
      const lists = Array.isArray(src?.watchlists) ? src.watchlists : [];
      if (!indices.length && !lists.length) throw new Error("No custom indices or watchlists in this file.");
      const ok = await confirmDialog({ title: "Import catalogue?", confirmLabel: "Import",
        message: `${indices.length} custom ind${indices.length === 1 ? "ex" : "ices"} and ${lists.length} watchlist${lists.length === 1 ? "" : "s"} will be added. Entries with the same id are replaced; everything else is kept.` });
      if (!ok) return;
      const failed = [];
      for (const i of indices) await api.put(`/catalog/indices/${enc(i.id || slugify(i.name || i.ticker))}`, i).catch((e) => failed.push(`${i.name || i.ticker}: ${fieldMessage(e, "ticker")}`));
      for (const w of lists) await api.put(`/catalog/watchlists/${enc(w.id || slugify(w.name))}`, { name: w.name, tickers: w.tickers || [] }).catch((e) => failed.push(`${w.name}: ${fieldMessage(e, "tickers")}`));
      await refreshCatalog();
      toast(failed.length ? { tone: "warning", title: `Imported with ${failed.length} problem${failed.length > 1 ? "s" : ""}`, message: failed.join("\n") }
        : { tone: "success", title: "Catalogue imported" });
    } catch (e) { toastError(e, "Couldn't import the catalogue"); }
  }

  ioEl.append(
    h("button.btn.secondary.sm", { type: "button", onclick: () => fileInput.click() }, icon("download", { size: "sm" }), "Import JSON"),
    h("button.btn.secondary.sm", { type: "button", onclick: exportCatalogue }, icon("copy", { size: "sm" }), "Export JSON"),
    h("span.field-hint", "Share your indices and watchlists, or move them to another computer."), fileInput);

  const unsub = store.subscribe((s) => s.catalog, render);
  ctx.onCleanup(unsub);
  render();
  return [indicesEl, watchEl, ioEl];
}

