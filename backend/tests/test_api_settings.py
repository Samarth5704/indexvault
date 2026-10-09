"""API: health, settings, catalogue, backup/restore, error envelope, static frontend."""
import pytest

from conftest import assert_api_conventions


def error_code(r):
    body = r.json()
    assert set(body) == {"error"} and set(body["error"]) == {"code", "message", "detail"}
    return body["error"]["code"]


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    h = r.json()
    assert h["status"] == "ok" and h["source"] == "demo"
    assert {s["name"] for s in h["sources"]} >= {"yahoo", "demo", "csv"}
    assert h["warnings"] == [] and h["jobs_running"] is False


def test_health_source_check(client):
    h = client.get("/api/health?check=true").json()
    assert h["source_check"]["ok"] is True


def test_frontend_served_at_root(client):
    r = client.get("/")
    assert r.status_code == 200 and "IndexVault" in r.text
    js = client.get("/js/app.js")
    assert js.headers["content-type"].startswith("text/javascript")
    assert js.headers["cache-control"] == "no-cache"          # edited modules never go stale
    assert client.get("/js/app.js", headers={"If-None-Match": js.headers["etag"]}).status_code == 304


def test_unknown_route_uses_error_envelope(client):
    r = client.get("/api/nope")
    assert r.status_code == 404 and error_code(r) == "not_found"


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #
def test_get_settings(client):
    s = client.get("/api/settings").json()
    assert s["schema_version"] == 1 and s["data"]["source"] == "demo"
    assert s["analytics"]["kpi_cards"][1] == "cagr"
    assert_api_conventions(s)


def test_patch_section_merges_and_persists(client):
    r = client.patch("/api/settings/analytics", json={"risk_free_rate": 0.07})
    assert r.status_code == 200 and r.json()["analytics"]["risk_free_rate"] == 0.07
    s = client.get("/api/settings").json()
    assert s["analytics"]["risk_free_rate"] == 0.07 and s["analytics"]["trading_days"] == 252


@pytest.mark.parametrize("section,body", [
    ("analytics", {"risk_free_rate": 6.5}),
    ("appearance", {"theme": "nope"}),
    ("formats", {"bogus": 1}),
])
def test_patch_invalid_is_422(client, section, body):
    r = client.patch(f"/api/settings/{section}", json=body)
    assert r.status_code == 422 and error_code(r) == "validation_error"
    detail = r.json()["error"]["detail"][0]
    assert detail["loc"] or section in detail["msg"]  # cross-field errors name the field in msg


def test_patch_unknown_section_and_non_object(client):
    assert client.patch("/api/settings/nope", json={}).status_code == 404
    r = client.patch("/api/settings/sip", json=[1, 2])
    assert r.status_code == 400 and error_code(r) == "bad_request"


def test_put_and_reset(client):
    s = client.get("/api/settings").json()
    s["formats"]["decimals"] = 4
    s["sip"]["amount"] = 2500
    assert client.put("/api/settings", json=s).json()["formats"]["decimals"] == 4
    after = client.post("/api/settings/reset?section=formats").json()
    assert after["formats"]["decimals"] == 2 and after["sip"]["amount"] == 2500
    assert client.post("/api/settings/reset?section=bogus").status_code == 404
    assert client.post("/api/settings/reset").json()["sip"]["amount"] == 10_000


def test_settings_schema(client):
    schema = client.get("/api/settings/schema").json()
    assert "Analytics" in schema["$defs"]
    assert schema["$defs"]["Sip"]["properties"]["step_up"]["description"]


def test_settings_schema_ui_hints(client):
    defs = client.get("/api/settings/schema").json()["$defs"]
    assert defs["Analytics"]["properties"]["risk_free_rate"]["x-unit"] == "pct"
    assert defs["Sip"]["properties"]["step_up"]["x-unit"] == "pct"
    kpi = defs["Analytics"]["properties"]["kpi_cards"]
    assert kpi["x-ordered"] is True
    assert {"value": "cagr", "label": "CAGR"} in kpi["x-options"]
    assert {o["value"] for o in defs["Analytics"]["properties"]["trailing_periods"]["x-options"]} >= {"1M", "YTD", "10Y"}
    assert defs["Export"]["properties"]["excel_header_colour"]["format"] == "color"


def test_cache_dir_change_blocked_while_job_runs(client, monkeypatch):
    monkeypatch.setattr(client.app.state.ctx.jobs, "is_busy", lambda: True)
    r = client.patch("/api/settings/data", json={"cache_dir": "elsewhere"})
    assert r.status_code == 409 and error_code(r) == "conflict"
    assert client.patch("/api/settings/data", json={"stale_after_hours": 1}).status_code == 200


def test_cache_dir_change_moves_cache_root(client, tmp_path):
    from indexvault import data
    client.patch("/api/settings/data", json={"cache_dir": str(tmp_path / "moved")})
    assert data.get_cache_root() == (tmp_path / "moved").resolve()


# --------------------------------------------------------------------------- #
# Catalogue
# --------------------------------------------------------------------------- #
def test_catalog_crud(client):
    r = client.post("/api/catalog/indices/mom30", json={"name": "Momentum 30", "ticker": "MOM30.NS", "category": "Factor"})
    assert r.status_code == 201
    assert client.post("/api/catalog/indices/mom30", json={"name": "x", "ticker": "X"}).status_code == 409
    assert client.put("/api/catalog/indices/mom30", json={"name": "Momentum 30 v2", "ticker": "MOM30.NS",
                                                          "category": "Factor"}).status_code == 200
    cats = {c["name"]: c["items"] for c in client.get("/api/catalog").json()["categories"]}
    assert cats["Factor"] == [{"name": "Momentum 30 v2", "ticker": "MOM30.NS", "source": "yahoo",
                               "custom": True, "id": "mom30", "used_source": "demo",  # tests run in Demo mode
                               "kind": "price", "history": None}]
    assert client.delete("/api/catalog/indices/mom30").status_code == 204
    assert client.delete("/api/catalog/indices/mom30").status_code == 404
    assert client.post("/api/catalog/indices/Bad%20Id", json={"name": "x", "ticker": "X"}).status_code == 422


def test_watchlists_and_order(client):
    client.post("/api/catalog/watchlists/sectors", json={"name": "Sectors", "tickers": ["^NSEBANK", "^CNXIT"]})
    client.post("/api/catalog/watchlists/core", json={"name": "Core", "tickers": ["^NSEI"]})
    r = client.put("/api/catalog/watchlists/order", json={"ids": ["core", "sectors"]})
    assert [w["id"] for w in r.json()] == ["core", "sectors"]
    assert client.put("/api/catalog/watchlists/order", json={"ids": ["core"]}).status_code == 400
    assert [w["id"] for w in client.get("/api/catalog").json()["watchlists"]] == ["core", "sectors"]
    assert client.delete("/api/catalog/watchlists/core").status_code == 204


# --------------------------------------------------------------------------- #
# Backup / restore
# --------------------------------------------------------------------------- #
def test_backup_restore_round_trip(client):
    client.patch("/api/settings/sip", json={"amount": 7777})
    client.post("/api/catalog/watchlists/core", json={"name": "Core", "tickers": ["^NSEI"]})
    r = client.get("/api/settings/backup")
    assert "attachment" in r.headers["content-disposition"]
    backup = r.json()
    assert backup["kind"] == "indexvault-backup" and backup["settings"]["sip"]["amount"] == 7777

    client.post("/api/settings/reset")
    client.delete("/api/catalog/watchlists/core")
    restored = client.post("/api/settings/restore", json=backup).json()
    assert restored["settings"]["sip"]["amount"] == 7777
    assert [w["id"] for w in restored["catalog"]["watchlists"]] == ["core"]


def test_restore_migrates_old_settings_and_rejects_junk(client):
    old = {"kind": "indexvault-backup", "version": 1,
           "settings": {"data": {"source": "demo"}, "sip": {"step_up_pct": 10},
                        "analytics": {"kpi_cards": ["CAGR %", "Sharpe"]}},
           "catalog": {}}
    s = client.post("/api/settings/restore", json=old).json()["settings"]
    assert s["sip"]["step_up"] == pytest.approx(0.10) and s["analytics"]["kpi_cards"] == ["cagr", "sharpe"]
    assert client.post("/api/settings/restore", json={"kind": "other"}).status_code == 400
    bad = {**old, "settings": {"schema_version": 99}}
    assert client.post("/api/settings/restore", json=bad).status_code == 400
    bad_values = {**old, "settings": {"schema_version": 1, "formats": {"decimals": 99}}}
    assert client.post("/api/settings/restore", json=bad_values).status_code == 422
    assert client.get("/api/settings").json()["sip"]["step_up"] == pytest.approx(0.10)  # unchanged by failures


def test_dashboard_layout_validation(client):
    good = [{"id": "a", "widget": "snapshot", "x": 0, "y": 0, "w": 3, "h": 2, "config": {"ticker": "^NSEI"}},
            {"id": "b", "widget": "notes", "x": 9, "y": 0, "w": 3, "h": 3, "config": {"text": "# Hi"}}]
    r = client.patch("/api/settings/dashboard", json={"layout": good})
    assert r.status_code == 200 and [w["id"] for w in r.json()["dashboard"]["layout"]] == ["a", "b"]
    too_wide = [{**good[0], "x": 10, "w": 3}]
    assert client.patch("/api/settings/dashboard", json={"layout": too_wide}).status_code == 422
    dupes = [good[0], {**good[1], "id": "a"}]
    assert client.patch("/api/settings/dashboard", json={"layout": dupes}).status_code == 422
    huge = [{**good[1], "config": {"text": "x" * 25_000}}]
    assert client.patch("/api/settings/dashboard", json={"layout": huge}).status_code == 422
    assert client.post("/api/settings/reset", params={"section": "dashboard"}).json()["dashboard"]["layout"] == []
