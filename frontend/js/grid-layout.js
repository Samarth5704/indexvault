// Layout maths for the dashboard's 12-column widget grid (no DOM here).
// Items are {id, x, y, w, h, …} in grid cells. The layout is kept "compact":
// widgets float up until they touch the one above, so there are no holes.
// Moving or resizing one widget pushes whatever it lands on downwards.

export const COLS = 12;

const overlaps = (a, b) => a.id !== b.id && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const byPosition = (a, b) => a.y - b.y || a.x - b.x;
export const sortByPosition = (layout) => [...layout].sort(byPosition);
export const bottom = (layout) => layout.reduce((m, i) => Math.max(m, i.y + i.h), 0);

/** Keep an item inside the grid (and at least min size). */
export function clampItem(item, { minW = 1, minH = 1, maxW = COLS, maxH = 12 } = {}) {
  const w = Math.max(minW, Math.min(maxW, COLS, item.w));
  const h = Math.max(minH, Math.min(maxH, item.h));
  return { ...item, w, h, x: Math.max(0, Math.min(COLS - w, item.x)), y: Math.max(0, item.y) };
}

/** Float every item up as far as it goes, in reading order. */
export function compact(layout) {
  const order = sortByPosition(layout);
  const placed = [];
  for (const item of order) {
    const next = { ...item };
    while (next.y > 0 && !placed.some((p) => overlaps({ ...next, y: next.y - 1 }, p))) next.y--;
    // push down past anything already placed that it still overlaps
    let hit;
    while ((hit = placed.find((p) => overlaps(next, p)))) next.y = hit.y + hit.h;
    placed.push(next);
  }
  const byId = new Map(placed.map((p) => [p.id, p]));
  return layout.map((i) => byId.get(i.id));
}

/** Move/resize item `id` to `patch` ({x, y, w, h}); others make room and the grid compacts. */
export function update(layout, id, patch, limits) {
  const before = layout.find((i) => i.id === id);
  const moved = layout.map((i) => (i.id === id ? clampItem({ ...i, ...patch }, limits) : i));
  const target = moved.find((i) => i.id === id);
  // What it lands on makes way. A widget that fits in the spot just vacated swaps
  // into it (so equal cards trade places); others hop above it when moving down,
  // or go below it. Then everything floats up again (gravity), which is why a
  // widget dropped into empty space settles under the one above it.
  const down = target.y > before.y;
  let swapped = false;
  const shifted = moved.map((i) => {
    if (!overlaps(i, target)) return i;
    const intoOldSpot = { ...i, x: before.x, y: before.y };
    if (!swapped && i.w <= before.w && i.h <= before.h && !overlaps(intoOldSpot, target)) {
      swapped = true;
      return intoOldSpot;
    }
    const hop = down && i.w <= target.w; // a wider widget would bulldoze the row above, so it goes below instead
    return { ...i, y: hop ? Math.max(0, target.y - i.h) : target.y + target.h };
  });
  return compact(shifted);
}

/** First free spot for a w×h item, scanning rows from the top (falls back to the bottom). */
export function findSpot(layout, w, h) {
  const width = Math.min(w, COLS);
  for (let y = 0; y <= bottom(layout); y++) {
    for (let x = 0; x + width <= COLS; x++) {
      const probe = { id: "\0probe", x, y, w: width, h };
      if (!layout.some((i) => overlaps(probe, i))) return { x, y };
    }
  }
  return { x: 0, y: bottom(layout) };
}

export const sameLayout = (a, b) => a.length === b.length &&
  a.every((i, k) => ["id", "x", "y", "w", "h"].every((f) => i[f] === b[k][f]) && JSON.stringify(i.config) === JSON.stringify(b[k].config));

/**
 * Where an arrow key should move item `id`: one cell, or — when that cell is
 * taken — far enough to land on the neighbour's spot, so equal widgets swap.
 */
export function keyboardMove(layout, id, dx, dy) {
  const cur = layout.find((i) => i.id === id);
  const probe = { ...cur, x: cur.x + dx, y: Math.max(0, cur.y + dy) };
  const hit = layout.filter((i) => overlaps(probe, i)).sort(byPosition).at(dx < 0 || dy < 0 ? -1 : 0);
  if (!hit) return { x: probe.x, y: probe.y };
  if (dx) return { x: hit.h <= cur.h ? (dx > 0 ? Math.max(probe.x, hit.x + hit.w - cur.w) : Math.min(probe.x, hit.x)) : probe.x, y: cur.y };
  if (hit.w > cur.w) return { x: cur.x, y: dy > 0 ? hit.y + hit.h : Math.max(0, hit.y - cur.h) }; // hop over a wide one
  return { x: cur.x, y: dy > 0 ? Math.max(probe.y, hit.y + hit.h - cur.h) : Math.min(probe.y, hit.y) };
}
