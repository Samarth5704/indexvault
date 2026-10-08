// Column builder: add / remove / reorder columns and edit windows of derived
// columns (SMA, EMA, RSI, rolling vol). Changes apply live via onChange(ids).

import { BASE, columnLabel, DEFAULT_COLUMNS, defaultWindow, isValidColumn, parseColumn, SIMPLE, WINDOWED } from "../columns.js";
import { h, icon } from "../dom.js";
import { openDrawer } from "./drawer.js";

const TYPES = [
  ...Object.entries(BASE).map(([id, label]) => ({ id, label, group: "Price data" })),
  { id: "return", label: "Return (simple)", group: "Derived" },
  { id: "log_return", label: "Return (log)", group: "Derived" },
  ...Object.entries(WINDOWED).map(([id, label]) => ({ id, label: id === "vol" ? "Rolling volatility" : label, group: "Derived", windowed: true })),
  { id: "drawdown", label: SIMPLE.drawdown, group: "Derived" },
  { id: "rebased", label: SIMPLE.rebased, group: "Derived" },
];

/** openColumnBuilder({columns, settings, freq, onChange}) */
export function openColumnBuilder({ columns, settings, freq, onChange }) {
  let cols = [...columns];
  const list = h("ol.col-list", { "aria-label": "Columns, in display order" });
  const err = h("p.field-error", { role: "alert" });
  const typeSel = h("select.select", { "aria-label": "Column type" },
    ["Price data", "Derived"].map((g) => h("optgroup", { label: g },
      TYPES.filter((t) => t.group === g).map((t) => h("option", { value: t.id }, t.label)))));
  const winInput = h("input.input.win-input", { type: "number", min: "2", max: "1000", step: "1", "aria-label": "Window (bars)" });
  const winField = h("label.field.win-field", h("span.field-label", "Window"), winInput);
  const unit = { Daily: "trading days", Weekly: "weeks", Monthly: "months", Quarterly: "quarters", Yearly: "years" }[freq];

  function syncWindowField() {
    const t = TYPES.find((x) => x.id === typeSel.value);
    winField.hidden = !t.windowed;
    if (t.windowed) winInput.value = defaultWindow(t.id, settings);
    err.textContent = "";
  }

  function commit(next) {
    cols = next;
    render();
    onChange(cols);
  }

  function editWindow(i) {
    const { kind, window } = parseColumn(cols[i]);
    const input = h("input.input.win-input", { type: "number", min: "2", max: "1000", value: String(window), "aria-label": `${columnLabel(cols[i])} window` });
    const apply = () => {
      const id = `${kind}_${Math.round(Number(input.value))}`;
      if (!isValidColumn(id)) { err.textContent = "Window must be a whole number from 2 to 1000."; input.focus(); return; }
      if (id !== cols[i] && cols.includes(id)) { err.textContent = `${columnLabel(id)} is already in the table.`; input.focus(); return; }
      err.textContent = "";
      commit(cols.map((c, k) => (k === i ? id : c)));
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); apply(); }
      if (e.key === "Escape") { e.stopPropagation(); render(); }
    });
    input.addEventListener("blur", apply);
    list.children[i].querySelector(".col-name").replaceChildren(h("span", WINDOWED[kind]), input);
    input.select();
  }

  function render() {
    list.replaceChildren(...cols.map((id, i) => {
      const windowed = parseColumn(id).window != null;
      return h("li.col-item",
        h("span.col-name", columnLabel(id)),
        h("div.col-actions",
          windowed && h("button.icon-btn.sm", { type: "button", "aria-label": `Edit ${columnLabel(id)} window`, title: "Edit window", onclick: () => editWindow(i) }, icon("edit", { size: "sm" })),
          h("button.icon-btn.sm", { type: "button", "aria-label": `Move ${columnLabel(id)} up`, disabled: i === 0,
            onclick: () => { const n = [...cols]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; commit(n); } }, icon("arrow-up", { size: "sm" })),
          h("button.icon-btn.sm", { type: "button", "aria-label": `Move ${columnLabel(id)} down`, disabled: i === cols.length - 1,
            onclick: () => { const n = [...cols]; [n[i], n[i + 1]] = [n[i + 1], n[i]]; commit(n); } }, icon("arrow-down", { size: "sm" })),
          h("button.icon-btn.sm", { type: "button", "aria-label": `Remove ${columnLabel(id)}`, disabled: cols.length === 1,
            onclick: () => commit(cols.filter((_, k) => k !== i)) }, icon("x", { size: "sm" }))));
    }));
  }

  const form = h("form.col-add",
    h("label.field", h("span.field-label", "Add column"), typeSel),
    winField,
    h("button.btn.primary.sm", { type: "submit" }, icon("plus", { size: "sm" }), "Add"));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = TYPES.find((x) => x.id === typeSel.value);
    const id = t.windowed ? `${t.id}_${Math.round(Number(winInput.value))}` : t.id;
    if (!isValidColumn(id)) { err.textContent = "Window must be a whole number from 2 to 1000."; winInput.focus(); return; }
    if (cols.includes(id)) { err.textContent = `${columnLabel(id)} is already in the table.`; return; }
    err.textContent = "";
    commit([...cols, id]);
  });
  typeSel.addEventListener("change", syncWindowField);
  typeSel.value = "sma";
  syncWindowField();
  render();

  let closeDrawer = () => {};
  closeDrawer = openDrawer({
    title: "Columns",
    body: h("div.col-builder",
      form, err,
      h("p.field-hint", `Windows count ${unit} at the current frequency (${freq}). Returns, drawdown and volatility are shown as %, RSI on a 0–100 scale.`),
      h("h3.section-title", "In the table"),
      list),
    footer: h("div.drawer-actions",
      h("button.btn.ghost.sm", { type: "button", onclick: () => commit([...DEFAULT_COLUMNS]) }, "Reset to default"),
      h("button.btn.secondary.sm", { type: "button", onclick: () => closeDrawer() }, "Done")),
  });
  return closeDrawer;
}
