"""NSE index history from niftyindices.com: price (OHLC) and total return (TRI).

Personal research use only: the data belongs to NSE Indices Ltd, and these are the
endpoints the site's own "Historical Data" page calls, not a published API. They
have changed before (the old `/Backpage.aspx/...` paths now return HTML), so any
failure raises `SourceUnavailable`, whose message points to the CSV import.

Politeness: one shared session, at most one request every `request_gap` seconds,
ranges split into chunks of at most a year (the site refuses longer ones), and a
couple of retries with backoff on 429/5xx. History is walked backwards a year at a
time; the first year that comes back empty ends the walk, and the result carries
`attrs["no_data_before"]` so the cache can record the series' earliest date and
never ask for those empty years again.

Tickers: a catalogue ticker mapped in `indices.NSE_NAMES` (e.g. "^CNXAUTO"), or the
same with a "-TRI" suffix for its total return index ("^NSEI-TRI"). TRI rows are
close-only (Open/High/Low = Close) and carry the net total return in an extra
"NTR" column.
"""
from __future__ import annotations

import json
import threading
import time
from datetime import timedelta

import numpy as np
import pandas as pd

from .indices import NSE_NAMES
from .sources import clean, register_source

BASE_URL = "https://www.niftyindices.com"
PAGE_PATH = "/reports/historical-data"
PRICE_PATH = "/BackPage/getHistoricaldatatabletoString"
TRI_PATH = "/BackPage/getTotalReturnIndexString"
TRI_SUFFIX = "-TRI"
CHUNK_DAYS = 365          # the site rejects ranges longer than one year
TIMEOUT = 20              # seconds per request
RETRIES = 2               # extra attempts on 429 / 5xx / network errors
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/130.0 Safari/537.36",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/json; charset=utf-8",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": BASE_URL,
    "Referer": BASE_URL + PAGE_PATH,
}
FALLBACK_HINT = ("Download the CSV from niftyindices.com → Reports → Historical Data "
                 "and import it on the Cache page.")


class SourceUnavailable(RuntimeError):
    """niftyindices.com didn't give usable data. `fallback` tells the UI what to offer."""
    fallback = "csv_import"

    def __init__(self, reason: str):
        super().__init__(f"niftyindices.com didn't answer ({reason}). {FALLBACK_HINT}")
        self.reason = reason


_lock = threading.Lock()
_session = None
_last_call = 0.0
_request_gap = 1.0


def set_request_gap(seconds: float) -> None:
    """Minimum pause between requests (the API sets this from settings)."""
    global _request_gap
    _request_gap = max(0.0, float(seconds))


def is_tri(ticker: str) -> bool:
    return ticker.endswith(TRI_SUFFIX)


def index_names(ticker: str) -> tuple[str, str]:
    """(trading name the API wants, long display name) for a catalogue ticker."""
    base = ticker[: -len(TRI_SUFFIX)] if is_tri(ticker) else ticker
    if base not in NSE_NAMES:
        raise SourceUnavailable(f"no niftyindices.com index is mapped to {ticker!r}")
    return NSE_NAMES[base]


def _get_session():
    global _session
    if _session is None:
        import requests  # already installed (yfinance dependency)

        s = requests.Session()
        s.headers.update(HEADERS)
        try:
            s.get(BASE_URL + PAGE_PATH, timeout=TIMEOUT)  # same first step as a browser
        except requests.RequestException as e:
            raise SourceUnavailable(f"site unreachable: {type(e).__name__}") from None
        _session = s
    return _session


def _post(path: str, name: str, long_name: str, start: pd.Timestamp, end: pd.Timestamp) -> list[dict]:
    """One request (rate-limited, retried). Returns the decoded rows."""
    import requests

    global _last_call
    cinfo = "{'name':'%s','startDate':'%s','endDate':'%s','indexName':'%s'}" % (
        name.upper(), start.strftime("%d-%b-%Y"), end.strftime("%d-%b-%Y"), long_name)
    body = json.dumps({"cinfo": cinfo})
    for attempt in range(RETRIES + 1):
        with _lock:
            wait = _request_gap - (time.monotonic() - _last_call)
            if wait > 0:
                time.sleep(wait)
            try:
                r = _get_session().post(BASE_URL + path, data=body, timeout=TIMEOUT)
            except requests.RequestException as e:
                r, err = None, f"network error: {type(e).__name__}"
            finally:
                _last_call = time.monotonic()
        if r is not None and r.status_code < 400:
            return _decode(r.content)
        if r is not None:
            err = f"HTTP {r.status_code}"
            if r.status_code not in (429, 500, 502, 503, 504):
                break
        if attempt < RETRIES:
            time.sleep(2 * (attempt + 1))
    raise SourceUnavailable(err)


def _decode(content: bytes) -> list[dict]:
    """The reply is JSON (`{"d": "<json array>"}` or the array) despite a text/html label."""
    try:
        body = json.loads(content.decode("utf-8-sig"))
        rows = json.loads(body["d"]) if isinstance(body, dict) and "d" in body else body
    except (ValueError, KeyError, TypeError):
        raise SourceUnavailable("the reply wasn't the expected data; the site may have changed") from None
    if not isinstance(rows, list):
        raise SourceUnavailable("the reply wasn't a list of rows; the site may have changed")
    return rows


def _num(values) -> np.ndarray:
    return pd.to_numeric(pd.Series(values, dtype="string").str.replace(",", "", regex=False), errors="coerce").to_numpy()


def parse_price(rows: list[dict]) -> pd.DataFrame:
    if not rows:
        return clean(None)
    idx = pd.to_datetime([r.get("HistoricalDate") for r in rows], format="%d %b %Y", errors="coerce")
    df = pd.DataFrame({col: _num([r.get(key) for r in rows])
                       for col, key in (("Open", "OPEN"), ("High", "HIGH"), ("Low", "LOW"), ("Close", "CLOSE"))},
                      index=idx)
    df = df[df.index.notna()]
    for col in ("Open", "High", "Low"):  # some early rows carry only a close
        df[col] = df[col].fillna(df["Close"])
    return clean(df)


def parse_tri(rows: list[dict]) -> pd.DataFrame:
    if not rows:
        return clean(None)
    idx = pd.to_datetime([r.get("Date") for r in rows], format="%d %b %Y", errors="coerce")
    close = _num([r.get("TotalReturnsIndex") for r in rows])
    df = pd.DataFrame({"Open": close, "High": close, "Low": close, "Close": close,
                       "NTR": _num([r.get("NTR_Value") for r in rows])}, index=idx)
    return clean(df[df.index.notna()])


def fetch_nse(ticker: str, start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame:
    """Daily history in [start, end], newest year first; stops at the first empty year."""
    name, long_name = index_names(ticker)
    tri = is_tri(ticker)
    path, parse = (TRI_PATH, parse_tri) if tri else (PRICE_PATH, parse_price)
    end = min(pd.Timestamp(end).normalize(), pd.Timestamp.today().normalize())
    start = pd.Timestamp(start).normalize()
    frames, no_data_before = [], None
    chunk_end = end
    while chunk_end >= start:
        chunk_start = max(start, chunk_end - timedelta(days=CHUNK_DAYS - 1))
        part = parse(_post(path, name, long_name, chunk_start, chunk_end))
        if part.empty:
            no_data_before = chunk_end  # nothing on or before this date
            break
        frames.append(part)
        chunk_end = chunk_start - timedelta(days=1)
    df = clean(pd.concat(frames)) if frames else clean(None)
    if no_data_before is not None:
        df.attrs["no_data_before"] = str(no_data_before.date())
    return df



register_source("nse", fetch_nse, label="NSE (niftyindices.com)")
