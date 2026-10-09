"""Series data, bulk load jobs (+ SSE progress) and CSV import."""
from __future__ import annotations

import re
from datetime import date

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from indexvault import analytics as an
from indexvault import data
from indexvault.indices import NSE_NAMES, display_name, has_volume, series_kind

from ..context import AppContext, get_ctx
from ..errors import ApiError, bad_request, not_found
from ..jsonutil import JsonableRoute, frame_payload
from ..settings import Frequency

router = APIRouter(route_class=JsonableRoute)

BASE_COLUMNS = {"open": "Open", "high": "High", "low": "Low", "close": "Close",
                "adj_close": "Adj Close", "volume": "Volume", "ntr": "NTR"}
DEFAULT_COLUMNS = ["open", "high", "low", "close", "adj_close", "volume", "return"]
TRI_DEFAULT_COLUMNS = ["close", "ntr", "return"]  # TRI: gross close + net total return
_WINDOWED = re.compile(r"^(sma|ema|rsi|vol)_(\d{1,4})$")
_SIMPLE = {"return", "log_return", "drawdown", "rebased"}
BAR_DAYS = {"Daily": 1, "Weekly": 7, "Monthly": 31, "Quarterly": 92, "Yearly": 366}
PERIODS_PER_YEAR = {"Weekly": 52, "Monthly": 12, "Quarterly": 4, "Yearly": 1}
MAX_CSV_BYTES = 20 * 1024 * 1024


# --------------------------------------------------------------------------- #
# Helpers shared with other routers
# --------------------------------------------------------------------------- #
def names(ctx: AppContext) -> dict[str, str]:
    """ticker -> display name for custom catalogue entries."""
    return {c.ticker: c.name for c in ctx.catalog.get().custom_indices}


def volume_available(ticker: str, df: pd.DataFrame | None = None) -> bool:
    """Real volume for this series? The catalogue says indices have none, but Yahoo
    has started sending volume for some (e.g. ^NSEI), so the data gets the last word:
    a series counts as having volume when most of its rows do."""
    if has_volume(ticker):
        return True
    if df is None:
        return False
    col = next((c for c in ("Volume", "volume") if c in df.columns), None)
    if col is None or df.empty:
        return False
    return bool((df[col].fillna(0) > 0).mean() > 0.5)


def has_ohlc(df: pd.DataFrame | None) -> bool | None:
    """False for close-only series (TRI, CSVs with just a close), where open, high
    and low merely repeat the close on (almost) every row; None when the frame
    doesn't carry all four columns. Accepts raw (Open…) or table (open…) names."""
    cols = {str(c).lower(): c for c in (df.columns if df is not None else [])}
    if df is None or df.empty or not {"open", "high", "low", "close"} <= set(cols):
        return None
    o, h, lo, c = (df[cols[k]] for k in ("open", "high", "low", "close"))
    return bool(((o == c) & (h == c) & (lo == c)).mean() < 0.95)


def caveats(ticker: str, source: str, df: pd.DataFrame | None = None) -> list[str]:
    out = []
    if source == "demo":
        out.append("Synthetic demo data — not real market prices.")
    is_index = ticker.startswith("^") or ticker in NSE_NAMES
    if series_kind(ticker) == "tri":
        out.append("Total return index (TRI): dividends reinvested, gross of tax. The NTR column is net of tax.")
    elif is_index and source in ("yahoo", "nse"):
        out.append("Price index: excludes dividends (TRI is ~1–1.5% p.a. higher).")
    if source == "nse":
        out.append("Data from niftyindices.com (NSE Indices), for personal research use only.")
    if has_ohlc(df) is False:
        out.append("Close only: open, high and low just repeat the close.")
    if not volume_available(ticker, df):
        out.append("Volume is not available for this series.")
    return out


def parse_columns(raw: str | None) -> list[str]:
    cols = [c.strip().lower() for c in raw.split(",")] if raw else list(DEFAULT_COLUMNS)
    cols = list(dict.fromkeys(c for c in cols if c))
    bad = [c for c in cols if c not in BASE_COLUMNS and c not in _SIMPLE and not _valid_windowed(c)]
    if bad:
        raise bad_request(f"Unknown column(s): {', '.join(bad)}.",
                          allowed=[*BASE_COLUMNS, *sorted(_SIMPLE), "sma_<n>", "ema_<n>", "rsi_<n>", "vol_<n>"])
    return cols


def _valid_windowed(col: str) -> bool:
    m = _WINDOWED.match(col)
    return bool(m) and 2 <= int(m.group(2)) <= 1000


def warmup_for(cols: list[str], freq: str) -> pd.DateOffset:
    """Extra history to load before start so windowed columns are filled from row 1."""
    bars = max([int(m.group(2)) for c in cols if (m := _WINDOWED.match(c))] + [1])
    return pd.DateOffset(days=int(bars * BAR_DAYS[freq] * 1.5) + 10)


def build_columns(daily: pd.DataFrame, cols: list[str], freq: str, start: pd.Timestamp | None,
                  trading_days: int) -> pd.DataFrame:
    """Resample, compute derived columns (decimals for returns/vol/drawdown), trim to start."""
    bars = data.resample(daily, freq, add_returns=False)
    close = bars["Close"]
    ppy = trading_days if freq == "Daily" else PERIODS_PER_YEAR[freq]
    out = pd.DataFrame(index=bars.index)
    for c in cols:
        if c in BASE_COLUMNS:
            out[c] = bars[BASE_COLUMNS[c]] if BASE_COLUMNS[c] in bars else np.nan
        elif c == "return":
            out[c] = close.pct_change()
        elif c == "log_return":
            out[c] = np.log(close).diff()
        elif m := _WINDOWED.match(c):
            kind, n = m.group(1), int(m.group(2))
            if kind == "sma":
                out[c] = close.rolling(n).mean()
            elif kind == "ema":
                out[c] = an.exponential_moving_averages(close, (n,)).iloc[:, 0]
            elif kind == "rsi":
                out[c] = an.rsi(close, n)
            else:
                out[c] = close.pct_change().rolling(n).std() * np.sqrt(ppy)
    if start is not None:
        out = out.loc[start:]
    shown = close.loc[out.index]
    if "drawdown" in cols:
        out["drawdown"] = an.drawdown(shown)
    if "rebased" in cols:
        out["rebased"] = shown / shown.iloc[0] * 100 if len(shown) else shown
    return out[cols]


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@router.get("/series/{ticker}")
def get_series(
    ticker: str,
    start: date | None = None,
    end: date | None = None,
    period: str | None = Query(None, description="1M…20Y, YTD or Max; ignored if start is given."),
    freq: Frequency | None = None,
    columns: str | None = Query(None, description="Comma list, e.g. close,return,sma_50,rsi_14,vol_63,drawdown,rebased"),
    source: str | None = None,
    ctx: AppContext = Depends(get_ctx),
):
    """OHLCV + derived columns. Returns, log returns, vol and drawdown are decimals;
    rsi is 0–100; rebased starts at 100."""
    s = ctx.settings
    source = ctx.source_for(ticker, ctx.explicit_source(source))
    freq = freq or s.data.default_frequency
    cols = parse_columns(columns) if columns or series_kind(ticker) == "price" else list(TRI_DEFAULT_COLUMNS)
    start_ts, end_ts = ctx.date_range(period, start, end)
    daily = ctx.frame(ticker, source, start_ts, end_ts, warmup=warmup_for(cols, freq))
    table = build_columns(daily, cols, freq, start_ts, s.analytics.trading_days)
    if table.empty:
        raise not_found(f"No {ticker} rows in the requested range.", ticker=ticker)
    return {
        "ticker": ticker, "name": display_name(ticker, names(ctx)), "source": source, "freq": freq,
        **frame_payload(table),
        "meta": {"rows": len(table), "first": table.index[0], "last": table.index[-1],
                 "kind": series_kind(ticker), "ohlc": has_ohlc(daily) is not False,
                 "source_label": data.SOURCE_INFO[source].label,
                 "has_volume": volume_available(ticker, daily), "caveats": caveats(ticker, source, daily)},
    }


class LoadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tickers: list[str] = Field(min_length=1)
    start: date | None = None
    end: date | None = None
    period: str | None = None
    refresh: bool = False
    source: str | None = None


def submit_fetch_job(ctx: AppContext, kind: str, tickers: list[str], source: str | None,
                     start: pd.Timestamp | None, end: pd.Timestamp, refresh: bool) -> dict:
    """`source` None = each ticker's own source."""
    def work(ticker: str) -> dict:
        try:
            df = ctx.full_frame(ticker, source, start, end, refresh=refresh)
        except ApiError as e:
            d = e.detail if isinstance(e.detail, dict) else {}
            # a source with a fallback (NSE → CSV import) has the full advice in the message
            raise RuntimeError(e.message if d.get("fallback") else d.get("reason", e.message)) from None
        return {"rows": len(df), "first": df.index[0], "last": df.index[-1]}

    online = any(not data.SOURCE_INFO[ctx.source_for(t, source)].offline for t in tickers)
    throttle = ctx.settings.data.request_throttle_seconds if online else 0.0
    return ctx.jobs.submit(kind, tickers, work, throttle)


@router.post("/load", status_code=202)
def load(body: LoadRequest, ctx: AppContext = Depends(get_ctx)):
    """Download/update tickers in the background. Poll GET /jobs/{id} or stream it."""
    source = ctx.explicit_source(body.source)
    tickers = ctx.tickers(body.tickers)
    start, end = ctx.date_range(body.period, body.start, body.end)
    return submit_fetch_job(ctx, "load", tickers, source, start, end, body.refresh)


@router.get("/jobs/{job_id}")
def get_job(job_id: str, ctx: AppContext = Depends(get_ctx)):
    job = ctx.jobs.get(job_id)
    if job is None:
        raise not_found(f"No job {job_id!r}.")
    return job


@router.get("/jobs/{job_id}/stream")
def stream_job(job_id: str, ctx: AppContext = Depends(get_ctx)):
    """Server-sent events: `progress` (job snapshot) on each change, then `done`."""
    if ctx.jobs.get(job_id) is None:
        raise not_found(f"No job {job_id!r}.")
    return StreamingResponse(ctx.jobs.stream(job_id), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/import/csv", status_code=201)
async def import_csv(request: Request,
                     ticker: str = Query(..., min_length=1, max_length=40, pattern=r"^[A-Za-z0-9^=._&-]+$"),
                     dayfirst: bool = Query(False, description="Dates are DD-MM-YYYY."),
                     ctx: AppContext = Depends(get_ctx)):
    """Raw CSV in the request body (Content-Type text/csv). Stored as source "csv"."""
    body = await request.body()
    if not body:
        raise bad_request("Request body is empty; send the CSV file contents.")
    if len(body) > MAX_CSV_BYTES:
        raise ApiError(413, "too_large", "CSV is larger than 20 MB.")
    try:
        df = data.import_csv(ticker, body, dayfirst=dayfirst)
    except (ValueError, pd.errors.ParserError) as e:
        raise bad_request(f"Could not read the CSV: {e}") from None
    return {"ticker": ticker, "source": "csv", "rows": len(df),
            "first": df.index[0], "last": df.index[-1]}
