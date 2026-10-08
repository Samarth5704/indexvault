// Data table with virtual scrolling (only visible rows are in the DOM), sticky
// header, click-to-sort, per-column menu (sort / move / hide) and jump-to-date.
// DESIGN § 3: numbers right-aligned in mono, negatives in --loss with a − sign.

import { h, icon, onOutsideClick } from "../dom.js";

const OVERSCAN = 12;

/**
 * dataTable({label, formatCell(colId, v), onColumnsChange(ids)})
 * setData({columns: [{id, label, kind}], rows: [[...]]}) — first column is the date.
 * Returns {el, setData, scrollToDate(iso), view(), destroy}.
 */
export function dataTable({ label = "Data", formatCell = (_, v) => v, onColumnsChange = () => {} }) {
  const thead = h("thead");
  const tbody = h("tbody");
  const table = h("table.data-table.vtable-table", thead, tbody);
  const scroller = h("div.vtable-scroll", { tabindex: "0", role: "region", "aria-label": label }, table);
  const status = h("p.sr-only", { "aria-live": "polite" });
  const el = h("div.vtable", scroller, status);

  let columns = [], rows = [], order = [], sort = null, rowH = 36, highlight = -1, closeMenu = null;

  function measure() {
    rowH = parseFloat(getComputedStyle(el).getPropertyValue("--row-h")) || 36;
  }

  // ---------------------------------------------------------------- sorting
  function applySort() {
    order = rows.map((_, i) => i);
    if (!sort) return;
    const { index, dir } = sort;
    const sign = dir === "asc" ? 1 : -1;
    order.sort((a, b) => {
      const x = rows[a][index], y = rows[b][index];
      if (x == null && y == null) return a - b;
      if (x == null) return 1; // missing values always last
      if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sign || a - b;
    });
  }

  function setSort(index, dir) {
    sort = dir ? { index, dir } : null;
    applySort();
    renderHead();
    renderBody();
    status.textContent = sort ? `Sorted by ${columns[index].label}, ${dir === "asc" ? "ascending" : "descending"}` : "Sort cleared";
  }

  function cycleSort(index) {
    const cur = sort?.index === index ? sort.dir : null;
    setSort(index, cur === null ? (index === 0 ? "desc" : "asc") : cur === "asc" ? "desc" : null);
  }

  // ---------------------------------------------------------------- header + menu
  function renderHead() {
    thead.replaceChildren(h("tr", { "aria-rowindex": "1" }, columns.map((c, i) => {
      const dir = sort?.index === i ? sort.dir : null;
      return h("th", { scope: "col", "aria-sort": dir ? (dir === "asc" ? "ascending" : "descending") : "none", "data-kind": c.kind },
        h("div.th-inner",
          h("button.th-sort", { type: "button", onclick: () => cycleSort(i), title: `Sort by ${c.label}` },
            h("span.truncate", c.label),
            h("span.sort-ind", { "aria-hidden": "true" }, dir === "asc" ? "▲" : dir === "desc" ? "▼" : "")),
          i > 0 && h("button.th-menu.icon-btn.sm", { type: "button", "aria-label": `${c.label} column options`, "aria-haspopup": "menu",
            onclick: (e) => openMenu(i, e.currentTarget) }, icon("more", { size: "sm" }))));
    })));
  }

  function openMenu(index, anchor) {
    closeMenu?.();
    const c = columns[index];
    const ids = columns.slice(1).map((x) => x.id);
    const pos = index - 1;
    const move = (delta) => {
      const next = [...ids];
      next.splice(pos + delta, 0, next.splice(pos, 1)[0]);
      onColumnsChange(next);
    };
    const items = [
      ["Sort ascending", "arrow-up", () => setSort(index, "asc")],
      ["Sort descending", "arrow-down", () => setSort(index, "desc")],
      pos > 0 && ["Move left", "chevron-left", () => move(-1)],
      pos < ids.length - 1 && ["Move right", "chevron-right", () => move(1)],
      ids.length > 1 && ["Hide column", "eye-off", () => onColumnsChange(ids.filter((x) => x !== c.id))],
    ].filter(Boolean);
    const menu = h("div.popover.menu", { role: "menu", "aria-label": `${c.label} options` },
      items.map(([text, ic, fn]) => h("button.menu-item", { type: "button", role: "menuitem",
        onclick: () => { close(); fn(); } }, icon(ic, { size: "sm" }), text)));
    const rect = anchor.getBoundingClientRect();
    Object.assign(menu.style, { position: "fixed", top: `${rect.bottom + 4}px`, left: `${Math.max(8, rect.right - 180)}px` });
    document.body.append(menu);
    const buttons = [...menu.querySelectorAll("button")];
    buttons[0].focus();
    menu.addEventListener("keydown", (e) => {
      const i = buttons.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { buttons[(i + 1) % buttons.length].focus(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { buttons[(i - 1 + buttons.length) % buttons.length].focus(); e.preventDefault(); }
      else if (e.key === "Escape") { close(); anchor.focus(); e.stopPropagation(); }
    });
    const stop = onOutsideClick(menu, () => close(), anchor);
    function close() { stop(); menu.remove(); closeMenu = null; }
    closeMenu = close;
  }

  // ---------------------------------------------------------------- body (virtual)
  function cell(c, v) {
    if (c.kind === "date") return h("td.td-date", formatCell(c.id, v));
    const neg = typeof v === "number" && v < 0;
    return h(`td.num${neg ? ".neg" : ""}`, formatCell(c.id, v));
  }

  function renderBody() {
    const n = order.length;
    const viewH = scroller.clientHeight || 600;
    const first = Math.max(0, Math.floor(scroller.scrollTop / rowH) - OVERSCAN);
    const last = Math.min(n, first + Math.ceil(viewH / rowH) + OVERSCAN * 2);
    const span = columns.length;
    const out = [h("tr.vt-spacer", { "aria-hidden": "true" }, h("td", { colspan: span, style: { height: `${first * rowH}px` } }))];
    for (let k = first; k < last; k++) {
      const r = rows[order[k]];
      out.push(h("tr", { "aria-rowindex": String(k + 2), "data-highlight": order[k] === highlight ? "true" : null },
        columns.map((c, i) => cell(c, r[i]))));
    }
    out.push(h("tr.vt-spacer", { "aria-hidden": "true" }, h("td", { colspan: span, style: { height: `${(n - last) * rowH}px` } })));
    tbody.replaceChildren(...out);
  }

  // Scroll events already arrive at most once per frame, so render directly
  // (no rAF: it would leave blank rows in a page that isn't painting yet).
  scroller.addEventListener("scroll", renderBody, { passive: true });
  const onTheme = () => { measure(); renderBody(); };
  document.addEventListener("iv:themechange", onTheme);
  const resize = new ResizeObserver(() => renderBody());
  resize.observe(scroller);

  return {
    el,
    setData(data) {
      const sortedId = sort ? columns[sort.index]?.id : null;
      columns = data.columns;
      rows = data.rows;
      table.setAttribute("aria-rowcount", String(rows.length + 1));
      table.setAttribute("aria-colcount", String(columns.length));
      const idx = columns.findIndex((c) => c.id === sortedId);
      sort = sort && idx >= 0 ? { index: idx, dir: sort.dir } : null;
      highlight = -1;
      measure();
      applySort();
      renderHead();
      renderBody();
    },
    /** Scroll to the first row on/after `iso` (or the nearest date when sorted by another column). */
    scrollToDate(iso) {
      if (!rows.length) return null;
      let best = -1, bestGap = Infinity;
      rows.forEach((r, i) => {
        const gap = Math.abs(Date.parse(r[0]) - Date.parse(iso));
        if (gap < bestGap || (gap === bestGap && r[0] >= iso)) { best = i; bestGap = gap; }
      });
      highlight = best;
      const pos = order.indexOf(best);
      scroller.scrollTop = Math.max(0, pos * rowH - scroller.clientHeight / 3);
      renderBody();
      status.textContent = `Jumped to ${rows[best][0]}`;
      return rows[best][0];
    },
    /** Current columns and rows in display (sorted) order — for copy/export. */
    view: () => ({ columns, rows: order.map((i) => rows[i]) }),
    destroy() {
      closeMenu?.();
      resize.disconnect();
      document.removeEventListener("iv:themechange", onTheme);
    },
  };
}
