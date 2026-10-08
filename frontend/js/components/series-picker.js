// Series picker: chips (dot in the series' slot colour, never a coloured chip) +
// a dropdown with grouped fuzzy search, watchlist tabs, recent picks and full
// keyboard support (DESIGN § 3). Selection order fixes each series' colour slot.

import { h, icon, nextId, onOutsideClick } from "../dom.js";
import { fuzzyFilter } from "../fuzzy.js";
import { addSeries, MAX_SERIES, recentSeries, removeSeries, selection, SERIES_COLOURS, seriesColour, setSelection, store } from "../store.js";

/** ticker -> {ticker, name, category, source} from the merged catalogue. */
export function catalogIndex() {
  const out = new Map();
  for (const cat of store.get().catalog.categories) {
    for (const item of cat.items) if (!out.has(item.ticker)) out.set(item.ticker, { ...item, category: cat.name });
  }
  return out;
}

export const seriesName = (ticker) => catalogIndex().get(ticker)?.name || ticker;

export function seriesPicker({ inSheet = false } = {}) {
  const listId = nextId("picker-list");
  const chips = h("ul.chip-row", { "aria-label": "Selected series" });
  const search = h("input.input.picker-search", {
    type: "search", placeholder: "Search indices, tickers…", role: "combobox", autocomplete: "off",
    "aria-autocomplete": "list", "aria-expanded": "true", "aria-controls": listId, "aria-label": "Search series",
  });
  const tabs = h("div.picker-tabs", { role: "tablist", "aria-label": "Lists" });
  const list = h("ul.picker-list", { id: listId, role: "listbox", "aria-multiselectable": "true", "aria-label": "Series" });
  const hint = h("p.picker-hint");
  const panel = h("div.popover.picker-panel", { hidden: true }, search, tabs, list, hint);
  const addBtn = h("button.btn.ghost.sm.picker-add", { type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" },
    icon("plus", { size: "sm" }), h("span", "Add series"));
  const more = h("button.chip.chip-more", { type: "button", hidden: true, onclick: () => open() });
  const el = h("div.series-picker", { "data-in-sheet": inSheet ? "true" : null }, chips, more, h("div.picker-anchor", addBtn, panel));

  let tab = "all", active = 0, options = [], stopOutside = null;

  function renderChips() {
    const idx = catalogIndex();
    chips.replaceChildren(...selection().series.map((t, i) => {
      const name = idx.get(t)?.name || t;
      return h("li.chip", { title: `${name} (${t})${i >= SERIES_COLOURS ? " — beyond 8 series, shown in grey" : ""}` },
        h("span.chip-dot", { style: { background: seriesColour(t) }, "aria-hidden": "true" }),
        h("span.chip-label.truncate", name),
        h("button.chip-x", { type: "button", "aria-label": `Remove ${name}`, onclick: () => removeSeries(t) }, icon("x", { size: "sm" })));
    }));
    if (!selection().series.length) chips.append(h("li.chip-empty.muted", "No series selected"));
    requestAnimationFrame(markOverflow);
  }

  /** Chips that don't fit are hidden behind a "+N" chip, so no selection is ever invisible. */
  function markOverflow() {
    if (inSheet) return;
    const items = [...chips.querySelectorAll(".chip")];
    items.forEach((c) => { c.hidden = false; });
    more.hidden = true;
    if (chips.scrollWidth <= chips.clientWidth + 1) return;
    more.hidden = false;
    const limit = chips.getBoundingClientRect().right;
    const hiddenItems = items.filter((c) => c.getBoundingClientRect().right > limit + 1);
    hiddenItems.forEach((c) => { c.hidden = true; });
    more.textContent = `+${hiddenItems.length}`;
    more.setAttribute("aria-label", `${hiddenItems.length} more selected series: ${hiddenItems.map((c) => c.querySelector(".chip-label").textContent).join(", ")}. Open picker`);
    more.title = hiddenItems.map((c) => c.querySelector(".chip-label").textContent).join(", ");
  }

  function candidates() {
    const idx = catalogIndex();
    if (tab === "recent") return recentSeries().map((t) => idx.get(t) || { ticker: t, name: t, category: "Recent" });
    const wl = store.get().catalog.watchlists.find((w) => w.id === tab);
    if (wl) return wl.tickers.map((t) => ({ ...(idx.get(t) || { ticker: t, name: t }), category: wl.name }));
    return [...idx.values()];
  }

  function renderTabs() {
    const items = [["all", "All"], ["recent", "Recent"], ...store.get().catalog.watchlists.map((w) => [w.id, w.name])];
    tabs.replaceChildren(...items.map(([id, label]) => h("button.picker-tab", {
      type: "button", role: "tab", "aria-selected": String(tab === id), tabindex: tab === id ? "0" : "-1",
      onclick: () => { tab = id; active = 0; renderTabs(); renderList(); search.focus(); },
    }, label)));
  }

  function renderList() {
    const query = search.value;
    options = fuzzyFilter(candidates(), query, (o) => [o.name, o.ticker]);
    // A typed ticker that isn't in the catalogue can still be added.
    const typed = query.trim();
    if (typed && /^[A-Za-z0-9^=._&-]{1,40}$/.test(typed) && !options.some((o) => o.ticker.toLowerCase() === typed.toLowerCase())) {
      options.push({ ticker: typed.toUpperCase(), name: `Use "${typed.toUpperCase()}"`, category: "Custom ticker" });
    }
    active = Math.min(active, Math.max(0, options.length - 1));
    const sel = new Set(selection().series);
    const rows = [];
    let lastCat = null;
    options.forEach((o, i) => {
      if (!query.trim() && o.category !== lastCat) {
        rows.push(h("li.picker-group", { role: "presentation" }, o.category));
        lastCat = o.category;
      }
      rows.push(h("li.picker-option", {
        id: `${listId}-${i}`, role: "option", "aria-selected": String(sel.has(o.ticker)),
        "data-active": i === active ? "true" : null,
        onpointerdown: (e) => e.preventDefault(), // keep focus in the search box
        onclick: () => toggle(o.ticker),
        onpointermove: () => setActive(i),
      },
      h("span.picker-check", sel.has(o.ticker) ? icon("check", { size: "sm" }) : ""),
      h("span.picker-name.truncate", o.name),
      h("span.picker-ticker.mono", o.ticker)));
    });
    if (!options.length) rows.push(h("li.picker-none.muted", { role: "presentation" }, tab === "recent" ? "No recent picks yet." : "No matches."));
    list.replaceChildren(...rows);
    search.setAttribute("aria-activedescendant", options.length ? `${listId}-${active}` : "");
    const n = selection().series.length;
    hint.textContent = n > SERIES_COLOURS
      ? `${n} series: series 9+ are drawn in grey. Fewer series read better.`
      : `${n}/${MAX_SERIES} selected · ↑↓ to move, Enter to toggle, Esc to close`;
  }

  function setActive(i) {
    if (i === active) return;
    list.querySelector('[data-active="true"]')?.removeAttribute("data-active");
    active = i;
    const node = document.getElementById(`${listId}-${i}`);
    node?.setAttribute("data-active", "true");
    node?.scrollIntoView({ block: "nearest" });
    search.setAttribute("aria-activedescendant", node ? node.id : "");
  }

  function toggle(ticker) {
    if (selection().series.includes(ticker)) removeSeries(ticker);
    else if (!addSeries(ticker)) hint.textContent = `You can compare up to ${MAX_SERIES} series.`;
    renderList();
  }

  function open() {
    if (!panel.hidden) return;
    panel.hidden = false;
    addBtn.setAttribute("aria-expanded", "true");
    search.value = "";
    tab = "all";
    active = 0;
    renderTabs();
    renderList();
    search.focus();
    stopOutside = onOutsideClick(panel, close, addBtn);
  }

  function close({ focus = false } = {}) {
    if (panel.hidden) return;
    panel.hidden = true;
    addBtn.setAttribute("aria-expanded", "false");
    stopOutside?.();
    if (focus) addBtn.focus();
  }

  addBtn.addEventListener("click", () => (panel.hidden ? open() : close()));
  search.addEventListener("input", () => { active = 0; renderList(); });
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { setActive(Math.min(active + 1, options.length - 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp") { setActive(Math.max(active - 1, 0)); e.preventDefault(); }
    else if (e.key === "Enter" && options[active]) { toggle(options[active].ticker); e.preventDefault(); }
    else if (e.key === "Escape" && !inSheet) { close({ focus: true }); e.stopPropagation(); } // in a sheet, Esc closes the sheet
  });

  const unsubs = [
    store.subscribe((s) => s.selection.series, () => { renderChips(); if (!panel.hidden) renderList(); }),
    store.subscribe((s) => s.catalog, renderChips),
  ];
  const resize = new ResizeObserver(() => markOverflow());
  resize.observe(el);
  renderChips();
  return { el, open, destroy: () => { close(); resize.disconnect(); unsubs.forEach((u) => u()); } };
}

/** Replace the selection with a watchlist's tickers. */
export function useWatchlist(id) {
  const wl = store.get().catalog.watchlists.find((w) => w.id === id);
  if (wl) setSelection({ series: wl.tickers.slice(0, MAX_SERIES) });
}
