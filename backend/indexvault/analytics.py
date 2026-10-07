"""Analytics on price series (pd.Series of closes indexed by date).

Unit convention: values under keys ending in `%` are percentages ×100
(12.0 = 12%); everything else is a decimal (0.12 = 12%). Every tunable is a
parameter whose default matches the original prototype, so existing callers
(e.g. the backtester) see identical results. Note: Yahoo index levels are
*price* indices, so returns exclude dividends (TRI would be ~1–1.5% p.a.
higher for NIFTY 50).
"""
from __future__ import annotations

import re
from collections.abc import Sequence

import numpy as np
import pandas as pd

TD = 252  # default trading days per year
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

DEFAULT_TRAILING_PERIODS = ("1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "10Y", "15Y", "20Y")

# Return-frequency codes (as stored in settings) -> pandas resample rule.
# None = use daily returns as-is.
RETURN_FREQS: dict[str, str | None] = {"D": None, "W": "W-FRI", "M": "ME"}

_PERIOD_RE = re.compile(r"^(\d{1,3})([DWMY])$")


def period_offset(label: str) -> pd.DateOffset | None:
    """Parse a period label like '1M', '3Y', '10D', '2W' or 'YTD'.

    Returns the DateOffset, or None for 'YTD'. Raises ValueError if invalid.
    """
    if label == "YTD":
        return None
    m = _PERIOD_RE.match(label)
    if not m or int(m.group(1)) == 0:
        raise ValueError(f"invalid period {label!r}; use e.g. 1M, 3Y, 10D, 2W or YTD")
    n, unit = int(m.group(1)), m.group(2)
    key = {"D": "days", "W": "weeks", "M": "months", "Y": "years"}[unit]
    return pd.DateOffset(**{key: n})


def resample_rule(freq: str | None) -> str | None:
    """Accept a settings code ('D'/'W'/'M') or a raw pandas rule ('W-FRI')."""
    if freq is None:
        return None
    return RETURN_FREQS.get(freq, freq)


def _period_returns(wide: pd.DataFrame, freq: str | None) -> pd.DataFrame:
    px = wide.ffill()
    rule = resample_rule(freq)
    if rule:
        px = px.resample(rule).last()
    return px.pct_change(fill_method=None).dropna(how="any")


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


def ann_vol(close: pd.Series, trading_days: int = TD) -> float:
    return daily_returns(close).std() * np.sqrt(trading_days)


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


def summary_metrics(close: pd.Series, rf: float = 0.065, trading_days: int = TD) -> dict:
    """Headline risk/return statistics. rf = annual risk-free rate (decimal)."""
    close = close.dropna()
    r = daily_returns(close)
    if len(r) < 5:
        return {}
    td = trading_days
    rf_d = (1 + rf) ** (1 / td) - 1
    ex = r - rf_d
    vol = r.std() * np.sqrt(td)
    downside = np.sqrt((np.minimum(ex, 0) ** 2).mean()) * np.sqrt(td)
    g = cagr(close)
    dd = drawdown(close)
    mdd = dd.min()
    monthly = close.resample("ME").last().pct_change().dropna()
    yearly = close.resample("YE").last().pct_change().dropna()
    var95 = np.percentile(r, 5)
    last_year = close.iloc[-td:]
    return {
        "Start": close.index[0].date(),
        "End": close.index[-1].date(),
        "Years": round(years_between(close.index[0], close.index[-1]), 2),
        "Start level": close.iloc[0],
        "End level": close.iloc[-1],
        "Total return %": (close.iloc[-1] / close.iloc[0] - 1) * 100,
        "CAGR %": g * 100,
        "Annual volatility %": vol * 100,
        "Sharpe": ex.mean() * td / vol if vol else np.nan,
        "Sortino": ex.mean() * td / downside if downside else np.nan,
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
        "52w high": last_year.max(),
        "% from 52w high": (close.iloc[-1] / last_year.max() - 1) * 100,
    }


def metrics_table(closes: dict[str, pd.Series], rf: float = 0.065,
                  trading_days: int = TD) -> pd.DataFrame:
    return pd.DataFrame({k: summary_metrics(v, rf, trading_days) for k, v in closes.items()})


def trailing_returns(close: pd.Series,
                     periods: Sequence[str] = DEFAULT_TRAILING_PERIODS) -> dict:
    """Point-to-point returns like a fund factsheet, in % (CAGR for periods > 1y).

    `periods` are labels understood by `period_offset` ('1M', '3Y', 'YTD', …).
    """
    close = close.dropna()
    end = close.index[-1]
    out = {}
    for label in periods:
        off = period_offset(label)
        start = pd.Timestamp(end.year - 1, 12, 31) if off is None else end - off
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
    """For each date, annualised return (decimal) over the preceding `years` years."""
    close = close.dropna()
    months = int(round(years * 12))
    past_dates = close.index - pd.DateOffset(months=months)
    past = close.reindex(past_dates, method="ffill")
    past.index = close.index
    past[past_dates < close.index[0]] = np.nan
    return ((close / past) ** (1 / years) - 1).dropna()


def _pct_label(t: float) -> str:
    return f"{t * 100:g}%"


def rolling_summary(close: pd.Series, windows=(1, 3, 5, 7, 10),
                    thresholds: Sequence[float] = (0.10, 0.15)) -> pd.DataFrame:
    """Distribution of rolling CAGRs per window. `thresholds` are decimal CAGR
    hurdles; each adds a column '% of periods > <t>%'."""
    rows = {}
    for w in windows:
        rc = rolling_cagr(close, w)
        if rc.empty:
            continue
        row = {
            "Observations": len(rc),
            "Min %": rc.min() * 100,
            "Median %": rc.median() * 100,
            "Mean %": rc.mean() * 100,
            "Max %": rc.max() * 100,
            "% of periods negative": (rc < 0).mean() * 100,
        }
        for t in thresholds:
            row[f"% of periods > {_pct_label(t)}"] = (rc > t).mean() * 100
        rows[f"{w:g}Y"] = row
    return pd.DataFrame(rows).T


def rolling_volatility(close: pd.Series, window: int = 63, trading_days: int = TD) -> pd.Series:
    return daily_returns(close).rolling(window).std() * np.sqrt(trading_days)


def moving_averages(close: pd.Series, windows=(50, 200)) -> pd.DataFrame:
    return pd.DataFrame({f"SMA {w}": close.rolling(w).mean() for w in windows})


# --------------------------------------------------------------------------- #
# Multi-series
# --------------------------------------------------------------------------- #
def rebase(wide: pd.DataFrame, base: float = 100) -> pd.DataFrame:
    wide = wide.ffill().dropna(how="any")
    return wide / wide.iloc[0] * base


def correlation(wide: pd.DataFrame, freq: str | None = "W-FRI") -> pd.DataFrame:
    """Correlation of returns. Weekly by default, which avoids false low
    correlation between markets with different holidays / time zones.
    `freq` takes 'D'/'W'/'M', a pandas rule, or None for daily."""
    return _period_returns(wide, freq).corr()


def rolling_correlation(a: pd.Series, b: pd.Series, window: int = 52,
                        freq: str | None = "W-FRI", *,
                        window_weeks: int | None = None) -> pd.Series:
    """Rolling correlation over `window` periods of `freq` returns.
    `window_weeks` is the prototype's name for `window`, kept for old callers."""
    if window_weeks is not None:
        window = window_weeks
    w = _period_returns(pd.concat([a, b], axis=1), freq)
    return w.iloc[:, 0].rolling(window).corr(w.iloc[:, 1]).dropna()


def beta(asset: pd.Series, bench: pd.Series, freq: str | None = "W-FRI",
         min_obs: int = 10) -> float:
    w = _period_returns(pd.concat([asset, bench], axis=1), freq)
    if len(w) < min_obs:
        return np.nan
    c = np.cov(w.iloc[:, 0], w.iloc[:, 1])
    return c[0, 1] / c[1, 1]


def relative_strength(a: pd.Series, b: pd.Series) -> pd.Series:
    """Ratio a/b rebased to 100. Rising line = a outperforming b."""
    w = pd.concat([a, b], axis=1).ffill().dropna()
    rs = w.iloc[:, 0] / w.iloc[:, 1]
    return rs / rs.iloc[0] * 100


# --------------------------------------------------------------------------- #
# Data quality
# --------------------------------------------------------------------------- #
def data_quality(df: pd.DataFrame, has_volume: bool = True,
                 big_move: float = 0.08, gap_days: int = 5) -> dict:
    """Health checks worth running before trusting a dataset in research.
    `big_move` is a decimal daily-move threshold; `gap_days` the calendar-day gap
    that counts as a hole in the data."""
    if df.empty:
        return {"Rows": 0}
    close = df["Close"]
    r = close.pct_change()
    gaps = close.index.to_series().diff().dt.days
    stale = (close.diff() == 0).astype(int)
    longest_stale = stale.groupby((stale == 0).cumsum()).sum().max()
    ohlc_bad = ((df["High"] < df[["Open", "Close"]].max(axis=1) - 1e-6) |
                (df["Low"] > df[["Open", "Close"]].min(axis=1) + 1e-6)).sum()
    bdays = int(np.busday_count(close.index[0].date(), (close.index[-1] + pd.Timedelta(days=1)).date()))
    return {
        "Rows": len(df),
        "First date": close.index[0].date(),
        "Last date": close.index[-1].date(),
        "Coverage of weekdays %": len(df) / bdays * 100,
        f"Gaps > {gap_days} calendar days": int((gaps > gap_days).sum()),
        "Largest gap (days)": int(gaps.max()) if len(gaps) > 1 else 0,
        "Largest gap ends": gaps.idxmax().date() if len(gaps) > 1 else None,
        "Missing values": int(df[["Open", "High", "Low", "Close"]].isna().sum().sum()),
        "Duplicate dates": int(df.index.duplicated().sum()),
        "Longest unchanged-close run": int(longest_stale),
        f"Days with |move| > {_pct_label(big_move)}": int((r.abs() > big_move).sum()),
        "OHLC inconsistencies": int(ohlc_bad),
        "Zero-volume days": int((df["Volume"] == 0).sum()) if has_volume else "n/a (index)",
    }


def big_moves(close: pd.Series, threshold: float = 0.05) -> pd.DataFrame:
    r = daily_returns(close)
    m = r[r.abs() > threshold]
    return pd.DataFrame({"Close": close.reindex(m.index), "Move %": m * 100}).sort_values("Move %")


# Re-exported so `analytics.<name>` keeps working for prototype-era callers.
# Imported last so the names above exist first (sip.py also imports `cagr` lazily).
from .indicators import exponential_moving_averages, log_returns, rsi  # noqa: E402,F401
from .sip import sip_backtest, sip_start_sensitivity, xirr  # noqa: E402,F401
