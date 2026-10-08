// Shortcuts (SPEC § 3.10 #9): view and rebind keyboard shortcuts. "Change" records
// the next key combo (a plain key followed quickly by another makes a sequence like
// "g d"); clashes are caught before saving. Escape cancels recording.

import { shortcutLabel } from "../../commands.js";
import { toastError } from "../../components/toast.js";
import { h, icon } from "../../dom.js";
import { saveSection, settings } from "../../settings.js";
import { searchText } from "./schema-section.js";

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const SEQUENCE_MS = 900;
// Mirrors DEFAULT_SHORTCUTS in backend/api/settings.py (labels for the UI).
export const ACTIONS = {
  palette: { label: "Open the command palette", default: "mod+k" },
  toggle_theme: { label: "Toggle light / dark", default: "mod+shift+l" },
  toggle_sidebar: { label: "Collapse or expand the sidebar", default: "mod+b" },
  focus_series_picker: { label: "Add series (open the picker)", default: "/" },
};
const KEY_RE = /^(?:(?:mod|ctrl|alt|shift|meta)\+)*(?:[a-z0-9/.,;'`[\]=-]|f[1-9]|f1[0-2]|enter|escape|space|tab|up|down|left|right)$/;
const BROWSER_KEYS = new Set(["mod+w", "mod+t", "mod+n", "mod+shift+n", "mod+shift+t", "mod+q", "mod+tab", "mod+l", "mod+r", "mod+p"]);
const NAMED = { " ": "space", arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", enter: "enter", tab: "tab", escape: "escape" };

/** KeyboardEvent -> "mod+shift+l" (null for a lone modifier). */
export function comboFromEvent(e) {
  if (["Control", "Shift", "Alt", "Meta", "OS"].includes(e.key)) return null;
  let key = NAMED[e.key.toLowerCase()];
  if (!key && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase(); // layout-safe letters, even with Shift/Alt
  else if (!key && /^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (!key && /^F\d{1,2}$/.test(e.key)) key = e.key.toLowerCase();
  key ||= e.key.toLowerCase();
  const mods = [];
  if (IS_MAC ? e.metaKey : e.ctrlKey) mods.push("mod");
  if (IS_MAC && e.ctrlKey) mods.push("ctrl");
  if (!IS_MAC && e.metaKey) mods.push("meta");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  return [...mods, key].join("+");
}

export function shortcutsSection(ctx) {
  const list = h("div.shortcut-list", { role: "list" });
  let recording = null; // {action, first, timer, row}

  function render() {
    const map = settings().shortcuts;
    const actions = [...new Set([...Object.keys(ACTIONS), ...Object.keys(map)])];
    list.replaceChildren(...actions.map((a) => row(a, map[a])));
  }

  function row(action, combo) {
    const meta = ACTIONS[action] || { label: action.replaceAll("_", " ") };
    const isRec = recording?.action === action;
    const keys = h("span.shortcut-keys", isRec ? h("span.recording", recording.first ? `${shortcutLabel(recording.first)} then…` : "Press keys…")
      : combo ? combo.split(" ").map((chord, i) => [i ? h("span.muted", " then ") : null, h("kbd.kbd", shortcutLabel(chord))]) : h("span.muted", "Not set"));
    const msg = h("p.field-error", { "data-action": action });
    return h("div.shortcut-row", { role: "listitem", "data-search": searchText(meta.label, action, combo, "shortcut key") , "data-recording": isRec ? "true" : null },
      h("div.shortcut-text", h("span", meta.label), msg),
      keys,
      h("div.row-actions",
        isRec
          ? h("button.btn.ghost.sm", { type: "button", onclick: stop }, "Cancel")
          : h("button.btn.secondary.sm", { type: "button", onclick: () => start(action) }, "Change"),
        meta.default && combo !== meta.default && !isRec &&
          h("button.icon-btn.sm", { type: "button", "aria-label": `Reset ${meta.label} to ${shortcutLabel(meta.default)}`, title: `Reset to ${shortcutLabel(meta.default)}`,
            onclick: () => save(action, meta.default) }, icon("refresh", { size: "sm" }))));
  }

  function start(action) {
    stop();
    recording = { action, first: null, timer: null };
    window.addEventListener("keydown", onKey, true);
    render();
    list.querySelector('[data-recording="true"] .btn')?.focus();
  }

  function stop() {
    if (!recording) return;
    clearTimeout(recording.timer);
    recording = null;
    window.removeEventListener("keydown", onKey, true);
    render();
  }

  // Capture phase on window runs before the app's global shortcut handler.
  function onKey(e) {
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) return; // let focus move
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === "Escape" && !recording.first) return stop();
    const combo = comboFromEvent(e);
    if (!combo) return;
    const plain = !combo.includes("+");
    const { action } = recording;
    if (recording.first) {
      clearTimeout(recording.timer);
      return finish(action, plain ? `${recording.first} ${combo}` : recording.first);
    }
    if (!plain) return finish(action, combo);
    recording.first = combo; // wait briefly for a second key ("g d")
    recording.timer = setTimeout(() => finish(action, recording.first), SEQUENCE_MS);
    render();
  }

  function finish(action, combo) {
    stop();
    const problem = check(action, combo);
    if (problem) return showError(action, problem);
    save(action, combo);
  }

  function check(action, combo) {
    if (!combo.split(" ").every((c) => KEY_RE.test(c))) return `“${shortcutLabel(combo)}” can't be used as a shortcut. Try letters, digits or F-keys with Ctrl/Alt/Shift.`;
    const clash = Object.entries(settings().shortcuts).find(([a, c]) => a !== action && c === combo);
    if (clash) return `${shortcutLabel(combo)} is already used for “${ACTIONS[clash[0]]?.label || clash[0]}”.`;
    return "";
  }

  async function save(action, combo) {
    try {
      await saveSection("shortcuts", { ...settings().shortcuts, [action]: combo });
      if (BROWSER_KEYS.has(combo)) showError(action, `Saved, but your browser may keep ${shortcutLabel(combo)} for itself.`);
    } catch (e) { toastError(e, "Couldn't save the shortcut"); }
  }

  function showError(action, text) {
    const el = list.querySelector(`.field-error[data-action="${action}"]`);
    if (el) el.textContent = text;
  }

  ctx.watch((s) => s.shortcuts, () => { if (!recording) render(); });
  ctx.onCleanup(stop);
  render();
  return [h("p.field-hint.shortcut-intro", "Press Change, then the new keys. Shortcuts without a modifier key (like /) don't fire while you're typing in a text box."), list];
}
