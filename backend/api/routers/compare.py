"""Multi-series analytics: compare, relative strength, rolling correlation,
rolling returns. Percentages are decimals; defaults come from settings."""
from __future__ import annotations

from datetime import date
from typing import Literal

import pandas as pd
from fastapi import APIRouter, Depends, Query

from indexvault import analytics as an
from indexvault.indices import display_name

from ..context import AppContext, get_ctx
from ..errors import bad_request
from ..jsonutil import JsonableRoute, convert_record, iso_dates, series_payload
from ..metrics import from_core
from .analytics import Period, Tickers, _inputs
from .series import names

router = APIRouter(prefix="/analytics", route_class=JsonableRoute)

CorrFreq = Literal["D", "W", "M"]
REBASE_NOTE = ("All series are rebased to 100 on the first date every series has data, "
               "so growth is compared over exactly the same period.")


def _metrics(ctx: AppContext, source: str, ticker: str, close: pd.Series, start_ts, end_ts) -> dict:
    """Same memo key as /analytics/summary, so the two share results."""
    s = ctx.settings.analytics
    key = (str(start_ts), str(end_ts), s.risk_free_rate, s.trading_days)
    return ctx.computed("summary", [ticker], source, key,
                        lambda: from_core(an.summary_metrics(close, s.risk_free_rate, s.trading_days)))


@router.get("/compare")
def compare(tickers: str = Tickers, benchmark: str | None = Query(None, description="Defaults to the first ticker."),
            start: date | None = None, end: date | None = None, period: str | None = Period,
            source: str | None = None, freq: CorrFreq | None = Query(None, description="Return frequency for correlation and beta."),
            ctx: AppContext = Depends(get_ctx)):
    s = ctx.settings.analytics
    freq = freq or s.correlation_frequency
    source, tickers_, start_ts, end_ts = _inputs(ctx, tickers, period, start, end, source)
    benchmark = benchmark or tickers_[0]
    closes = ctx.closes(list(dict.fromkeys([*tickers_, benchmark])), source, start_ts, end_ts)
    wide = pd.DataFrame({t: closes[t] for t in tickers_})
    rebased = an.rebase(wide)
    if rebased.empty:
        raise bad_request("These series have no dates in common.")
    corr = an.correlation(wide, freq)
    metrics = {t: _metrics(ctx, source, t, c, start_ts, end_ts) for t, c in closes.items() if t in tickers_}
    return {
        "tickers": tickers_, "names": {t: display_name(t, names(ctx)) for t in tickers_},
        "benchmark": benchmark, "frequency": freq,
        "rebased": {"start": rebased.index[0], "note": REBASE_NOTE, "dates": iso_dates(rebased.index),
                    "series": {t: rebased[t].tolist() for t in tickers_}},
        "metric_ids": s.compare_metrics,
        "metrics": {t: {m: v.get(m) for m in s.compare_metrics} for t, v in metrics.items()},
        "beta": {t: an.beta(closes[t], closes[benchmark], freq) for t in tickers_},
        "correlation": {"tickers": list(corr.columns), "matrix": corr.to_numpy().tolist()},
        "scatter": [{"ticker": t, "cagr": metrics[t].get("cagr"), "ann_vol": metrics[t].get("ann_vol")}
                    for t in tickers_],
    }


@router.get("/relative-strength")
def relative_strength(a: str, b: str, start: date | None = None, end: date | None = None,
                      period: str | None = Period, source: str | None = None,
                      sma: int | None = Query(None, ge=2, le=1000, description="Defaults to the first SMA window in settings."),
                      ctx: AppContext = Depends(get_ctx)):
    """Ratio a/b rebased to 100: rising means a is outperforming b."""
    source, (ta, tb), start_ts, end_ts = _inputs(ctx, f"{a},{b}", period, start, end, source)
    closes = ctx.closes([ta, tb], source, start_ts, end_ts)
    rs = an.relative_strength(closes[ta], closes[tb])
    windows = ctx.settings.analytics.sma_windows
    window = sma or (windows[0] if windows else None)
    return {"a": ta, "b": tb, "ratio": series_payload(rs), "sma_window": window,
            "sma": series_payload(rs.rolling(window).mean()) if window else None}


@router.get("/rolling-correlation")
def rolling_correlation(a: str, b: str, start: date | None = None, end: date | None = None,
                        period: str | None = Period, source: str | None = None,
                        window: int | None = Query(None, ge=5, le=520, description="In periods of `freq`."),
                        freq: CorrFreq | None = None, ctx: AppContext = Depends(get_ctx)):
    s = ctx.settings.analytics
    window, freq = window or s.rolling_corr_window, freq or s.correlation_frequency
    source, (ta, tb), start_ts, end_ts = _inputs(ctx, f"{a},{b}", period, start, end, source)
    closes = ctx.closes([ta, tb], source, start_ts, end_ts)
    rc = an.rolling_correlation(closes[ta], closes[tb], window, freq)
    return {"a": ta, "b": tb, "window": window, "frequency": freq, "series": series_payload(rc)}


# --------------------------------------------------------------------------- #
# Rolling returns
# --------------------------------------------------------------------------- #
_YEAR_WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven",
               8: "eight", 9: "nine", 10: "ten"}


def group_int(n: int, system: str) -> str:
    """12,34,567 (Indian) or 1,234,567 (international)."""
    s = str(abs(int(n)))
    if system == "indian" and len(s) > 3:
        head, tail = s[:-3], s[-3:]
        head = ",".join([head[max(0, i - 2):i] for i in range(len(head), 0, -2)][::-1])
        s = f"{head},{tail}"
    elif system != "indian":
        s = f"{abs(int(n)):,}"
    return ("-" if n < 0 else "") + s


def insight(name: str, years: int, obs: int, pct_negative: float, pct_target: float,
            target: float, system: str) -> str:
    span = f"{_YEAR_WORDS.get(years, years)}-year"
    lost = "never lost money" if pct_negative == 0 else f"lost money {pct_negative * 100:.1f}% of the time"
    return (f"Over {group_int(obs, system)} {span} periods, {name} {lost} and beat "
            f"{target * 100:g}% a year {pct_target * 100:.1f}% of the time.")


@router.get("/rolling")
def rolling(tickers: str = Tickers, start: date | None = None, end: date | None = None,
            period: str | None = Query("Max", description="Rolling returns need long history; defaults to Max."),
            source: str | None = None,
            years: str | None = Query(None, description="Comma list of holding periods in years."),
            target: float | None = Query(None, ge=-0.5, le=1, description="Target CAGR (decimal)."),
            ctx: AppContext = Depends(get_ctx)):
    s = ctx.settings
    try:
        windows = [int(y) for y in years.split(",")] if years else s.analytics.rolling_windows_years
    except ValueError:
        raise bad_request("years must be whole numbers, e.g. 1,3,5") from None
    if not windows or any(not 1 <= w <= 30 for w in windows):
        raise bad_request("years must be between 1 and 30.")
    target = s.analytics.target_cagr if target is None else target
    source, tickers_, start_ts, end_ts = _inputs(ctx, tickers, period, start, end, source)
    closes = ctx.closes(tickers_, source, start_ts, end_ts)
    label = f"% of periods > {target * 100:g}%"
    out = {}
    for t, close in closes.items():
        name = display_name(t, names(ctx))
        summ = an.rolling_summary(close, windows, thresholds=(target,))
        per_window = {}
        for w in windows:
            rc = an.rolling_cagr(close, w)
            if rc.empty:
                per_window[str(w)] = None
                continue
            st = convert_record(summ.loc[f"{w}Y"].to_dict(), renames={
                "% of periods negative": "pct_negative", label: "pct_above_target"})
            st["observations"] = int(st["observations"])
            st.update(q1=float(rc.quantile(0.25)), q3=float(rc.quantile(0.75)), latest=float(rc.iloc[-1]),
                      insight=insight(name, w, st["observations"], st["pct_negative"],
                                      st["pct_above_target"], target, s.formats.number_system),
                      series=series_payload(rc))
            per_window[str(w)] = st
        out[t] = {"name": name, "windows": per_window}
    return {"years": windows, "target": target, "series": out}
