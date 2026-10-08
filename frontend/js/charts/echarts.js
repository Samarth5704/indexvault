// Apache ECharts host + option builders for heatmap, bars and histogram.
// DESIGN § 7: diverging heatmap centred at 0 with 2px gaps, per-mark tooltips,
// 1px --grid lines, no borders, first draw animates only (never on refresh).

import { prefersReducedMotion } from "../dom.js";
import { chartTokens, onThemeChange } from "./theme.js";
import { echarts } from "./vendor.js";

/** createEChart(el, build(tokens) -> option, {height}) -> {update(build), png(), destroy()} */
export async function createEChart(el, build, { height = 300 } = {}) {
  const ec = await echarts();
  el.style.height = `${height}px`;
  const inst = ec.init(el, null, { renderer: "canvas" });
  let first = true;

  function render() {
    const option = build(chartTokens());
    inst.setOption({ ...option, animation: first && !prefersReducedMotion() }, true);
    first = false;
  }

  render();
  const ro = new ResizeObserver(() => inst.resize());
  ro.observe(el);
  const offTheme = onThemeChange(render);

  return {
    update(next) { build = next; render(); },
    png() {
      const url = inst.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: chartTokens().surface });
      return fetch(url).then((r) => r.blob());
    },
    destroy() { offTheme(); ro.disconnect(); inst.dispose(); },
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

// --------------------------------------------------------------------------
// Builders
// --------------------------------------------------------------------------
/**
 * Year × month heatmap plus a separate "Year" column with its own colour scale
 * (annual returns are ~5× monthly ones and would otherwise saturate).
 * values: rows of 12 monthly decimals per year; yearTotals: decimal per year.
 */
export function heatmapOption(t, { years, months, values, yearTotals, fmt }) {
  const cols = [...months, "Year"];
  const monthCells = [], yearCells = [];
  years.forEach((y, yi) => {
    values[yi].forEach((v, mi) => { if (v != null) monthCells.push([mi, yi, v]); });
    if (yearTotals[yi] != null) yearCells.push([12, yi, yearTotals[yi]]);
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
    tooltip: tooltip(t, { formatter: (p) => `${years[p.value[1]]} · ${cols[p.value[0]]}<br><b>${fmt(p.value[2])}</b>` }),
    xAxis: { type: "category", data: cols, position: "top", ...axisStyle(t), splitLine: { show: false }, axisLine: { show: false } },
    yAxis: { type: "category", data: years.map(String), inverse: true, ...axisStyle(t), splitLine: { show: false }, axisLine: { show: false } },
    visualMap: [scale(monthCells, 0), scale(yearCells, 1)],
    series: [cellSeries(monthCells, "Month"), cellSeries(yearCells, "Year")],
  };
}

/** Bars coloured by sign (gain/loss), value labels with a sign. */
export function barsOption(t, { labels, values, fmt, tooltipLabel = (l) => l }) {
  return {
    grid: grid({ top: 24 }),
    tooltip: tooltip(t, { trigger: "item", formatter: (p) => `${tooltipLabel(labels[p.dataIndex])}<br><b>${fmt(p.value)}</b>` }),
    xAxis: { type: "category", data: labels, ...axisStyle(t), splitLine: { show: false } },
    yAxis: { type: "value", ...axisStyle(t), axisLine: { show: false }, axisLabel: { ...axisStyle(t).axisLabel, formatter: (v) => fmt(v, 0) } },
    series: [{
      type: "bar", barMaxWidth: 28,
      data: values.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? t.gain : t.loss, borderRadius: v >= 0 ? [2, 2, 0, 0] : [0, 0, 2, 2] } })),
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
