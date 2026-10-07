"""Data-source registry. A source is any callable

    fetch(ticker: str, start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame

returning daily OHLCV (columns as in COLUMNS, DatetimeIndex named "Date").
Pass raw frames through `clean()` to normalise them. Register new sources
(an NSE scraper, a broker API, …) with `register_source`; `data.get_data`
then caches them like the built-ins.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta

import numpy as np
import pandas as pd

COLUMNS = ["Open", "High", "Low", "Close", "Adj Close", "Volume"]

Fetch = Callable[[str, pd.Timestamp, pd.Timestamp], pd.DataFrame]


@dataclass(frozen=True)
class SourceInfo:
    name: str
    label: str
    offline: bool  # True if it needs no network (safe for tests / demos)


# name -> fetch function. Kept as a plain dict so prototype-era code that
# indexes `data.SOURCES[name]` keeps working.
SOURCES: dict[str, Fetch] = {}
SOURCE_INFO: dict[str, SourceInfo] = {}


def register_source(name: str, fetch: Fetch, *, label: str | None = None,
                    offline: bool = False) -> None:
    """Add or replace a data source."""
    if not name or not name.replace("-", "").replace("_", "").isalnum() or name.startswith("_"):
        raise ValueError(f"invalid source name {name!r}")
    SOURCES[name] = fetch
    SOURCE_INFO[name] = SourceInfo(name, label or name.title(), offline)


def unregister_source(name: str) -> None:
    SOURCES.pop(name, None)
    SOURCE_INFO.pop(name, None)


def available_sources() -> list[SourceInfo]:
    return list(SOURCE_INFO.values())


def clean(df: pd.DataFrame | None) -> pd.DataFrame:
    """Normalise a raw OHLCV frame: columns, tz-naive midnight index, sorted,
    de-duplicated, no missing or non-positive closes."""
    if df is None or df.empty:
        return pd.DataFrame(columns=COLUMNS)
    if isinstance(df.columns, pd.MultiIndex):
        df = df.droplevel(-1, axis=1) if df.columns.nlevels > 1 else df
    df = df.copy()
    if "Adj Close" not in df.columns and "Close" in df.columns:
        df["Adj Close"] = df["Close"]
    if "Volume" not in df.columns:
        df["Volume"] = 0
    df = df[[c for c in COLUMNS if c in df.columns]]
    idx = pd.to_datetime(df.index)
    if getattr(idx, "tz", None) is not None:
        idx = idx.tz_localize(None)
    df.index = idx.normalize()
    df.index.name = "Date"
    df = df[~df.index.duplicated(keep="last")].sort_index()
    df = df.dropna(subset=["Close"])
    df = df[df["Close"] > 0]
    return df


def fetch_yahoo(ticker: str, start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame:
    import yfinance as yf

    raw = yf.Ticker(ticker).history(
        start=start.strftime("%Y-%m-%d"),
        end=(end + timedelta(days=1)).strftime("%Y-%m-%d"),
        interval="1d",
        auto_adjust=False,
        actions=False,
    )
    return clean(raw)


def fetch_demo(ticker: str, start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame:
    """Deterministic synthetic OHLCV (regime-switching random walk) for offline use."""
    seed = sum(ord(c) * (i + 1) for i, c in enumerate(ticker)) % (2**32)
    rng = np.random.default_rng(seed)
    days = pd.bdate_range("2000-01-03", pd.Timestamp.today().normalize())
    n = len(days)
    drift = rng.uniform(0.07, 0.16) / 252
    base_vol = rng.uniform(0.14, 0.26) / np.sqrt(252)
    # volatility regimes: calm / stressed
    regime = np.zeros(n)
    state = 0
    for i in range(n):
        if rng.random() < (0.004 if state == 0 else 0.02):
            state = 1 - state
        regime[i] = state
    vol = base_vol * np.where(regime == 1, 2.2, 1.0)
    rets = drift - np.where(regime == 1, 0.0004, 0) + vol * rng.standard_t(5, n) / np.sqrt(5 / 3)
    close = rng.uniform(800, 6000) * np.exp(np.cumsum(rets))
    open_ = close * np.exp(rng.normal(0, vol * 0.3))
    high = np.maximum(open_, close) * np.exp(np.abs(rng.normal(0, vol * 0.5)))
    low = np.minimum(open_, close) * np.exp(-np.abs(rng.normal(0, vol * 0.5)))
    volume = 0 if ticker.startswith("^") else rng.integers(1e5, 5e6, n)
    df = pd.DataFrame(
        {"Open": open_, "High": high, "Low": low, "Close": close, "Adj Close": close, "Volume": volume},
        index=days,
    )
    return clean(df.loc[start:end])


register_source("yahoo", fetch_yahoo, label="Yahoo Finance")
register_source("demo", fetch_demo, label="Demo (synthetic)", offline=True)
