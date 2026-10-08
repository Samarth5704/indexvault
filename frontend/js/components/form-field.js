// Form field rendered from a JSON-schema property (GET /settings/schema), so every
// setting gets an editor without hand-writing it (SPEC § 3.10).
//
// formField({schema, value, meta, onChange}) -> {el, set(value), focus()}
//   schema   the property schema (anyOf-with-null = nullable; x-unit, x-options, x-ordered)
//   meta     overrides: label, hint, widget, options [{value,label}], suffix, step, onPreview(v)
//   onChange async (value) => void; throw to show the message under the field
//
// Widgets: segmented · select · switch · number · percent · range · color · text · list

import { h, icon, nextId } from "../dom.js";

const SAVED_MS = 1600;

/** Pick the non-null branch of `anyOf: [{…}, {type: "null"}]`. */
export function unwrap(schema) {
  const branches = schema.anyOf || [];
  const main = branches.find((b) => b.type !== "null");
  return main ? { ...schema, ...main, nullable: branches.some((b) => b.type === "null") } : schema;
}

function pickWidget(s, meta) {
  if (meta.widget) return meta.widget;
  if (s.type === "boolean") return "switch";
  if (s.type === "array") return "list";
  if (s.format === "color") return "color";
  if (s["x-unit"] === "pct") return "percent";
  if (s.type === "number" || s.type === "integer") return "number";
  const opts = meta.options || s.enum;
  if (opts) return opts.length <= 4 && (!meta.options || meta.segmented !== false) ? "segmented" : "select";
  return "text";
}

const options = (s, meta) => meta.options || (s.enum || s["x-options"] || []).map((o) => (typeof o === "object" ? o : { value: o, label: String(o) }));

export function formField({ schema, value, meta = {}, onChange }) {
  const s = unwrap(schema);
  const widget = pickWidget(s, meta);
  const id = nextId("f");
  const label = meta.label || sentence(s.title);
  const status = h("span.field-status", { "aria-live": "polite" });
  const error = h("p.field-error", { id: `${id}-err` });
  const hintText = meta.hint ?? (widget === "percent" ? s.description?.replace(/ ?\(decimal[^)]*\)/, "") : s.description);
  const hint = hintText && h("p.field-hint", { id: `${id}-hint` }, hintText);
  let current = value;
  let savedTimer;

  async function commit(next) {
    const problem = validate(s, next, widget);
    if (problem) return showError(problem);
    showError("");
    status.replaceChildren(h("span.muted", "Saving…"));
    control.set(next); // show the choice at once; rolled back below if the save fails
    try {
      await onChange(next);
      current = next;
      control.set(next);
      status.replaceChildren(icon("check", { size: "sm" }), h("span", "Saved"));
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => status.replaceChildren(), SAVED_MS);
    } catch (e) {
      status.replaceChildren();
      showError(e.message || String(e));
      control.set(current); // roll the control back to the stored value
    }
  }

  function showError(msg) {
    error.textContent = msg;
    el.toggleAttribute("data-invalid", Boolean(msg));
  }

  const control = WIDGETS[widget]({ id, s, meta, value, commit, label });
  const describedBy = [hint && `${id}-hint`, `${id}-err`].filter(Boolean).join(" ");
  control.focusEl?.setAttribute("aria-describedby", describedBy);

  const el = h("div.setting", { "data-widget": widget },
    h("div.setting-text",
      h(widget === "segmented" || widget === "list" ? "span.setting-label" : "label.setting-label",
        { for: widget === "segmented" || widget === "list" ? null : id, id: `${id}-label` }, label, status),
      hint),
    h("div.setting-control", control.el, error));
  return {
    el,
    set(v) { current = v; if (!el.contains(document.activeElement)) control.set(v); },
    focus: () => control.focusEl?.focus(),
  };
}

// --------------------------------------------------------------------------
// Validation (mirrors the schema so most mistakes never reach the server)
// --------------------------------------------------------------------------
function validate(s, v, widget) {
  if (v == null) return s.nullable ? "" : "Required.";
  if (s.type === "number" || s.type === "integer") {
    if (!Number.isFinite(v)) return "Enter a number.";
    if (s.type === "integer" && !Number.isInteger(v)) return "Use a whole number.";
    const show = (x) => (widget === "percent" ? `${+(x * 100).toFixed(4)}%` : x);
    if (s.minimum != null && v < s.minimum) return `Minimum is ${show(s.minimum)}.`;
    if (s.exclusiveMinimum != null && v <= s.exclusiveMinimum) return `Must be more than ${show(s.exclusiveMinimum)}.`;
    if (s.maximum != null && v > s.maximum) return `Maximum is ${show(s.maximum)}.`;
  }
  if (s.type === "string" && s.minLength && v.length < s.minLength) return "Required.";
  if (s.type === "string" && s.maxLength && v.length > s.maxLength) return `At most ${s.maxLength} characters.`;
  if (s.format === "color" && !/^#[0-9a-f]{6}$/i.test(v)) return "Use a hex colour like #2a78d6.";
  if (s.type === "array") {
    if (s.minItems && v.length < s.minItems) return `Keep at least ${s.minItems}.`;
    if (s.maxItems && v.length > s.maxItems) return `At most ${s.maxItems}.`;
    if (new Set(v).size !== v.length) return "Each value can appear once.";
    const it = s.items || {};
    for (const x of v) {
      if (it.minimum != null && x < it.minimum) return `Values start at ${it.minimum}.`;
      if (it.maximum != null && x > it.maximum) return `Values go up to ${it.maximum}.`;
    }
  }
  return "";
}

// --------------------------------------------------------------------------
// Widgets: each returns {el, set(value), focusEl}
// --------------------------------------------------------------------------
const WIDGETS = {
  segmented({ id, s, meta, value, commit, label }) {
    const opts = options(s, meta);
    const group = h("div.segmented", { role: "radiogroup", "aria-label": label, id });
    const buttons = opts.map((o) => h("button.seg", { type: "button", role: "radio", "data-value": String(o.value), onclick: () => commit(o.value) }, o.label));
    group.append(...buttons);
    const set = (v) => buttons.forEach((b, i) => {
      const on = opts[i].value === v;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    group.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      const i = buttons.indexOf(document.activeElement);
      const next = buttons[(i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length];
      next.focus();
      next.click();
      e.preventDefault();
    });
    set(value);
    return { el: group, set, focusEl: buttons.find((b) => b.tabIndex === 0) || buttons[0] };
  },

  select({ id, s, meta, value, commit }) {
    const opts = options(s, meta);
    const sel = h("select.select", { id, onchange: () => commit(opts[sel.selectedIndex].value) },
      opts.map((o) => h("option", { value: String(o.value) }, o.label)));
    const set = (v) => { sel.selectedIndex = Math.max(0, opts.findIndex((o) => o.value === v)); };
    set(value);
    return { el: sel, set, focusEl: sel };
  },

  switch({ id, value, commit }) {
    const input = h("input.switch", { type: "checkbox", role: "switch", id, onchange: () => commit(input.checked) });
    const set = (v) => { input.checked = Boolean(v); };
    set(value);
    return { el: input, set, focusEl: input };
  },

  number({ id, s, meta, value, commit }) {
    const input = h("input.input.num", { type: "number", id, step: meta.step ?? (s.type === "integer" ? 1 : "any"),
      min: s.minimum, max: s.maximum, inputmode: "decimal" });
    input.addEventListener("change", () => commit(input.value === "" ? null : Number(input.value)));
    const set = (v) => { input.value = v ?? ""; };
    set(value);
    return { el: withSuffix(input, meta.suffix), set, focusEl: input };
  },

  percent({ id, s, meta, value, commit }) {
    const scale = (v) => (v == null ? "" : +(v * 100).toFixed(4));
    const input = h("input.input.num", { type: "number", id, step: meta.step ?? 0.1, min: scale(s.minimum), max: scale(s.maximum), inputmode: "decimal" });
    input.addEventListener("change", () => commit(input.value === "" ? null : +(Number(input.value) / 100).toFixed(8)));
    const set = (v) => { input.value = scale(v); };
    set(value);
    return { el: withSuffix(input, meta.suffix ?? "%"), set, focusEl: input };
  },

  range({ id, s, meta, value, commit }) {
    const out = h("output.range-out.mono", { for: id });
    const fmt = meta.format || ((v) => String(v));
    const input = h("input.range", { type: "range", id, min: s.minimum, max: s.maximum, step: meta.step ?? "any" });
    input.addEventListener("input", () => { out.textContent = fmt(Number(input.value)); meta.onPreview?.(Number(input.value)); });
    input.addEventListener("change", () => commit(Number(input.value)));
    const set = (v) => { input.value = v; out.textContent = fmt(Number(v)); };
    set(value);
    return { el: h("div.range-row", input, out), set, focusEl: input };
  },

  color({ id, s, meta, value, commit }) {
    const picker = h("input.colour-input", { type: "color", "aria-label": "Pick a colour" });
    const text = h("input.input.mono.colour-text", { id, maxlength: 7, spellcheck: "false", placeholder: meta.placeholder || "#rrggbb" });
    picker.addEventListener("input", () => { text.value = picker.value; meta.onPreview?.(picker.value); });
    picker.addEventListener("change", () => commit(picker.value));
    text.addEventListener("change", () => commit(text.value.trim() === "" && s.nullable ? null : normaliseHex(text.value)));
    const clearBtn = s.nullable && h("button.btn.ghost.sm", { type: "button", onclick: () => commit(null) }, meta.nullLabel || "Use default");
    const swatches = meta.swatches && h("div.swatches", meta.swatches.map((c) => h("button.swatch", {
      type: "button", style: { background: c }, title: c, "aria-label": `Use ${c}`, onclick: () => commit(c) })));
    const set = (v) => {
      text.value = v ?? "";
      picker.value = /^#[0-9a-f]{6}$/i.test(v || "") ? v : meta.fallback?.() || "#000000";
      if (clearBtn) clearBtn.disabled = v == null;
    };
    set(value);
    return { el: h("div.colour-row", swatches, picker, text, clearBtn), set, focusEl: text };
  },

  text({ id, s, meta, value, commit }) {
    const input = h("input.input", { id, type: "text", maxlength: s.maxLength, spellcheck: "false", class: meta.mono ? "mono" : null });
    input.addEventListener("change", () => commit(input.value.trim()));
    const set = (v) => { input.value = v ?? ""; };
    set(value);
    return { el: input, set, focusEl: input };
  },

  list: listWidget,
};

function withSuffix(input, suffix) {
  return suffix ? h("div.input-suffix", input, h("span.suffix", suffix)) : input;
}

const normaliseHex = (v) => {
  const t = v.trim().toLowerCase();
  const m = t.match(/^#?([0-9a-f]{3})$/);
  return m ? `#${[...m[1]].map((c) => c + c).join("")}` : t.startsWith("#") ? t : `#${t}`;
};

/**
 * Chips editor for arrays. With options (x-options or meta.options) new items come
 * from a select; otherwise from a text box (numbers for integer items). x-ordered
 * lists get move buttons, since the order is shown in the app.
 */
function listWidget({ id, s, meta, value, commit, label }) {
  const opts = options(s, meta);
  const ordered = s["x-ordered"] || meta.ordered;
  const numeric = s.items?.type === "integer" || s.items?.type === "number";
  const labelOf = (v) => opts.find((o) => o.value === v)?.label ?? meta.itemLabel?.(v) ?? String(v);
  let items = [...(value || [])];
  const chips = h("ul.list-chips", { "aria-label": label });
  const adder = opts.length && !meta.free
    ? h("select.select.list-add", { id, "aria-label": `Add to ${label}` })
    : h("input.input.list-add", { id, type: numeric ? "number" : "text", placeholder: meta.placeholder || "Add…", "aria-label": `Add to ${label}`,
      min: s.items?.minimum, max: s.items?.maximum, list: opts.length ? `${id}-dl` : null });
  const datalist = opts.length > 0 && meta.free && h("datalist", { id: `${id}-dl` }, opts.map((o) => h("option", { value: o.value })));

  const move = (i, d) => { const next = [...items]; [next[i], next[i + d]] = [next[i + d], next[i]]; commit(next); };
  function render() {
    chips.replaceChildren(...items.map((v, i) => h("li.list-chip",
      ordered && h("span.list-pos.mono", String(i + 1)),
      h("span.list-chip-label", labelOf(v)),
      ordered && h("button.chip-x", { type: "button", disabled: i === 0, "aria-label": `Move ${labelOf(v)} earlier`, onclick: () => move(i, -1) }, icon("chevron-left", { size: "sm" })),
      ordered && h("button.chip-x", { type: "button", disabled: i === items.length - 1, "aria-label": `Move ${labelOf(v)} later`, onclick: () => move(i, 1) }, icon("chevron-right", { size: "sm" })),
      h("button.chip-x", { type: "button", "aria-label": `Remove ${labelOf(v)}`, onclick: () => commit(items.filter((_, j) => j !== i)) }, icon("x", { size: "sm" })))));
    if (adder.tagName === "SELECT") {
      const left = opts.filter((o) => !items.includes(o.value));
      adder.replaceChildren(h("option", { value: "" }, left.length ? "Add…" : "All added"), ...left.map((o) => h("option", { value: String(o.value) }, o.label)));
      adder.disabled = !left.length || (s.maxItems && items.length >= s.maxItems);
    }
  }
  function add() {
    const raw = adder.value.trim();
    if (!raw) return;
    const v = adder.tagName === "SELECT" ? opts.find((o) => String(o.value) === raw)?.value : numeric ? Number(raw) : meta.normalise?.(raw) ?? raw;
    adder.value = "";
    let next = [...items, v];
    if (meta.sortNumeric) next = next.sort((a, b) => a - b);
    commit(next);
  }
  if (adder.tagName === "SELECT") adder.addEventListener("change", add);
  else adder.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  const addBtn = adder.tagName !== "SELECT" && h("button.btn.secondary.sm", { type: "button", onclick: add }, icon("plus", { size: "sm" }), "Add");

  const set = (v) => { items = [...(v || [])]; render(); };
  set(value);
  return { el: h("div.list-field", chips, h("div.list-add-row", adder, addBtn, datalist)), set, focusEl: adder };
}

/** "Default Period" (pydantic's title) -> "Default period". */
const sentence = (title = "") => title.charAt(0) + title.slice(1).toLowerCase();
