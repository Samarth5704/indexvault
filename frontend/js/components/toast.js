// Toasts: bottom-right stack, polite live region, progress bar for jobs.
// Auto-dismiss after 4 s unless it's an error or still in progress (DESIGN § 3).

import { api } from "../api.js";
import { h, icon } from "../dom.js";

const ICONS = { info: "info", success: "check-circle", warning: "alert-triangle", error: "alert-octagon" };
const AUTO_DISMISS_MS = 4000;
let region;

function container() {
  region ??= document.getElementById("toasts");
  return region;
}

/**
 * toast({title, message, tone, progress, action:{label, onClick}, duration})
 * Returns {update(patch), close()}. progress: 0–1 shows a bar; null hides it.
 */
export function toast(opts) {
  let state = { tone: "info", duration: AUTO_DISMISS_MS, ...opts };
  let timer;
  const titleEl = h("p.toast-title");
  const msgEl = h("p.toast-msg");
  const iconEl = h("span.toast-icon");
  const bar = h("div.toast-bar", h("div.toast-bar-fill"));
  const actionEl = h("button.btn.ghost.sm.toast-action", { type: "button" });
  const el = h("div.toast", { role: state.tone === "error" ? "alert" : "status" },
    iconEl,
    h("div.toast-body", titleEl, msgEl, bar),
    actionEl,
    h("button.icon-btn.sm.toast-close", { type: "button", "aria-label": "Dismiss", onclick: () => close() }, icon("x", { size: "sm" })));

  function render() {
    el.dataset.tone = state.tone;
    iconEl.replaceChildren(icon(ICONS[state.tone] || "info"));
    titleEl.textContent = state.title || "";
    msgEl.textContent = state.message || "";
    msgEl.hidden = !state.message;
    const hasProgress = typeof state.progress === "number";
    bar.hidden = !hasProgress;
    if (hasProgress) bar.firstChild.style.width = `${Math.round(Math.min(1, Math.max(0, state.progress)) * 100)}%`;
    actionEl.hidden = !state.action;
    if (state.action) {
      actionEl.textContent = state.action.label;
      actionEl.onclick = () => { state.action.onClick(); close(); };
    }
    clearTimeout(timer);
    if (state.tone !== "error" && !hasProgress && state.duration) timer = setTimeout(close, state.duration);
  }

  function close() {
    clearTimeout(timer);
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 200);
  }

  render();
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", () => render());
  container().append(el);
  return { update(patch) { state = { ...state, ...patch }; render(); }, close };
}

export const toastError = (error, title = "Something went wrong") =>
  toast({ tone: "error", title, message: error?.message || String(error) });

/** Start-and-follow a background job (POST returning a job), with a live progress toast. */
export async function runJobWithToast(start, { title, doneTitle = "Done" }) {
  const t = toast({ title, message: "Starting…", progress: 0 });
  try {
    const job = await start();
    const final = await api.followJob(job.id, (j) => {
      const current = j.items.find((i) => i.status === "running");
      t.update({ progress: j.progress, message: `${j.completed}/${j.total}${current ? ` · ${current.ticker}` : ""}` });
    });
    const failed = final.items.filter((i) => i.status === "error");
    t.update({
      progress: null,
      tone: failed.length ? (failed.length === final.total ? "error" : "warning") : "success",
      title: failed.length ? `${doneTitle} with ${failed.length} error${failed.length > 1 ? "s" : ""}` : doneTitle,
      message: failed.length ? failed.map((f) => `${f.ticker}: ${f.message}`).join("\n") : `${final.total} series updated`,
    });
    return final;
  } catch (e) {
    t.update({ tone: "error", progress: null, title: `${title} failed`, message: e.message });
    throw e;
  }
}
