"""Shared application state and the data-access layer used by every router.

`AppContext` owns the settings/catalogue stores, the job manager and the memo.
Its data methods wrap `indexvault.data.get_data`, keeping parsed cache frames
in memory keyed on the cache file's mtime so repeat requests skip CSV reads.
"""
from __future__ import annotations

from collections.abc import Callable, Hashable, Iterable
from datetime import date
from typing import Any

import pandas as pd
from fastapi import Request

from indexvault import analytics as an
from indexvault import data, nse
from indexvault.indices import DEFAULT_SOURCE, series_kind

from .catalog import CatalogStore
from .errors import ApiError, bad_request, not_found
from .jobs import JobManager
from .memo import Memo
from .settings import Settings
from .settings_store import SettingsStore
from .storage import resolve_path

MAX_TICKERS = 20


class AppContext:
    def __init__(self, settings_store: SettingsStore, catalog_store: CatalogStore):
        self.settings_store = settings_store
        self.catalog = catalog_store
        self.memo = Memo(maxsize=512)
        self.jobs = JobManager()
        self._cache_root = None
        settings_store.subscribe(self._apply_settings)
        settings_store.load()
        catalog_store.load()

    # -- settings ------------------------------------------------------------ #
    @property
    def settings(self) -> Settings:
        return self.settings_store.get()

    def _apply_settings(self, s: Settings) -> None:
        nse.set_request_gap(s.data.nse_request_gap_seconds)
        root = resolve_path(s.data.cache_dir)
        if root != self._cache_root:
            data.set_cache_root(root)
            self._cache_root = root
            self.memo.clear()

    def warnings(self) -> list[str]:
        return [*self.settings_store.warnings, *self.catalog.warnings]

    # -- argument helpers ---------------------------------------------------- #
    def source(self, source: str | None) -> str:
        source = source or self.settings.data.source
        if source not in data.SOURCES:
            raise bad_request(f"Unknown data source {source!r}.", available=sorted(data.SOURCES))
        return source

    def explicit_source(self, source: str | None) -> str | None:
        """A `?source=` the caller asked for (validated), or None = per-ticker default."""
        return self.source(source) if source else None

    def source_for(self, ticker: str, explicit: str | None = None) -> str:
        """Which source serves `ticker`. Precedence: an explicit request > the global
        Demo switch (offline mode stays whole) > a per-ticker override (e.g. a CSV
        import) > a custom index's own source > the built-in default (NSE for indices
        Yahoo no longer serves, and every TRI) > the global source."""
        if explicit:
            return self.source(explicit)
        default = self.settings.data.source
        if default == "demo":
            return default
        cat = self.catalog.get()
        override = cat.source_overrides.get(ticker)
        if override in data.SOURCES:
            return override
        custom = next((c for c in cat.custom_indices if c.ticker == ticker), None)
        if custom is not None and custom.source in data.SOURCES:
            return custom.source
        return DEFAULT_SOURCE.get(ticker, default)

    def catalog_payload(self) -> dict[str, Any]:
        """The merged catalogue. Each item keeps its configured `source` and gains
        `used_source` (after overrides / Demo mode), `kind` ("price" | "tri") and its
        cached history span (None until first downloaded)."""
        out = self.catalog.merged()
        short = self.settings.data.short_history_days
        for cat in out["categories"]:
            for item in cat["items"]:
                src = self.source_for(item["ticker"])
                item["used_source"], item["kind"] = src, series_kind(item["ticker"])
                item["history"] = history_info(data.cache_span(item["ticker"], src), short, src)
        out["short_history_days"] = short
        return out

    @staticmethod
    def tickers(raw: str | Iterable[str] | None, required: bool = True) -> list[str]:
        items = raw.split(",") if isinstance(raw, str) else list(raw or [])
        out = list(dict.fromkeys(t.strip() for t in items if t and t.strip()))
        if required and not out:
            raise bad_request("Give at least one ticker.")
        if len(out) > MAX_TICKERS:
            raise bad_request(f"At most {MAX_TICKERS} tickers per request.", given=len(out))
        return out

    def date_range(self, period: str | None, start: date | None, end: date | None
                   ) -> tuple[pd.Timestamp | None, pd.Timestamp]:
        """Resolve (start, end). Explicit dates win over `period`; with neither,
        the default period from settings applies. start None = all history."""
        end_ts = pd.Timestamp(end) if end else pd.Timestamp.today().normalize()
        if start:
            start_ts = pd.Timestamp(start)
        else:
            label = period or self.settings.data.default_period
            if label == "Max":
                start_ts = None
            else:
                try:
                    off = an.period_offset(label)
                except ValueError as e:
                    raise bad_request(str(e), period=label) from None
                start_ts = pd.Timestamp(end_ts.year - 1, 12, 31) if off is None else end_ts - off
        if start_ts is not None and start_ts > end_ts:
            raise bad_request("start is after end.", start=str(start_ts.date()), end=str(end_ts.date()))
        return start_ts, end_ts

    # -- data ---------------------------------------------------------------- #
    def full_frame(self, ticker: str, source: str | None, start: pd.Timestamp | None,
                   end: pd.Timestamp, refresh: bool = False) -> pd.DataFrame:
        """All cached daily rows for a ticker, after fetching whatever
        [start, end] needs. `source` None = the ticker's own source (`source_for`).
        Raises ApiError(404/502) on no data / source failure."""
        source = self.source_for(ticker, source)
        stale = self.settings.data.stale_after_hours
        if not refresh:
            hit = self.memo.get(self._frame_key(ticker, source))
            if hit is not None and not data.needs_fetch(hit[0], hit[1], start, end, stale):
                return hit[0]
        try:
            data.get_data(ticker, start, end, source=source, refresh=refresh, stale_after_hours=stale)
        except FileNotFoundError as e:
            raise not_found(str(e), ticker=ticker, source=source) from None
        except nse.SourceUnavailable as e:  # message already says what to do instead
            raise ApiError(502, "source_error", str(e), {"ticker": ticker, "source": source,
                           "reason": e.reason, "fallback": e.fallback}) from None
        except Exception as e:  # noqa: BLE001 — network / parsing errors from the source
            raise ApiError(502, "source_error", f"Could not fetch {ticker} from {source}.",
                           {"ticker": ticker, "source": source, "reason": str(e)[:300]}) from None
        df, info = data.load_cached(ticker, source)
        if df is None or df.empty:
            raise not_found(f"No data for {ticker} from {source}.", ticker=ticker, source=source)
        self.memo.set(self._frame_key(ticker, source), (df, info))
        return df

    def frame(self, ticker: str, source: str | None, start: pd.Timestamp | None, end: pd.Timestamp,
              warmup: pd.DateOffset | None = None) -> pd.DataFrame:
        """Daily OHLCV in [start, end]. `warmup` loads that much extra history
        before start (for indicators); trim it yourself after computing."""
        load_from = start - warmup if (start is not None and warmup is not None) else start
        df = self.full_frame(ticker, source, load_from, end)
        out = df.loc[load_from:end] if load_from is not None else df.loc[:end]
        if out.empty:
            raise not_found(f"No {ticker} data between {_d(start)} and {_d(end)}.", ticker=ticker)
        return out

    def closes(self, tickers: list[str], source: str | None, start, end) -> dict[str, pd.Series]:
        return {t: self.frame(t, source, start, end)["Close"] for t in tickers}

    def computed(self, name: str, tickers: Iterable[str], source: str | None, params: Hashable,
                 fn: Callable[[], Any]) -> Any:
        """Memoise `fn()` on (name, params, each ticker's resolved source and cache mtime)."""
        key = (name, params, self._mtimes(tickers, source))
        return self.memo.get_or_compute(key, fn)

    def _frame_key(self, ticker: str, source: str) -> tuple:
        return ("frame", str(data.get_cache_root()), source, ticker, self._mtime(ticker, source))

    @staticmethod
    def _mtime(ticker: str, source: str) -> int:
        try:
            return data.cache_file(ticker, source).stat().st_mtime_ns
        except FileNotFoundError:
            return 0

    def _mtimes(self, tickers: Iterable[str], source: str | None) -> tuple:
        return tuple((t, src, self._mtime(t, src)) for t in tickers for src in [self.source_for(t, source)])


def history_info(span: dict | None, short_days: int, source: str) -> dict | None:
    """{first, last, days, short, complete} for a cached series. `short` means under
    `short_days` of history *that the source can provide*: only when we know there is
    no more (earliest date recorded, the source returned less than was asked for, or
    it's a CSV import). A series merely loaded for a short range isn't short."""
    if not span or not span.get("first_date"):
        return None
    first, last = pd.Timestamp(span["first_date"]), pd.Timestamp(span["last_date"])
    days = int((last - first).days)
    complete = bool(span.get("earliest_available"))
    asked = pd.Timestamp(span["requested_start"]) if span.get("requested_start") else first
    known_short = complete or source == "csv" or first > asked + pd.Timedelta(days=14)
    return {"first": span["first_date"], "last": span["last_date"], "rows": span.get("rows"),
            "days": days, "short": days < short_days and known_short, "complete": complete}


def _d(ts: pd.Timestamp | None) -> str:
    return "the beginning" if ts is None else str(ts.date())


def get_ctx(request: Request) -> AppContext:
    return request.app.state.ctx
