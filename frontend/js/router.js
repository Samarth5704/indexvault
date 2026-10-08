// Hash router: "#/<page>?<selection>&<page params>".
// Selection keys (s, p, from, to, f) sync both ways with the store; any other
// query keys are page params (e.g. #/settings?section=formats).

import { ROUTE_BY_ID } from "./routes.js";
import { selectionFromQuery, selectionToQuery, store } from "./store.js";

const SELECTION_KEYS = new Set(["s", "p", "from", "to", "f"]);
const DEFAULT_PAGE = "dashboard";

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [page = "", query = ""] = raw.split("?");
  return { page: page || DEFAULT_PAGE, query: new URLSearchParams(query) };
}

function pageParams(query) {
  return Object.fromEntries([...query].filter(([k]) => !SELECTION_KEYS.has(k)));
}

function buildHash(page, sel, params = {}) {
  const extra = new URLSearchParams(params).toString();
  return `#/${page}?${selectionToQuery(sel)}${extra ? `&${extra}` : ""}`;
}

function onHashChange() {
  const { page, query } = parseHash();
  if (!ROUTE_BY_ID[page]) {
    navigate(DEFAULT_PAGE, {}, { replace: true });
    return;
  }
  const { selection } = store.get();
  store.set({
    route: { page, params: pageParams(query) },
    selection: selectionFromQuery(query, selection),
  });
  syncUrl(); // normalise (adds defaults like p=10Y&f=D)
}

/** Write the current page + selection to the address bar without a history entry. */
function syncUrl() {
  const { route, selection } = store.get();
  const hash = buildHash(route.page, selection, route.params);
  if (hash !== location.hash) history.replaceState(null, "", hash);
}

export function navigate(page, params = {}, { replace = false } = {}) {
  const hash = buildHash(page, store.get().selection, params);
  if (replace) {
    history.replaceState(null, "", hash);
    onHashChange();
  } else {
    location.hash = hash;
  }
}

/** Link target for a page that keeps the current selection. */
export const hrefFor = (page, params = {}) => buildHash(page, store.get().selection, params);

export function startRouter() {
  window.addEventListener("hashchange", onHashChange);
  store.subscribe((s) => s.selection, syncUrl);
  onHashChange();
}
