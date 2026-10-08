// Tiny DOM helpers — the whole "framework" (no build step, no dependencies).

/**
 * h("button.btn.primary", {onclick, "aria-label": "Save"}, "Save")
 * Tag string may carry .classes and #id. Attrs: on* -> listeners, class/className,
 * style (object), dataset (object), boolean true -> empty attribute, false/null -> skipped.
 * Children: strings, numbers, nodes, arrays (flattened), null/false (skipped).
 */
export function h(tag, attrs = {}, ...children) {
  if (attrs === null || typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = {};
  }
  const [, name = "div", rest = ""] = tag.match(/^([a-z0-9-]*)(.*)$/i);
  const el = name === "svg" || name === "use" ? document.createElementNS(SVG_NS, name) : document.createElement(name || "div");
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === ".") el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "class" || key === "className") String(value).split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
    else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key === "text") el.textContent = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Icon from the inline sprite in index.html. Decorative unless `label` is given. */
export function icon(name, { size = "", label = "" } = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", `icon${size ? ` icon-${size}` : ""}`);
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) {
  el.replaceChildren();
  return el;
}

/** Run `fn` when a click lands outside `el` (and not on `except`). Returns an unsubscribe. */
export function onOutsideClick(el, fn, except = null) {
  const handler = (e) => {
    if (!el.contains(e.target) && !(except && except.contains(e.target))) fn(e);
  };
  document.addEventListener("pointerdown", handler, true);
  return () => document.removeEventListener("pointerdown", handler, true);
}

/** Keep Tab focus inside `el` (modals, sheets). Returns an unsubscribe. */
export function trapFocus(el) {
  const handler = (e) => {
    if (e.key !== "Tab") return;
    const items = $$('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])', el)
      .filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  };
  el.addEventListener("keydown", handler);
  return () => el.removeEventListener("keydown", handler);
}

let uid = 0;
export const nextId = (prefix = "iv") => `${prefix}-${++uid}`;

export const prefersReducedMotion = () =>
  document.documentElement.dataset.motion === "off" ||
  document.documentElement.dataset.motion === "reduced" ||
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
