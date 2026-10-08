// Date range: segmented presets + "Custom" popover with typed/calendar inputs.
// Frequency: compact select. Both write the shared selection (store -> URL).

import { h, icon, onOutsideClick } from "../dom.js";
import { format } from "../settings.js";
import { FREQS, selection, setSelection, store } from "../store.js";

const PRESETS = ["1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "10Y", "Max"];
const MINOR = new Set(["1M", "3M", "6M", "YTD", "3Y"]); // hidden first on narrow desktops
const today = () => new Date().toISOString().slice(0, 10);

export function dateRange({ presets = PRESETS } = {}) {
  const group = h("div.segmented", { role: "radiogroup", "aria-label": "Date range" });
  const customBtn = h("button.seg.seg-custom", { type: "button", "aria-haspopup": "dialog", "aria-expanded": "false" },
    icon("calendar", { size: "sm" }), h("span.seg-custom-label", "Custom"));
  const from = h("input.input", { type: "date", max: today(), "aria-label": "From date" });
  const to = h("input.input", { type: "date", max: today(), "aria-label": "To date" });
  const err = h("p.field-error", { role: "alert" });
  const pop = h("form.popover.range-pop", { hidden: true, role: "dialog", "aria-label": "Custom date range" },
    h("div.range-fields",
      h("label.field", h("span.field-label", "From"), from),
      h("label.field", h("span.field-label", "To"), to)),
    err,
    h("div.range-actions",
      h("button.btn.ghost.sm", { type: "button", onclick: () => close(true) }, "Cancel"),
      h("button.btn.primary.sm", { type: "submit" }, "Apply")));
  const el = h("div.date-range", group, h("div.picker-anchor", customBtn, pop));
  let stopOutside = null;

  function render() {
    const sel = selection();
    group.replaceChildren(...presets.map((p) => {
      const on = !sel.start && sel.period === p;
      return h("button.seg", { type: "button", role: "radio", "aria-checked": String(on), "data-minor": MINOR.has(p) && !on ? "true" : null, tabindex: on || (sel.start && p === presets[0]) ? "0" : "-1",
        onclick: () => setSelection({ period: p, start: null, end: null }) }, p);
    }));
    const custom = Boolean(sel.start);
    customBtn.dataset.on = custom ? "true" : "false";
    customBtn.querySelector(".seg-custom-label").textContent = custom
      ? `${format.date(sel.start)} → ${sel.end ? format.date(sel.end) : "today"}` : "Custom";
  }

  // Arrow keys move between presets (radiogroup pattern).
  group.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const radios = [...group.querySelectorAll('[role="radio"]')];
    const i = radios.indexOf(document.activeElement);
    if (i < 0) return;
    const next = radios[(i + (e.key === "ArrowRight" ? 1 : -1) + radios.length) % radios.length];
    next.focus();
    next.click();
    e.preventDefault();
  });

  function open() {
    const sel = selection();
    from.value = sel.start || "";
    to.value = sel.end || "";
    err.textContent = "";
    pop.hidden = false;
    customBtn.setAttribute("aria-expanded", "true");
    from.focus();
    stopOutside = onOutsideClick(pop, () => close(), customBtn);
  }

  function close(focus = false) {
    pop.hidden = true;
    customBtn.setAttribute("aria-expanded", "false");
    stopOutside?.();
    if (focus) customBtn.focus();
  }

  customBtn.addEventListener("click", () => (pop.hidden ? open() : close()));
  pop.addEventListener("keydown", (e) => { if (e.key === "Escape") { close(true); e.stopPropagation(); } });
  pop.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!from.value) { err.textContent = "Choose a start date."; from.focus(); return; }
    if (to.value && to.value < from.value) { err.textContent = "The end date is before the start date."; to.focus(); return; }
    setSelection({ start: from.value, end: to.value || null });
    close(true);
  });

  const unsubs = [store.subscribe((s) => s.selection, render), store.subscribe((s) => s.settings?.formats, render)];
  render();
  return { el, destroy: () => unsubs.forEach((u) => u()) };
}

export function freqSelect() {
  const select = h("select.select.freq-select", { "aria-label": "Frequency",
    onchange: (e) => setSelection({ freq: e.target.value }) },
  Object.values(FREQS).map((f) => h("option", { value: f }, f)));
  const sync = () => { select.value = selection().freq; };
  const unsub = store.subscribe((s) => s.selection.freq, sync);
  sync();
  return { el: select, destroy: unsub };
}
