// Confirm dialog for destructive actions (CLAUDE.md rule 10: never delete user
// data without asking). Resolves true on confirm, false on cancel/Escape/outside click.

import { h, icon, trapFocus } from "../dom.js";

export function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const cancelBtn = h("button.btn.secondary", { type: "button" }, "Cancel");
    const okBtn = h(danger ? "button.btn.danger" : "button.btn.primary", { type: "button" }, confirmLabel);
    const dialog = h("div.confirm", { role: "alertdialog", "aria-modal": "true", "aria-labelledby": "confirm-title", "aria-describedby": "confirm-msg" },
      h("div.confirm-icon", { "data-danger": danger ? "true" : null }, icon(danger ? "alert-triangle" : "info")),
      h("h2#confirm-title", title),
      h("p#confirm-msg.text-2", message),
      h("div.confirm-actions", cancelBtn, okBtn));
    const overlay = h("div.overlay.confirm-overlay", dialog);
    const lastFocus = document.activeElement;
    const untrap = trapFocus(dialog);

    function done(result) {
      untrap();
      overlay.remove();
      lastFocus?.focus?.();
      resolve(result);
    }
    cancelBtn.addEventListener("click", () => done(false));
    okBtn.addEventListener("click", () => done(true));
    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) done(false); });
    dialog.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); done(false); } });
    document.getElementById("sheet-root").append(overlay);
    cancelBtn.focus(); // safe default for destructive dialogs
  });
}
