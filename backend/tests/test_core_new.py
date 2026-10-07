"""M1a new core functions: log returns, EMA, RSI, SIP top-ups and start-date sensitivity."""
import numpy as np
import pandas as pd
import pytest

from indexvault import analytics as an


def series(values, start="2021-01-01"):
    return pd.Series(values, index=pd.bdate_range(start, periods=len(values)), dtype=float)


def steady(rate=0.10, start="2015-01-01", end="2020-12-31"):
    idx = pd.bdate_range(start, end)
    t = (idx - idx[0]).days / 365.25
    return pd.Series(100 * (1 + rate) ** t, index=idx)


def test_log_returns():
    lr = an.log_returns(series([100, 110, 99]))
    assert lr.iloc[0] == pytest.approx(np.log(1.1))
    assert lr.sum() == pytest.approx(np.log(0.99))


def test_ema_matches_recursion():
    ema = an.exponential_moving_averages(series([1, 2, 3, 4, 5]), windows=(3,))["EMA 3"]
    assert ema.iloc[:2].isna().all()                           # needs `window` rows
    assert ema.iloc[2:].tolist() == pytest.approx([2.25, 3.125, 4.0625])  # alpha = 2/(3+1)


def test_rsi_matches_stockcharts_reference():
    # Worked example from StockCharts' "Relative Strength Index" ChartSchool
    # spreadsheet (full-precision closes; the article's table rounds them).
    closes = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245,
              45.8433, 46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028,
              46.0328, 46.4116, 46.2222]
    r = an.rsi(series(closes), 14)
    assert r.iloc[:14].isna().all()
    assert r.iloc[14:].tolist() == pytest.approx([70.53, 66.32, 66.55, 69.41, 66.36], abs=0.01)


def test_rsi_extremes_and_neutral():
    assert an.rsi(series(range(1, 40)), 14).dropna().eq(100).all()
    assert an.rsi(series([50.0] * 30), 14).dropna().eq(50).all()
    zigzag = an.rsi(series([100 + (i % 2) for i in range(60)]), 14).dropna()
    assert zigzag.between(40, 60).all()
    assert an.rsi(series(range(30)), 7).name == "RSI 7"


def test_sip_top_ups():
    flat = pd.Series(100.0, index=pd.bdate_range("2018-01-01", "2020-12-31"))
    ledger, st = an.sip_backtest(flat, amount=1000,
                                 top_ups=[("2019-06-15", 5000), ("2030-01-01", 999)])
    assert st["Instalments"] == 36 and st["Top-ups"] == 1        # 2030 is out of range
    assert st["Total invested"] == pytest.approx(41_000)
    jump = ledger["Invested"].diff()
    assert jump.loc["2019-06-17"] == pytest.approx(5000)          # Saturday -> Monday
    assert abs(st["SIP XIRR %"]) < 1e-4


def test_sip_without_top_ups_unchanged():
    s = steady()
    _, a = an.sip_backtest(s, amount=1000, day_of_month=5)
    _, b = an.sip_backtest(s, amount=1000, day_of_month=5, top_ups=[])
    assert a == b and a["Top-ups"] == 0


def test_sip_start_sensitivity_steady_market():
    s = steady(0.10)
    sens = an.sip_start_sensitivity(s, amount=1000, day_of_month=1, min_months=12)
    assert sens.index.name == "Start"
    assert list(sens.columns) == ["Months", "Invested", "Final value", "XIRR"]
    assert sens["Months"].iloc[0] == 72 and sens["Months"].iloc[-1] == 12
    assert len(sens) == 72 - 12 + 1
    assert sens["XIRR"].to_numpy() == pytest.approx(0.10, abs=2e-3)  # decimal, not %
    first_full = an.sip_backtest(s, amount=1000, day_of_month=1)[1]
    assert sens["XIRR"].iloc[0] == pytest.approx(first_full["SIP XIRR %"] / 100, abs=1e-9)


def test_sip_start_sensitivity_step_up_counts_from_each_start():
    flat = pd.Series(100.0, index=pd.bdate_range("2018-01-01", "2020-12-31"))
    sens = an.sip_start_sensitivity(flat, amount=1000, step_up_pct=10, min_months=24)
    assert sens["Invested"].iloc[0] == pytest.approx(12 * 1000 + 12 * 1100 + 12 * 1210)
    assert sens["Invested"].iloc[-1] == pytest.approx(12 * 1000 + 12 * 1100)
    assert sens["XIRR"].abs().max() < 1e-6


def test_sip_start_sensitivity_short_history():
    out = an.sip_start_sensitivity(series([100.0] * 10))
    assert out.empty and list(out.columns) == ["Months", "Invested", "Final value", "XIRR"]
