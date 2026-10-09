"""Cache inventory and maintenance, plus the catalogue ticker health check."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pandas as pd
from fastapi import APIRouter, Body, Depends, Query

from indexvault import data
from indexvault.indices import NSE_NAMES, TRI_SUFFIX

from ..context import AppContext, get_ctx
from ..errors import ApiError, bad_request, not_found
from ..jsonutil import JsonableRoute, convert_rows

router = APIRouter(route_class=JsonableRoute)

CHECK_WORKERS = 4  # parallel probes; low enough not to trip Yahoo's rate limits


def _inventory() -> list[dict]:
    inv = data.cache_inventory()
    return convert_rows(inv, renames={"Size (KB)": "size_kb"}) if not inv.empty else []


def _in_use(ctx: AppContext, row: dict) -> bool:
    """Is this cached file the one the app reads for its ticker? (After a ticker moves
    to another source, e.g. Yahoo -> NSE, its old file is just left over.)"""
    return ctx.source_for(row["ticker"]) == row["source"]


@router.get("/cache")
def get_cache(ctx: AppContext = Depends(get_ctx)):
    rows = _inventory()
    for r in rows:
        r["in_use"] = _in_use(ctx, r)
        r["used_source"] = ctx.source_for(r["ticker"])
    return {"cache_dir": str(data.get_cache_root()), "entries": rows,
            "total_rows": sum(r["rows"] for r in rows),
            "total_size_kb": round(sum(r["size_kb"] for r in rows), 1)}


@router.post("/cache/update", status_code=202)
def update_cache(body: dict = Body(default={}, examples=[{"source": "yahoo", "tickers": ["^NSEI"]}]),
                 ctx: AppContext = Depends(get_ctx)):
    """Bring cached tickers up to date (no backfill). By default every cached series
    the app actually uses, each from its own source; left-over files of tickers that
    now come from another source are skipped, and CSV imports can't be refreshed.
    `source` limits it to one source; `tickers` names them explicitly.
    Returns a job like POST /load."""
    explicit = ctx.explicit_source(body.get("source"))
    asked = ctx.tickers(body.get("tickers"), required=False)
    if asked:
        plan = {t: ctx.source_for(t, explicit) for t in asked}
    else:
        plan = {r["ticker"]: r["source"] for r in _inventory()
                if r["source"] != "csv" and _in_use(ctx, r) and (explicit is None or r["source"] == explicit)}
    if not plan:
        raise bad_request("Nothing cached to update" + (f" for source {explicit!r}." if explicit else "."))
    today = pd.Timestamp.today().normalize()

    def work(ticker: str) -> dict:
        source = plan[ticker]
        df, info = data.load_cached(ticker, source)
        start = pd.Timestamp(info["requested_start"]) if info.get("requested_start") else None
        try:
            df = ctx.full_frame(ticker, source, start, today)
        except ApiError as e:
            raise RuntimeError(e.message) from None
        return {"rows": len(df), "first": df.index[0], "last": df.index[-1]}

    tickers = list(plan)
    online = any(not data.SOURCE_INFO[s].offline for s in plan.values())
    throttle = ctx.settings.data.request_throttle_seconds if online else 0.0
    return ctx.jobs.submit("cache_update", tickers, work, throttle)


@router.delete("/cache/{source}/{ticker}")
def delete_cached(source: str, ticker: str):
    n = data.clear_cache(ticker=ticker, source=source)
    if n == 0:
        raise not_found(f"{ticker} is not cached for source {source!r}.")
    return {"deleted_files": n}


@router.delete("/cache")
def delete_all(confirm: bool = Query(False, description="Must be true: deletes every cached file."),
               source: str | None = None):
    if not confirm:
        raise bad_request("Add ?confirm=true to delete the whole cache.")
    return {"deleted_files": data.clear_cache(source=source)}


@router.get("/tickers/check")
def check_tickers(source: str | None = None, ctx: AppContext = Depends(get_ctx)):
    """Probe catalogue tickers for recent data from `source` (slow for Yahoo):
    those that use it, plus for Yahoo every built-in price series and for NSE every
    index niftyindices.com can serve."""
    source = ctx.source(source)

    def wanted(i: dict) -> bool:
        if i["source"] == source:
            return True
        if source == "nse":
            return i["ticker"].removesuffix(TRI_SUFFIX) in NSE_NAMES
        return source != "csv" and not i["custom"] and i["kind"] == "price"

    items = [i for c in ctx.catalog_payload()["categories"] for i in c["items"] if wanted(i)]
    with ThreadPoolExecutor(max_workers=CHECK_WORKERS) as pool:
        results = list(pool.map(lambda i: data.check_ticker(i["ticker"], source), items))
    rows = [{"ticker": i["ticker"], "name": i["name"], "ok": ok, "message": msg}
            for i, (ok, msg) in zip(items, results)]
    return {"source": source, "checked": len(rows), "ok": sum(r["ok"] for r in rows), "results": rows}
