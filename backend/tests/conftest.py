"""Shared fixtures. Keeps every test away from the real cache, config and network."""
import os
import tempfile

# Must run before indexvault.data is imported (CACHE_ROOT is read at import).
os.environ.setdefault("INDEXVAULT_CACHE", tempfile.mkdtemp(prefix="iv-cache-"))
os.environ.setdefault("INDEXVAULT_CONFIG", tempfile.mkdtemp(prefix="iv-config-"))

import pandas as pd  # noqa: E402
import pytest  # noqa: E402

from indexvault import data  # noqa: E402


@pytest.fixture
def cache_root(tmp_path):
    """A fresh, empty cache root for one test; the previous root is restored after."""
    old = data.get_cache_root()
    root = data.set_cache_root(tmp_path / "cache")
    yield root
    data.set_cache_root(old)


@pytest.fixture
def counting_source():
    """Registers source "counting": deterministic daily closes up to 2 business
    days ago, recording every fetch call as (ticker, start, end)."""
    calls = []
    last = pd.Timestamp.today().normalize() - pd.offsets.BDay(2)

    def fetch(ticker, start, end):
        calls.append((ticker, start, end))
        idx = pd.bdate_range(max(start, pd.Timestamp("2020-01-01")), min(end, last))
        close = pd.Series(range(100, 100 + len(idx)), index=idx, dtype=float)
        return data._clean(pd.DataFrame({"Open": close, "High": close, "Low": close, "Close": close}))

    data.register_source("counting", fetch, offline=True)
    yield calls
    data.unregister_source("counting")


@pytest.fixture
def client(tmp_path, monkeypatch):
    """TestClient on a fresh app: temp config + cache, demo source by default,
    and Yahoo wired to fail so no test can reach the network."""
    import json

    from fastapi.testclient import TestClient

    from api.main import create_app

    config = tmp_path / "config"
    config.mkdir()
    (config / "settings.json").write_text(json.dumps({
        "schema_version": 1, "data": {"source": "demo", "cache_dir": str(tmp_path / "cache")}}))

    def no_network(*_args, **_kwargs):
        raise AssertionError("tests must not call Yahoo")

    monkeypatch.setitem(data.SOURCES, "yahoo", no_network)
    old_root = data.get_cache_root()
    with TestClient(create_app(config)) as c:
        yield c
    data.set_cache_root(old_root)


def walk(obj, path=""):
    """Yield (path, key, value) for every dict entry in a JSON document."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield path, k, v
            yield from walk(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from walk(v, f"{path}[{i}]")


def assert_api_conventions(doc):
    """CLAUDE.md rule 4 + SPEC § 5: no '%' in keys, dates never carry a time."""
    for path, key, value in walk(doc):
        assert "%" not in str(key), f"'%' in key {key!r} at {path}"
        if isinstance(value, str):
            assert "T00:00:00" not in value, f"timestamp {value!r} at {path}.{key}"
