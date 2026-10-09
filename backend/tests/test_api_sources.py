"""Per-ticker sources (Yahoo / NSE / CSV overrides), TRI series, short-history flags,
common end dates, close-only series and the cache update plan. The NSE source is
replaced by an offline fake; nothing touches the network."""
import pandas as pd
import pytest

from indexvault import data, nse


def fake_nse(ticker, start, end):
    """Demo-shaped data; TRI tickers come back close-only with an NTR column."""
    df = data._fetch_demo(ticker, start, end)
    if ticker.endswith("-TRI"):
        df = df.assign(Open=df["Close"], High=df["Close"], Low=df["Close"], NTR=df["Close"] * 0.95)
    return df


@pytest.fixture
def live(client, monkeypatch):
    """Global source Yahoo (so per-ticker defaults apply) with a fake NSE source."""
    monkeypatch.setitem(data.SOURCES, "nse", fake_nse)
    assert client.patch("/api/settings/data", json={"source": "yahoo"}).status_code == 200
    return client


def csv_bytes(start, periods, close_only=False):
    days = pd.bdate_range(start, periods=periods)
    rows = [f"{d.date()},{100 + i}" if close_only else f"{d.date()},{100 + i},{102 + i},{99 + i},{101 + i}"
            for i, d in enumerate(days)]
    head = "Date,Close" if close_only else "Date,Open,High,Low,Close"
    return ("\n".join([head, *rows]) + "\n").encode()


def import_csv(client, ticker, body):
    r = client.post("/api/import/csv", params={"ticker": ticker}, content=body, headers={"Content-Type": "text/csv"})
    assert r.status_code == 201, r.text
    return r.json()


def items(client):
    return {i["ticker"]: i for c in client.get("/api/catalog").json()["categories"] for i in c["items"]}


def test_catalog_reports_configured_and_used_sources(live):
    cat = items(live)
    assert cat["^CNXAUTO"]["source"] == "nse" and cat["^CNXAUTO"]["used_source"] == "nse"
    assert cat["^NSEI"]["used_source"] == "yahoo" and cat["^NSEI"]["kind"] == "price"
    tri = cat["^NSEI-TRI"]
    assert tri["name"] == "NIFTY 50 TRI" and tri["kind"] == "tri" and tri["used_source"] == "nse"


def test_series_comes_from_each_tickers_own_source(live):
    meta = live.get("/api/series/%5ECNXAUTO", params={"period": "1Y"}).json()["meta"]
    assert meta["source_label"] == "NSE (niftyindices.com)" and meta["kind"] == "price" and meta["ohlc"] is True
    assert any("personal research use only" in c for c in meta["caveats"])
    assert any(c.startswith("Price index") for c in meta["caveats"])
    explicit = live.get("/api/series/%5ECNXAUTO", params={"period": "1Y", "source": "demo"}).json()["meta"]
    assert explicit["source_label"] == "Demo (synthetic)"                      # an explicit ?source= wins
    live.patch("/api/settings/data", json={"source": "demo"})
    assert items(live)["^CNXAUTO"]["used_source"] == "demo"                    # Demo mode keeps everything offline


def test_csv_override(live):
    r = live.put("/api/catalog/overrides/%5ECNXAUTO", json={"source": "csv"})
    assert r.status_code == 400 and "No CSV" in r.json()["error"]["message"]
    import_csv(live, "^CNXAUTO", csv_bytes("2025-06-02", 100))
    assert live.put("/api/catalog/overrides/%5ECNXAUTO", json={"source": "csv"}).json() == {"^CNXAUTO": "csv"}
    meta = live.get("/api/series/%5ECNXAUTO", params={"period": "Max"}).json()["meta"]
    assert meta["source_label"] == "CSV import"
    item = items(live)["^CNXAUTO"]
    assert item["used_source"] == "csv" and item["history"]["short"] is True and item["history"]["days"] < 365
    live.patch("/api/settings/data", json={"short_history_days": 60})
    assert items(live)["^CNXAUTO"]["history"]["short"] is False                # threshold comes from settings
    assert live.delete("/api/catalog/overrides/%5ECNXAUTO").status_code == 204
    assert items(live)["^CNXAUTO"]["used_source"] == "nse"
    assert live.delete("/api/catalog/overrides/%5ECNXAUTO").status_code == 404


def test_nse_failure_offers_csv_import(live, monkeypatch):
    def broken(*_a, **_k):
        raise nse.SourceUnavailable("HTTP 404")

    monkeypatch.setitem(data.SOURCES, "nse", broken)
    r = live.get("/api/series/%5ECNXMEDIA", params={"period": "1Y"})
    assert r.status_code == 502
    err = r.json()["error"]
    assert err["detail"]["fallback"] == "csv_import" and "Cache page" in err["message"]


def test_tri_series_close_only_with_ntr(live):
    body = live.get("/api/series/%5ENSEI-TRI", params={"period": "1Y"}).json()
    assert body["columns"] == ["date", "close", "ntr", "return"]                # TRI default columns
    assert body["meta"]["kind"] == "tri" and body["meta"]["ohlc"] is False
    assert any(c.startswith("Total return index") for c in body["meta"]["caveats"])
    assert any(c.startswith("Close only") for c in body["meta"]["caveats"])
    q = live.get("/api/analytics/quality", params={"tickers": "^NSEI-TRI", "period": "1Y"}).json()["series"]["^NSEI-TRI"]
    assert q["close_only"] is True and q["ohlc_inconsistencies"] is None
    assert "OHLC" not in " ".join(q["issues"])


def test_tri_export_always_has_ntr(live):
    r = live.post("/api/export", json={"tickers": ["^NSEI-TRI"], "period": "1Y", "columns": ["close"], "format": "json"})
    assert r.status_code == 200, r.text
    series = r.json()["series"]["^NSEI-TRI"]
    assert "ntr" in series["columns"] and series["source"] == "nse"


def test_common_end_date_for_several_series(client):
    import_csv(client, "AAA", csv_bytes("2024-01-01", 120))
    import_csv(client, "BBB", csv_bytes("2024-01-01", 118))                    # two trading days shorter
    last_b = pd.bdate_range("2024-01-01", periods=118)[-1]
    t = client.get("/api/analytics/trailing", params={"tickers": "AAA,BBB", "source": "csv", "periods": "1M",
                                                         "end": "2024-12-31"}).json()
    assert t["end"] == str(last_b.date()) and t["common_end"] is True
    c = client.get("/api/analytics/compare", params={"tickers": "AAA,BBB", "source": "csv",
                                                        "start": "2024-01-01", "end": "2024-12-31"}).json()
    assert c["end"] == str(last_b.date()) and c["rebased"]["dates"][-1] == str(last_b.date())
    one = client.get("/api/analytics/trailing", params={"tickers": "AAA", "source": "csv", "periods": "1M",
                                                           "end": "2024-12-31"}).json()
    assert one["common_end"] is False and one["end"] > t["end"]


def test_close_only_csv(client):
    import_csv(client, "CLOSEONLY", csv_bytes("2024-01-01", 60, close_only=True))
    meta = client.get("/api/series/CLOSEONLY", params={"source": "csv", "period": "Max"}).json()["meta"]
    assert meta["ohlc"] is False


def test_update_all_skips_files_left_over_from_another_source(live):
    stale = pd.DataFrame({"Open": [1.0], "High": [1.0], "Low": [1.0], "Close": [1.0]},
                         index=pd.DatetimeIndex([pd.Timestamp.today().normalize()]))
    data._save("^CNXAUTO", "yahoo", data._clean(stale), {"requested_start": "2015-01-01"})   # what Yahoo left us
    live.get("/api/series/%5ECNXAUTO", params={"period": "1Y"})                               # the NSE file
    entries = {(e["ticker"], e["source"]): e for e in live.get("/api/cache").json()["entries"]}
    assert entries[("^CNXAUTO", "yahoo")]["in_use"] is False and entries[("^CNXAUTO", "yahoo")]["used_source"] == "nse"
    assert entries[("^CNXAUTO", "nse")]["in_use"] is True
    job = live.post("/api/cache/update", json={"source": "nse"}).json()
    assert [i["ticker"] for i in job["items"]] == ["^CNXAUTO"]
    assert live.post("/api/cache/update", json={"source": "yahoo"}).status_code == 400   # only a left-over file


def test_new_settings(client):
    d = client.get("/api/settings").json()["data"]
    assert d["nse_request_gap_seconds"] == 1.0 and d["short_history_days"] == 365
    assert client.patch("/api/settings/data", json={"nse_request_gap_seconds": 0.1}).status_code == 422
    assert client.patch("/api/settings/data", json={"short_history_days": 10}).status_code == 422
    assert nse._request_gap == 1.0                                                # applied to the source
    client.patch("/api/settings/data", json={"nse_request_gap_seconds": 2.5})
    assert nse._request_gap == 2.5


def test_short_flag_only_when_the_source_has_no_more(live):
    live.get("/api/series/%5ECNXAUTO", params={"period": "3M"})                 # loaded for 3 months only
    hist = items(live)["^CNXAUTO"]["history"]
    assert hist["days"] < 365 and hist["short"] is False                        # NSE could give more: not "short"
    stale = pd.DataFrame({"Open": [1.0], "High": [1.0], "Low": [1.0], "Close": [1.0]},
                         index=pd.DatetimeIndex([pd.Timestamp.today().normalize()]))
    data._save("^CNXMEDIA", "yahoo", data._clean(stale), {"requested_start": "2015-01-01"})
    assert live.put("/api/catalog/overrides/%5ECNXMEDIA", json={"source": "yahoo"}).status_code == 200
    assert items(live)["^CNXMEDIA"]["history"]["short"] is True                  # asked for 2015, got one day


def test_period_cagr_matches_trailing(client):
    s = client.get("/api/analytics/summary", params={"tickers": "^NSEI", "period": "10Y"}).json()
    t = client.get("/api/analytics/trailing", params={"tickers": "^NSEI", "periods": "10Y"}).json()
    assert round(s["series"]["^NSEI"]["metrics"]["cagr"], 10) == round(t["series"]["^NSEI"]["10Y"], 10)
