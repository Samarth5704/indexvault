// Widget registry, the widget card chrome, the add/configure drawer and the
// default layout. Widget types match `WIDGETS` in backend/api/settings.py.

import { openDrawer } from "../../components/drawer.js";
import { h, icon, nextId } from "../../dom.js";
import { store } from "../../store.js";
import { groupOptions } from "./common.js";
import { heatmap, mini_chart, snapshot } from "./widgets-market.js";
import { drawdown_monitor, notes, rolling_snapshot, vix_gauge } from "./widgets-risk.js";

export const WIDGETS = { snapshot, mini_chart, heatmap, vix_gauge, drawdown_monitor, rolling_snapshot, notes };

export const newId = () => `w${Math.random().toString(36).slice(2, 10)}`;
export const limitsFor = (item) => WIDGETS[item.widget]?.min || {};

/** The layout shipped with the app ("Reset layout" restores it). 12 columns. */
export function defaultLayout() {
  const w = (id, widget, x, y, wd, ht, config) => ({ id, widget, x, y, w: wd, h: ht, config: { ...WIDGETS[widget].defaults(), ...config } });
  return [
    w("snap-nifty", "snapshot", 0, 0, 3, 2, { ticker: "^NSEI" }),
    w("snap-sensex", "snapshot", 3, 0, 3, 2, { ticker: "^BSESN" }),
    w("snap-bank", "snapshot", 6, 0, 3, 2, { ticker: "^NSEBANK" }),
    w("snap-it", "snapshot", 9, 0, 3, 2, { ticker: "^CNXIT" }),
    w("chart-nifty", "mini_chart", 0, 2, 8, 4, { ticker: "^NSEI", period: "1Y", style: "area" }),
    w("vix", "vix_gauge", 8, 2, 4, 4, {}),
    w("heat-sectors", "heatmap", 0, 6, 4, 5, { group: "cat:Sectoral" }),
    w("dd-broad", "drawdown_monitor", 4, 6, 4, 5, { group: "cat:Broad market" }),
    w("roll-nifty", "rolling_snapshot", 8, 6, 4, 3, { ticker: "^NSEI" }),
    w("notes", "notes", 8, 9, 4, 2, {}),
  ];
}

// ------------------------------------------------------------------ card chrome
/**
 * The card around a widget: drag handle + title + subtitle on the left, actions on
 * the right (widget actions, configure, remove). Returns {el, title(), destroy()}.
 */
export function widgetCard(item, { onConfigure, onRemove, saveConfig }) {
  const def = WIDGETS[item.widget];
  let alive = true;
  const titleEl = h("h3.card-title.truncate");
  const subEl = h("p.card-sub.truncate");
  const actions = h("div.wc-actions");
  const body = h("div.wc-body");
  const grip = h("span.wc-grip", { "aria-hidden": "true", title: "Drag to move" }, icon("more", { size: "sm" }));
  const el = h("article.card.wc", { "data-widget": item.widget },
    h("header.wc-head", { "data-drag-handle": "" }, grip, h("div.wc-titles", titleEl, subEl), actions), body);

  if (!def) {
    titleEl.textContent = item.widget;
    body.append(h("p.muted.card-pad", "This widget type isn't available in this version."));
    actions.append(removeBtn());
    return { el, title: () => item.widget, destroy() {} };
  }
  titleEl.textContent = def.title(item.config);
  subEl.textContent = def.sub(item.config);

  function removeBtn() {
    return h("button.icon-btn.sm.wc-remove", { type: "button", "aria-label": `Remove ${titleEl.textContent}`, title: "Remove", onclick: () => onRemove(item) }, icon("x", { size: "sm" }));
  }
  const env = {
    alive: () => alive,
    setSub: (text) => { subEl.textContent = text; },
    saveConfig,
    addAction({ icon: name, label, toggle = false, onClick }) {
      const btn = h("button.icon-btn.sm", { type: "button", "aria-label": label, title: label, "aria-pressed": toggle ? "false" : null });
      btn.addEventListener("click", () => {
        const on = toggle ? btn.getAttribute("aria-pressed") !== "true" : true;
        if (toggle) btn.setAttribute("aria-pressed", String(on));
        onClick(on);
      });
      actions.prepend(btn);
    },
  };
  actions.append(
    h("button.icon-btn.sm", { type: "button", "aria-label": `Configure ${titleEl.textContent}`, title: "Configure", onclick: () => onConfigure(item) }, icon("sliders", { size: "sm" })),
    removeBtn());
  // Buttons inside the header must not start a drag.
  actions.addEventListener("pointerdown", (e) => e.stopPropagation());
  const cleanup = def.mount(body, item.config, env);
  return { el, title: () => titleEl.textContent, destroy() { alive = false; cleanup?.(); } };
}

// ------------------------------------------------------------------ drawer
function tickerSelect(value) {
  const { categories } = store.get().catalog;
  const sel = h("select.select", categories.map((c) => h("optgroup", { label: c.name },
    c.items.map((i) => h("option", { value: i.ticker, selected: i.ticker === value }, `${i.name} · ${i.ticker}`)))));
  if (value && ![...sel.options].some((o) => o.value === value)) sel.prepend(h("option", { value, selected: true }, value));
  return sel;
}

function fieldControl(f, value) {
  if (f.kind === "ticker") return tickerSelect(value);
  const opts = f.kind === "group" ? groupOptions() : typeof f.options === "function" ? f.options() : f.options;
  return h("select.select", opts.map((o) => h("option", { value: String(o.value), selected: String(o.value) === String(value) }, o.label)));
}

/** A config form for `type`; resolves via onSave(config). */
function configForm(type, config, onSave, { submitLabel, onBack } = {}) {
  const def = WIDGETS[type];
  const controls = def.fields.map((f) => [f, fieldControl(f, config[f.key])]);
  const titleIn = type === "notes" && h("input.input", { value: config.title || "Notes", maxlength: 40 });
  const read = () => {
    const out = { ...config };
    for (const [f, c] of controls) {
      const opt = f.kind === "select" ? (typeof f.options === "function" ? f.options() : f.options).find((o) => String(o.value) === c.value) : null;
      out[f.key] = opt ? opt.value : c.value;
    }
    if (titleIn) out.title = titleIn.value.trim() || "Notes";
    return out;
  };
  const field = (label, control) => { const id = nextId("wf"); control.id = id; return h("div.field", h("label.field-label", { for: id }, label), control); };
  const body = h("form.drawer-form", { onsubmit: (e) => { e.preventDefault(); onSave(read()); } },
    h("p.field-hint", def.blurb),
    titleIn && field("Title", titleIn),
    controls.map(([f, c]) => field(f.label, c)),
    !controls.length && !titleIn && h("p.muted", "Nothing to set up for this widget."),
    h("button", { type: "submit", hidden: true }));
  const footer = h("div.drawer-actions",
    onBack && h("button.btn.ghost", { type: "button", onclick: onBack }, icon("chevron-left", { size: "sm" }), "Back"),
    h("button.btn.primary", { type: "button", onclick: () => onSave(read()) }, submitLabel || "Save"));
  return { body, footer };
}

/** Configure an existing widget. */
export function openConfigure(item, onSave) {
  const def = WIDGETS[item.widget];
  let close;
  const { body, footer } = configForm(item.widget, item.config, (config) => { close(); onSave(config); });
  close = openDrawer({ title: `Configure ${def.title(item.config)}`, body, footer });
}

/** Pick a widget type, set it up, then onAdd({widget, config, w, h}). */
export function openAddWidget(onAdd) {
  let close = null;
  const gallery = () => h("ul.widget-gallery", Object.entries(WIDGETS).map(([type, def]) => h("li",
    h("button.widget-option", { type: "button", onclick: () => choose(type) },
      h("span.widget-option-icon", icon(def.icon)),
      h("span.widget-option-text", h("span.item-name", def.label), h("span.field-hint", def.blurb)),
      icon("chevron-right", { size: "sm" })))));
  function choose(type) {
    close?.(); // leave the gallery
    const def = WIDGETS[type];
    const add = (config) => { close(); onAdd({ widget: type, config, ...def.size }); };
    if (!def.fields.length && type !== "notes") return add(def.defaults());
    const { body, footer } = configForm(type, def.defaults(), add, { submitLabel: "Add to dashboard", onBack: () => { close(); open(); } });
    close = openDrawer({ title: `Add ${def.label.toLowerCase()}`, body, footer });
  }
  function open() { close = openDrawer({ title: "Add a widget", body: gallery() }); }
  open();
}
