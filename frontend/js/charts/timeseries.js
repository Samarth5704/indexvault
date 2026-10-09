// Time-series charts on TradingView Lightweight Charts (price, underwater, rolling vol).
// DESIGN Â§ 7: one y-axis, 2px lines, 1px --grid gridlines, no borders, colours from
// tokens (re-themed live), unified crosshair readout.

import { format } from "../settings.js";
import { chartTokens, onThemeChange, resolveColour, withAlpha } from "./theme.js";
import { lttb } from "./lttb.js";
import { lightweight } from "./vendor.js";

// Long line/area series are thinned with LTTB to ~2 points per pixel; zooming in
// past FULL_DETAIL_SPAN of the range swaps the real data back in.
const THIN_ABOVE = 2500;
const FULL_DETAIL_SPAN = 0.4;
const MIN_BAR_SPACING = 0.2; // px; lowered per chart when the whole range needs it

/** LW time (string | BusinessDay | UTCTimestamp) -> "YYYY-MM-DD". */
export function isoTime(t) {
  if (typeof t === "string") return t;
  if (typeof t === "number") return new Date(t * 1000).toISOString().slice(0, 10);
  if (t && t.year) return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
  return null;
}

/**
 * createTimeChart(container, {height, valueFormat, ticks})
 * valueFormat(v) formats the crosshair label and price tags at full precision
 * (default: number). ticks: "integer" (default when valueFormat is not given: index
 * levels) or "money" (whole ₹ L / Cr) puts axis ticks on whole units; otherwise ticks
 * use valueFormat.
 * Series defs: {id, type: "line"|"area"|"candle"|"underwater", data, colour, title,
 *               dashed, width, markers: [{time, position, shape, colour, text}],
 *               priceLines: [{price, title, colour}]}
 */
export async function createTimeChart(container, { height = 320, valueFormat, ticks } = {}) {
  ticks ??= valueFormat ? null : "integer";
  valueFormat ??= (v) => format.number(v);
  const LW = await lightweight();
  container.style.height = `${height}px`;
  let unit = { div: 1, suffix: "" }; // money axis unit, chosen from the data in build()
  let fontSize = chartTokens().fontSize;
  const axis = { valueFormat, priceTicks: (prices) => priceTickLabels(prices), timeTick: (time, type) => timeTickLabel(time, type) };
  const chart = LW.createChart(container, {
    autoSize: true, width: container.clientWidth, height, ...baseOptions(LW, axis),
  });
  // autoSize measures asynchronously: a fitContent() before the real width is
  // known fits into 0px and falls back to default bar spacing (â‰ˆ the last 9 months
  // of daily bars). So re-fit once the size arrives, unless the user has zoomed.
  let pendingFit = false, userMoved = false;
  const sizer = new ResizeObserver(([entry]) => {
    if (pendingFit && !userMoved && entry.contentRect.width > 0) setTimeout(() => { fitSpacing(); chart.timeScale().fitContent(); }, 0);
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
    // Ticks are multiples of minMove; labels still come from the formatters.
    if (ticks) common.priceFormat = { type: "price", precision: 0, minMove: ticks === "money" ? unit.div : 1 };
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
    fontSize = t.fontSize;
    if (ticks === "money") {
      unit = format.moneyUnit(defs.reduce((m, d) => d.data.reduce((a, p) => Math.max(a, Math.abs(p.value ?? p.close ?? 0)), m), 0));
    }
    chart.applyOptions(baseOptions(LW, axis));
    chart.priceScale("right").applyOptions({ mode: logScale ? LW.PriceScaleMode.Logarithmic : LW.PriceScaleMode.Normal });
    const thinned = thinAll(defs);
    for (const def of defs) {
      const [kind, opts] = seriesOptions(def, t);
      const api = chart.addSeries(kind, opts);
      const shown = thinned.get(def);
      api.setData(shown);
      for (const pl of def.priceLines || []) {
        api.createPriceLine({ price: pl.price, title: pl.title || "", color: resolveColour(pl.colour) || t.text2,
          lineWidth: 1, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: true });
      }
      const markers = def.markers?.length ? LW.createSeriesMarkers(api, def.markers.map((m) => ({
        time: m.time, position: m.position, shape: m.shape, text: m.text || "",
        color: resolveColour(m.colour) || t.text2,
      }))) : null;
      const values = new Map(def.data.map((d) => [isoTime(d.time), d])); // readouts use the full data
      live.set(def.id, { api, def, shown, times: shown.map((d) => isoTime(d.time)), values, markers });
    }
    fitSpacing();
    if (range) chart.timeScale().setVisibleLogicalRange(range);
    else {
      chart.timeScale().fitContent();
      pendingFit = true;
      setTimeout(() => { if (!userMoved) { fitSpacing(); chart.timeScale().fitContent(); } }, 50);
    }
  }

  // fitContent() never goes below minBarSpacing, so on a narrow pane a long range
  // (10Y daily ≈ 2,500 bars in ≈ 260px at 390px) would show only its last few years.
  // Lower the minimum just enough for every bar to fit the current width.
  function fitSpacing() {
    const width = chart.timeScale().width();
    if (!width) return;
    const bars = Math.max(0, ...[...live.values()].map((s) => s.shown.length)) + 3; // + rightOffset and a spare
    chart.applyOptions({ timeScale: { minBarSpacing: Math.min(MIN_BAR_SPACING, width / bars) } });
  }

  /** def -> data to draw. Long series are LTTB-thinned; several thinned series on one
   *  chart share the union of their kept dates, so they stay aligned on the time axis
   *  and in crosshair readouts. */
  function thinAll(list) {
    const out = new Map(list.map((d) => [d, d.data]));
    const long = list.filter((d) => d.type !== "candle" && d.data.length > THIN_ABOVE);
    if (!long.length) return out;
    const target = Math.min(THIN_ABOVE, Math.max(1200, Math.round((container.clientWidth || 800) * 2)));
    const kept = long.map((d) => lttb(d.data, target, { keep: d.markers?.length ? new Set(d.markers.map((m) => m.time)) : null }));
    if (long.length === 1) return out.set(long[0], kept[0]);
    const union = new Set(kept.flatMap((pts) => pts.map((p) => p.time)));
    for (const d of long) out.set(d, d.data.filter((p) => union.has(p.time)));
    return out;
  }

  // Zoomed in far enough: show every point of the thinned series (once).
  chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
    if (!range) return;
    const thinned = [...live.values()].filter((s) => s.shown !== s.def.data);
    if (!thinned.length) return;
    const all = thinned[0].def.data;
    const span = (t) => new Date(isoTime(t)).getTime();
    const full = span(all.at(-1).time) - span(all[0].time);
    if (!full || (span(range.to) - span(range.from)) / full > FULL_DETAIL_SPAN) return;
    for (const s of thinned) {
      s.api.setData(s.def.data);
      s.shown = s.def.data;
      s.times = s.def.data.map((d) => isoTime(d.time));
    }
    chart.timeScale().setVisibleRange(range);
  });

  // Price-axis tick labels: whole units (ticks set), and blank where a label would sit
  // under a price tag / price-line label or be cut off at the top or bottom of the pane.
  function priceTickLabels(prices) {
    const labels = prices.map((p) => (ticks === "money" ? format.money(p, Math.abs(p) < unit.div / 2 ? {} : { unit }) // "₹0", not "₹0 L"
      : ticks === "integer" ? format.number(Math.round(p), { decimals: 0 }) : valueFormat(p)));
    const ref = live.values().next().value?.api;
    if (!ref) return labels;
    const half = fontSize / 2 + 3; // half an axis label's height
    const bottom = chart.paneSize().height - half;
    const tags = tagCoordinates();
    return labels.map((text, i) => {
      const y = ref.priceToCoordinate(prices[i]);
      if (y == null) return text;
      if (y < half || y > bottom || tags.some((ty) => Math.abs(ty - y) < 2 * half)) return "";
      return i && text === labels[i - 1] ? "" : text; // log scale can round two ticks alike
    });
  }

  function tagCoordinates() {
    const ys = [];
    for (const { api, def, shown } of live.values()) {
      const last = shown.at(-1);
      if ((def.lastValue ?? true) && last) ys.push(api.priceToCoordinate(last.value ?? last.close));
      for (const pl of def.priceLines || []) ys.push(api.priceToCoordinate(pl.price));
    }
    return ys.filter((y) => y != null);
  }

  // Time-axis labels that would be cut off at either end of the pane are left out.
  // LW caches labels per date, so re-apply the formatter (clears the cache) on scroll.
  function timeTickLabel(time, type) {
    const x = chart.timeScale().timeToCoordinate(time);
    if (x == null) return null;
    const half = ((type === 0 ? 4 : 3) * 0.62 * fontSize) / 2 + 2; // "2026" / "Oct" / "15"
    return x < half || x > chart.timeScale().width() - half ? "" : null; // null: LW's own label
  }
  let relabel = 0;
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
    cancelAnimationFrame(relabel);
    relabel = requestAnimationFrame(() => chart.applyOptions({ timeScale: { tickMarkFormatter: axis.timeTick } }));
  });

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
      const d = first.shown[i];
      chart.setCrosshairPosition(d.value ?? d.close, d.time, first.api);
    },
    hideCrosshair: () => chart.clearCrosshairPosition(),
    /** PNG of the chart (what you see, in the current theme). */
    png: () => new Promise((resolve) => chart.takeScreenshot().toBlob(resolve, "image/png")),
    destroy() { offTheme(); sizer.disconnect(); cancelAnimationFrame(relabel); crosshairListeners.clear(); chart.remove(); },
  };
}

function baseOptions(LW, { valueFormat, priceTicks, timeTick }) {
  const t = chartTokens();
  return {
    layout: {
      background: { type: LW.ColorType.Solid, color: t.surface },
      textColor: t.text2, fontFamily: t.fontMono, fontSize: t.fontSize,
      attributionLogo: true, // TradingView's licence asks for attribution; keep it
    },
    grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.08 } },
    timeScale: { borderVisible: false, rightOffset: 2, minBarSpacing: MIN_BAR_SPACING, tickMarkFormatter: timeTick },
    crosshair: {
      mode: LW.CrosshairMode.Normal,
      vertLine: { color: t.axis, labelBackgroundColor: t.surface2 },
      horzLine: { color: t.axis, labelBackgroundColor: t.surface2 },
    },
    localization: { priceFormatter: valueFormat, tickmarksPriceFormatter: priceTicks, timeFormatter: (time) => format.date(isoTime(time)) },
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
