// Copy text robustly: Clipboard API -> legacy execCommand -> a dialog with the
// text pre-selected so the user can press Ctrl/⌘+C (some embedded browsers and
// locked-down setups refuse programmatic clipboard writes).

import { openDrawer } from "./components/drawer.js";
import { h } from "./dom.js";

function legacyCopy(text) {
  const ta = h("textarea", { readonly: true, style: { position: "fixed", top: "-1000px", opacity: "0" } });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}

/** Returns "copied" or "manual" (the user was shown the text to copy themselves). */
export async function copyText(text, { title = "Copy" } = {}) {
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch { /* fall through */ }
  if (legacyCopy(text)) return "copied";
  const ta = h("textarea.input.copy-area", { readonly: true, "aria-label": "Text to copy", rows: "14" });
  ta.value = text;
  openDrawer({
    title,
    body: h("div.copy-fallback",
      h("p.field-hint", "Your browser blocked automatic copying. The text is selected — press Ctrl+C (⌘C on a Mac)."),
      ta),
  });
  ta.focus();
  ta.select();
  return "manual";
}
