"""Analytics routes for one or a few series: summary, trailing returns,
drawdowns, calendar returns, distribution, rolling vol, seasonality, data health.

All percentages are decimals; parameter defaults come from settings.
"""
from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, Query
from scipy import stats as sps

from indexvault import analytics as an
from indexvault.indices import display_name

from ..context import AppContext, get_ctx
from ..errors import bad_request
from ..jsonutil import JsonableRoute, convert_record, convert_rows, iso_dates, series_payload
from ..metrics import METRICS, from_core
from .series import names, volume_available

router = APIRouter(prefix="/analytics", route_class=JsonableRoute)

Tickers = Query(..., description="Comma-separated tickers, e.g. ^NSEI,^NSEBANK")
Period = Query(None, description="1M…20Y, YTD or Max; ignored if start is given.")


def _inputs(ctx: AppContext, tickers: str, period, start, end, source):
    source = ctx.source(source)
    tickers_ = ctx.tickers(tickers)
    start_ts, end_ts = ctx.date_range(period, start, end)
    return source, tickers_, start_ts, end_ts


def _single(ctx: AppContext, ticker: str, period, start, end, source):
    source, (t,), start_ts, end_ts = _inputs(ctx, ticker, period, start, end, source)
    return source, t, start_ts, end_ts, ctx.frame(t, source, start_ts, end_ts)["Close"]


def _range(close: pd.Series) -> dict:
    return {"start": close.index[0], "end": close.index[-1]}


# --------------------------------------------------------------------------- #
# Summary & trailing
# --------------------------------------------------------------------------- #
@router.get("/summary")
def summary(tickers: str = Tickers, start: date | None = None, end: date | None = None,
            period: str | None = Period, source: str | None = None,
            rf: float | None = Query(None, ge=0, le=0.5, description="Risk-free rate (decimal)."),
            ctx: AppContext = Depends(get_ctx)):
    s = ctx.settings.analytics
    rf = s.risk_free_rate if rf is None else rf
    source, tickers_, start_ts, end_ts = _inputs(ctx, tickers, period, start, end, source)
    closes = ctx.closes(tickers_, source, start_ts, end_ts)
    key = (str(start_ts), str(end_ts), rf, s.trading_days)
    series = {t: {"name": display_name(t, names(ctx)), **_range(c),
                  "metrics": ctx.computed("summary", [t], source, key,
                                          lambda c=c: from_core(an.summary_metrics(c, rf, s.trading_days)))}
              for t, c in closes.items()}
    return {"params": {"rf": rf, "trading_days": s.trading_days},
            "metrics": [{"id": m.id, "label": m.label, "kind": m.kind} for m in METRICS.values()],
            "kpi_cards": s.kpi_cards, "series": series}


@router.get("/trailing")
def trailing(tickers: str = Tickers, end: date | None = None, source: str | None = None,
             periods: str | None = Query(None, description="Comma list, e.g. 1M,1Y,3Y,YTD"),
             ctx: AppContext = Depends(get_ctx)):
    """Factsheet-style trailing returns to `end` (CAGR for periods over a year)."""
    labels = [p.strip() for p in periods.split(",")] if periods else ctx.settings.analytics.trailing_periods
    try:
        offsets = [an.period_offset(p) for p in labels]
    except ValueError as e:
        raise bad_request(str(e)) from None
    source = ctx.source(source)
    tickers_ = ctx.tickers(tickers)
    end_ts = pd.Timestamp(end) if end else pd.Timestamp.today().normalize()
    earliest = min((end_ts - o for o in offsets if o is not None), default=end_ts)
    start_ts = min(earliest, pd.Timestamp(end_ts.year - 1, 12, 31)) - pd.DateOffset(days=10)
    out = {}
    for t in tickers_:
        close = ctx.frame(t, source, start_ts, end_ts)["Close"]
        out[t] = {k: (None if pd.isna(v) else v / 100) for k, v in an.trailing_returns(close, labels).items()}
    return {"periods": labels, "end": end_ts, "series": out}


# --------------------------------------------------------------------------- #
# Single-series charts
# --------------------------------------------------------------------------- #
@router.get("/drawdowns")
def drawdowns(ticker: str, start: date | None = None, end: date | None = None,
              period: str | None = Period, source: str | None = None,
              top: int | None = Query(None, ge=1, le=50), ctx: AppContext = Depends(get_ctx)):
    *_, close = _single(ctx, ticker, period, start, end, source)
    top = top or ctx.settings.analytics.drawdown_table_size
    table = an.drawdown_table(close, top)
    episodes = convert_rows(table, renames={
        "Peak→Trough (days)": "peak_to_trough_days", "Trough→Recovery (days)": "trough_to_recovery_days",
        "Total length (days)": "total_days"})
    for e in episodes:
        e["ongoing"] = e["recovered"] == "Not yet"
        if e["ongoing"]:
            e["recovered"] = None
    return {"ticker": ticker, **_range(close), "underwater": series_payload(an.drawdown(close)),
            "current": float(an.drawdown(close).iloc[-1]), "episodes": episodes}


@router.get("/monthly-grid")
def monthly_grid(ticker: str, start: date | None = None, end: date | None = None,
                 period: str | None = Period, source: str | None = None, ctx: AppContext = Depends(get_ctx)):
    *_, close = _single(ctx, ticker, period, start, end, source)
    grid = an.monthly_returns_table(close) / 100
    return {"ticker": ticker, **_range(close), "months": an.MONTHS, "years": grid.index.tolist(),
            "values": grid[an.MONTHS].to_numpy().tolist(), "year_total": grid["Year"].tolist()}


@router.get("/yearly")
def yearly(ticker: str, start: date | None = None, end: date | None = None,
           period: str | None = Period, source: str | None = None, ctx: AppContext = Depends(get_ctx)):
    """Calendar-year returns. Each row gives the first/last date with data, so
    partial first/last years can be labelled."""
    *_, close = _single(ctx, ticker, period, start, end, source)
    grid = an.monthly_returns_table(close)
    dates = close.index.to_series()
    first, last = dates.groupby(dates.dt.year).min(), dates.groupby(dates.dt.year).max()
    return {"ticker": ticker, "years": [
        {"year": int(y), "return": grid.loc[y, "Year"] / 100, "start": first[y], "end": last[y]}
        for y in grid.index]}


@router.get("/distribution")
def distribution(ticker: str, start: date | None = None, end: date | None = None,
                 period: str | None = Period, source: str | None = None,
                 bins: int | None = Query(None, ge=10, le=200), ctx: AppContext = Depends(get_ctx)):
    """Daily-return histogram with the matching normal curve (as expected counts)."""
    *_, close = _single(ctx, ticker, period, start, end, source)
    r = an.daily_returns(close)
    if len(r) < 2:
        raise bad_request("Need at least two daily returns.")
    counts, edges = np.histogram(r, bins=bins or ctx.settings.analytics.histogram_bins)
    mids, width = (edges[:-1] + edges[1:]) / 2, edges[1] - edges[0]
    mu, sd = float(r.mean()), float(r.std())
    normal = len(r) * width * sps.norm.pdf(mids, mu, sd) if sd > 0 else np.zeros_like(mids)
    return {"ticker": ticker, **_range(close), "edges": edges.tolist(), "counts": counts.tolist(),
            "normal": normal.tolist(), "n": len(r), "mean": mu, "std": sd,
            "skew": float(r.skew()), "excess_kurtosis": float(r.kurt())}


@router.get("/rolling-vol")
def rolling_vol(ticker: str, start: date | None = None, end: date | None = None,
                period: str | None = Period, source: str | None = None,
                window: int | None = Query(None, ge=5, le=1000), ctx: AppContext = Depends(get_ctx)):
    s = ctx.settings.analytics
    window = window or s.rolling_vol_window
    source, (t,), start_ts, end_ts = _inputs(ctx, ticker, period, start, end, source)
    close = ctx.frame(t, source, start_ts, end_ts, warmup=pd.DateOffset(days=int(window * 1.6) + 10))["Close"]
    vol = an.rolling_volatility(close, window, s.trading_days)
    vol = vol.loc[start_ts:] if start_ts is not None else vol
    return {"ticker": t, "window": window, "series": series_payload(vol)}


# --------------------------------------------------------------------------- #
# Seasonality
# --------------------------------------------------------------------------- #
@router.get("/seasonality")
def seasonality(ticker: str, start: date | None = None, end: date | None = None,
                period: str | None = Period, source: str | None = None,
                min_years: int = Query(0, ge=0, le=50, description="Flag months with fewer years of data."),
                ctx: AppContext = Depends(get_ctx)):
    *_, close = _single(ctx, ticker, period, start, end, source)
    rows = convert_rows(an.seasonality(close), index_key="month")
    for r in rows:
        r["enough_data"] = r["years"] >= min_years
    return {"ticker": ticker, **_range(close), "months": rows,
            "caution": "Monthly patterns are noisy; a few extreme years can dominate the averages."}


@router.get("/weekday")
def weekday(ticker: str, start: date | None = None, end: date | None = None,
            period: str | None = Period, source: str | None = None, ctx: AppContext = Depends(get_ctx)):
    *_, close = _single(ctx, ticker, period, start, end, source)
    return {"ticker": ticker, **_range(close), "days": convert_rows(an.weekday_stats(close), index_key="day")}


# --------------------------------------------------------------------------- #
# Data health
# --------------------------------------------------------------------------- #
def _quality(df: pd.DataFrame, ticker: str, big_move: float, gap_days: int) -> dict:
    q = an.data_quality(df, volume_available(ticker, df), big_move=big_move, gap_days=gap_days)
    gaps = q.pop(f"Gaps > {gap_days} calendar days")
    moves = q.pop(next(k for k in q if k.startswith("Days with |move|")))
    zero_vol = q.pop("Zero-volume days")
    rec = convert_record(q, renames={"Coverage of weekdays %": "coverage"})
    rec.update(gaps=gaps, big_moves=moves, zero_volume_days=zero_vol if isinstance(zero_vol, int) else None)
    issues, status = [], "good"
    for field, label in (("duplicate_dates", "duplicate dates"), ("missing_values", "missing values"),
                         ("ohlc_inconsistencies", "OHLC inconsistencies")):
        if rec[field]:
            issues.append(f"{rec[field]} {label}")
            status = "critical"
    for field, label in (("gaps", f"gaps over {gap_days} days"), ("big_moves", "big moves to review")):
        if rec[field]:
            issues.append(f"{rec[field]} {label}")
            status = "warning" if status == "good" else status
    return {**rec, "status": status, "issues": issues}


@router.get("/quality")
def quality(tickers: str = Tickers, start: date | None = None, end: date | None = None,
            period: str | None = Period, source: str | None = None, ctx: AppContext = Depends(get_ctx)):
    s = ctx.settings.analytics
    source, tickers_, start_ts, end_ts = _inputs(ctx, tickers, period, start, end, source)
    return {"thresholds": {"big_move": s.big_move_threshold, "gap_days": s.quality_gap_days},
            "series": {t: _quality(ctx.frame(t, source, start_ts, end_ts), t,
                                   s.big_move_threshold, s.quality_gap_days) for t in tickers_}}


@router.get("/big-moves")
def big_moves(ticker: str, start: date | None = None, end: date | None = None,
              period: str | None = Period, source: str | None = None,
              threshold: float | None = Query(None, gt=0, le=0.5, description="Decimal daily move."),
              ctx: AppContext = Depends(get_ctx)):
    *_, close = _single(ctx, ticker, period, start, end, source)
    threshold = threshold or ctx.settings.analytics.big_move_threshold
    moves = an.big_moves(close, threshold).sort_index()
    return {"ticker": ticker, "threshold": threshold,
            "moves": [{"date": d, "close": c, "move": m / 100}
                      for d, c, m in zip(iso_dates(moves.index), moves["Close"], moves["Move %"])]}
