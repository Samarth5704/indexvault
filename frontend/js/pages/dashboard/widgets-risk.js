// Risk and personal widgets: India VIX gauge, drawdown monitor, rolling-return
// snapshot, notes (SPEC § 3.1).

import { api, enc } from "../../api.js";
import { seriesName } from "../../components/series-picker.js";
import { h } from "../../dom.js";
import { renderMarkdown } from "../../markdown.js";
import { format, settings } from "../../settings.js";
import { groupLabel, groupTickers, loadInto } from "./common.js";
import { missingNote } from "./widgets-market.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const pct0 = (v) => format.pct(v, { decimals: 0 });

// ------------------------------------------------------------------ VIX gauge
const VIX_BANDS = [[0.25, "Calm", "good"], [0.6, "Normal", "good"], [0.85, "Elevated", "warning"], [1.01, "High", "serious"]];
export const vix_gauge = {
  label: "India VIX gauge", icon: "health", blurb: "Today's India VIX and where it sits in its own history (percentile).",
  size: { w: 3, h: 3 }, min: { minW: 2, minH: 3, maxH: 5 },
  fields: [
    { key: "ticker", label: "Volatility index", kind: "ticker" },
    { key: "lookback", label: "History", kind: "select", options: ["3Y", "5Y", "10Y", "Max"].map((p) => ({ value: p, label: p })) },
  ],
  defaults: () => ({ ticker: "^INDIAVIX", lookback: "10Y" }),
  title: (c) => (c.ticker === "^INDIAVIX" ? "India VIX" : seriesName(c.ticker)),
  sub: (c) => `Percentile vs ${c.lookback}`,
  mount(body, cfg, env) {
    loadInto(body, {
      alive: env.alive, sk: { variant: "block" },
      load: () => api.get(`/series/${enc(cfg.ticker)}`, { period: cfg.lookback, columns: "close", freq: "Daily" }),
      isEmpty: (s) => s.rows.filter((r) => r[1] != null).length < 20,
      empty: { icon: "health", title: "Not enough history", message: "The volatility index needs at least a month of data." },
      render: (s) => {
        const closes = s.rows.map((r) => r[1]).filter((v) => v != null);
        const last = closes.at(-1), prev = closes.at(-2);
        const sorted = [...closes].sort((a, b) => a - b);
        const pctile = sorted.filter((v) => v < last).length / sorted.length;
        const [, band, status] = VIX_BANDS.find(([max]) => pctile < max);
        const d = format.delta(prev ? last / prev - 1 : null);
        env.setSub(`${format.date(s.rows.at(-1)[0])} · percentile vs ${cfg.lookback}`);
        return h("div.vix",
          gauge(pctile, status, `${format.number(last)}, higher than ${pct0(pctile)} of days in ${cfg.lookback}`),
          h("div.vix-read",
            h("p.vix-value.mono", format.number(last)),
            h("span.status-pill", { "data-status": status }, band),
            h("p.vix-pctile", `Higher than ${pct0(pctile)} of days`),
            h("p.muted.vix-day", h("span", { "data-tone": d.tone, class: "signed" }, `${d.arrow} ${d.text}`), " today")),
          h("dl.vix-range",
            h("div", h("dt", "Low"), h("dd.mono", format.number(sorted[0]))),
            h("div", h("dt", "Median"), h("dd.mono", format.number(sorted[Math.floor(sorted.length / 2)]))),
            h("div", h("dt", "High"), h("dd.mono", format.number(sorted.at(-1))))));
      },
    });
  },
};

function gauge(fraction, status, label) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 120 68");
  svg.setAttribute("class", "gauge");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  const pt = (f, r = 50) => [60 + r * Math.cos(Math.PI * (1 - f)), 60 - r * Math.sin(Math.PI * (1 - f))].map((n) => n.toFixed(2));
  const arc = (f) => `M ${pt(0).join(" ")} A 50 50 0 0 1 ${pt(f).join(" ")}`;
  const [nx, ny] = pt(fraction, 38);
  svg.innerHTML =
    `<path d="${arc(1)}" fill="none" stroke="var(--surface-3)" stroke-width="10" stroke-linecap="round"/>` +
    (fraction > 0.005 ? `<path d="${arc(fraction)}" fill="none" stroke="var(--${status})" stroke-width="10" stroke-linecap="round"/>` : "") +
    `<line x1="60" y1="60" x2="${nx}" y2="${ny}" stroke="var(--text)" stroke-width="2" stroke-linecap="round"/>` +
    `<circle cx="60" cy="60" r="4" fill="var(--text)"/>`;
  return svg;
}

// ------------------------------------------------------------------ drawdown monitor
export const drawdown_monitor = {
  label: "Drawdown monitor", icon: "arrow-down", blurb: "How far each index in a group is below its all-time high, deepest first.",
  size: { w: 4, h: 4 }, min: { minW: 3, minH: 3 },
  fields: [{ key: "group", label: "Group", kind: "group" }],
  defaults: () => ({ group: "cat:Broad market" }),
  title: (c) => groupLabel(c.group),
  sub: () => "Drawdown from all-time high",
  mount(body, cfg, env) {
    const tickers = groupTickers(cfg.group);
    loadInto(body, {
      alive: env.alive, sk: { lines: 6 },
      load: async () => (tickers.length ? api.get("/analytics/summary", { tickers, period: "Max" }) : null),
      isEmpty: (d) => !d,
      empty: { icon: "arrow-down", title: "Nothing in this group", message: "Choose another group or add tickers to the watchlist." },
      render: (d) => {
        const rows = tickers.map((t) => ({ t, cur: d.series[t]?.metrics.current_drawdown, max: d.series[t]?.metrics.max_drawdown }))
          .filter((r) => r.cur != null).sort((a, b) => a.cur - b.cur);
        const deepest = Math.max(1e-9, ...rows.map((r) => Math.abs(r.max ?? r.cur)));
        const missing = missingNote(tickers.filter((t) => d.series[t]?.metrics.current_drawdown == null));
        return h("ul.dd-list", rows.map((r) => {
          const bar = h("span.dd-bar");
          bar.style.width = `${(Math.abs(r.cur) / deepest) * 100}%`;
          const worst = h("span.dd-worst", { title: `Worst ever: ${format.pct(r.max)}` });
          worst.style.left = `${(Math.abs(r.max ?? 0) / deepest) * 100}%`;
          return h("li.dd-row",
            h("span.dd-name.truncate", { title: seriesName(r.t) }, seriesName(r.t)),
            h("span.dd-track", { "aria-hidden": "true" }, bar, worst),
            h("span.dd-value.mono", r.cur > -0.0005 ? "At high" : format.pct(r.cur, { decimals: 1 })));
        }), h("li.dd-legend.muted", h("span.dd-worst-key", { "aria-hidden": "true" }), "tick = worst drawdown ever"),
        missing && h("li", missing));
      },
    });
  },
};

// ------------------------------------------------------------------ rolling snapshot
export const rolling_snapshot = {
  label: "Rolling-return snapshot", icon: "rolling", blurb: "Today's rolling CAGR against its full history: range, middle half and median.",
  size: { w: 4, h: 3 }, min: { minW: 3, minH: 3, maxH: 5 },
  fields: [
    { key: "ticker", label: "Series", kind: "ticker" },
    { key: "years", label: "Holding period", kind: "select", options: () => settings().analytics.rolling_windows_years.map((y) => ({ value: y, label: `${y} years` })) },
  ],
  defaults: () => ({ ticker: "^NSEI", years: settings().analytics.rolling_windows_years.includes(5) ? 5 : settings().analytics.rolling_windows_years[0] }),
  title: (c) => seriesName(c.ticker),
  sub: (c) => `${c.years}Y rolling CAGR`,
  mount(body, cfg, env) {
    loadInto(body, {
      alive: env.alive, sk: { variant: "block" },
      load: () => api.get("/analytics/rolling", { tickers: cfg.ticker, years: cfg.years }),
      isEmpty: (d) => !d.series[cfg.ticker]?.windows[String(cfg.years)],
      empty: { icon: "rolling", title: "Not enough history", message: "This series is shorter than the holding period. Try fewer years." },
      render: (d) => {
        const w = d.series[cfg.ticker].windows[String(cfg.years)];
        const vs = w.latest - w.median;
        const span = w.max - w.min || 1;
        const at = (v) => `${((v - w.min) / span) * 100}%`;
        const box = h("span.roll-box");
        Object.assign(box.style, { left: at(w.q1), width: `${((w.q3 - w.q1) / span) * 100}%` });
        const med = h("span.roll-median"); med.style.left = at(w.median);
        const now = h("span.roll-now"); now.style.left = at(w.latest);
        const target = d.target >= w.min && d.target <= w.max ? h("span.roll-target", { title: `Target ${format.pct(d.target)}` }) : null;
        if (target) target.style.left = at(d.target);
        return h("div.roll",
          h("div.roll-head",
            h("div", h("p.field-label", "Today"), h("p.roll-latest.mono", format.pct(w.latest, { decimals: 1 }))),
            h("div", h("p.field-label", "Median"), h("p.mono.roll-med", format.pct(w.median, { decimals: 1 }))),
            h("p.roll-vs", { "data-tone": vs >= 0 ? "gain" : "loss" }, `${vs >= 0 ? "▲" : "▼"} ${format.pct(Math.abs(vs), { decimals: 1 })} ${vs >= 0 ? "above" : "below"} median`)),
          h("div.roll-scale", { role: "img", "aria-label": `Range ${format.pct(w.min)} to ${format.pct(w.max)}; middle half ${format.pct(w.q1)} to ${format.pct(w.q3)}; today ${format.pct(w.latest)}` },
            box, med, target, now),
          h("div.roll-ends.mono", h("span", format.pct(w.min, { decimals: 0 })), h("span", format.pct(w.max, { decimals: 0 }))),
          h("p.roll-insight.text-2", w.insight));
      },
    });
  },
};

// ------------------------------------------------------------------ notes
const NOTES_MAX = 5000;
export const notes = {
  label: "Notes", icon: "edit", blurb: "Your own notes in Markdown, saved with your settings on this computer.",
  size: { w: 4, h: 3 }, min: { minW: 2, minH: 2 },
  fields: [],
  defaults: () => ({ title: "Notes", text: "## Watching\n- NIFTY near its 200-day average?\n- **VIX** above 20 = nervous market\n\n*Edit me with the pencil.*" }),
  title: (c) => c.title || "Notes",
  sub: () => "Markdown",
  mount(body, cfg, env) {
    let text = cfg.text || "";
    let timer;
    const view = () => body.replaceChildren(text.trim() ? h("div.notes-view", renderMarkdown(text)) : h("p.muted.notes-empty", "Empty. Use the pencil to write something."));
    function edit() {
      const area = h("textarea.input.notes-area", { maxlength: NOTES_MAX, "aria-label": "Notes (Markdown)", spellcheck: "true" });
      area.value = text;
      const count = h("span.muted", `${text.length} / ${NOTES_MAX}`);
      const save = () => { clearTimeout(timer); if (area.value !== cfg.text) env.saveConfig({ ...cfg, text: area.value }); };
      area.addEventListener("input", () => {
        text = area.value;
        count.textContent = `${text.length} / ${NOTES_MAX}`;
        clearTimeout(timer);
        timer = setTimeout(save, 800);
      });
      area.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); save(); view(); } });
      body.replaceChildren(h("div.notes-edit", area,
        h("div.notes-foot", h("span.muted", "Markdown: # heading, **bold**, *italic*, - list, [link](https://…)"), count)));
      area.focus();
      return save;
    }
    let flush = null;
    env.addAction({ icon: "edit", label: "Edit notes", toggle: true, onClick: (on) => { if (on) flush = edit(); else { flush?.(); view(); } } });
    view();
    return () => { if (flush) flush(); clearTimeout(timer); };
  },
};
