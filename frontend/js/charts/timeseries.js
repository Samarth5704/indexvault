// Time-series charts on TradingView Lightweight Charts (price, underwater, rolling vol).
// DESIGN § 7: one y-axis, 2px lines, 1px --grid gridlines, no borders, colours from
// tokens (re-themed live), unified crosshair readout.

import { format } from "../settings.js";
import { chartTokens, onThemeChange, resolveColour, withAlpha } from "./theme.js";
import { lightweight } from "./vendor.js";

/** LW time (string | BusinessDay | UTCTimestamp) -> "YYYY-MM-DD". */
export function isoTime(t) {
  if (typeof t === "string") return t;
  if (typeof t === "number") return new Date(t * 1000).toISOString().slice(0, 10);
  if (t && t.year) return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
  return null;
}

/**
 * createTimeChart(container, {height, valueFormat})
 * valueFormat(v) formats the price axis and crosshair label (default: number).
 * Series defs: {id, type: "line"|"area"|"candle"|"underwater", data, colour, title,
 *               dashed, width, markers: [{time, position, shape, colour, text}]}
 */
export async function createTimeChart(container, { height = 320, valueFormat = (v) => format.number(v) } = {}) {
  const LW = await lightweight();
  container.style.height = `${height}px`;
  const chart = LW.createChart(container, {
    autoSize: true, width: container.clientWidth, height, ...baseOptions(LW, valueFormat),
  });
  // autoSize measures asynchronously: a fitContent() before the real width is
  // known fits into 0px and falls back to default bar spacing (≈ the last 9 months
  // of daily bars). So re-fit once the size arrives, unless the user has zoomed.
  let pendingFit = false, userMoved = false;
  const sizer = new ResizeObserver(([entry]) => {
    if (pendingFit && !userMoved && entry.contentRect.width > 0) setTimeout(() => chart.timeScale().fitContent(), 0);
  });
  sizer.observe(container);
  container.addEventListener("wheel", () => { userMoved = true; }, { passive: true });
  container.addEventListener("pointerdown", () => { userMoved = true; });
  let defs = [];
  let logScale = false;
  const live = new Map(); // id -> {api, times: string[], values: Map, markers}
  const crosshairListeners = new Set();

  function seriesOptions(def, t) {
    const colour = resolveColour(def.colour) || t.series[0];
    const line = { lineWidth: def.width ?? 2, lineStyle: def.dashed ? LW.LineStyle.Dashed : LW.LineStyle.Solid };
    const common = { priceLineVisible: false, lastValueVisible: def.lastValue ?? true, title: def.title || "" };
    switch (def.type) {
      case "candle":
        return [LW.CandlestickSeries, { ...common, upColor: t.gain, downColor: t.loss, wickUpColor: t.gain, wickDownColor: t.loss, borderVisible: false }];
      case "area":
        return [LW.AreaSeries, { ...common, ...line, lineColor: colour, topColor: withAlpha(colour, 0.28), bottomColor: withAlpha(colour, 0.02) }];
      case "underwater": // filled between 0 and the (negative) line
        return [LW.BaselineSeries, { ...common, ...line, baseValue: { type: "price", price: 0 },
          topLineColor: t.loss, topFillColor1: "rgba(0,0,0,0)", topFillColor2: "rgba(0,0,0,0)",
          bottomLineColor: t.loss, bottomFillColor1: withAlpha(t.loss, 0.08), bottomFillColor2: withAlpha(t.loss, 0.32) }];
      default:
        return [LW.LineSeries, { ...common, ...line, color: colour, crosshairMarkerRadius: 3 }];
    }
  }

  function build() {
    const t = chartTokens();
    const range = live.size ? chart.timeScale().getVisibleLogicalRange() : null;
    for (const { api } of live.values()) chart.removeSeries(api);
    live.clear();
    chart.applyOptions(baseOptions(LW, valueFormat));
    chart.priceScale("right").applyOptions({ mode: logScale ? LW.PriceScaleMode.Logarithmic : LW.PriceScaleMode.Normal });
    for (const def of defs) {
      const [kind, opts] = seriesOptions(def, t);
      const api = chart.addSeries(kind, opts);
      api.setData(def.data);
      const markers = def.markers?.length ? LW.createSeriesMarkers(api, def.markers.map((m) => ({
        time: m.time, position: m.position, shape: m.shape, text: m.text || "",
        color: resolveColour(m.colour) || t.text2,
      }))) : null;
      const values = new Map(def.data.map((d) => [isoTime(d.time), d]));
      live.set(def.id, { api, def, times: def.data.map((d) => isoTime(d.time)), values, markers });
    }
    if (range) chart.timeScale().setVisibleLogicalRange(range);
    else {
      chart.timeScale().fitContent();
      pendingFit = true;
      setTimeout(() => { if (!userMoved) chart.timeScale().fitContent(); }, 50);
    }
  }

  chart.subscribeCrosshairMove((param) => {
    const time = param.time ? isoTime(param.time) : null;
    const values = {};
    if (time) for (const [id, s] of live) values[id] = param.seriesData.get(s.api) || s.values.get(time) || null;
    const info = time ? { time, values } : null;
    for (const fn of crosshairListeners) fn(info, Boolean(param.sourceEvent));
  });

  const offTheme = onThemeChange(() => { if (defs.length) build(); });

  return {
    chart,
    setSeries(next) { defs = next; build(); },
    setLogScale(on) {
      logScale = on;
      chart.priceScale("right").applyOptions({ mode: on ? LW.PriceScaleMode.Logarithmic : LW.PriceScaleMode.Normal });
    },
    /** fn(info | null, fromUser) on every crosshair move; info = {time, values: {id: datum}}. */
    onCrosshair(fn) { crosshairListeners.add(fn); return () => crosshairListeners.delete(fn); },
    /** Show the crosshair at the nearest date on/before `time` (for cross-chart sync). */
    showCrosshairAt(time) {
      const first = live.values().next().value;
      if (!first) return;
      const i = lastIndexOnOrBefore(first.times, time);
      if (i < 0) return chart.clearCrosshairPosition();
      const d = first.def.data[i];
      chart.setCrosshairPosition(d.value ?? d.close, d.time, first.api);
    },
    hideCrosshair: () => chart.clearCrosshairPosition(),
    /** PNG of the chart (what you see, in the current theme). */
    png: () => new Promise((resolve) => chart.takeScreenshot().toBlob(resolve, "image/png")),
    destroy() { offTheme(); sizer.disconnect(); crosshairListeners.clear(); chart.remove(); },
  };
}

function baseOptions(LW, valueFormat) {
  const t = chartTokens();
  return {
    layout: {
      background: { type: LW.ColorType.Solid, color: t.surface },
      textColor: t.text2, fontFamily: t.fontMono, fontSize: t.fontSize,
      attributionLogo: true, // TradingView's licence asks for attribution; keep it
    },
    grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.08 } },
    timeScale: { borderVisible: false, rightOffset: 2, minBarSpacing: 0.2 },
    crosshair: {
      mode: LW.CrosshairMode.Normal,
      vertLine: { color: t.axis, labelBackgroundColor: t.surface2 },
      horzLine: { color: t.axis, labelBackgroundColor: t.surface2 },
    },
    localization: { priceFormatter: valueFormat, timeFormatter: (time) => format.date(isoTime(time)) },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
  };
}

function lastIndexOnOrBefore(sortedIsoTimes, iso) {
  let lo = 0, hi = sortedIsoTimes.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedIsoTimes[mid] <= iso) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
