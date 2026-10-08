// Largest-Triangle-Three-Buckets downsampling (Steinarsson, 2013) for long
// time series: keeps the visual shape (peaks, troughs, crashes) with far fewer
// points, so 20 years of daily data draws fast. Results are memoised per input
// array, so re-theming or re-rendering the same data costs nothing.

const memo = new WeakMap(); // data array -> Map(key -> result)

/**
 * lttb(points, threshold, {keep})  points: [{time, value}] sorted by time.
 * Returns at most `threshold` points (plus any whose time is in `keep`, e.g.
 * marker dates, which must stay so markers can attach). First/last always kept.
 */
export function lttb(points, threshold, { keep = null } = {}) {
  const n = points.length;
  if (threshold >= n || threshold < 3) return points;
  const key = `${threshold}|${keep ? [...keep].join(",") : ""}`;
  let cache = memo.get(points);
  if (cache?.has(key)) return cache.get(key);

  const out = [points[0]];
  const every = (n - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    // average of the next bucket = the third corner of the triangle
    const nextStart = Math.floor((i + 1) * every) + 1;
    const nextEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    let avgX = 0, avgY = 0, count = 0;
    for (let j = nextStart; j < nextEnd; j++) {
      const v = points[j].value;
      if (v == null) continue;
      avgX += j; avgY += v; count++;
    }
    if (count) { avgX /= count; avgY /= count; } else { avgX = nextStart; avgY = points[a].value ?? 0; }

    // pick the point in this bucket that makes the largest triangle with a and the average
    const start = Math.floor(i * every) + 1;
    const end = Math.floor((i + 1) * every) + 1;
    const ay = points[a].value ?? avgY;
    let best = start, bestArea = -1;
    for (let j = start; j < end; j++) {
      const v = points[j].value;
      if (v == null) continue;
      const area = Math.abs((a - avgX) * (v - ay) - (a - j) * (avgY - ay));
      if (area > bestArea) { bestArea = area; best = j; }
    }
    out.push(points[best]);
    a = best;
  }
  out.push(points[n - 1]);

  // The all-time high and low always survive (a crash low or max-drawdown trough
  // that vanished would misstate the chart), plus anything the caller must keep.
  let lo = 0, hi = 0;
  points.forEach((p, i) => {
    if (p.value == null) return;
    if (points[lo].value == null || p.value < points[lo].value) lo = i;
    if (points[hi].value == null || p.value > points[hi].value) hi = i;
  });
  const must = new Set([points[lo].time, points[hi].time, ...(keep || [])]);
  const have = new Set(out.map((p) => p.time));
  const extra = points.filter((p) => must.has(p.time) && !have.has(p.time));
  const result = extra.length ? [...out, ...extra].sort((p, q) => (p.time < q.time ? -1 : p.time > q.time ? 1 : 0)) : out;
  if (!cache) memo.set(points, (cache = new Map()));
  cache.set(key, result);
  return result;
}
