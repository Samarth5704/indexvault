// SIP Lab (SPEC § 3.6): monthly SIP backtest with step-up and top-ups, invested vs
// value vs lump sum, XIRR, start-date sensitivity, up to 4 saved scenarios, ledger export.
// Inputs live in the URL: t, amt, day, su (step-up decimal), tu ("YYYY-MM-DD:amount;…").

import { api } from "../api.js";
import { createEChart, heatmapOption } from "../charts/echarts.js";
import { createTimeChart } from "../charts/timeseries.js";
import { chartCard, downloadBlob } from "../components/chart-card.js";
import { emptyState, errorState } from "../components/feedback.js";
import { kpiCard } from "../components/kpi-card.js";
import { seriesName } from "../components/series-picker.js";
import { toast, toastError } from "../components/toast.js";
import { h, icon } from "../dom.js";
import { setPageParams } from "../router.js";
import { format, settings } from "../settings.js";
import { rangeParams, selection, seriesColour, store } from "../store.js";

const MAX_SCENARIOS = 4;
const SCENARIO_KEY = "iv.sipScenarios";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pct = (v, d) => format.pct(v, d == null ? {} : { decimals: d });
const money = (v) => format.money(v, { compact: true });

// ---------------------------------------------------------------- inputs <-> URL
function readInputs() {
  const p = store.get().route.params;
  const d = settings().sip;
  const { series } = selection();
  const num = (v, lo, hi, fallback) => (v != null && v !== "" && Number.isFinite(+v) && +v >= lo && +v <= hi ? +v : fallback);
  const topUps = (p.tu || "").split(";").map((x) => x.split(":")).filter(([dt, a]) => /^\d{4}-\d{2}-\d{2}$/.test(dt) && +a > 0)
    .map(([date, amount]) => ({ date, amount: +amount }));
  return {
    ticker: series.includes(p.t) ? p.t : series[0],
    amount: num(p.amt, 1, 1e8, d.amount),
    day: num(p.day, 1, 28, d.day),
    step_up: num(p.su, 0, 1, d.step_up),
    top_ups: topUps,
  };
}

function writeInputs(inp) {
  setPageParams({ ...store.get().route.params, t: inp.ticker, amt: String(inp.amount), day: String(inp.day),
    su: String(inp.step_up), tu: inp.top_ups.length ? inp.top_ups.map((x) => `${x.date}:${x.amount}`).join(";") : undefined });
}

// ---------------------------------------------------------------- saved scenarios (per browser)
function loadScenarios() {
  try { return JSON.parse(localStorage.getItem(SCENARIO_KEY) || "[]").slice(0, MAX_SCENARIOS); } catch { return []; }
}
function saveScenarios(list) {
  try { localStorage.setItem(SCENARIO_KEY, JSON.stringify(list)); } catch { toast({ tone: "warning", title: "Couldn't save scenarios in this browser" }); }
}
const scenarioName = (x) => `${seriesName(x.ticker)} · ${format.money(x.amount)}/mo · day ${x.day}${x.step_up ? ` · +${pct(x.step_up, 0)}/yr` : ""}${x.top_ups.length ? ` · ${x.top_ups.length} top-up${x.top_ups.length > 1 ? "s" : ""}` : ""}`;

// ---------------------------------------------------------------- form
/** Default date for a new top-up: the middle of the last run's period (else today). */
function midRange(run) {
  const p = run?.res?.params;
  if (!p) return new Date().toISOString().slice(0, 10);
  const mid = (new Date(p.start).getTime() + new Date(p.end).getTime()) / 2;
  return new Date(mid).toISOString().slice(0, 10);
}

function inputForm(inp, onChange, defaultTopUpDate) {
  const err = h("p.field-error", { role: "alert" });
  const field = (label, input, hint) => h("label.field", h("span.field-label", label), input, hint && h("span.field-hint", hint));
  const tickerSel = h("select.select", selection().series.map((t) => h("option", { value: t, selected: t === inp.ticker }, seriesName(t))));
  const amount = h("input.input", { type: "number", min: "1", step: "500", value: String(inp.amount), inputmode: "decimal" });
  const day = h("input.input", { type: "number", min: "1", max: "28", step: "1", value: String(inp.day) });
  const stepUp = h("input.input", { type: "number", min: "0", max: "100", step: "1", value: String(+(inp.step_up * 100).toFixed(2)) });
  const topList = h("ul.topup-list");
  let tops = inp.top_ups.map((x) => ({ ...x }));

  function renderTops() {
    topList.replaceChildren(...tops.map((x, i) => h("li.topup",
      h("input.input", { type: "date", value: x.date, "aria-label": `Top-up ${i + 1} date`, onchange: (e) => { tops[i].date = e.target.value; emit(); } }),
      h("input.input", { type: "number", min: "1", step: "1000", value: String(x.amount), "aria-label": `Top-up ${i + 1} amount`, onchange: (e) => { tops[i].amount = +e.target.value; emit(); } }),
      h("button.icon-btn.sm", { type: "button", "aria-label": `Remove top-up ${i + 1}`, onclick: () => { tops.splice(i, 1); renderTops(); emit(); } }, icon("x", { size: "sm" })))));
  }

  function emit() {
    const v = { ticker: tickerSel.value, amount: +amount.value, day: +day.value, step_up: +stepUp.value / 100,
      top_ups: tops.filter((x) => x.date && x.amount > 0) };
    const problem = !(v.amount > 0 && v.amount <= 1e8) ? "Monthly amount must be more than 0."
      : !(Number.isInteger(v.day) && v.day >= 1 && v.day <= 28) ? "SIP day must be a whole number from 1 to 28."
      : !(v.step_up >= 0 && v.step_up <= 1) ? "Step-up must be between 0% and 100% a year." : "";
    err.textContent = problem;
    if (!problem) onChange(v);
  }

  for (const el of [tickerSel, amount, day, stepUp]) el.addEventListener("change", emit);
  renderTops();
  const sel = selection();
  return h("div.sip-form",
    field("Series", tickerSel),
    h("div.form-row",
      field(`Monthly amount (${settings().formats.currency})`, amount),
      field("SIP day", day, "Next trading day if a holiday")),
    field("Annual step-up %", stepUp, "Raise the SIP amount every 12 months"),
    h("div.field", h("span.field-label", "Lump-sum top-ups"), topList,
      h("button.btn.ghost.sm", { type: "button", onclick: () => { tops.push({ date: defaultTopUpDate(), amount: inp.amount * 10 }); renderTops(); emit(); } },
        icon("plus", { size: "sm" }), "Add top-up")),
    err,
    h("p.field-hint", `Period: ${sel.start ? `${format.date(sel.start)} → ${sel.end ? format.date(sel.end) : "today"}` : sel.period} (from the top bar).`));
}

// ---------------------------------------------------------------- page
export default {
  mount(el, ctx) {
    const exportBtns = h("div.head-actions",
      h("button.btn.secondary.sm", { type: "button", onclick: () => exportLedger("csv") }, icon("download", { size: "sm" }), "Ledger CSV"),
      h("button.btn.secondary.sm", { type: "button", onclick: () => exportLedger("xlsx") }, icon("download", { size: "sm" }), "Ledger Excel"));
    const body = h("div.page-body");
    el.append(h("header.page-head", h("div", h("h1", "SIP Lab"),
      h("p.page-sub", "What would a monthly SIP have done? Step-ups, top-ups, every start month, and your own scenarios side by side.")), exportBtns), body);

    let token = 0, disposers = [], current = null;
    const dispose = () => { disposers.forEach((d) => d()); disposers = []; };

    async function exportLedger(fmt) {
      if (!current) return;
      try {
        const res = await api.raw("POST", `/analytics/sip/export?format=${fmt}`, { body: current.request, timeout: 60_000 });
        const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || `sip.${fmt}`;
        downloadBlob(name, await res.blob());
        toast({ tone: "success", title: "Ledger exported", message: name });
      } catch (e) { toastError(e, "Export failed"); }
    }

    let view = null; // the built layout; rebuilt only when the selection changes

    function render() {
      ++token;
      dispose();
      view = null;
      if (!selection().series.length) {
        exportBtns.hidden = true;
        body.replaceChildren(h("section.card", emptyState({ icon: "sip", title: "Pick a series for your SIP",
          message: "Choose an index in the series picker, then set the monthly amount here.", action: { label: "Add series", onClick: ctx.openPicker } })));
        return;
      }
      exportBtns.hidden = false;
      const inp = readInputs();
      const kpis = h("div.kpi-strip.sip-kpis");
      const saveBtn = h("button.btn.secondary.sm", { type: "button" }, icon("save", { size: "sm" }), "Save scenario");
      const formCard = h("section.card.span-4.sip-inputs", h("header.card-head", h("div.card-titles", h("h3.card-title", "Your SIP")), saveBtn),
        h("div.card-pad", inputForm(inp, writeInputs, () => midRange(current))));
      const chart = chartCard({ title: "Invested vs value", subtitle: "Month-end values · lump sum = the total invested, all on day one",
        filename: "sip", png: () => view.tc.png(),
        data: () => ({ columns: ["Date", "Invested", "Value", "Lump-sum value", "Units", "Price"],
          rows: view.res.ledger.rows.map((r) => { const c = Object.fromEntries(view.res.ledger.columns.map((k, i) => [k, r[i]])); return [c.date, c.invested, c.value, c.lump_sum_value, c.units, c.price]; }),
          format: { Invested: format.money, Value: format.money, "Lump-sum value": format.money, Units: (v) => format.number(v, { decimals: 3 }), Price: (v) => format.number(v) } }) });
      chart.el.classList.add("span-8");
      const sens = chartCard({ title: "Start-date sensitivity", subtitle: `XIRR of the same SIP started in each month, held to the end (at least ${settings().sip.sensitivity_min_months} instalments)`,
        filename: "sip-sensitivity", png: () => view.gridChart.png(),
        data: () => ({ columns: ["Start", "Months", "Invested", "Final value", "XIRR"], rows: view.res.sensitivity.map((r) => [r.start, r.months, r.invested, r.final_value, r.xirr]),
          format: { Invested: format.money, "Final value": format.money, XIRR: pct } }) });
      sens.el.classList.add("span-12");
      const scenBody = h("div.card-pad");
      const scenCard = h("section.card.span-12", h("header.card-head", h("div.card-titles", h("h3.card-title", "Scenarios"),
        h("p.card-sub", `Save up to ${MAX_SCENARIOS} and compare them over the same period · stored in this browser`))), scenBody);

      body.replaceChildren(kpis, h("div.grid", formCard, chart.el, sens.el, scenCard));
      view = { kpis, saveBtn, chart, sens, scenBody, tc: null, gridChart: null, res: null };
      renderScenarios(scenBody);
      run();
    }

    /** Re-run the backtest for the current inputs, keeping the form (and its focus) intact. */
    async function run() {
      if (!view) return render();
      const mine = ++token;
      dispose();
      const track = (fn) => (mine === token ? disposers.push(fn) : fn());
      const { kpis, saveBtn, chart, sens, scenBody } = view;
      const inp = readInputs();
      const request = { ticker: inp.ticker, amount: inp.amount, day: inp.day, step_up: inp.step_up, top_ups: inp.top_ups, ...rangeParams() };
      kpis.replaceChildren(...["Invested", "Final value", "XIRR", "Absolute return", "Lump sum instead", "Worst point vs invested"].map(() => kpiCard({ label: "…" }).el));
      chart.loading(); sens.loading();
      let res;
      try {
        res = await api.post("/analytics/sip?sensitivity=true", request, { timeout: 60_000 });
      } catch (e) {
        if (mine !== token) return;
        current = null;
        kpis.replaceChildren(errorState(e, { onRetry: run }));
        chart.error(e, run); sens.error(e, run);
        return;
      }
      if (mine !== token) return;
      current = { request, res };
      view.res = res;
      const st = res.stats;
      saveBtn.disabled = loadScenarios().length >= MAX_SCENARIOS;
      saveBtn.onclick = () => {
        const list = loadScenarios();
        if (list.length >= MAX_SCENARIOS) return toast({ tone: "warning", title: `You can keep ${MAX_SCENARIOS} scenarios`, message: "Remove one to save another." });
        saveScenarios([...list, inp]);
        toast({ tone: "success", title: "Scenario saved", message: scenarioName(inp) });
        renderScenarios(scenBody);
        saveBtn.disabled = list.length + 1 >= MAX_SCENARIOS;
      };

      const card = (label, value, kind, extra = {}) => { const c = kpiCard({ label, kind, ...extra }); c.update({ value, ...extra }); return c.el; };
      kpis.replaceChildren(
        moneyCard("Invested", st.total_invested, `${st.instalments} instalments${st.top_ups ? ` + ${st.top_ups} top-up${st.top_ups > 1 ? "s" : ""}` : ""}`),
        moneyCard("Final value", st.final_value, `${st.absolute_gain >= 0 ? "Gain" : "Loss"} ${format.money(Math.abs(st.absolute_gain), { compact: true })}`),
        card("XIRR", st.xirr, "pct"),
        card("Absolute return", st.absolute_return, "pct"),
        moneyCard("Lump sum instead", st.lump_sum_final_value, `CAGR ${pct(st.lump_sum_cagr, 1)} · same total on day one`),
        card("Worst point vs invested", st.worst_drawdown, "pct"));

      const plot = h("div.plot");
      chart.content(h("div", h("ul.legend",
        h("li", h("span.chip-dot", { style: { background: seriesColour(inp.ticker) } }), "Value"),
        h("li", h("span.legend-line.dashed"), "Invested"),
        h("li", h("span.legend-line"), "Lump sum")), plot));
      const tc = view.tc = await createTimeChart(plot, { height: 320, valueFormat: money });
      track(() => tc.destroy());
      const col = (name) => res.ledger.columns.indexOf(name);
      const line = (name) => res.ledger.rows.filter((r) => r[col(name)] != null).map((r) => ({ time: r[0], value: r[col(name)] }));
      tc.setSeries([
        { id: "value", type: "area", colour: seriesColour(inp.ticker), title: "Value", data: line("value") },
        { id: "invested", type: "line", colour: "var(--text-muted)", dashed: true, title: "Invested", data: line("invested") },
        { id: "lump", type: "line", colour: "var(--text-2)", width: 1.5, title: "Lump sum", data: line("lump_sum_value") },
      ]);

      renderSensitivity(sens, res.sensitivity, (c) => { view.gridChart = c; track(() => c.destroy()); });
    }

    function moneyCard(label, value, sub) {
      return h("article.card.kpi-card", h("p.kpi-label", label), h("p.kpi-value.mono", money(value)), h("p.kpi-delta.muted", sub));
    }

    async function renderSensitivity(card, rows, keep) {
      if (!rows?.length) return card.empty({ icon: "calendar", title: "Range too short", message: "Pick a longer period to see how the start month changes the result." });
      const years = [...new Set(rows.map((r) => +r.start.slice(0, 4)))].sort((a, b) => a - b);
      const values = years.map(() => Array(12).fill(null));
      rows.forEach((r) => { values[years.indexOf(+r.start.slice(0, 4))][+r.start.slice(5, 7) - 1] = r.xirr; });
      const valid = rows.filter((r) => r.xirr != null);
      const best = valid.reduce((a, b) => (b.xirr > a.xirr ? b : a));
      const worst = valid.reduce((a, b) => (b.xirr < a.xirr ? b : a));
      const positive = valid.filter((r) => r.xirr > 0).length / valid.length;
      const label = (r) => `${MONTHS[+r.start.slice(5, 7) - 1]} ${r.start.slice(0, 4)}`;
      const plot = h("div.plot");
      card.content(h("div", h("div.plot-scroll", { tabindex: "0", role: "region", "aria-label": "XIRR by start month (scrolls sideways)" }, plot),
        h("p.insight", `Best start: ${label(best)} (${pct(best.xirr, 1)} XIRR). Worst: ${label(worst)} (${pct(worst.xirr, 1)}). ` +
          `XIRR was positive for ${format.number(positive * 100, { decimals: 0 })}% of start months.`)));
      keep(await createEChart(plot, (t) => heatmapOption(t, { years, months: MONTHS, values, fmt: (v) => pct(v, 1), tooltipTitle: "Start" }),
        { height: Math.max(160, years.length * 28 + 44) }));
    }

    function renderScenarios(target) {
      const list = loadScenarios();
      if (!list.length) {
        target.replaceChildren(h("p.muted", "No saved scenarios yet. Set up a SIP above and press “Save scenario” to compare up to four."));
        return;
      }
      target.replaceChildren(h("p.muted", "Running scenarios…"));
      const layout = view;
      Promise.allSettled(list.map((x) => api.post("/analytics/sip", { ...x, ...rangeParams() }))).then((results) => {
        if (layout !== view) return; // page was rebuilt meanwhile
        const cols = ["Scenario", "Invested", "Final value", "XIRR", "Absolute return", "Worst vs invested", ""];
        const rows = list.map((x, i) => {
          const r = results[i];
          const st = r.status === "fulfilled" ? r.value.stats : null;
          return h("tr",
            h("td", h("span.chip-dot", { style: { background: seriesColour(x.ticker) } }), " ", scenarioName(x)),
            ...(st ? [st.total_invested, st.final_value].map((v) => h("td.num", format.money(v)))
              .concat([st.xirr, st.absolute_return, st.worst_drawdown].map((v) => h(`td.num${v < 0 ? ".neg" : ""}`, pct(v, 1))))
              : [h("td.muted", { colspan: "5" }, r.reason?.message || "Couldn't run")]),
            h("td.row-actions",
              h("button.btn.ghost.sm", { type: "button", onclick: () => { writeInputs(x); render(); } }, "Load"), // rebuild so the form shows it
              h("button.icon-btn.sm", { type: "button", "aria-label": `Remove scenario ${i + 1}`, onclick: () => {
                saveScenarios(list.filter((_, k) => k !== i)); renderScenarios(target);
                if (view) view.saveBtn.disabled = loadScenarios().length >= MAX_SCENARIOS;
              } }, icon("trash", { size: "sm" }))));
        });
        target.replaceChildren(h("div.table-wrap", h("table.data-table.scenario-table",
          h("thead", h("tr", cols.map((c) => h("th", { scope: "col" }, c)))), h("tbody", rows))));
      });
    }

    const here = (fn) => () => { if (store.get().route.page === "sip") fn(); };
    const unsubs = [
      store.subscribe((s) => s.selection, here(render)),
      store.subscribe((s) => s.route.params, here(run)),
      store.subscribe((s) => s.settings?.sip, here(render)),
      store.subscribe((s) => s.settings?.formats, here(render)),
      store.subscribe((s) => s.settings?.data.source, here(render)),
    ];
    render();
    return () => { unsubs.forEach((u) => u()); token++; dispose(); };
  },
};
