"""SIP (systematic investment plan) simulator, XIRR and start-date sensitivity.

`sip_backtest` keeps the prototype's units: `step_up_pct` is in percent
(10 = +10%/yr) and stat keys ending in `%` are ×100. The newer
`sip_start_sensitivity` returns decimals (its keys have no `%`).
"""
from __future__ import annotations

from collections.abc import Iterable
from datetime import date

import numpy as np
import pandas as pd


def xirr(cashflows: list[tuple[pd.Timestamp, float]]) -> float:
    """Annualised IRR (decimal) for irregular cash flows (negative = investment)."""
    from scipy.optimize import brentq

    if not cashflows:
        return np.nan
    t0 = min(d for d, _ in cashflows)
    ts = np.array([(d - t0).days / 365.25 for d, _ in cashflows])
    cf = np.array([c for _, c in cashflows])

    def npv(r):
        return np.sum(cf / (1 + r) ** ts)

    try:
        return brentq(npv, -0.9999, 100)
    except ValueError:
        return np.nan


def _monthly_buy_dates(close: pd.Series, day_of_month: int) -> list[tuple[pd.Timestamp, int]]:
    """First trading day on/after `day_of_month` in each month, with the month's
    index since the first month (used for annual step-ups). Months with no such
    trading day are skipped."""
    months = pd.period_range(close.index[0], close.index[-1], freq="M")
    out = []
    for i, p in enumerate(months):
        target = pd.Timestamp(p.year, p.month, min(day_of_month, p.days_in_month))
        pos = close.index.searchsorted(target)
        if pos < len(close) and close.index[pos].to_period("M") == p:
            out.append((close.index[pos], i))
    return out


def _top_up_buys(close: pd.Series, top_ups: Iterable[tuple[str | date, float]]) -> list[tuple[pd.Timestamp, float]]:
    """Map each (date, amount) top-up to the first trading day on/after it."""
    out = []
    for d, amt in top_ups:
        pos = close.index.searchsorted(pd.Timestamp(d))
        if pos < len(close) and amt > 0:
            out.append((close.index[pos], float(amt)))
    return out


def sip_backtest(
    close: pd.Series,
    amount: float = 10_000,
    day_of_month: int = 1,
    step_up_pct: float = 0.0,
    start: pd.Timestamp | None = None,
    end: pd.Timestamp | None = None,
    top_ups: Iterable[tuple[str | date, float]] | None = None,
) -> tuple[pd.DataFrame, dict]:
    """Monthly SIP into the index. Buys on the first trading day on/after
    `day_of_month` each month. Optional annual step-up (e.g. 10 = +10%/yr) and
    one-off lump-sum `top_ups` as (date, amount) pairs, bought on the first
    trading day on/after each date. Returns a daily ledger and summary stats
    (incl. XIRR and a lump-sum comparison)."""
    from .analytics import cagr  # lazy: analytics re-exports this module

    close = close.dropna()
    if start is not None:
        close = close.loc[pd.Timestamp(start):]
    if end is not None:
        close = close.loc[:pd.Timestamp(end)]
    if len(close) < 30:
        return pd.DataFrame(), {}

    buys = [(d, amount * (1 + step_up_pct / 100) ** (i // 12))
            for d, i in _monthly_buy_dates(close, day_of_month)]
    extra = _top_up_buys(close, top_ups or [])
    all_buys = sorted(buys + extra, key=lambda b: b[0])
    if not all_buys:
        return pd.DataFrame(), {}
    first = all_buys[0][0]

    inv = pd.Series(0.0, index=close.index)
    units = pd.Series(0.0, index=close.index)
    for d, a in all_buys:
        inv[d] += a
        units[d] += a / close[d]
    ledger = pd.DataFrame({
        "Price": close,
        "Invested": inv.cumsum(),
        "Units": units.cumsum(),
    })
    ledger["Value"] = ledger["Units"] * ledger["Price"]
    ledger["Gain"] = ledger["Value"] - ledger["Invested"]

    total_inv = ledger["Invested"].iloc[-1]
    final = ledger["Value"].iloc[-1]
    cfs = [(d, -a) for d, a in all_buys] + [(close.index[-1], final)]
    lump_final = total_inv * close.iloc[-1] / close.loc[first]
    ledger["Lump sum value"] = total_inv * close / close.loc[first]
    ledger.loc[: first - pd.Timedelta(days=1), "Lump sum value"] = np.nan

    stats = {
        "Instalments": len(buys),
        "Top-ups": len(extra),
        "Total invested": total_inv,
        "Final value": final,
        "Absolute gain": final - total_inv,
        "Absolute return %": (final / total_inv - 1) * 100,
        "SIP XIRR %": xirr(cfs) * 100,
        "Lump-sum final value": lump_final,
        "Lump-sum CAGR %": cagr(close.loc[first:]) * 100,
        "Worst SIP drawdown %": ((ledger["Value"] / ledger["Invested"]) - 1).min() * 100,
        "Avg buy price": total_inv / ledger["Units"].iloc[-1],
        "Last price": close.iloc[-1],
    }
    return ledger, stats


def sip_start_sensitivity(
    close: pd.Series,
    amount: float = 10_000,
    day_of_month: int = 1,
    step_up_pct: float = 0.0,
    end: pd.Timestamp | None = None,
    min_months: int = 12,
) -> pd.DataFrame:
    """XIRR of the same SIP started in every possible month, all ending at `end`.

    One row per start month (index = first buy date) with columns
    Months, Invested, Final value and XIRR (decimal). Starts leaving fewer
    than `min_months` instalments are omitted. Step-ups count from each start.
    """
    close = close.dropna()
    if end is not None:
        close = close.loc[:pd.Timestamp(end)]
    cols = ["Months", "Invested", "Final value", "XIRR"]
    if len(close) < 30:
        return pd.DataFrame(columns=cols)
    dates = [d for d, _ in _monthly_buy_dates(close, day_of_month)]
    prices = close.loc[dates].to_numpy()
    last_date, last_price = close.index[-1], close.iloc[-1]
    rows = {}
    for i in range(len(dates) - min_months + 1):
        k = np.arange(len(dates) - i)
        amts = amount * (1 + step_up_pct / 100) ** (k // 12)
        value = (amts / prices[i:]).sum() * last_price
        cfs = [(d, -a) for d, a in zip(dates[i:], amts)] + [(last_date, value)]
        rows[dates[i]] = {"Months": len(k), "Invested": amts.sum(),
                          "Final value": value, "XIRR": xirr(cfs)}
    out = pd.DataFrame.from_dict(rows, orient="index", columns=cols)
    out.index.name = "Start"
    return out
