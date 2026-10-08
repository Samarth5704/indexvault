// KPI card: label, big mono value (counts up from its previous value), optional
// delta pill (▲ +1.2%) and 32px sparkline (DESIGN § 3).

import { h, prefersReducedMotion } from "../dom.js";
import { format } from "../settings.js";

const COUNT_MS = 400;

export function sparkline(values) {
  const pts = values.filter((v) => Number.isFinite(v));
  if (pts.length < 2) return null;
  const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const w = 96, hgt = 32;
  const d = pts.map((v, i) => `${((i / (pts.length - 1)) * w).toFixed(1)},${(hgt - 2 - ((v - min) / span) * (hgt - 4)).toFixed(1)}`).join(" ");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "kpi-spark");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = `<polyline points="${d}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
  svg.dataset.tone = pts[pts.length - 1] >= pts[0] ? "gain" : "loss";
  return svg;
}

/**
 * kpiCard({label, value, kind, delta, deltaLabel, spark, hint})
 * kind: "pct" | "ratio" | "level" | "years" | "date" (as in /analytics/summary).
 * Returns {el, update({value, kind, delta, spark})}.
 */
export function kpiCard({ label, value = null, kind = "level", delta = null, deltaLabel = "", spark = null, hint = "" }) {
  const valueEl = h("p.kpi-value.mono");
  const deltaEl = h("p.kpi-delta");
  const sparkSlot = h("div.kpi-spark-slot");
  const el = h("article.card.kpi-card", { title: hint || null },
    h("p.kpi-label", label), valueEl, h("div.kpi-foot", deltaEl, sparkSlot));
  let shown = null;
  let frame;

  function paintValue(v) {
    valueEl.textContent = format.metric(v, kind);
  }

  function animateTo(target) {
    cancelAnimationFrame(frame);
    const from = shown;
    shown = target;
    const numeric = kind !== "date" && Number.isFinite(from) && Number.isFinite(target);
    if (!numeric || prefersReducedMotion() || from === target) return paintValue(target);
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / COUNT_MS);
      const eased = 1 - (1 - t) ** 3;
      paintValue(from + (target - from) * eased);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }

  function update(next) {
    if (next.kind) kind = next.kind;
    if ("value" in next) animateTo(next.value);
    if ("delta" in next) {
      const d = format.delta(next.delta);
      deltaEl.dataset.tone = d.tone;
      deltaEl.replaceChildren(
        next.delta == null ? "" : h("span.delta-pill", { "data-tone": d.tone }, h("span", { "aria-hidden": "true" }, d.arrow), ` ${d.text}`),
        deltaLabel && next.delta != null ? h("span.kpi-delta-label", ` ${deltaLabel}`) : "");
    }
    if ("spark" in next) sparkSlot.replaceChildren(next.spark ? sparkline(next.spark) || "" : "");
  }

  update({ value, delta, spark });
  return { el, update };
}
