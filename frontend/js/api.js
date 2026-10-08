// Fetch wrapper for /api: timeouts, normalised errors, small GET cache, job streams.
// Response shapes: docs/API.md. Percentages arrive as decimals.

const BASE = "/api";
const DEFAULT_TIMEOUT = 30_000;
const CACHE_TTL = 60_000;
const cache = new Map(); // url -> {at, promise}

export class ApiError extends Error {
  constructor({ status = 0, code = "network_error", message = "Network error", detail = null } = {}) {
    super(message);
    Object.assign(this, { status, code, detail });
  }
}

function url(path, params) {
  const u = new URL(BASE + path, location.origin);
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
    u.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  return u.pathname + u.search;
}

/** Encode a ticker for use in a path segment (^ -> %5E). */
export const enc = (ticker) => encodeURIComponent(ticker);

async function request(method, path, { params, body, timeout = DEFAULT_TIMEOUT, raw = false, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("timeout", "TimeoutError")), timeout);
  signal?.addEventListener("abort", () => ctrl.abort(signal.reason), { once: true });
  let res;
  try {
    res = await fetch(url(path, params), {
      method,
      signal: ctrl.signal,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const timedOut = ctrl.signal.reason?.name === "TimeoutError";
    if (e.name === "AbortError" && !timedOut) throw e; // caller cancelled
    throw new ApiError({
      code: timedOut ? "timeout" : "network_error",
      message: timedOut ? "The server took too long to answer." : "Can't reach the IndexVault server. Is it running?",
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let err = {};
    try { err = (await res.json()).error || {}; } catch { /* not JSON */ }
    throw new ApiError({ status: res.status, code: err.code || "http_error", message: err.message || res.statusText, detail: err.detail });
  }
  if (raw) return res;
  return res.status === 204 ? null : res.json();
}

export const api = {
  /** GET with a short in-memory cache (identical concurrent calls share one request). */
  get(path, params, { fresh = false, ...opts } = {}) {
    const key = url(path, params);
    const hit = cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < CACHE_TTL) return hit.promise;
    const promise = request("GET", path, { params, ...opts });
    cache.set(key, { at: Date.now(), promise });
    promise.catch(() => cache.delete(key));
    return promise;
  },
  post: (path, body, opts) => request("POST", path, { body, ...opts }),
  put: (path, body, opts) => request("PUT", path, { body, ...opts }),
  patch: (path, body, opts) => request("PATCH", path, { body, ...opts }),
  del: (path, opts) => request("DELETE", path, opts),
  raw: (method, path, opts) => request(method, path, { ...opts, raw: true }),

  /** Drop cached GETs (all, or those whose URL starts with `prefix`). */
  invalidate(prefix = "") {
    for (const key of cache.keys()) if (key.startsWith(BASE + prefix)) cache.delete(key);
  },

  /**
   * Follow a background job via server-sent events. Calls onUpdate(job) on every change.
   * Resolves with the final job; falls back to polling if EventSource fails.
   */
  followJob(jobId, onUpdate = () => {}) {
    return new Promise((resolve, reject) => {
      const es = new EventSource(`${BASE}/jobs/${encodeURIComponent(jobId)}/stream`);
      const finish = (job) => { es.close(); onUpdate(job); resolve(job); };
      es.addEventListener("progress", (e) => onUpdate(JSON.parse(e.data)));
      es.addEventListener("done", (e) => finish(JSON.parse(e.data)));
      es.addEventListener("error", () => {
        es.close();
        pollJob(jobId, onUpdate).then(resolve, reject);
      });
    });
  },
};

async function pollJob(jobId, onUpdate) {
  for (;;) {
    const job = await request("GET", `/jobs/${encodeURIComponent(jobId)}`);
    onUpdate(job);
    if (job.status === "done" || job.status === "failed") return job;
    await new Promise((r) => setTimeout(r, 500));
  }
}
