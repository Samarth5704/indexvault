"""Sanity tests with hand-checkable numbers. Run: python -m pytest -q"""
import os
import tempfile

import numpy as np
import pandas as pd
import pytest

os.environ["INDEXVAULT_CACHE"] = tempfile.mkdtemp()

from indexvault import analytics as an  # noqa: E402
from indexvault import data  # noqa: E402


def steady(rate=0.10, years=5):
    idx = pd.bdate_range("2015-01-01", periods=int(252 * years))
    t = (idx - idx[0]).days / 365.25
    return pd.Series(100 * (1 + rate) ** t, index=idx)


def test_cagr_exact():
    assert an.cagr(steady(0.10)) == pytest.approx(0.10, abs=1e-9)


def test_drawdown_known():
    s = pd.Series([100, 120, 90, 60, 130, 125], index=pd.bdate_range("2020-01-01", periods=6), dtype=float)
    assert an.drawdown(s).min() == pytest.approx(-0.5)
    tbl = an.drawdown_table(s)
    assert tbl.iloc[0]["Depth %"] == pytest.approx(-50)
    assert str(tbl.iloc[0]["Recovered"]) == str(s.index[4].date())


def test_rolling_cagr_matches_steady_growth():
    rc = an.rolling_cagr(steady(0.12, 8), 3)
    assert rc.median() == pytest.approx(0.12, abs=2e-3)


def test_xirr_simple():
    cf = [(pd.Timestamp("2020-01-01"), -100), (pd.Timestamp("2021-01-01"), 110)]
    assert an.xirr(cf) == pytest.approx(0.10, abs=2e-3)


def test_sip_on_flat_market_returns_zero():
    idx = pd.bdate_range("2018-01-01", "2020-12-31")
    s = pd.Series(100.0, index=idx)
    ledger, st = an.sip_backtest(s, amount=1000)
    assert st["Instalments"] == 36
    assert st["Total invested"] == pytest.approx(36000)
    assert st["Final value"] == pytest.approx(36000)
    assert abs(st["SIP XIRR %"]) < 1e-4


def test_sip_step_up():
    idx = pd.bdate_range("2018-01-01", "2019-12-31")
    _, st = an.sip_backtest(pd.Series(50.0, index=idx), amount=1000, step_up_pct=10)
    assert st["Total invested"] == pytest.approx(12 * 1000 + 12 * 1100)


def test_resample_ohlc_rules():
    df = data._fetch_demo("^TEST", pd.Timestamp("2021-01-01"), pd.Timestamp("2021-12-31"))
    m = data.resample(df, "Monthly")
    jan = df.loc["2021-01"]
    row = m.iloc[0]
    assert row["Open"] == pytest.approx(jan["Open"].iloc[0])
    assert row["High"] == pytest.approx(jan["High"].max())
    assert row["Low"] == pytest.approx(jan["Low"].min())
    assert row["Close"] == pytest.approx(jan["Close"].iloc[-1])
    assert m.index[0] == jan.index[-1]  # labelled with last trading day
    assert len(m) == 12


def test_cache_incremental_and_backfill():
    df1 = data.get_data("^NSEI", "2015-01-01", None, source="demo")
    cached, info = data.load_cached("^NSEI", "demo")
    assert info["requested_start"] == "2015-01-01"
    df2 = data.get_data("^NSEI", "2010-01-01", None, source="demo")
    assert df2.index[0] < df1.index[0]
    _, info2 = data.load_cached("^NSEI", "demo")
    assert info2["requested_start"] == "2010-01-01"
    assert not df2.index.duplicated().any()
    inv = data.cache_inventory()
    assert (inv["Ticker"] == "^NSEI").any()


def test_excel_export_roundtrip():
    df = data.get_data("^NSEBANK", "2022-01-01", "2022-06-30", source="demo")
    b = data.to_excel_bytes({"NIFTY Bank": df, "Summary": pd.DataFrame({"x": [1.0]})})
    back = pd.read_excel(__import__("io").BytesIO(b), sheet_name=None, index_col=0)
    assert set(back) == {"NIFTY Bank", "Summary"}
    assert len(back["NIFTY Bank"]) == len(df)


def test_summary_metrics_keys():
    m = an.summary_metrics(data.get_data("^CNXIT", "2010-01-01", source="demo")["Close"])
    for k in ["CAGR %", "Sharpe", "Max drawdown %", "Daily VaR 95 %"]:
        assert np.isfinite(m[k])


def test_truncated_fetch_is_backfilled_later(counting_source):
    """A source that once returned just the last bar for a long range must not
    leave the cache thinking that range is covered."""
    last = pd.Timestamp.today().normalize() - pd.offsets.BDay(2)
    one_row = pd.DataFrame({"Open": [1.0], "High": [1.0], "Low": [1.0], "Close": [1.0]}, index=[last])
    data._save("^TRUNC", "counting", data._clean(one_row), {"requested_start": "2021-01-01"})
    cached, info = data.load_cached("^TRUNC", "counting")
    assert data._requested_start(cached, info) == last
    assert data.needs_fetch(cached, info, "2021-01-01")
    df = data.get_data("^TRUNC", "2021-01-01", source="counting")
    assert len(df) > 100 and df.index[0] <= pd.Timestamp("2021-01-05")
    assert counting_source[0][1] == pd.Timestamp("2021-01-01")  # it backfilled the missing history
    cached, info = data.load_cached("^TRUNC", "counting")
    assert not data.needs_fetch(cached, info, "2021-01-01")  # and now trusts the full range


def test_truncated_source_is_retried_once_a_day():
    """When the source really has only the latest bar, don't ask it again on every request."""
    calls = []
    last = pd.Timestamp.today().normalize() - pd.offsets.BDay(2)

    def fetch(ticker, start, end):
        calls.append((start, end))
        idx = [last] if start <= last <= end else []
        return data._clean(pd.DataFrame({"Open": 1.0, "High": 1.0, "Low": 1.0, "Close": 1.0}, index=pd.DatetimeIndex(idx)))

    data.register_source("stubby", fetch, offline=True)
    try:
        data.get_data("^ONE", "2021-01-01", source="stubby")   # first fetch: one row
        data.get_data("^ONE", "2021-01-01", source="stubby")   # backfill attempt: empty
        n = len(calls)
        data.get_data("^ONE", "2021-01-01", source="stubby")   # trusted until tomorrow
        assert len(calls) == n == 2
        _, info = data.load_cached("^ONE", "stubby")
        assert info["backfill_empty_on"] == __import__("datetime").date.today().isoformat()
    finally:
        data.unregister_source("stubby")
