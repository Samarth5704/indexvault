"""The niftyindices.com source: parsing, chunking, politeness, failures, and how the
cache records a series' earliest available date. No network: `_post` or the
session is replaced in every test."""
import json

import pandas as pd
import pytest

from indexvault import data, nse

TODAY = pd.Timestamp.today().normalize()


def price_rows(dates, base=100.0):
    return [{"HistoricalDate": d.strftime("%d %b %Y"), "OPEN": f"{base + i:.2f}", "HIGH": f"{base + i + 2:,.2f}",
             "LOW": f"{base + i - 2:.2f}", "CLOSE": f"{base + i + 1:.2f}", "INDEX_NAME": "Nifty Auto"}
            for i, d in enumerate(reversed(list(dates)))]  # the site sends newest first


def tri_rows(dates):
    return [{"Date": d.strftime("%d %b %Y"), "TotalReturnsIndex": f"{1000 + i}", "NTR_Value": f"{900 + i}"}
            for i, d in enumerate(dates)]


@pytest.fixture
def fake_site(monkeypatch):
    """An index with daily data from `first` onwards; records every request."""
    calls = []
    state = {"first": pd.Timestamp("2018-03-01")}

    def post(path, name, long_name, start, end):
        calls.append((path, name, start, end))
        days = pd.bdate_range(max(start, state["first"]), end)
        return tri_rows(days) if path == nse.TRI_PATH else price_rows(days)

    monkeypatch.setattr(nse, "_post", post)
    return calls, state


def test_parse_price_and_tri():
    days = pd.bdate_range("2026-09-01", periods=3)
    p = nse.parse_price(price_rows(days))
    assert list(p.index) == list(days) and p.index.is_monotonic_increasing
    assert {"Open", "High", "Low", "Close"} <= set(p.columns) and (p["High"] > p["Low"]).all()  # "1,234.00" parsed
    t = nse.parse_tri(tri_rows(days))
    assert (t["Open"] == t["Close"]).all() and (t["High"] == t["Close"]).all()  # close-only
    assert list(t["NTR"]) == [900.0, 901.0, 902.0]


def test_decode_handles_wrapped_json_and_bom():
    rows = [{"Date": "01 Sep 2026", "TotalReturnsIndex": "1"}]
    wrapped = ("﻿" + json.dumps({"d": json.dumps(rows)})).encode("utf-8")
    assert nse._decode(wrapped) == rows
    assert nse._decode(json.dumps(rows).encode()) == rows
    with pytest.raises(nse.SourceUnavailable, match="CSV"):
        nse._decode(b"<!DOCTYPE html><html>")  # the old endpoints now answer with a web page


def test_names_and_unknown_tickers():
    assert nse.index_names("^CNXSC") == ("NIFTY SMLCAP 100", "Nifty Smallcap 100")
    assert nse.index_names("^CNXSC-TRI") == nse.index_names("^CNXSC")
    with pytest.raises(nse.SourceUnavailable, match="no niftyindices.com index"):
        nse.index_names("^GSPC")


def test_fetch_walks_back_in_yearly_chunks_and_stops_at_first_empty_year(fake_site):
    calls, state = fake_site
    df = nse.fetch_nse("^CNXAUTO", pd.Timestamp("2010-01-01"), TODAY)
    assert df.index[0] == state["first"] and df.index[-1] <= TODAY
    spans = [(s, e) for _, _, s, e in calls]
    assert all((e - s).days < nse.CHUNK_DAYS for s, e in spans)                     # never over a year
    assert all(spans[i + 1][1] < spans[i][0] for i in range(len(spans) - 1))         # newest first, no overlap
    assert spans[-1][1] < state["first"]                                              # the last call was empty…
    assert spans[-1][0] > pd.Timestamp("2010-01-01")                                  # …and the walk stopped there
    assert df.attrs["no_data_before"] == str(spans[-1][1].date())


def test_tri_ticker_uses_tri_endpoint(fake_site):
    calls, _ = fake_site
    df = nse.fetch_nse("^NSEI-TRI", TODAY - pd.Timedelta(days=30), TODAY)
    assert calls[0][0] == nse.TRI_PATH and calls[0][1] == "Nifty 50"
    assert "NTR" in df.columns


class FakeResponse:
    def __init__(self, status, payload=None):
        self.status_code = status
        self.content = json.dumps({"d": json.dumps(payload or [])}).encode()


def test_post_is_rate_limited_and_retries(monkeypatch):
    sleeps, answers = [], [FakeResponse(503), FakeResponse(200, [{"Date": "01 Sep 2026"}])]

    class Session:
        def post(self, *_a, **_k):
            return answers.pop(0)

    monkeypatch.setattr(nse, "_get_session", lambda: Session())
    monkeypatch.setattr(nse.time, "sleep", sleeps.append)
    monkeypatch.setattr(nse, "_last_call", nse.time.monotonic())  # a request "just happened"
    nse.set_request_gap(1.5)
    rows = nse._post(nse.TRI_PATH, "Nifty 50", "Nifty 50", TODAY, TODAY)
    assert rows == [{"Date": "01 Sep 2026"}]
    assert sleeps and sleeps[0] > 1.0      # waited for the gap before the first request
    assert 2 in sleeps                     # backoff after the 503


def test_post_gives_up_with_a_csv_hint(monkeypatch):
    class Session:
        def post(self, *_a, **_k):
            return FakeResponse(404)

    monkeypatch.setattr(nse, "_get_session", lambda: Session())
    monkeypatch.setattr(nse.time, "sleep", lambda s: None)
    with pytest.raises(nse.SourceUnavailable) as e:
        nse._post(nse.PRICE_PATH, "Nifty Auto", "Nifty Auto", TODAY, TODAY)
    assert e.value.reason == "HTTP 404" and "import it on the Cache page" in str(e.value)
    assert e.value.fallback == "csv_import"


def test_cache_records_earliest_date_and_never_rerequests_empty_years(cache_root, fake_site):
    calls, state = fake_site
    data.get_data("^CNXAUTO", start="2016-01-01", source="nse")   # asks from before the index existed (2018)
    _, info = data.load_cached("^CNXAUTO", "nse")
    assert info["earliest_available"] == str(state["first"].date())
    n = len(calls)
    df = data.get_data("^CNXAUTO", source="nse")                   # "Max": nothing older to ask for
    assert len(calls) == n and df.index[0] == state["first"]


def test_backfill_records_earliest_when_first_load_was_recent(cache_root, fake_site):
    calls, state = fake_site
    data.get_data("^CNXAUTO", start=str((TODAY - pd.Timedelta(days=200)).date()), source="nse")
    _, info = data.load_cached("^CNXAUTO", "nse")
    assert "earliest_available" not in info                         # stopped at the requested start, not an empty year
    data.get_data("^CNXAUTO", source="nse")                         # Max: walk back from the cached start
    _, info = data.load_cached("^CNXAUTO", "nse")
    assert info["earliest_available"] == str(state["first"].date())
    n = len(calls)
    data.get_data("^CNXAUTO", start="1995-01-01", source="nse")
    assert len(calls) == n                                          # empty years are never asked for again
    span = data.cache_span("^CNXAUTO", "nse")
    assert span["first_date"] == str(state["first"].date()) and span["rows"] > 1000


def test_resample_keeps_ntr():
    days = pd.bdate_range("2026-01-01", "2026-03-31")
    df = nse.parse_tri(tri_rows(days))
    m = data.resample(df, "Monthly")
    assert "NTR" in m.columns and m["NTR"].iloc[-1] == df["NTR"].iloc[-1]


def test_niftyindices_csv_downloads_parse():
    price = b"Date,Open,High,Low,Close,Shares Traded,Turnover (\xe2\x82\xb9 Cr)\n" \
            b"01 Jan 2020,\"11,443.20\",\"11,552.40\",\"11,428.05\",\"11,512.40\",1000,12.5\n" \
            b"02 Jan 2020,\"11,526.70\",\"11,600.20\",\"11,522.40\",\"11,598.70\",900,11.1\n"
    p = data.parse_ohlcv_csv(price, dayfirst=True)
    assert list(p.index) == [pd.Timestamp("2020-01-01"), pd.Timestamp("2020-01-02")] and p["Close"].iloc[0] == 11512.40
    tri = b"Date,Total Returns Index,Net Total Returns Index\n01 Jan 2020,16000.5,15000.1\n02 Jan 2020,16100,15090\n"
    t = data.parse_ohlcv_csv(tri, dayfirst=True)
    assert t["Close"].iloc[1] == 16100 and t["NTR"].iloc[0] == 15000.1 and (t["Open"] == t["Close"]).all()


def test_iso_dates_are_never_day_swapped():
    csv = b"Date,Close\n2026-04-09,100\n2026-04-10,101\n2026-05-01,102\n"
    for dayfirst in (True, False):
        df = data.parse_ohlcv_csv(csv, dayfirst=dayfirst)
        assert list(df.index) == [pd.Timestamp("2026-04-09"), pd.Timestamp("2026-04-10"), pd.Timestamp("2026-05-01")]
    dmy = data.parse_ohlcv_csv(b"Date,Close\n01-02-2026,1\n03-02-2026,2\n", dayfirst=True)
    assert dmy.index[0] == pd.Timestamp("2026-02-01")                            # 1 Feb, as the user said
