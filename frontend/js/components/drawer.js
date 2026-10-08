// Drawer: a side panel on desktop, a bottom sheet on phones (CSS decides).
// Modal: overlay, focus trap, Esc to close, focus returns to the opener.

import { h, icon, trapFocus } from "../dom.js";

/** openDrawer({title, body, footer?, onClose?}) -> close() */
export function openDrawer({ title, body, footer = null, onClose }) {
  const closeBtn = h("button.icon-btn", { type: "button", "aria-label": "Close", onclick: () => close() }, icon("x"));
  const panel = h("aside.drawer", { role: "dialog", "aria-modal": "true", "aria-label": title },
    h("header.drawer-head", h("h2", title), closeBtn),
    h("div.drawer-body", body),
    footer && h("footer.drawer-foot", footer));
  const overlay = h("div.overlay.drawer-overlay", { onpointerdown: (e) => { if (e.target === overlay) close(); } }, panel);
  const lastFocus = document.activeElement;
  const untrap = trapFocus(panel);
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  panel.addEventListener("keydown", onKey);
  document.getElementById("sheet-root").append(overlay);
  (panel.querySelector("input, select, button:not(.icon-btn)") || closeBtn).focus();

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    untrap();
    overlay.remove();
    onClose?.();
    lastFocus?.focus?.();
  }
  return close;
}
