"""Shared fixtures. Keeps every test away from the real cache and config folders."""
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
