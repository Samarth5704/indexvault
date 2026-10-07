"""CatalogStore: custom indices, watchlists, merged view, persistence."""
import json

import pytest
from pydantic import ValidationError

from api.catalog import CatalogStore
from indexvault.indices import CATALOG


@pytest.fixture
def store(tmp_path):
    return CatalogStore(tmp_path / "catalog.json")


def test_empty_catalog_has_builtins(store, tmp_path):
    merged = store.merged()
    assert [c["name"] for c in merged["categories"]] == list(CATALOG)
    assert merged["watchlists"] == []
    nifty = merged["categories"][0]["items"][0]
    assert nifty == {"name": "NIFTY 50", "ticker": "^NSEI", "source": "yahoo", "custom": False, "id": None}
    assert not (tmp_path / "catalog.json").exists()        # nothing written until a change


def test_add_custom_index(store):
    store.upsert_index("momentum", {"name": "NIFTY200 Momentum 30", "ticker": "MOM30.NS", "category": "Factor"})
    store.upsert_index("my-csv", {"name": "My series", "ticker": "MINE", "source": "csv"})
    cats = {c["name"]: c["items"] for c in store.merged()["categories"]}
    assert cats["Factor"][0]["custom"] is True and cats["Factor"][0]["id"] == "momentum"
    assert cats["Custom"][0]["source"] == "csv"
    fresh = CatalogStore(store.path).load()
    assert [i.id for i in fresh.custom_indices] == ["momentum", "my-csv"]


def test_upsert_replaces_by_id(store):
    store.upsert_index("x", {"name": "A", "ticker": "A.NS"})
    store.upsert_index("x", {"name": "B", "ticker": "B.NS"})
    assert [(i.id, i.name) for i in store.get().custom_indices] == [("x", "B")]


@pytest.mark.parametrize("data", [
    {"name": "", "ticker": "A"},
    {"name": "A", "ticker": "bad ticker"},
    {"name": "A", "ticker": "A", "source": "nope"},
    {"name": "A", "ticker": "A", "extra": 1},
])
def test_invalid_index_rejected(store, data):
    with pytest.raises(ValidationError):
        store.upsert_index("x", data)


def test_invalid_id_and_duplicate_ticker(store):
    with pytest.raises(ValidationError):
        store.upsert_index("Bad Id", {"name": "A", "ticker": "A"})
    store.upsert_index("one", {"name": "A", "ticker": "A.NS"})
    with pytest.raises(ValidationError, match="already in the catalogue"):
        store.upsert_index("two", {"name": "Again", "ticker": "A.NS"})
    assert [i.id for i in store.get().custom_indices] == ["one"]


def test_delete_index(store):
    store.upsert_index("x", {"name": "A", "ticker": "A.NS"})
    store.delete_index("x")
    assert store.get().custom_indices == []
    with pytest.raises(KeyError):
        store.delete_index("x")


def test_watchlists_crud_and_reorder(store):
    store.upsert_watchlist("sectors", {"name": "Sectors I track", "tickers": ["^NSEBANK", "^CNXIT"]})
    store.upsert_watchlist("core", {"name": "Core", "tickers": ["^NSEI"]})
    assert [w.id for w in store.reorder_watchlists(["core", "sectors"])] == ["core", "sectors"]
    with pytest.raises(ValueError):
        store.reorder_watchlists(["core"])
    with pytest.raises(ValidationError):
        store.upsert_watchlist("dupe", {"name": "D", "tickers": ["^NSEI", "^NSEI"]})
    store.delete_watchlist("core")
    assert [w["id"] for w in CatalogStore(store.path).merged()["watchlists"]] == ["sectors"]


def test_corrupt_catalog_set_aside(store, tmp_path):
    store.path.write_text(json.dumps({"custom_indices": "nope"}), encoding="utf-8")
    assert store.load().custom_indices == []
    assert store.warnings and any(p.name.startswith("catalog.invalid-") for p in tmp_path.iterdir())
