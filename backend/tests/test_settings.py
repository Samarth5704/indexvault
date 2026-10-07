"""Settings model (defaults, validation, migration) and SettingsStore persistence."""
import json

import pytest
from pydantic import ValidationError

from api.settings import SCHEMA_VERSION, SECTIONS, Settings
from api.settings_store import MigrationError, SettingsStore, migrate, parse_settings
from api.storage import PROJECT_ROOT, resolve_path


@pytest.fixture
def store(tmp_path):
    return SettingsStore(tmp_path / "settings.json")


def files(tmp_path):
    return sorted(p.name for p in tmp_path.iterdir())


# --------------------------------------------------------------------------- #
# Defaults
# --------------------------------------------------------------------------- #
def test_defaults_match_spec():
    s = Settings()
    assert s.schema_version == SCHEMA_VERSION == 1
    assert s.appearance.theme == "midnight" and s.appearance.mode == "system"
    assert s.formats.number_system == "indian" and s.formats.currency == "₹"
    assert s.data.default_series == ["^NSEI", "^NSEBANK"] and s.data.stale_after_hours == 3
    a = s.analytics
    assert (a.risk_free_rate, a.trading_days, a.sma_windows) == (0.065, 252, [50, 200])
    assert a.correlation_frequency == "W" and a.target_cagr == 0.12
    assert a.kpi_cards[:2] == ["end_level", "cagr"]
    assert (s.sip.amount, s.sip.day, s.sip.step_up) == (10_000, 5, 0.0)
    assert s.shortcuts["palette"] == "mod+k"


def test_no_percent_signs_in_keys():
    def keys(d):
        if isinstance(d, dict):
            for k, v in d.items():
                yield k
                yield from keys(v)
        elif isinstance(d, list):
            for v in d:
                yield from keys(v)
    dumped = Settings().model_dump(mode="json")
    assert not [k for k in keys(dumped) if "%" in k]
    assert not [m for m in dumped["analytics"]["kpi_cards"] + dumped["analytics"]["compare_metrics"] if "%" in m]


def test_schema_has_descriptions_for_the_settings_ui():
    schema = Settings.model_json_schema()
    analytics = schema["$defs"]["Analytics"]["properties"]
    assert all("description" in p for p in analytics.values())
    assert analytics["risk_free_rate"]["maximum"] == 0.5


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("patch", [
    {"appearance": {"font_scale": 2}},
    {"appearance": {"accent": "red"}},
    {"appearance": {"theme": "nope"}},
    {"appearance": {"chart_palette": "nope"}},
    {"appearance": {"unknown_field": 1}},
    {"formats": {"decimals": 9}},
    {"data": {"source": "bloomberg"}},
    {"data": {"default_period": "7Y"}},
    {"analytics": {"risk_free_rate": 6.5}},              # percent instead of decimal
    {"analytics": {"sma_windows": [50, 50]}},
    {"analytics": {"sma_windows": [1]}},
    {"analytics": {"trailing_periods": ["2X"]}},
    {"analytics": {"kpi_cards": ["CAGR %"]}},             # display name, not id
    {"analytics": {"kpi_cards": []}},
    {"analytics": {"correlation_frequency": "W-FRI"}},
    {"sip": {"day": 31}},
    {"sip": {"step_up": 10}},                             # percent instead of decimal
    {"shortcuts": {"palette": "mod+k", "other": "mod+k"}},
    {"shortcuts": {"palette": "hyper+k"}},
    {"custom_themes": {"midnight": {"base": "paper"}}},   # clashes with built-in
    {"custom_themes": {"x": {"base": "paper", "tokens": {"--bg": "red;}body{"}}}},
    {"export": {"presets": [{"name": "a"}, {"name": "a"}]}},
    {"dashboard": {"layout": [{"widget": "clock", "x": 0, "y": 0, "w": 1, "h": 1}]}},
])
def test_invalid_values_rejected(patch):
    base = Settings().model_dump(mode="json")
    for section, values in patch.items():
        base[section] = {**base[section], **values} if isinstance(base[section], dict) and section not in (
            "shortcuts", "custom_themes") else values
    with pytest.raises(ValidationError):
        Settings.model_validate(base)


def test_custom_theme_and_palette_can_be_selected():
    s = Settings.model_validate({
        "custom_themes": {"ocean": {"base": "midnight", "tokens": {"--accent": "#00aaff"}}},
        "custom_palettes": {"mine": ["#112233", "#445566", "#778899"]},
        "appearance": {"theme": "ocean", "chart_palette": "mine", "accent": "#ABCDEF"},
    })
    assert s.appearance.theme == "ocean"
    assert s.appearance.accent == "#abcdef"                # normalised to lowercase


def test_valid_shortcut_forms():
    s = Settings.model_validate({"shortcuts": {"a": "mod+shift+l", "b": "g d", "c": "/", "d": "f5"}})
    assert s.shortcuts["b"] == "g d"


# --------------------------------------------------------------------------- #
# Migration
# --------------------------------------------------------------------------- #
UNVERSIONED = {
    "appearance": {"theme": "paper"},
    "analytics": {"kpi_cards": ["CAGR %", "Sharpe", "% from 52w high"],
                  "compare_metrics": ["Max drawdown %", "Calmar"],
                  "correlation_frequency": "W-FRI"},
    "sip": {"amount": 5000, "step_up_pct": 10},
}


def test_migrate_v0_to_v1():
    data, original = migrate(UNVERSIONED)
    assert original == 0 and data["schema_version"] == 1
    s = Settings.model_validate(data)
    assert s.analytics.kpi_cards == ["cagr", "sharpe", "pct_from_52w_high"]
    assert s.analytics.compare_metrics == ["max_drawdown", "calmar"]
    assert s.analytics.correlation_frequency == "W"
    assert s.sip.step_up == pytest.approx(0.10) and s.sip.amount == 5000
    assert s.appearance.theme == "paper"
    assert "step_up_pct" in UNVERSIONED["sip"]            # input not mutated


def test_migrate_rejects_newer_and_garbage():
    with pytest.raises(MigrationError, match="newer"):
        migrate({"schema_version": SCHEMA_VERSION + 1})
    with pytest.raises(MigrationError):
        migrate([1, 2])
    with pytest.raises(MigrationError):
        migrate({"schema_version": "1"})


def test_parse_settings_for_restore():
    assert parse_settings(UNVERSIONED).sip.step_up == pytest.approx(0.10)


# --------------------------------------------------------------------------- #
# Store
# --------------------------------------------------------------------------- #
def test_first_load_creates_file(store, tmp_path):
    s = store.load()
    assert s == Settings()
    assert json.loads(store.path.read_text(encoding="utf-8"))["schema_version"] == 1
    assert files(tmp_path) == ["settings.json"]             # no temp files left over
    assert store.warnings == []


def test_round_trip(store, tmp_path):
    store.patch_section("analytics", {"risk_free_rate": 0.07, "sma_windows": [20, 50, 200]})
    fresh = SettingsStore(store.path).load()
    assert fresh.analytics.risk_free_rate == 0.07
    assert fresh.analytics.sma_windows == [20, 50, 200]
    assert fresh.analytics.trading_days == 252             # untouched fields kept


def test_patch_invalid_leaves_file_unchanged(store):
    store.load()
    before = store.path.read_bytes()
    with pytest.raises(ValidationError):
        store.patch_section("analytics", {"trading_days": 5})
    assert store.path.read_bytes() == before
    assert store.get().analytics.trading_days == 252


def test_patch_dict_section_replaces(store):
    store.patch_section("custom_themes", {"a": {"base": "paper"}, "b": {"base": "paper"}})
    store.patch_section("custom_themes", {"b": {"base": "paper"}})
    assert list(store.get().custom_themes) == ["b"]


def test_patch_unknown_section(store):
    with pytest.raises(KeyError):
        store.patch_section("schema_version", {})
    with pytest.raises(KeyError):
        store.patch_section("nope", {})
    assert "schema_version" not in SECTIONS


def test_reset_section_and_all(store):
    store.patch_section("sip", {"amount": 1})
    store.patch_section("formats", {"decimals": 4})
    assert store.reset("sip").sip.amount == 10_000
    assert store.get().formats.decimals == 4
    assert store.reset().formats.decimals == 2


def test_get_returns_copies(store):
    s = store.get()
    s.analytics.sma_windows.append(999)
    assert store.get().analytics.sma_windows == [50, 200]


def test_corrupt_file_is_set_aside(store, tmp_path):
    store.path.write_text("{ not json", encoding="utf-8")
    assert store.load() == Settings()
    assert len(store.warnings) == 1 and "settings.invalid-" in store.warnings[0]
    moved = [n for n in files(tmp_path) if n.startswith("settings.invalid-")]
    assert len(moved) == 1
    assert (tmp_path / moved[0]).read_text(encoding="utf-8") == "{ not json"


def test_invalid_values_file_is_set_aside(store, tmp_path):
    store.path.write_text(json.dumps({"schema_version": 1, "formats": {"decimals": 99}}), encoding="utf-8")
    store.load()
    assert any(n.startswith("settings.invalid-") for n in files(tmp_path))


def test_old_file_is_migrated_and_backed_up(store, tmp_path):
    store.path.write_text(json.dumps(UNVERSIONED), encoding="utf-8")
    s = store.load()
    assert s.sip.step_up == pytest.approx(0.10)
    backups = [n for n in files(tmp_path) if n.startswith("settings.v0-")]
    assert len(backups) == 1
    assert json.loads((tmp_path / backups[0]).read_text(encoding="utf-8")) == UNVERSIONED
    assert json.loads(store.path.read_text(encoding="utf-8"))["schema_version"] == 1


def test_subscribers_notified(store):
    seen = []
    store.subscribe(lambda s: seen.append(s.data.cache_dir))
    store.load()
    store.patch_section("data", {"cache_dir": "elsewhere"})
    assert seen == ["backend/data_cache", "elsewhere"]


def test_resolve_path_is_relative_to_project_root(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)                            # working dir must not matter
    assert resolve_path("backend/data_cache") == (PROJECT_ROOT / "backend" / "data_cache").resolve()
    assert resolve_path(tmp_path / "abs") == (tmp_path / "abs").resolve()
