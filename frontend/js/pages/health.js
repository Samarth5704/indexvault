// Data Health (SPEC § 3.8): quality checks per selected series with status pills
// (icon + label, never colour alone), issue list and a big-moves drill-down.

import { api } from "../api.js";
import { staticTable } from "../components/chart-card.js";
import { asyncView, emptyState, errorState, skeleton, statusPill } from "../components/feedback.js";
import { seriesName } from "../components/series-picker.js";
import { h, icon } from "../dom.js";
import { hrefFor } from "../router.js";
import { format } from "../settings.js";
import { rangeParams, selection, seriesColour, store } from "../store.js";

const n0 = (v) => (v == null ? "—" : format.number(v, { decimals: 0 }));
const STATUS_ORDER = { critical: 0, warning: 1, good: 2 };

export default {
  mount(el, ctx) {
    const summary = h("div.health-summary");
    const body = h("div.page-body");
    el.append(h("header.page-head", h("div", h("h1", "Data Health"),
      h("p.page-sub", "Check each series before trusting it in research: gaps, stale prices, broken OHLC bars, duplicates and big moves."))),
    summary, body);
    let token = 0;

    async function render() {
      const mine = ++token;
      const { series } = selection();
      if (!series.length) {
        summary.replaceChildren();
        body.replaceChildren(h("section.card", emptyState({ icon: "health", title: "Pick series to check",
          message: "Data Health runs quality checks on every selected series.", action: { label: "Add series", onClick: ctx.openPicker } })));
        return;
      }
      body.replaceChildren(h("section.card.card-pad", skeleton({ lines: series.length + 1, label: "Running checks" })));
      summary.replaceChildren();
      let q;
      try {
        q = await api.get("/analytics/quality", { tickers: series, ...rangeParams() });
      } catch (e) {
        if (mine === token) body.replaceChildren(h("section.card", errorState(e, { onRetry: render })));
        return;
      }
      if (mine !== token) return;
      const th = q.thresholds;
      const counts = { good: 0, warning: 0, critical: 0 };
      series.forEach((t) => { counts[q.series[t].status]++; });
      summary.replaceChildren(
        ...Object.entries(counts).filter(([, c]) => c).map(([s, c]) => statusPill(s, `${c} ${s}`)),
        h("p.muted.health-thresholds", `Big move: daily change over ${format.pct(th.big_move, { decimals: 0 })} · gap: more than ${th.gap_days} calendar days · `,
          h("a", { href: hrefFor("settings", { section: "analytics" }) }, "change thresholds")));

      const order = [...series].sort((a, b) => STATUS_ORDER[q.series[a].status] - STATUS_ORDER[q.series[b].status]);
      body.replaceChildren(h("section.card", h("div.table-wrap", h("table.data-table.health-table",
        h("thead", h("tr", ["Series", "Status", "Rows", "Coverage", `Gaps > ${th.gap_days}d`, "Largest gap", "Missing", "Duplicates",
          "Unchanged run", "Big moves", "OHLC issues", ""].map((c) => h("th", { scope: "col" }, c)))),
        h("tbody", order.flatMap((t) => healthRows(t, q.series[t])))))));
    }

    function healthRows(ticker, r) {
      const detail = h("tr.health-detail", { hidden: true }, h("td", { colspan: "12" }));
      const toggle = h("button.btn.ghost.sm", { type: "button", "aria-expanded": "false" }, "Details", icon("chevron-right", { size: "sm" }));
      toggle.addEventListener("click", () => {
        const open = detail.hidden;
        detail.hidden = !open;
        toggle.setAttribute("aria-expanded", String(open));
        if (open && !detail.dataset.loaded) {
          detail.dataset.loaded = "1";
          asyncView(detail.firstChild, {
            load: () => api.get("/analytics/big-moves", { ticker, ...rangeParams() }),
            isEmpty: (b) => !b.moves.length,
            empty: { icon: "check-circle", title: "No big moves", message: "No daily move crossed the threshold in this range." },
            render: (b) => h("div.health-moves",
              h("p.text-2", `${r.issues.length ? `${r.issues.join(" · ")}.` : "No issues found."} Largest gap (${n0(r.largest_gap_days)} days) ends ${format.date(r.largest_gap_ends)}.`),
              staticTable({ label: `Big moves for ${seriesName(ticker)}`, columns: ["Date", "Close", "Move"],
                rows: b.moves.map((m) => [format.date(m.date), m.close, m.move]),
                format: { Close: (v) => format.number(v), Move: (v) => format.pct(v, { decimals: 2, sign: true }) } })),
          });
        }
      });
      const num = (v, warn = false) => h(`td.num${warn && v ? ".flag" : ""}`, n0(v));
      return [h("tr",
        h("td", h("span.chip-dot", { style: { background: seriesColour(ticker) }, "aria-hidden": "true" }), " ", seriesName(ticker),
          h("span.mono.muted", ` ${ticker}`)),
        h("td", statusPill(r.status)),
        num(r.rows), h("td.num", format.pct(r.coverage, { decimals: 1 })),
        num(r.gaps, true), h("td.num", `${n0(r.largest_gap_days)} d`), num(r.missing_values, true), num(r.duplicate_dates, true),
        h("td.num", `${n0(r.longest_unchanged_close_run)} d`), num(r.big_moves, true),
        r.close_only ? h("td.num.muted", { title: "TRI or close-only data: there are no real open/high/low bars to check" }, "n/a (close only)")
          : num(r.ohlc_inconsistencies, true),
        h("td", toggle)), detail];
    }

    const here = (fn) => () => { if (store.get().route.page === "health") fn(); };
    const unsubs = [
      store.subscribe((s) => s.selection, here(render)),
      store.subscribe((s) => s.settings?.analytics, here(render)),
      store.subscribe((s) => s.settings?.data.source, here(render)),
    ];
    render();
    return () => { unsubs.forEach((u) => u()); token++; };
  },
};
