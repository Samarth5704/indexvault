"""Data layer: fetch from a registered source, cache locally, update
incrementally, resample to other frequencies and export.

Cache layout (one CSV + one JSON per ticker, one folder per source):
    <cache root>/yahoo/<SAFE_TICKER>.csv
    <cache root>/yahoo/<SAFE_TICKER>.json  -> {"ticker", "requested_start", "last_update"}
    <cache root>/_imports/<SAFE_TICKER>.csv -> original rows of user CSV imports
Folders starting with "_" are not sources and are skipped by inventory/clear.

The cache root defaults to $INDEXVAULT_CACHE or backend/data_cache and can be
changed at runtime with `set_cache_root`. Cache reads/writes for one ticker are
serialised with a per-(source, ticker) lock, so concurrent threads in one
process are safe (separate processes are not coordinated).
"""
from __future__ import annotations

import io
import json
import os
import re
import threading
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd

from .sources import (  # noqa: F401  (re-exported for prototype-era callers)
    COLUMNS,
    SOURCE_INFO,
    SOURCES,
    available_sources,
    clean as _clean,
    fetch_demo as _fetch_demo,
    fetch_yahoo as _fetch_yahoo,
    register_source,
    unregister_source,
)

EARLIEST = pd.Timestamp("1990-01-01")
IMPORTS_DIR = "_imports"

CACHE_ROOT = Path(
    os.environ.get(
        "INDEXVAULT_CACHE", Path(__file__).resolve().parent.parent / "data_cache"
    )
)

FREQUENCIES = {
    "Daily": None,
    "Weekly": "W-FRI",
    "Monthly": "ME",
    "Quarterly": "QE",
    "Yearly": "YE",
}


def set_cache_root(path: str | os.PathLike) -> Path:
    """Point the cache at another folder (created lazily on first write)."""
    global CACHE_ROOT
    CACHE_ROOT = Path(path).expanduser().resolve()
    return CACHE_ROOT


def get_cache_root() -> Path:
    return CACHE_ROOT


# --------------------------------------------------------------------------- #
# Cache helpers
# --------------------------------------------------------------------------- #
_locks: dict[tuple[str, str], threading.RLock] = {}
_locks_guard = threading.Lock()


def _safe(ticker: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", ticker)


def _ticker_lock(source: str, ticker: str) -> threading.RLock:
    with _locks_guard:
        return _locks.setdefault((source, _safe(ticker)), threading.RLock())


def _source_dirs() -> list[Path]:
    if not CACHE_ROOT.exists():
        return []
    return sorted(p for p in CACHE_ROOT.iterdir() if p.is_dir() and not p.name.startswith("_"))


def _paths(ticker: str, source: str) -> tuple[Path, Path]:
    d = CACHE_ROOT / source
    d.mkdir(parents=True, exist_ok=True)
    s = _safe(ticker)
    return d / f"{s}.csv", d / f"{s}.json"


def load_cached(ticker: str, source: str = "yahoo") -> tuple[pd.DataFrame | None, dict]:
    with _ticker_lock(source, ticker):
        csv, meta = _paths(ticker, source)
        if not csv.exists():
            return None, {}
        df = pd.read_csv(csv, index_col=0, parse_dates=True)
        df.index.name = "Date"
        info = json.loads(meta.read_text()) if meta.exists() else {}
        return df, info


def _save(ticker: str, source: str, df: pd.DataFrame, info: dict) -> None:
    csv, meta = _paths(ticker, source)
    df.to_csv(csv, float_format="%.4f")
    info = {**info, "ticker": ticker, "last_update": datetime.now().isoformat(timespec="seconds")}
    meta.write_text(json.dumps(info, indent=2))


def cache_inventory() -> pd.DataFrame:
    """One row per cached ticker across all sources."""
    rows = []
    for src_dir in _source_dirs():
        for meta in sorted(src_dir.glob("*.json")):
            info = json.loads(meta.read_text())
            csv = meta.with_suffix(".csv")
            if not csv.exists():
                continue
            idx = pd.read_csv(csv, usecols=[0], index_col=0, parse_dates=True).index
            rows.append({
                "Source": src_dir.name,
                "Ticker": info.get("ticker", meta.stem),
                "Rows": len(idx),
                "First date": idx.min().date() if len(idx) else None,
                "Last date": idx.max().date() if len(idx) else None,
                "Last updated": info.get("last_update", ""),
                "Size (KB)": round(csv.stat().st_size / 1024, 1),
            })
    return pd.DataFrame(rows)


def clear_cache(ticker: str | None = None, source: str | None = None) -> int:
    """Delete cached files; returns how many were removed. Leaves CSV imports
    (the `_imports` folder) alone, so a "csv" ticker can be rebuilt from them."""
    n = 0
    for src_dir in _source_dirs():
        if source and src_dir.name != source:
            continue
        pattern = f"{_safe(ticker)}.*" if ticker else "*"
        for f in src_dir.glob(pattern):
            if f.suffix in (".csv", ".json"):
                with _ticker_lock(src_dir.name, f.stem):
                    f.unlink(missing_ok=True)
                n += 1
    return n


# --------------------------------------------------------------------------- #
# CSV import source
# --------------------------------------------------------------------------- #
_CSV_ALIASES = {
    "date": "Date", "datetime": "Date", "timestamp": "Date",
    "open": "Open", "high": "High", "low": "Low",
    "close": "Close", "price": "Close", "last": "Close", "close price": "Close",
    "adj close": "Adj Close", "adj_close": "Adj Close", "adjclose": "Adj Close",
    "volume": "Volume", "shares traded": "Volume",
}


def parse_ohlcv_csv(src: str | os.PathLike | bytes, dayfirst: bool = False) -> pd.DataFrame:
    """Read a user CSV with a date column and at least a close/price column.

    Column names are matched case-insensitively (Date, Open, High, Low, Close or
    Price, Adj Close, Volume); the first column is used as the date if none is
    named. Missing Open/High/Low default to Close. Numbers may contain commas.
    Set `dayfirst=True` for DD-MM-YYYY dates.
    """
    raw = pd.read_csv(io.BytesIO(src) if isinstance(src, bytes) else src)
    raw = raw.rename(columns=lambda c: _CSV_ALIASES.get(str(c).strip().lower(), str(c).strip()))
    if "Date" not in raw.columns:
        raw = raw.rename(columns={raw.columns[0]: "Date"})
    if "Close" not in raw.columns:
        raise ValueError("CSV needs a Close (or Price) column")
    out = pd.DataFrame(index=pd.to_datetime(raw["Date"], dayfirst=dayfirst, format="mixed"))
    for col in COLUMNS:
        if col in raw.columns:
            vals = raw[col].astype(str).str.replace(",", "", regex=False)
            out[col] = pd.to_numeric(vals, errors="coerce").to_numpy()
    for col in ("Open", "High", "Low"):
        if col not in out.columns:
            out[col] = out["Close"]
    return _clean(out)


def _import_path(ticker: str) -> Path:
    return CACHE_ROOT / IMPORTS_DIR / f"{_safe(ticker)}.csv"


def _fetch_csv(ticker: str, start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame:
    path = _import_path(ticker)
    if not path.exists():
        raise FileNotFoundError(f"no CSV imported for {ticker!r}")
    df = pd.read_csv(path, index_col=0, parse_dates=True)
    return _clean(df).loc[start:end]


register_source("csv", _fetch_csv, label="CSV import", offline=True)


def import_csv(ticker: str, src: str | os.PathLike | bytes, dayfirst: bool = False) -> pd.DataFrame:
    """Import a CSV as source "csv" under `ticker`, replacing any earlier import."""
    df = parse_ohlcv_csv(src, dayfirst=dayfirst)
    if df.empty:
        raise ValueError("CSV contained no usable rows")
    path = _import_path(ticker)
    path.parent.mkdir(parents=True, exist_ok=True)
    with _ticker_lock("csv", ticker):
        df.to_csv(path, float_format="%.6f")
        return get_data(ticker, source="csv", refresh=True)


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #
def get_data(
    ticker: str,
    start: str | date | None = None,
    end: str | date | None = None,
    source: str = "yahoo",
    refresh: bool = False,
    use_cache: bool = True,
    stale_after_hours: float = 3,
) -> pd.DataFrame:
    """Daily OHLCV for `ticker` between start and end (inclusive).

    Uses the local cache when possible and only downloads what is missing:
      * newer rows since the last cached date (incremental update), once the
        cache is older than `stale_after_hours` or 3+ business days behind
      * older rows if you ask for an earlier start than ever before (backfill)
    `refresh=True` re-downloads the full requested range.
    """
    if source not in SOURCES:
        raise KeyError(f"unknown source {source!r}; registered: {sorted(SOURCES)}")
    fetch = SOURCES[source]
    start = pd.Timestamp(start) if start else EARLIEST
    end = pd.Timestamp(end) if end else pd.Timestamp.today().normalize()

    if not use_cache:
        return fetch(ticker, start, end)

    with _ticker_lock(source, ticker):
        cached, info = load_cached(ticker, source)
        if refresh or cached is None or cached.empty:
            df = fetch(ticker, start, end)
            if not df.empty:
                _save(ticker, source, df, {"requested_start": str(start.date())})
            return df.loc[start:end]

        pieces = [cached]
        req_start = pd.Timestamp(info.get("requested_start", cached.index.min()))
        if start < req_start:  # backfill older history
            older = fetch(ticker, start, cached.index.min() - timedelta(days=1))
            pieces.insert(0, older)
            req_start = start
        last = cached.index.max()
        today = pd.Timestamp.today().normalize()
        try:
            since_update = datetime.now() - datetime.fromisoformat(info.get("last_update", "1990-01-01"))
        except ValueError:
            since_update = timedelta(days=999)
        stale = last < today - pd.offsets.BDay(3) or since_update > timedelta(hours=stale_after_hours)
        if end > last and last < today and stale:
            # small overlap so revised last bars get corrected
            newer = fetch(ticker, last - timedelta(days=5), today)
            pieces.append(newer)

        if len(pieces) > 1:
            merged = pd.concat([p for p in pieces if not p.empty])
            merged = merged[~merged.index.duplicated(keep="last")].sort_index()
            _save(ticker, source, merged, {"requested_start": str(req_start.date())})
            cached = merged
        return cached.loc[start:end]


def check_ticker(ticker: str, source: str = "yahoo") -> tuple[bool, str]:
    """Quick probe: does the source return recent data for this ticker?"""
    try:
        end = pd.Timestamp.today().normalize()
        df = SOURCES[source](ticker, end - timedelta(days=20), end)
        if df.empty:
            return False, "no data returned"
        return True, f"last close {df['Close'].iloc[-1]:,.2f} on {df.index[-1].date()}"
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:120]


def resample(df: pd.DataFrame, freq: str, add_returns: bool = True) -> pd.DataFrame:
    """Aggregate daily OHLCV to Weekly/Monthly/Quarterly/Yearly bars.

    Each bar is labelled with the *last actual trading date* inside it
    (not a calendar month-end that may be a holiday).
    """
    rule = FREQUENCIES[freq]
    out = df.copy()
    if rule is not None and not df.empty:
        g = df.resample(rule)
        out = g.agg({
            "Open": "first", "High": "max", "Low": "min",
            "Close": "last", "Adj Close": "last", "Volume": "sum",
        })
        last_dates = df.index.to_series().resample(rule).max()
        out.index = last_dates.reindex(out.index).values
        out = out.dropna(subset=["Close"])
        out.index = pd.DatetimeIndex(out.index, name="Date")
    if add_returns and not out.empty:
        out["Return %"] = out["Close"].pct_change() * 100
    return out


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #
def _sheet_name(name: str, used: set[str]) -> str:
    s = re.sub(r"[\[\]\*\?/\\:]", "", name)[:31] or "Sheet"
    base, i = s, 2
    while s in used:
        s = f"{base[:28]}_{i}"
        i += 1
    used.add(s)
    return s


def to_excel_bytes(sheets: dict[str, pd.DataFrame]) -> bytes:
    """Write several DataFrames to one formatted .xlsx workbook."""
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    buf = io.BytesIO()
    used: set[str] = set()
    with pd.ExcelWriter(buf, engine="openpyxl") as xw:
        for name, frame in sheets.items():
            sname = _sheet_name(name, used)
            frame = frame.copy()
            if isinstance(frame.index, pd.DatetimeIndex):
                frame.index = frame.index.date
            frame.to_excel(xw, sheet_name=sname)
            ws = xw.sheets[sname]
            ws.freeze_panes = "B2"
            head_fill = PatternFill("solid", fgColor="1C5CAB")
            for cell in ws[1]:
                cell.font = Font(bold=True, color="FFFFFF")
                cell.fill = head_fill
                cell.alignment = Alignment(horizontal="center")
            for col_idx, col in enumerate(ws.columns, start=1):
                width = max(len(str(c.value)) if c.value is not None else 0 for c in list(col)[:200])
                ws.column_dimensions[get_column_letter(col_idx)].width = min(max(width + 2, 10), 40)
                for c in list(col)[1:]:
                    if isinstance(c.value, float):
                        c.number_format = "#,##0.00"
    return buf.getvalue()


def to_csv_zip_bytes(frames: dict[str, pd.DataFrame]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, frame in frames.items():
            z.writestr(f"{_safe(name)}.csv", frame.to_csv(float_format="%.4f"))
    return buf.getvalue()


def combine_close(frames: dict[str, pd.DataFrame], column: str = "Close") -> pd.DataFrame:
    """Wide table: one column per ticker, aligned on dates (outer join)."""
    return pd.DataFrame({k: v[column] for k, v in frames.items() if not v.empty}).sort_index()
