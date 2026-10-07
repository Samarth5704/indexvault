"""Analytics on price series (pd.Series of closes indexed by date).

All return figures are decimals (0.12 = 12%). Annualisation assumes
252 trading days. Note: Yahoo index levels are *price* indices, so returns
exclude dividends (TRI would be ~1–1.5% p.a. higher for NIFTY 50).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

TD = 252  # trading days per year
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# --------------------------------------------------------------------------- #
# Basics
# --------------------------------------------------------------------------- #
def daily_returns(close: pd.Series) -> pd.Series:
    return close.pct_change().dropna()


def years_between(a: pd.Timestamp, b: pd.Timestamp) -> float:
    return (b - a).days / 365.25


def cagr(close: pd.Series) -> float:
    close = close.dropna()
    if len(close) < 2:
        return np.nan
    yrs = years_between(close.index[0], close.index[-1])
    if yrs <= 0:
        return np.nan
    return (close.iloc[-1] / close.iloc[0]) ** (1 / yrs) - 1


def ann_vol(close: pd.Series) -> float:
    return daily_returns(close).std() * np.sqrt(TD)


def drawdown(close: pd.Series) -> pd.Series:
    """Percent below running peak at each date (0 or negative)."""
    return close / close.cummax() - 1


def drawdown_table(close: pd.Series, top: int = 5) -> pd.DataFrame:
    """Largest distinct drawdown episodes: peak, trough, recovery, depth, lengths."""
    close = close.dropna()
    dd = drawdown(close)
    episodes = []
    in_dd, peak_date = False, close.index[0]
    for dt, v in dd.items():
        if v == 0:
            if in_dd:
                seg = dd.loc[peak_date:dt]
                episodes.append((peak_date, seg.idxmin(), dt, seg.min()))
                in_dd = False
            peak_date = dt
        else:
            in_dd = True
    if in_dd:
        seg = dd.loc[peak_date:]
        episodes.append((peak_date, seg.idxmin(), pd.NaT, seg.min()))
    rows = []
    for p, t, r, depth in sorted(episodes, key=lambda e: e[3])[:top]:
        rows.append({
            "Peak": str(p.date()),
            "Trough": str(t.date()),
            "Recovered": str(r.date()) if pd.notna(r) else "Not yet",
            "Depth %": depth * 100,
            "Peak→Trough (days)": (t - p).days,
            "Trough→Recovery (days)": (r - t).days if pd.notna(r) else np.nan,
            "Total length (days)": ((r if pd.notna(r) else close.index[-1]) - p).days,
        })
    return pd.DataFrame(rows)


def summary_metrics(close: pd.Series, rf: float = 0.065) -> dict:
    """Headline risk/return statistics. rf = annual risk-free rate."""
    close = close.dropna()
    r = daily_returns(close)
    if len(r) < 5:
        return {}
    rf_d = (1 + rf) ** (1 / TD) - 1
    ex = r - rf_d
    vol = r.std() * np.sqrt(TD)
    downside = np.sqrt((np.minimum(ex, 0) ** 2).mean()) * np.sqrt(TD)
    g = cagr(close)
    dd = drawdown(close)
    mdd = dd.min()
    monthly = close.resample("ME").last().pct_change().dropna()
    yearly = close.resample("YE").last().pct_change().dropna()
    var95 = np.percentile(r, 5)
    return {
        "Start": close.index[0].date(),
        "End": close.index[-1].date(),
        "Years": round(years_between(close.index[0], close.index[-1]), 2),
        "Start level": close.iloc[0],
        "End level": close.iloc[-1],
        "Total return %": (close.iloc[-1] / close.iloc[0] - 1) * 100,
        "CAGR %": g * 100,
        "Annual volatility %": vol * 100,
        "Sharpe": ex.mean() * TD / vol if vol else np.nan,
        "Sortino": ex.mean() * TD / downside if downside else np.nan,
        "Max drawdown %": mdd * 100,
        "Max DD date": dd.idxmin().date(),
        "Calmar": g / abs(mdd) if mdd else np.nan,
        "Current drawdown %": dd.iloc[-1] * 100,
        "Best day %": r.max() * 100,
        "Worst day %": r.min() * 100,
        "Best month %": monthly.max() * 100 if len(monthly) else np.nan,
        "Worst month %": monthly.min() * 100 if len(monthly) else np.nan,
        "Best year %": yearly.max() * 100 if len(yearly) else np.nan,
        "Worst year %": yearly.min() * 100 if len(yearly) else np.nan,
        "Positive months %": (monthly > 0).mean() * 100 if len(monthly) else np.nan,
        "Daily VaR 95 %": var95 * 100,
        "Daily CVaR 95 %": r[r <= var95].mean() * 100,
        "Skew": r.skew(),
        "Excess kurtosis": r.kurt(),
        "52w high": close.iloc[-TD:].max(),
        "% from 52w high": (close.iloc[-1] / close.iloc[-TD:].max() - 1) * 100,
    }


def metrics_table(closes: dict[str, pd.Series], rf: float = 0.065) -> pd.DataFrame:
    return pd.DataFrame({k: summary_metrics(v, rf) for k, v in closes.items()})


def trailing_returns(close: pd.Series) -> dict:
    """Point-to-point returns like a fund factsheet (CAGR for periods > 1y)."""
    close = close.dropna()
    end = close.index[-1]
    out = {}
    periods = [("1M", pd.DateOffset(months=1)), ("3M", pd.DateOffset(months=3)),
               ("6M", pd.DateOffset(months=6)), ("YTD", None),
               ("1Y", pd.DateOffset(years=1)), ("3Y", pd.DateOffset(years=3)),
               ("5Y", pd.DateOffset(years=5)), ("10Y", pd.DateOffset(years=10)),
               ("15Y", pd.DateOffset(years=15)), ("20Y", pd.DateOffset(years=20))]
    for label, off in periods:
        start = pd.Timestamp(end.year - 1, 12, 31) if label == "YTD" else end - off
        if start < close.index[0]:
            out[label] = np.nan
            continue
        p0 = close.asof(start)
        tot = close.iloc[-1] / p0 - 1
        yrs = years_between(start, end)
        out[label] = ((1 + tot) ** (1 / yrs) - 1 if yrs > 1.01 else tot) * 100
    return out


# --------------------------------------------------------------------------- #
# Calendar & seasonality
# --------------------------------------------------------------------------- #
def monthly_returns_table(close: pd.Series) -> pd.DataFrame:
    """Year × Month grid of monthly returns (%) plus a full-year column."""
    m = close.resample("ME").last()
    mr = m.pct_change()
    # first month: measure from first available close
    if len(m):
        mr.iloc[0] = m.iloc[0] / close.iloc[0] - 1
    t = pd.DataFrame({"Year": mr.index.year, "Month": mr.index.month, "r": mr.values})
    grid = t.pivot(index="Year", columns="Month", values="r").reindex(columns=range(1, 13))
    grid.columns = MONTHS
    y = close.resample("YE").last()
    yr = y.pct_change()
    if len(y):
        yr.iloc[0] = y.iloc[0] / close.iloc[0] - 1
    grid["Year"] = yr.values
    return grid * 100


def seasonality(close: pd.Series) -> pd.DataFrame:
    """Average / median return and hit-rate by calendar month."""
    mr = close.resample("ME").last().pct_change().dropna()
    g = mr.groupby(mr.index.month)
    out = pd.DataFrame({
        "Avg %": g.mean() * 100,
        "Median %": g.median() * 100,
        "Positive %": g.apply(lambda x: (x > 0).mean() * 100),
        "Best %": g.max() * 100,
        "Worst %": g.min() * 100,
        "Years": g.count(),
    })
    out.index = [MONTHS[i - 1] for i in out.index]
    return out


def weekday_stats(close: pd.Series) -> pd.DataFrame:
    r = daily_returns(close)
    g = r.groupby(r.index.dayofweek)
    out = pd.DataFrame({
        "Avg %": g.mean() * 100,
        "Positive %": g.apply(lambda x: (x > 0).mean() * 100),
        "Volatility %": g.std() * 100,
        "Days": g.count(),
    })
    out.index = [["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i] for i in out.index]
    return out


# --------------------------------------------------------------------------- #
# Rolling analysis
# --------------------------------------------------------------------------- #
def rolling_cagr(close: pd.Series, years: float) -> pd.Series:
    """For each date, annualised return over the preceding `years` years."""
    close = close.dropna()
    months = int(round(years * 12))
    past_dates = close.index - pd.DateOffset(months=months)
    past = close.reindex(past_dates, method="ffill")
    past.index = close.index
    past[past_dates < close.index[0]] = np.nan
    return ((close / past) ** (1 / years) - 1).dropna()


def rolling_summary(close: pd.Series, windows=(1, 3, 5, 7, 10)) -> pd.DataFrame:
    rows = {}
    for w in windows:
        rc = rolling_cagr(close, w)
        if rc.empty:
            continue
        rows[f"{w}Y"] = {
            "Observations": len(rc),
            "Min %": rc.min() * 100,
            "Median %": rc.median() * 100,
            "Mean %": rc.mean() * 100,
            "Max %": rc.max() * 100,
            "% of periods negative": (rc < 0).mean() * 100,
            "% of periods > 10%": (rc > 0.10).mean() * 100,
            "% of periods > 15%": (rc > 0.15).mean() * 100,
        }
    return pd.DataFrame(rows).T


def rolling_volatility(close: pd.Series, window: int = 63) -> pd.Series:
    return daily_returns(close).rolling(window).std() * np.sqrt(TD)


def moving_averages(close: pd.Series, windows=(50, 200)) -> pd.DataFrame:
    return pd.DataFrame({f"SMA {w}": close.rolling(w).mean() for w in windows})


# --------------------------------------------------------------------------- #
# Multi-series
# --------------------------------------------------------------------------- #
def rebase(wide: pd.DataFrame, base: float = 100) -> pd.DataFrame:
    wide = wide.ffill().dropna(how="any")
    return wide / wide.iloc[0] * base


def correlation(wide: pd.DataFrame, freq: str = "W-FRI") -> pd.DataFrame:
    """Correlation of returns. Weekly by default, which avoids false low
    correlation between markets with different holidays / time zones."""
    px = wide.ffill()
    if freq:
        px = px.resample(freq).last()
    return px.pct_change(fill_method=None).dropna(how="any").corr()


def rolling_correlation(a: pd.Series, b: pd.Series, window_weeks: int = 52) -> pd.Series:
    w = pd.concat([a, b], axis=1).ffill().resample("W-FRI").last().pct_change(fill_method=None).dropna()
    return w.iloc[:, 0].rolling(window_weeks).corr(w.iloc[:, 1]).dropna()


def beta(asset: pd.Series, bench: pd.Series) -> float:
    w = pd.concat([asset, bench], axis=1).ffill().resample("W-FRI").last().pct_change(fill_method=None).dropna()
    if len(w) < 10:
        return np.nan
    c = np.cov(w.iloc[:, 0], w.iloc[:, 1])
    return c[0, 1] / c[1, 1]


def relative_strength(a: pd.Series, b: pd.Series) -> pd.Series:
    """Ratio a/b rebased to 100. Rising line = a outperforming b."""
    w = pd.concat([a, b], axis=1).ffill().dropna()
    rs = w.iloc[:, 0] / w.iloc[:, 1]
    return rs / rs.iloc[0] * 100


# --------------------------------------------------------------------------- #
# SIP simulator
# --------------------------------------------------------------------------- #
def xirr(cashflows: list[tuple[pd.Timestamp, float]]) -> float:
    """Annualised IRR for irregular cash flows (negative = investment)."""
    from scipy.optimize import brentq

    if not cashflows:
        return np.nan
    t0 = cashflows[0][0]
    ts = np.array([(d - t0).days / 365.25 for d, _ in cashflows])
    cf = np.array([c for _, c in cashflows])

    def npv(r):
        return np.sum(cf / (1 + r) ** ts)

    try:
        return brentq(npv, -0.9999, 100)
    except ValueError:
        return np.nan


def sip_backtest(
    close: pd.Series,
    amount: float = 10_000,
    day_of_month: int = 1,
    step_up_pct: float = 0.0,
    start: pd.Timestamp | None = None,
    end: pd.Timestamp | None = None,
) -> tuple[pd.DataFrame, dict]:
    """Monthly SIP into the index. Buys on the first trading day on/after
    `day_of_month` each month. Optional annual step-up (e.g. 10 = +10%/yr).
    Returns a daily ledger and summary stats (incl. XIRR and a lump-sum comparison)."""
    close = close.dropna()
    if start is not None:
        close = close.loc[pd.Timestamp(start):]
    if end is not None:
        close = close.loc[:pd.Timestamp(end)]
    if len(close) < 30:
        return pd.DataFrame(), {}

    months = pd.period_range(close.index[0], close.index[-1], freq="M")
    buys = []
    for i, p in enumerate(months):
        target = pd.Timestamp(p.year, p.month, min(day_of_month, p.days_in_month))
        pos = close.index.searchsorted(target)
        if pos >= len(close) or close.index[pos].to_period("M") != p:
            continue
        amt = amount * (1 + step_up_pct / 100) ** (i // 12)
        buys.append((close.index[pos], amt))

    inv = pd.Series(0.0, index=close.index)
    units = pd.Series(0.0, index=close.index)
    for d, a in buys:
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
    cfs = [(d, -a) for d, a in buys] + [(close.index[-1], final)]
    lump_final = total_inv * close.iloc[-1] / close.loc[buys[0][0]]
    ledger["Lump sum value"] = total_inv * close / close.loc[buys[0][0]]
    ledger.loc[: buys[0][0] - pd.Timedelta(days=1), "Lump sum value"] = np.nan

    stats = {
        "Instalments": len(buys),
        "Total invested": total_inv,
        "Final value": final,
        "Absolute gain": final - total_inv,
        "Absolute return %": (final / total_inv - 1) * 100,
        "SIP XIRR %": xirr(cfs) * 100,
        "Lump-sum final value": lump_final,
        "Lump-sum CAGR %": cagr(close.loc[buys[0][0]:]) * 100,
        "Worst SIP drawdown %": ((ledger["Value"] / ledger["Invested"]) - 1).min() * 100,
        "Avg buy price": total_inv / ledger["Units"].iloc[-1],
        "Last price": close.iloc[-1],
    }
    return ledger, stats


# --------------------------------------------------------------------------- #
# Data quality
# --------------------------------------------------------------------------- #
def data_quality(df: pd.DataFrame, has_volume: bool = True) -> dict:
    """Health checks worth running before trusting a dataset in research."""
    if df.empty:
        return {"Rows": 0}
    close = df["Close"]
    r = close.pct_change()
    gaps = close.index.to_series().diff().dt.days
    stale = (close.diff() == 0).astype(int)
    longest_stale = stale.groupby((stale == 0).cumsum()).sum().max()
    ohlc_bad = ((df["High"] < df[["Open", "Close"]].max(axis=1) - 1e-6) |
                (df["Low"] > df[["Open", "Close"]].min(axis=1) + 1e-6)).sum()
    bdays = len(pd.bdate_range(close.index[0], close.index[-1]))
    return {
        "Rows": len(df),
        "First date": close.index[0].date(),
        "Last date": close.index[-1].date(),
        "Coverage of weekdays %": len(df) / bdays * 100,
        "Gaps > 5 calendar days": int((gaps > 5).sum()),
        "Largest gap (days)": int(gaps.max()) if len(gaps) > 1 else 0,
        "Largest gap ends": gaps.idxmax().date() if len(gaps) > 1 else None,
        "Missing values": int(df[["Open", "High", "Low", "Close"]].isna().sum().sum()),
        "Duplicate dates": int(df.index.duplicated().sum()),
        "Longest unchanged-close run": int(longest_stale),
        "Days with |move| > 8%": int((r.abs() > 0.08).sum()),
        "OHLC inconsistencies": int(ohlc_bad),
        "Zero-volume days": int((df["Volume"] == 0).sum()) if has_volume else "n/a (index)",
    }


def big_moves(close: pd.Series, threshold: float = 0.05) -> pd.DataFrame:
    r = daily_returns(close)
    m = r[r.abs() > threshold]
    return pd.DataFrame({"Close": close.reindex(m.index), "Move %": m * 100}).sort_values("Move %")
