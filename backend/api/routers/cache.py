"""Cache inventory and maintenance, plus the catalogue ticker health check."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pandas as pd
from fastapi import APIRouter, Body, Depends, Query

from indexvault import data

from ..context import AppContext, get_ctx
from ..errors import ApiError, bad_request, not_found
from ..jsonutil import JsonableRoute, convert_rows

router = APIRouter(route_class=JsonableRoute)

CHECK_WORKERS = 4  # parallel probes; low enough not to trip Yahoo's rate limits


def _inventory() -> list[dict]:
    inv = data.cache_inventory()
    return convert_rows(inv, renames={"Size (KB)": "size_kb"}) if not inv.empty else []


@router.get("/cache")
def get_cache():
    rows = _inventory()
    return {"cache_dir": str(data.get_cache_root()), "entries": rows,
            "total_rows": sum(r["rows"] for r in rows),
            "total_size_kb": round(sum(r["size_kb"] for r in rows), 1)}


@router.post("/cache/update", status_code=202)
def update_cache(body: dict = Body(default={}, examples=[{"source": "yahoo", "tickers": ["^NSEI"]}]),
                 ctx: AppContext = Depends(get_ctx)):
    """Bring cached tickers up to date (no backfill). Defaults to every cached
    ticker of the default source. Returns a job like POST /load."""
    source = ctx.source(body.get("source"))
    cached = [r["ticker"] for r in _inventory() if r["source"] == source]
    tickers = ctx.tickers(body.get("tickers"), required=False) or cached
    if not tickers:
        raise bad_request(f"Nothing cached for source {source!r}.")
    today = pd.Timestamp.today().normalize()

    def work(ticker: str) -> dict:
        df, info = data.load_cached(ticker, source)
        start = pd.Timestamp(info["requested_start"]) if info.get("requested_start") else None
        try:
            df = ctx.full_frame(ticker, source, start, today)
        except ApiError as e:
            raise RuntimeError(e.message) from None
        return {"rows": len(df), "first": df.index[0], "last": df.index[-1]}

    throttle = 0.0 if data.SOURCE_INFO[source].offline else ctx.settings.data.request_throttle_seconds
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
    """Probe every catalogue ticker for recent data from `source` (slow for Yahoo)."""
    source = ctx.source(source)
    items = [i for c in ctx.catalog.merged()["categories"] for i in c["items"]
             if i["source"] == source or (source != "csv" and not i["custom"])]
    with ThreadPoolExecutor(max_workers=CHECK_WORKERS) as pool:
        results = list(pool.map(lambda i: data.check_ticker(i["ticker"], source), items))
    rows = [{"ticker": i["ticker"], "name": i["name"], "ok": ok, "message": msg}
            for i, (ok, msg) in zip(items, results)]
    return {"source": source, "checked": len(rows), "ok": sum(r["ok"] for r in rows), "results": rows}
