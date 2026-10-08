// Small presentational components: skeleton, empty state, error state, status pill.
// Every async view uses these so no panel is ever blank (CLAUDE.md rule 5).

import { h, icon } from "../dom.js";

/** Shimmering placeholder. variant: "lines" (default) | "block" | "kpi" | "chart". */
export function skeleton({ variant = "lines", lines = 3, label = "Loading" } = {}) {
  const el = h("div.skeleton", { "data-variant": variant, role: "status", "aria-live": "polite" },
    h("span.sr-only", `${label}…`));
  if (variant === "lines") {
    for (let i = 0; i < lines; i++) el.append(h("div.sk-line", { style: { width: `${90 - i * 15}%` } }));
  } else {
    el.append(h("div.sk-block"));
  }
  return el;
}

/** Icon + one sentence + optional action button (DESIGN § 3, § 5). */
export function emptyState({ icon: name = "inbox", title, message, action } = {}) {
  return h("div.empty-state",
    h("div.empty-art", icon(name)),
    title && h("p.empty-title", title),
    message && h("p.empty-msg", message),
    action && h("button.btn.secondary.sm", { type: "button", onclick: action.onClick }, action.label));
}

/** Error panel with retry. */
export function errorState(error, { onRetry } = {}) {
  return h("div.empty-state.error-state", { role: "alert" },
    h("div.empty-art", icon("alert-octagon")),
    h("p.empty-title", error?.code === "network_error" ? "Can't reach the server" : "Couldn't load this"),
    h("p.empty-msg", error?.message || String(error)),
    onRetry && h("button.btn.secondary.sm", { type: "button", onclick: onRetry }, icon("refresh", { size: "sm" }), "Try again"));
}

const STATUS = {
  good: { icon: "check-circle", label: "Good" },
  warning: { icon: "alert-triangle", label: "Warning" },
  serious: { icon: "alert-triangle", label: "Serious" },
  critical: { icon: "alert-octagon", label: "Critical" },
};

/** Icon + label + status colour at 12% alpha (never colour alone). */
export function statusPill(status, label = STATUS[status]?.label ?? status) {
  return h("span.status-pill", { "data-status": status }, icon(STATUS[status]?.icon || "info", { size: "sm" }), label);
}

/**
 * Render an async view: shows a skeleton while `load()` runs, then `render(data)`,
 * the empty state if `isEmpty(data)`, or an error state with retry.
 */
export async function asyncView(el, { load, render, isEmpty = () => false, empty, skeleton: sk = {} }) {
  el.replaceChildren(skeleton(sk));
  el.setAttribute("aria-busy", "true");
  try {
    const data = await load();
    el.replaceChildren(isEmpty(data) ? emptyState(empty) : render(data));
  } catch (e) {
    if (e.name === "AbortError") return;
    el.replaceChildren(errorState(e, { onRetry: () => asyncView(el, { load, render, isEmpty, empty, skeleton: sk }) }));
  } finally {
    el.removeAttribute("aria-busy");
  }
}

/**
 * Run load() for a chart card: skeleton first, error state with retry on failure.
 * onError(e, retry) lets other panels fed by the same request show the error too,
 * so nothing is left on a skeleton forever.
 */
export async function guard(card, load, onError = null) {
  card.loading();
  try {
    await load();
  } catch (e) {
    if (e.name === "AbortError") return;
    const retry = () => guard(card, load, onError);
    card.error(e, retry);
    onError?.(e, retry);
  }
}
