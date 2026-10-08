// Apache ECharts host + option builders for heatmap, bars and histogram.
// DESIGN § 7: diverging heatmap centred at 0 with 2px gaps, per-mark tooltips,
// 1px --grid lines, no borders, first draw animates only (never on refresh).

import { prefersReducedMotion } from "../dom.js";
import { chartTokens, onThemeChange, withAlpha } from "./theme.js";
import { echarts } from "./vendor.js";

/** createEChart(el, build(tokens) -> option, {height}) -> {update(build), png(), destroy()} */
export async function createEChart(el, build, { height = 300 } = {}) {
  const ec = await echarts();
  el.style.height = `${height}px`;
  const inst = ec.init(el, null, { renderer: "canvas" });
  let first = true;

  function render() {
    // Builders get the chart's pixel width too, so labels can be sized to fit.
    const option = build({ ...chartTokens(), width: inst.getWidth() || el.clientWidth });
    inst.setOption({ ...option, animation: first && !prefersReducedMotion() }, true);
    first = false;
  }

  render();
  let lastWidth = 0, timer = 0;
  const ro = new ResizeObserver(() => {
    inst.resize();
    const w = inst.getWidth();
    if (Math.abs(w - lastWidth) < 24) return; // re-layout labels only on real width changes
    lastWidth = w;
    clearTimeout(timer);
    timer = setTimeout(render, 120);
  });
  ro.observe(el);
  const offTheme = onThemeChange(render);

  return {
    update(next) { build = next; render(); },
    png() {
      const url = inst.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: chartTokens().surface });
      return fetch(url).then((r) => r.blob());
    },
    destroy() { clearTimeout(timer); offTheme(); ro.disconnect(); inst.dispose(); },
  };
}

// --------------------------------------------------------------------------
// Shared pieces
// --------------------------------------------------------------------------
const axisStyle = (t) => ({
  axisLine: { lineStyle: { color: t.axis } },
  axisTick: { show: false },
  axisLabel: { color: t.text2, fontFamily: t.fontMono, fontSize: t.fontSize },
  splitLine: { lineStyle: { color: t.grid, width: 1 } },
});

const tooltip = (t, extra = {}) => ({
  backgroundColor: t.surface, borderColor: t.border, borderWidth: 1,
  textStyle: { color: t.text, fontFamily: t.fontUi, fontSize: t.fontSize + 1 },
  extraCssText: "box-shadow: var(--shadow-pop); border-radius: var(--radius-sm);",
  ...extra,
});

const grid = (extra = {}) => ({ left: 8, right: 16, top: 16, bottom: 8, containLabel: true, ...extra });

/** "NIFTY Bank" -> "Bank" (keeps "NIFTY 50"); full names stay in tooltips and tables. */
const shortName = (n) => n.replace(/^NIFTY\s+(?=[A-Za-z])/, "");

/**
 * Category labels sized to their real slot (t.width = chart width): horizontal and
 * truncated with an ellipsis; vertical when slots are too narrow for a word.
 * Short names when crowded; full names stay in tooltips and tables.
 */
function categoryLabels(t, names, reserved = 64) {
  const slot = Math.max(1, (t.width - reserved) / names.length);
  const vertical = slot < 44;
  return {
    ...axisStyle(t).axisLabel, interval: 0, fontFamily: t.fontUi,
    rotate: vertical ? 90 : 0, width: vertical ? 96 : slot - 6, overflow: "truncate", ellipsis: "…",
    formatter: (v) => (names.length > 4 || vertical ? shortName(v) : v),
  };
}

// --------------------------------------------------------------------------
// Builders
// --------------------------------------------------------------------------
/**
 * Year × month heatmap plus a separate "Year" column with its own colour scale
 * (annual returns are ~5× monthly ones and would otherwise saturate).
 * values: rows of 12 monthly decimals per year; yearTotals: decimal per year, or
 * null for no Year column (e.g. the SIP start-date grid). tooltipTitle names a cell.
 */
export function heatmapOption(t, { years, months, values, yearTotals = null, fmt, tooltipTitle = null }) {
  const cols = yearTotals ? [...months, "Year"] : [...months];
  const monthCells = [], yearCells = [];
  years.forEach((y, yi) => {
    values[yi].forEach((v, mi) => { if (v != null) monthCells.push([mi, yi, v]); });
    if (yearTotals?.[yi] != null) yearCells.push([12, yi, yearTotals[yi]]);
  });
  const span = (cells) => Math.max(1e-9, ...cells.map((c) => Math.abs(c[2])));
  const scale = (cells, seriesIndex) => ({
    type: "continuous", seriesIndex, show: false, min: -span(cells), max: span(cells),
    inRange: { color: [t.divNeg, t.divMid, t.divPos] },
  });
  const cellSeries = (data, name) => ({
    type: "heatmap", name, data,
    label: { show: true, color: t.text, fontFamily: t.fontMono, fontSize: t.fontSize, formatter: (p) => fmt(p.value[2]) },
    itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 2 },
    emphasis: { itemStyle: { borderColor: t.text, borderWidth: 1 } },
  });
  return {
    grid: grid({ top: 8 }),
    tooltip: tooltip(t, { formatter: (p) => `${tooltipTitle ? `${tooltipTitle} ` : ""}${cols[p.value[0]]} ${years[p.value[1]]}<br><b>${fmt(p.value[2])}</b>` }),
    xAxis: { type: "category", data: cols, position: "top", ...axisStyle(t), splitLine: { show: false }, axisLine: { show: false } },
    yAxis: { type: "category", data: years.map(String), inverse: true, ...axisStyle(t), splitLine: { show: false }, axisLine: { show: false } },
    visualMap: yearTotals ? [scale(monthCells, 0), scale(yearCells, 1)] : [scale(monthCells, 0)],
    series: yearTotals ? [cellSeries(monthCells, "Month"), cellSeries(yearCells, "Year")] : [cellSeries(monthCells, "Month")],
  };
}

/** Bars coloured by sign (gain/loss), value labels with a sign. muted[i] greys a bar
 *  (e.g. too little data) and marks its label with "*" so colour isn't the only signal. */
export function barsOption(t, { labels, values, fmt, tooltipLabel = (l) => l, muted = [] }) {
  return {
    grid: grid({ top: 24 }),
    tooltip: tooltip(t, { trigger: "item", formatter: (p) => `${tooltipLabel(labels[p.dataIndex])}<br><b>${fmt(p.value)}</b>` }),
    xAxis: { type: "category", data: labels, ...axisStyle(t), splitLine: { show: false },
      axisLabel: { ...axisStyle(t).axisLabel, interval: 0, formatter: (v, i) => (muted[i] ? `${v}*` : v) } },
    yAxis: { type: "value", ...axisStyle(t), axisLine: { show: false }, axisLabel: { ...axisStyle(t).axisLabel, formatter: (v) => fmt(v, 0) } },
    series: [{
      type: "bar", barMaxWidth: 28,
      data: values.map((v, i) => ({ value: v, itemStyle: { color: muted[i] ? t.muted : v >= 0 ? t.gain : t.loss, opacity: muted[i] ? 0.6 : 1, borderRadius: v >= 0 ? [2, 2, 0, 0] : [0, 0, 2, 2] } })),
      label: { show: labels.length <= 24, position: "outside", color: t.text2, fontFamily: t.fontMono, fontSize: t.fontSize, formatter: (p) => fmt(p.value, 1) },
    }],
  };
}

/** Return histogram (bars) with the fitted normal curve (line) on one axis. */
export function histogramOption(t, { edges, counts, normal, fmt, colour }) {
  const mids = counts.map((_, i) => (edges[i] + edges[i + 1]) / 2);
  return {
    grid: grid({ top: 24 }),
    legend: { top: 0, right: 0, textStyle: { color: t.text2, fontSize: t.fontSize }, itemWidth: 14, itemHeight: 8, data: ["Days", "Normal"] },
    tooltip: tooltip(t, { trigger: "axis", axisPointer: { type: "shadow" },
      formatter: (ps) => `${fmt(edges[ps[0].dataIndex])} to ${fmt(edges[ps[0].dataIndex + 1])}<br>` +
        ps.map((p) => `${p.marker}${p.seriesName}: <b>${Math.round(p.value).toLocaleString("en-IN")}</b>`).join("<br>") }),
    xAxis: { type: "category", data: mids, ...axisStyle(t), splitLine: { show: false },
      axisLabel: { ...axisStyle(t).axisLabel, interval: Math.max(0, Math.round(mids.length / 8) - 1), formatter: (v) => fmt(Number(v), 1) } },
    yAxis: { type: "value", ...axisStyle(t), axisLine: { show: false } },
    series: [
      { name: "Days", type: "bar", data: counts, barCategoryGap: "8%", itemStyle: { color: colour, opacity: 0.85 } },
      { name: "Normal", type: "line", data: normal, smooth: true, symbol: "none", lineStyle: { color: t.text2, width: 2, type: "dashed" } },
    ],
  };
}

/** Correlation matrix: diverging scale fixed at −1…+1, centred at 0, values in cells. */
export function corrMatrixOption(t, { labels, matrix }) {
  const cells = [];
  matrix.forEach((row, i) => row.forEach((v, j) => cells.push([j, i, v])));
  return {
    grid: grid({ top: 8 }),
    tooltip: tooltip(t, { formatter: (p) => `${labels[p.value[1]]} × ${labels[p.value[0]]}<br><b>${p.value[2].toFixed(2)}</b>` }),
    xAxis: { type: "category", data: labels, position: "top", ...axisStyle(t), splitLine: { show: false }, axisLine: { show: false },
      axisLabel: categoryLabels(t, labels, 140) },
    yAxis: { type: "category", data: labels, inverse: true, ...axisStyle(t), splitLine: { show: false }, axisLine: { show: false },
      axisLabel: { ...axisStyle(t).axisLabel, fontFamily: t.fontUi } },
    visualMap: { type: "continuous", show: false, min: -1, max: 1, inRange: { color: [t.divNeg, t.divMid, t.divPos] } },
    series: [{
      type: "heatmap", data: cells,
      label: { show: labels.length <= 10, color: t.text, fontFamily: t.fontMono, fontSize: t.fontSize, formatter: (p) => p.value[2].toFixed(2) },
      itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 2 },
    }],
  };
}

/** Risk (x) vs return (y) scatter; each point in its series' slot colour, labelled directly. */
export function scatterOption(t, { points, fmt }) {
  return {
    grid: grid({ top: 24, right: 24 }),
    tooltip: tooltip(t, { formatter: (p) => `${p.data.name}<br>Return <b>${fmt(p.data.value[1])}</b><br>Volatility <b>${fmt(p.data.value[0])}</b>` }),
    xAxis: { type: "value", name: "Volatility", nameLocation: "middle", nameGap: 28, nameTextStyle: { color: t.muted },
      scale: true, ...axisStyle(t), axisLabel: { ...axisStyle(t).axisLabel, formatter: (v) => fmt(v, 0) } },
    yAxis: { type: "value", name: "CAGR", nameTextStyle: { color: t.muted }, scale: true, ...axisStyle(t),
      axisLabel: { ...axisStyle(t).axisLabel, formatter: (v) => fmt(v, 0) } },
    series: [{
      type: "scatter", symbolSize: 14,
      data: points.map((p) => ({ name: p.name, value: [p.x, p.y], itemStyle: { color: p.colour, borderColor: t.surface, borderWidth: 2 } })),
      label: { show: points.length <= 10, position: "right", color: t.text2, fontSize: t.fontSize, formatter: (p) => p.data.name },
      labelLayout: { hideOverlap: true },
    }],
  };
}

/** Box plots (min, q1, median, q3, max) per series, latest value as a dot, target as a dashed line. */
export function boxplotOption(t, { names, boxes, colours, latest, target, fmt }) {
  return {
    grid: grid({ top: 24 }),
    tooltip: tooltip(t, { trigger: "item", formatter: (p) => (p.seriesType === "boxplot"
      ? `${names[p.dataIndex]}<br>Max ${fmt(p.data[5])}<br>75% ${fmt(p.data[4])}<br>Median <b>${fmt(p.data[3])}</b><br>25% ${fmt(p.data[2])}<br>Min ${fmt(p.data[1])}`
      : `${names[p.dataIndex]}<br>Latest <b>${fmt(p.value)}</b>`) }),
    xAxis: { type: "category", data: names, ...axisStyle(t), splitLine: { show: false },
      axisLabel: categoryLabels(t, names) },
    yAxis: { type: "value", ...axisStyle(t), axisLine: { show: false }, axisLabel: { ...axisStyle(t).axisLabel, formatter: (v) => fmt(v, 0) } },
    series: [
      { type: "boxplot", boxWidth: [12, 36],
        data: boxes.map((b, i) => ({ value: b, itemStyle: { color: withAlpha(colours[i], 0.18), borderColor: colours[i], borderWidth: 1.5 } })),
        markLine: target == null ? undefined : { silent: true, symbol: "none", label: { color: t.text2, position: "insideEndTop", formatter: `Target ${fmt(target, 0)}` },
          lineStyle: { color: t.text2, type: "dashed" }, data: [{ yAxis: target }] } },
      { type: "scatter", name: "Latest", symbol: "diamond", symbolSize: 10,
        data: latest.map((v, i) => ({ value: v, itemStyle: { color: colours[i], borderColor: t.surface, borderWidth: 1 } })) },
    ],
  };
}
