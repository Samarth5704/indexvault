// Widget grid (SPEC § 3.1): a 12-column CSS grid of cards with drag-to-move,
// a resize handle, and keyboard move/resize. Written from scratch — no library.
//
// widgetGrid({layout, render, limits, label, onChange, onRemove})
//   render(item) -> {el, destroy?}   the widget card (any [data-drag-handle] inside starts a drag)
//   limits(item) -> {minW, minH, maxW, maxH}
//   onChange(layout)                 after a move/resize is committed
//   onRemove(item)                   Delete key in edit mode
// Returns {el, setEditing(on), setLayout(layout), item(id), refresh(id), destroy()}.
//
// Edit mode, keyboard: focus a widget, arrows move it, Shift+arrows resize it,
// Delete removes it. Below 1024px widgets stack in one column (no arranging).

import { h, prefersReducedMotion } from "../dom.js";
import { COLS, keyboardMove, sortByPosition, update } from "../grid-layout.js";

const STACK_QUERY = window.matchMedia("(max-width: 1023px)");
const EDGE = 64; // px from the viewport edge that auto-scrolls while dragging

export function widgetGrid({ layout, render, limits = () => ({}), label = "Widgets", onChange, onRemove }) {
  let items = layout.map((i) => ({ ...i }));
  let editing = false;
  const cells = new Map(); // id -> {cell, inst}
  const live = h("p.sr-only", { "aria-live": "polite" });
  const el = h("div.wg-grid", { role: "list", "aria-label": label });
  const root = h("div.wg-root", el, live);

  // ------------------------------------------------------------ cells
  function mountCell(item) {
    const inst = render(item);
    const resize = h("span.wg-resize", { "aria-hidden": "true", title: "Drag to resize" });
    const cell = h("div.wg-item", { role: "listitem", "data-id": item.id }, inst.el, resize);
    cell.addEventListener("keydown", (e) => onKey(e, item.id));
    cell.addEventListener("pointerdown", (e) => {
      if (!editing || STACK_QUERY.matches || e.button !== 0) return;
      if (e.target === resize) startResize(e, item.id);
      else if (e.target.closest("[data-drag-handle]")) startDrag(e, item.id);
    });
    cells.set(item.id, { cell, inst });
    return cell;
  }

  function place() {
    const order = sortByPosition(items);
    for (const item of items) {
      const { cell } = cells.get(item.id);
      cell.style.gridColumn = `${item.x + 1} / span ${item.w}`;
      cell.style.gridRow = `${item.y + 1} / span ${item.h}`;
      cell.style.order = String(order.indexOf(item)); // reading order when stacked
      cell.style.setProperty("--h", item.h);
      cell.tabIndex = editing ? 0 : -1;
      cell.setAttribute("aria-label", describe(item));
    }
  }

  function describe(item) {
    const name = cells.get(item.id)?.inst.title?.() || item.widget;
    return editing
      ? `${name}. Column ${item.x + 1}, row ${item.y + 1}, ${item.w} wide, ${item.h} tall. Arrow keys move, Shift and arrows resize, Delete removes.`
      : name;
  }

  /** Re-place with a FLIP animation so neighbours glide to their new spots. */
  function relayout(next, { skip = null } = {}) {
    const before = new Map([...cells].map(([id, c]) => [id, c.cell.getBoundingClientRect()]));
    items = next;
    place();
    if (prefersReducedMotion()) return;
    for (const [id, { cell }] of cells) {
      if (id === skip) continue;
      const a = before.get(id), b = cell.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (!dx && !dy) continue;
      cell.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
  }

  // ------------------------------------------------------------ geometry
  function metrics() {
    const cs = getComputedStyle(el);
    const gap = parseFloat(cs.columnGap) || 16;
    const row = parseFloat(cs.gridAutoRows) || 80;
    const rect = el.getBoundingClientRect();
    return { rect, colPitch: (rect.width + gap) / COLS, rowPitch: row + parseFloat(cs.rowGap || gap) };
  }

  function autoScroll(clientY) {
    if (clientY > innerHeight - EDGE) scrollBy(0, 14);
    else if (clientY < EDGE + 56) scrollBy(0, -14); // 56 = sticky top bar
  }

  // ------------------------------------------------------------ drag to move
  function startDrag(e, id) {
    e.preventDefault();
    const { cell } = cells.get(id);
    const m = metrics();
    const r = cell.getBoundingClientRect();
    const grab = { x: e.clientX - r.left, y: e.clientY - r.top };
    const start = items.map((i) => ({ ...i })); // every step is computed from here, so pushes never pile up
    cell.classList.add("wg-dragging");
    el.classList.add("wg-active");
    cell.setPointerCapture(e.pointerId);

    const move = (ev) => {
      autoScroll(ev.clientY);
      const rect = el.getBoundingClientRect();
      const x = Math.round((ev.clientX - rect.left - grab.x) / m.colPitch);
      const y = Math.max(0, Math.round((ev.clientY - rect.top - grab.y) / m.rowPitch));
      const cur = items.find((i) => i.id === id);
      if (x === cur.x && y === cur.y) return;
      relayout(update(start, id, { x, y }, limits(cur)), { skip: id });
    };
    const end = (ev) => {
      cell.removeEventListener("pointermove", move);
      cell.removeEventListener("pointerup", end);
      cell.removeEventListener("pointercancel", end);
      cell.classList.remove("wg-dragging");
      el.classList.remove("wg-active");
      if (ev.type === "pointercancel") relayout(start);
      else commit(id, "Moved");
    };
    cell.addEventListener("pointermove", move);
    cell.addEventListener("pointerup", end);
    cell.addEventListener("pointercancel", end);
  }

  // ------------------------------------------------------------ drag to resize
  function startResize(e, id) {
    e.preventDefault();
    const { cell } = cells.get(id);
    const m = metrics();
    const handle = e.target;
    const start = items.map((i) => ({ ...i })); // every step is computed from here, so pushes never pile up
    handle.setPointerCapture(e.pointerId);
    cell.classList.add("wg-resizing");
    el.classList.add("wg-active");
    const move = (ev) => {
      autoScroll(ev.clientY);
      const r = cell.getBoundingClientRect();
      const cur = items.find((i) => i.id === id);
      const w = Math.max(1, Math.round((ev.clientX - r.left) / m.colPitch));
      const hgt = Math.max(1, Math.round((ev.clientY - r.top) / m.rowPitch));
      if (w === cur.w && hgt === cur.h) return;
      relayout(update(start, id, { w, h: hgt }, limits(cur)), { skip: id });
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      cell.classList.remove("wg-resizing");
      el.classList.remove("wg-active");
      commit(id, "Resized");
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  // ------------------------------------------------------------ keyboard
  const KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  function onKey(e, id) {
    if (!editing || e.target !== cells.get(id).cell) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onRemove?.(items.find((i) => i.id === id));
      return;
    }
    const d = KEYS[e.key];
    if (!d || STACK_QUERY.matches) return;
    e.preventDefault();
    const cur = items.find((i) => i.id === id);
    const patch = e.shiftKey ? { w: cur.w + d[0], h: cur.h + d[1] } : keyboardMove(items, id, d[0], d[1]);
    relayout(update(items, id, patch, limits(cur)));
    commit(id, e.shiftKey ? "Resized" : "Moved");
    cells.get(id).cell.focus();
  }

  function commit(id, verb) {
    const item = items.find((i) => i.id === id);
    live.textContent = `${verb}: ${describe(item).split(". Arrow")[0]}.`;
    onChange?.(items.map((i) => ({ ...i })));
  }

  // ------------------------------------------------------------ public
  function setLayout(next) {
    const keep = new Set(next.map((i) => i.id));
    for (const [id, { cell, inst }] of cells) {
      if (keep.has(id)) continue;
      inst.destroy?.();
      cell.remove();
      cells.delete(id);
    }
    for (const item of next) {
      const old = items.find((i) => i.id === item.id);
      const existing = cells.get(item.id);
      if (existing && old && (old.widget !== item.widget || JSON.stringify(old.config) !== JSON.stringify(item.config))) {
        existing.inst.destroy?.(); // config changed: rebuild just this widget
        existing.cell.remove();
        cells.delete(item.id);
      }
      if (!cells.has(item.id)) el.append(mountCell(item));
    }
    relayout(next.map((i) => ({ ...i })));
  }

  for (const item of items) el.append(mountCell(item));
  place();
  const onStack = () => place();
  STACK_QUERY.addEventListener("change", onStack);

  return {
    el: root,
    setEditing(on) {
      editing = on;
      el.classList.toggle("wg-editing", on);
      place();
    },
    setLayout,
    /** Rebuild one widget (e.g. after a data-source change). */
    refresh(id) {
      const item = items.find((i) => i.id === id);
      const c = cells.get(id);
      if (!item || !c) return;
      c.inst.destroy?.();
      c.cell.remove();
      cells.delete(id);
      el.append(mountCell(item));
      place();
    },
    /** Store new config without rebuilding the widget (e.g. notes being typed). */
    setConfig(id, config) { items = items.map((i) => (i.id === id ? { ...i, config } : i)); },
    /** Rebuild every widget (data source, formats or catalogue changed). */
    refreshAll() { for (const item of items) this.refresh(item.id); },
    layout: () => items.map((i) => ({ ...i })),
    destroy() {
      STACK_QUERY.removeEventListener("change", onStack);
      for (const { inst } of cells.values()) inst.destroy?.();
    },
  };
}
