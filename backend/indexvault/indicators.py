"""Derived columns for the Data Studio column builder: log returns, EMAs, RSI.

Each takes a pd.Series of closes indexed by date and returns values aligned to it.
"""
from __future__ import annotations

from collections.abc import Sequence

import numpy as np
import pandas as pd


def log_returns(close: pd.Series) -> pd.Series:
    """Natural-log returns (decimal), first row dropped."""
    return np.log(close).diff().dropna()


def exponential_moving_averages(close: pd.Series, windows: Sequence[int] = (20,)) -> pd.DataFrame:
    """EMA per window (span = window, no bias adjustment), NaN until `window` rows exist."""
    return pd.DataFrame({
        f"EMA {w}": close.ewm(span=w, adjust=False, min_periods=w).mean() for w in windows
    })


def _wilder_average(x: np.ndarray, n: int) -> np.ndarray:
    """Wilder smoothing: seed with the simple mean of the first n values, then
    avg[i] = (avg[i-1] * (n-1) + x[i]) / n. NaN before the seed."""
    out = np.full(len(x), np.nan)
    if len(x) < n:
        return out
    out[n - 1] = x[:n].mean()
    for i in range(n, len(x)):
        out[i] = (out[i - 1] * (n - 1) + x[i]) / n
    return out


def rsi(close: pd.Series, window: int = 14) -> pd.Series:
    """Wilder's Relative Strength Index on a 0–100 scale (not a percentage).
    Matches the standard definition (as on TradingView): first value after
    `window` price changes."""
    delta = close.diff().iloc[1:]
    gain = pd.Series(_wilder_average(delta.clip(lower=0).to_numpy(), window), index=delta.index)
    loss = pd.Series(_wilder_average((-delta.clip(upper=0)).to_numpy(), window), index=delta.index)
    out = 100 - 100 / (1 + gain / loss)
    # Flat windows have gain = loss = 0: call that neutral, not undefined.
    out = out.mask((loss == 0) & (gain == 0), 50.0)
    out = out.mask((loss == 0) & (gain > 0), 100.0)
    return out.reindex(close.index).rename(f"RSI {window}")
