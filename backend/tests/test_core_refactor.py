"""M1a core refactor: tunables as parameters, cache root, source registry,
staleness, locking, CSV import and catalogue merge."""
import threading

import numpy as np
import pandas as pd
import pytest

from indexvault import analytics as an
from indexvault import data
from indexvault.indices import CATALOG, has_volume, merge_catalog


def steady(rate=0.10, years=5, start="2015-01-01"):
    idx = pd.bdate_range(start, periods=int(252 * years))
    t = (idx - idx[0]).days / 365.25
    return pd.Series(100 * (1 + rate) ** t, index=idx)


def prices_from_returns(r: np.ndarray, start="2018-01-01") -> pd.Series:
    idx = pd.bdate_range(start, periods=len(r) + 1)
    return pd.Series(100 * np.cumprod(np.r_[1.0, 1 + r]), index=idx)


# --------------------------------------------------------------------------- #
# Analytics parameters
# --------------------------------------------------------------------------- #
def test_trading_days_scales_volatility():
    s = data.get_data("^NSEI", "2015-01-01", "2020-12-31", source="demo")["Close"]
    assert an.ann_vol(s, 365) / an.ann_vol(s, 252) == pytest.approx(np.sqrt(365 / 252))
    assert an.rolling_volatility(s, 21, 365).dropna().iloc[-1] == pytest.approx(
        an.rolling_volatility(s, 21).dropna().iloc[-1] * np.sqrt(365 / 252))


def test_summary_metrics_defaults_unchanged_and_params_apply():
    s = data.get_data("^NSEI", "2010-01-01", source="demo")["Close"]
    default = an.summary_metrics(s)
    explicit = an.summary_metrics(s, rf=0.065, trading_days=252)
    assert default.keys() == explicit.keys()
    assert all(default[k] == explicit[k] for k in default)
    assert an.summary_metrics(s, rf=0.0)["Sharpe"] > default["Sharpe"]


def test_trailing_returns_custom_periods():
    s = steady(0.10, 6)
    out = an.trailing_returns(s, ["6M", "2Y", "YTD", "10Y"])
    assert list(out) == ["6M", "2Y", "YTD", "10Y"]
    assert out["2Y"] == pytest.approx(10.0, abs=0.05)          # CAGR for > 1y
    assert out["6M"] == pytest.approx((1.1 ** 0.5 - 1) * 100, abs=0.1)
    assert np.isnan(out["10Y"])                                 # longer than history
    assert list(an.trailing_returns(s)) == list(an.DEFAULT_TRAILING_PERIODS)


@pytest.mark.parametrize("bad", ["0M", "2X", "M", "YTDX", "1y", ""])
def test_period_offset_rejects_bad_labels(bad):
    with pytest.raises(ValueError):
        an.period_offset(bad)


def test_rolling_summary_thresholds():
    s = steady(0.10, 8)
    default = an.rolling_summary(s, windows=(3,))
    assert {"% of periods > 10%", "% of periods > 15%"} <= set(default.columns)
    custom = an.rolling_summary(s, windows=(3,), thresholds=(0.05, 0.125))
    assert custom.loc["3Y", "% of periods > 5%"] == 100
    assert custom.loc["3Y", "% of periods > 12.5%"] == 0
    assert "% of periods > 10%" not in custom.columns


def test_data_quality_thresholds():
    idx = pd.bdate_range("2020-01-01", periods=50)
    close = pd.Series(100.0, index=idx)
    close.iloc[25:] = 106.0                                     # one +6% day
    df = pd.DataFrame({"Open": close, "High": close, "Low": close, "Close": close, "Volume": 0})
    assert an.data_quality(df)["Days with |move| > 8%"] == 0
    q = an.data_quality(df, big_move=0.05, gap_days=10)
    assert q["Days with |move| > 5%"] == 1
    assert "Gaps > 10 calendar days" in q


def test_beta_and_correlation_frequency():
    rng = np.random.default_rng(0)
    r = rng.normal(0, 0.01, 600)
    bench, asset = prices_from_returns(r), prices_from_returns(2 * r)
    assert an.beta(asset, bench, freq="D") == pytest.approx(2.0)
    assert an.beta(asset, bench, freq="W") == an.beta(asset, bench)          # "W" == default "W-FRI"
    wide = pd.concat({"a": asset, "b": bench}, axis=1)
    assert an.correlation(wide, "D").loc["a", "b"] == pytest.approx(1.0)
    assert an.correlation(wide, "M").shape == (2, 2)


def test_rolling_correlation_window_alias():
    s1 = data.get_data("^NSEI", "2015-01-01", source="demo")["Close"]
    s2 = data.get_data("^NSEBANK", "2015-01-01", source="demo")["Close"]
    pd.testing.assert_series_equal(an.rolling_correlation(s1, s2, window_weeks=26),
                                   an.rolling_correlation(s1, s2, window=26))
    assert len(an.rolling_correlation(s1, s2, 20, freq="D")) > len(an.rolling_correlation(s1, s2, 20))


# --------------------------------------------------------------------------- #
# Data layer
# --------------------------------------------------------------------------- #
def test_set_cache_root_redirects_cache(cache_root, tmp_path):
    data.get_data("^NSEI", "2020-01-01", "2020-12-31", source="demo")
    assert (cache_root / "demo" / "_NSEI.csv").exists()
    inv = data.cache_inventory()
    assert list(inv["Ticker"]) == ["^NSEI"]
    data.set_cache_root(tmp_path / "other")
    assert data.cache_inventory().empty


def test_unknown_source_raises(cache_root):
    with pytest.raises(KeyError, match="unknown source"):
        data.get_data("^NSEI", source="nope")


def test_register_source_rejects_bad_names():
    with pytest.raises(ValueError):
        data.register_source("_hidden", lambda t, s, e: pd.DataFrame())


def test_registered_source_is_cached(cache_root, counting_source):
    df = data.get_data("XYZ", "2024-01-01", source="counting")
    assert len(counting_source) == 1 and not df.empty
    assert (cache_root / "counting" / "XYZ.json").exists()
    assert {s.name for s in data.available_sources()} >= {"yahoo", "demo", "csv", "counting"}


def test_stale_after_hours_controls_refetch(cache_root, counting_source):
    data.get_data("XYZ", "2024-01-01", source="counting")
    data.get_data("XYZ", "2024-01-01", source="counting", stale_after_hours=24)
    assert len(counting_source) == 1                  # fresh: served from cache
    data.get_data("XYZ", "2024-01-01", source="counting", stale_after_hours=0)
    assert len(counting_source) == 2                  # stale: fetches newer rows


def test_concurrent_get_data_fetches_once(cache_root, counting_source):
    errors = []

    def worker():
        try:
            data.get_data("XYZ", "2024-01-01", source="counting")
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    assert len(counting_source) == 1
    cached, _ = data.load_cached("XYZ", "counting")
    assert not cached.index.duplicated().any()


CSV_TEXT = b"""Date,Open,High,Low,Close,Shares Traded
02-01-2024,"21,700.0","21,800.5","21,650.0","21,750.25",1000
03-01-2024,"21,750.0","21,900.0","21,700.0","21,880.00",1200
04-01-2024,"21,880.0","21,950.0","21,600.0","21,650.75",900
"""


def test_csv_import_parses_and_caches(cache_root):
    df = data.import_csv("MYIDX", CSV_TEXT, dayfirst=True)
    assert list(df.index.strftime("%Y-%m-%d")) == ["2024-01-02", "2024-01-03", "2024-01-04"]
    assert df["Close"].iloc[0] == pytest.approx(21750.25)
    assert df["Volume"].iloc[1] == 1200
    # clear_cache leaves the import, so the series can be rebuilt from it
    assert data.clear_cache(source="csv") == 2
    assert (cache_root / data.IMPORTS_DIR / "MYIDX.csv").exists()
    again = data.get_data("MYIDX", source="csv")
    assert len(again) == 3


def test_csv_import_price_only_and_errors(cache_root):
    df = data.parse_ohlcv_csv(b"when,Price\n2024-01-02,10\n2024-01-03,11\n")
    assert (df["Open"] == df["Close"]).all() and len(df) == 2
    with pytest.raises(ValueError, match="Close"):
        data.parse_ohlcv_csv(b"Date,Volume\n2024-01-02,10\n")
    with pytest.raises(FileNotFoundError):
        data.get_data("NEVER", source="csv")


# --------------------------------------------------------------------------- #
# Catalogue
# --------------------------------------------------------------------------- #
def test_merge_catalog():
    before = {k: dict(v) for k, v in CATALOG.items()}
    merged = merge_catalog([
        {"name": "My Momentum", "ticker": "MOM.NS", "category": "Factor"},
        {"name": "NIFTY IT", "ticker": "NIFTYIT.NS", "category": "Sectoral"},
    ])
    assert list(merged)[: len(CATALOG)] == list(CATALOG)
    assert list(merged)[-1] == "Factor"
    assert merged["Sectoral"]["NIFTY IT"] == "NIFTYIT.NS"
    assert CATALOG == before                                    # built-ins not mutated


def test_has_volume():
    assert not has_volume("^NSEI") and not has_volume("^ANYTHING") and not has_volume("INR=X")
    assert has_volume("NIFTYBEES.NS")
