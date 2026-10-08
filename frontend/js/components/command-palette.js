// Command palette (Ctrl/⌘+K): centred 640px modal, fuzzy search, grouped
// results, shortcut hints on the right (DESIGN § 3). Commands come from a
// provider so they always reflect current state (selection, settings, catalogue).

import { h, icon, nextId, trapFocus } from "../dom.js";
import { fuzzyFilter } from "../fuzzy.js";

const MAX_RESULTS = 60;
const GROUP_ORDER = ["Pages", "Actions", "Series", "Appearance", "Settings"];

/** provider() -> [{id, group, label, icon?, hint?, keywords?, run(), searchOnly?}] */
export function createPalette(provider) {
  const listId = nextId("palette-list");
  const input = h("input.palette-input", {
    type: "text", placeholder: "Type a command, page or series…", role: "combobox", autocomplete: "off",
    "aria-expanded": "true", "aria-controls": listId, "aria-label": "Command",
  });
  const list = h("ul.palette-list", { id: listId, role: "listbox", "aria-label": "Results" });
  const dialog = h("div.palette", { role: "dialog", "aria-modal": "true", "aria-label": "Command palette" },
    h("div.palette-search", icon("search"), input, h("kbd.kbd", "Esc")),
    list);
  const overlay = h("div.overlay.palette-overlay", { hidden: true, onpointerdown: (e) => { if (e.target === overlay) close(); } }, dialog);
  document.getElementById("palette-root").append(overlay);

  let results = [], active = 0, lastFocus = null, untrap = null;

  function render() {
    const q = input.value;
    const all = provider().filter((c) => q.trim() || !c.searchOnly);
    results = fuzzyFilter(all, q, (c) => [c.label, ...(c.keywords || [])]).slice(0, MAX_RESULTS);
    if (!q.trim()) results.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
    active = Math.min(active, Math.max(0, results.length - 1));
    const rows = [];
    let group = null;
    results.forEach((c, i) => {
      if (c.group !== group) {
        group = c.group;
        rows.push(h("li.palette-group", { role: "presentation" }, group));
      }
      rows.push(h("li.palette-item", {
        id: `${listId}-${i}`, role: "option", "aria-selected": String(i === active),
        onpointerdown: (e) => e.preventDefault(),
        onclick: () => run(c),
        onpointermove: () => { if (active !== i) { active = i; mark(); } },
      }, icon(c.icon || "chevron-right", { size: "sm" }), h("span.palette-label.truncate", c.label),
      c.hint && h("kbd.kbd", c.hint)));
    });
    if (!results.length) rows.push(h("li.palette-none.muted", { role: "presentation" }, "No matching commands."));
    list.replaceChildren(...rows);
    mark();
  }

  function mark() {
    list.querySelectorAll('[aria-selected="true"]').forEach((n) => n.setAttribute("aria-selected", "false"));
    const node = document.getElementById(`${listId}-${active}`);
    node?.setAttribute("aria-selected", "true");
    node?.scrollIntoView({ block: "nearest" });
    input.setAttribute("aria-activedescendant", node ? node.id : "");
  }

  function run(cmd) {
    close();
    Promise.resolve().then(() => cmd.run());
  }

  function open(prefill = "") {
    if (!overlay.hidden) return;
    lastFocus = document.activeElement;
    overlay.hidden = false;
    input.value = prefill;
    active = 0;
    render();
    input.focus();
    untrap = trapFocus(dialog);
  }

  function close() {
    if (overlay.hidden) return;
    overlay.hidden = true;
    untrap?.();
    lastFocus?.focus?.();
  }

  input.addEventListener("input", () => { active = 0; render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { active = Math.min(active + 1, results.length - 1); mark(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); mark(); e.preventDefault(); }
    else if (e.key === "Enter" && results[active]) { run(results[active]); e.preventDefault(); }
    else if (e.key === "Escape") { close(); e.preventDefault(); }
  });

  return { open, close, toggle: () => (overlay.hidden ? open() : close()), isOpen: () => !overlay.hidden };
}
