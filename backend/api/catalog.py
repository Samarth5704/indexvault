"""User catalogue: custom indices and watchlists in config/catalog.json.

The built-in catalogue lives in core (`indexvault.indices.CATALOG`); `merged()`
combines both for the UI. Like settings, an unusable file is renamed aside,
never deleted.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, ValidationError, model_validator

from indexvault.indices import merge_catalog

from .settings import Slug, _source, _unique
from .storage import config_dir, read_json, set_aside, write_json_atomic

Ticker = Annotated[str, Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9^=._&-]+$")]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CustomIndex(_Model):
    id: Slug
    name: str = Field(min_length=1, max_length=60)
    ticker: Ticker
    category: str = Field("Custom", min_length=1, max_length=40)
    source: Annotated[str, AfterValidator(_source)] = "yahoo"


class Watchlist(_Model):
    id: Slug
    name: str = Field(min_length=1, max_length=60)
    tickers: Annotated[list[Ticker], AfterValidator(_unique)] = Field(default_factory=list, max_length=50)


class CatalogFile(_Model):
    schema_version: Literal[1] = 1
    custom_indices: list[CustomIndex] = Field(default_factory=list, max_length=500)
    watchlists: list[Watchlist] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def _unique_ids(self):
        for kind, items in (("custom index", self.custom_indices), ("watchlist", self.watchlists)):
            ids = [i.id for i in items]
            if len(set(ids)) != len(ids):
                raise ValueError(f"duplicate {kind} id")
        pairs = [(i.ticker, i.source) for i in self.custom_indices]
        if len(set(pairs)) != len(pairs):
            raise ValueError("the same ticker and source are already in the catalogue")
        return self


class CatalogStore:
    def __init__(self, path: Path | None = None):
        self.path = path or config_dir() / "catalog.json"
        self.warnings: list[str] = []
        self._lock = threading.RLock()
        self._data: CatalogFile | None = None

    def load(self) -> CatalogFile:
        with self._lock:
            self.warnings = []
            if not self.path.exists():
                self._data = CatalogFile()
            else:
                try:
                    self._data = CatalogFile.model_validate(read_json(self.path))
                except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValidationError) as e:
                    moved = set_aside(self.path, "invalid")
                    self.warnings.append(f"catalog.json could not be used ({str(e).splitlines()[0][:200]}); "
                                         f"it was moved to {moved.name}.")
                    self._data = CatalogFile()
            return self.get()

    def get(self) -> CatalogFile:
        with self._lock:
            if self._data is None:
                return self.load()
            return self._data.model_copy(deep=True)

    def replace(self, data: CatalogFile | dict) -> CatalogFile:
        """Replace the whole catalogue (used by backup restore)."""
        with self._lock:
            self._commit(data if isinstance(data, CatalogFile) else CatalogFile.model_validate(data))
            return self.get()

    # -- custom indices ---------------------------------------------------- #
    def upsert_index(self, id: str, data: dict) -> CustomIndex:
        """Create or replace the custom index `id`."""
        item = CustomIndex.model_validate({**data, "id": id})
        self._save_with("custom_indices", item)
        return item

    def delete_index(self, id: str) -> None:
        self._delete("custom_indices", id)

    # -- watchlists -------------------------------------------------------- #
    def upsert_watchlist(self, id: str, data: dict) -> Watchlist:
        item = Watchlist.model_validate({**data, "id": id})
        self._save_with("watchlists", item)
        return item

    def delete_watchlist(self, id: str) -> None:
        self._delete("watchlists", id)

    def reorder_watchlists(self, ids: list[str]) -> list[Watchlist]:
        with self._lock:
            cur = self.get()
            by_id = {w.id: w for w in cur.watchlists}
            if sorted(ids) != sorted(by_id):
                raise ValueError("reorder must list every watchlist id exactly once")
            cur.watchlists = [by_id[i] for i in ids]
            self._commit(cur)
            return cur.watchlists

    # -- views ------------------------------------------------------------- #
    def merged(self) -> dict[str, Any]:
        """Built-in + custom indices grouped by category, plus watchlists."""
        cur = self.get()
        custom = {(c.category, c.name): c for c in cur.custom_indices}
        groups = merge_catalog([c.model_dump() for c in cur.custom_indices])
        categories = []
        for cat, items in groups.items():
            rows = []
            for name, ticker in items.items():
                c = custom.get((cat, name))
                rows.append({"name": name, "ticker": ticker,
                             "source": c.source if c else "yahoo",
                             "custom": c is not None, "id": c.id if c else None})
            categories.append({"name": cat, "items": rows})
        return {"categories": categories,
                "watchlists": [w.model_dump() for w in cur.watchlists]}

    # -- internals --------------------------------------------------------- #
    def _save_with(self, field: str, item: BaseModel) -> None:
        with self._lock:
            cur = self.get()
            items = getattr(cur, field)
            idx = next((i for i, x in enumerate(items) if x.id == item.id), None)
            if idx is None:
                items.append(item)
            else:
                items[idx] = item
            self._commit(cur)

    def _delete(self, field: str, id: str) -> None:
        with self._lock:
            cur = self.get()
            items = getattr(cur, field)
            kept = [x for x in items if x.id != id]
            if len(kept) == len(items):
                raise KeyError(id)
            setattr(cur, field, kept)
            self._commit(cur)

    def _commit(self, data: CatalogFile) -> None:
        data = CatalogFile.model_validate(data.model_dump())  # re-run cross-item checks
        write_json_atomic(self.path, data.model_dump(mode="json"))
        self._data = data
