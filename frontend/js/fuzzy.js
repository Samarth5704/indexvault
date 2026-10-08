// Fuzzy matching for the series picker and command palette.
// Score > 0 when every query character appears in order. Bonuses for contiguous
// runs, word starts and an exact prefix; shorter texts win ties.

export function fuzzyScore(query, text) {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 1000 - t.length;
  const idx = t.indexOf(q);
  if (idx >= 0) return 800 - idx - t.length / 10;
  let score = 0, ti = 0, run = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    run = found === ti ? run + 1 : 0;
    const wordStart = found === 0 || /[\s\-_./^&]/.test(t[found - 1]);
    score += 10 + run * 5 + (wordStart ? 15 : 0) - Math.min(found - ti, 10);
    ti = found + 1;
  }
  return Math.max(1, score - t.length / 10);
}

/** Filter + sort items by best score over the given text fields. */
export function fuzzyFilter(items, query, fields) {
  if (!query.trim()) return items;
  return items
    .map((item) => ({ item, score: Math.max(...fields(item).map((f) => fuzzyScore(query, f || ""))) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}
