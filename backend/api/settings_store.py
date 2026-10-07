"""Load, migrate, validate and save config/settings.json.

Never deletes user data: an unreadable or invalid file is renamed aside
(settings.invalid-<stamp>.json) and defaults are used, with a warning kept in
`SettingsStore.warnings` for the UI to show. A file migrated from an older
schema is backed up first (settings.v<old>-<stamp>.json).
"""
from __future__ import annotations

import copy
import json
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ValidationError

from .metrics import CORE_KEY_TO_ID
from .settings import SCHEMA_VERSION, SECTIONS, Settings
from .storage import config_dir, read_json, set_aside, write_json_atomic


class MigrationError(ValueError):
    pass


# --------------------------------------------------------------------------- #
# Migrations: MIGRATIONS[n] upgrades a schema-n dict to schema n+1.
# --------------------------------------------------------------------------- #
def _v0_to_v1(d: dict) -> dict:
    """Unversioned files use prototype conventions: metric display names
    ("CAGR %"), SIP step-up in percent, and pandas rules for correlation."""
    d = copy.deepcopy(d)
    a = d.get("analytics") or {}
    for key in ("kpi_cards", "compare_metrics"):
        if isinstance(a.get(key), list):
            a[key] = [CORE_KEY_TO_ID.get(m, m) for m in a[key]]
    freq = {"W-FRI": "W", "ME": "M", "M": "M", "D": "D", "W": "W", "B": "D"}
    if "correlation_frequency" in a:
        a["correlation_frequency"] = freq.get(a["correlation_frequency"], a["correlation_frequency"])
    sip = d.get("sip") or {}
    if "step_up_pct" in sip:
        sip["step_up"] = (sip.pop("step_up_pct") or 0) / 100
    d["schema_version"] = 1
    return d


MIGRATIONS: dict[int, Callable[[dict], dict]] = {0: _v0_to_v1}


def migrate(raw: Any) -> tuple[dict, int]:
    """Upgrade a raw settings dict to the current schema.
    Returns (upgraded dict, original version)."""
    if not isinstance(raw, dict):
        raise MigrationError("settings file must contain a JSON object")
    version = raw.get("schema_version", 0)
    if not isinstance(version, int) or version < 0:
        raise MigrationError(f"invalid schema_version {version!r}")
    if version > SCHEMA_VERSION:
        raise MigrationError(f"settings are from a newer IndexVault (schema {version} > {SCHEMA_VERSION})")
    original, data = version, raw
    while version < SCHEMA_VERSION:
        data = MIGRATIONS[version](data)
        version = data["schema_version"]
    return data, original


def parse_settings(raw: Any) -> Settings:
    """Migrate + validate any settings dict (e.g. from a backup file).
    Raises MigrationError or pydantic.ValidationError."""
    data, _ = migrate(raw)
    return Settings.model_validate(data)


# --------------------------------------------------------------------------- #
# Store
# --------------------------------------------------------------------------- #
Listener = Callable[[Settings], None]


class SettingsStore:
    """Thread-safe holder of the current Settings, persisted to JSON.

    Callers get deep copies, so mutating a returned object never changes the
    store; write through `replace`, `patch_section` or `reset`.
    """

    def __init__(self, path: Path | None = None):
        self.path = path or config_dir() / "settings.json"
        self.warnings: list[str] = []
        self._lock = threading.RLock()
        self._settings: Settings | None = None
        self._listeners: list[Listener] = []

    # -- reading ----------------------------------------------------------- #
    def load(self) -> Settings:
        with self._lock:
            self.warnings = []
            self._settings = self._read_file()
            self._notify()
            return self.get()

    def get(self) -> Settings:
        with self._lock:
            if self._settings is None:
                return self.load()
            return self._settings.model_copy(deep=True)

    def section(self, name: str) -> Any:
        self._check_section(name)
        return getattr(self.get(), name)

    def _read_file(self) -> Settings:
        if not self.path.exists():
            settings = Settings()
            self._write(settings)
            return settings
        try:
            raw = read_json(self.path)
            data, original = migrate(raw)
            settings = Settings.model_validate(data)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, MigrationError, ValidationError) as e:
            moved = set_aside(self.path, "invalid")
            self.warnings.append(
                f"settings.json could not be used ({_first_line(e)}); it was moved to "
                f"{moved.name} and defaults were loaded.")
            settings = Settings()
            self._write(settings)
            return settings
        if original != SCHEMA_VERSION:
            backup = set_aside(self.path, f"v{original}")
            self.warnings.append(f"Settings upgraded from schema {original}; the old file is {backup.name}.")
            self._write(settings)
        return settings

    # -- writing ----------------------------------------------------------- #
    def replace(self, data: dict | Settings) -> Settings:
        """Validate and save a full settings object (current schema only)."""
        settings = data if isinstance(data, Settings) else Settings.model_validate(data)
        with self._lock:
            self._write(settings)
            self._settings = settings.model_copy(deep=True)
            self._notify()
            return self.get()

    def patch_section(self, name: str, data: dict) -> Settings:
        """Update one section. For model sections (appearance, analytics, …) the
        given fields are merged over the current ones; dict sections
        (custom_themes, custom_palettes, shortcuts) are replaced whole, so
        entries can be removed."""
        self._check_section(name)
        if not isinstance(data, dict):
            raise TypeError("section data must be an object")
        with self._lock:
            current = self.get().model_dump(mode="json")
            if isinstance(getattr(self.get(), name), BaseModel):
                current[name] = {**current[name], **data}
            else:
                current[name] = data
            return self.replace(current)

    def reset(self, section: str | None = None) -> Settings:
        """Restore defaults for one section, or everything when section is None."""
        with self._lock:
            if section is None:
                return self.replace(Settings())
            self._check_section(section)
            current = self.get().model_dump(mode="json")
            current[section] = Settings().model_dump(mode="json")[section]
            return self.replace(current)

    # -- misc -------------------------------------------------------------- #
    def subscribe(self, listener: Listener) -> None:
        """Call `listener(settings)` after every load or change."""
        self._listeners.append(listener)

    @staticmethod
    def schema() -> dict:
        return Settings.model_json_schema()

    def _write(self, settings: Settings) -> None:
        write_json_atomic(self.path, settings.model_dump(mode="json"))

    def _notify(self) -> None:
        for fn in self._listeners:
            fn(self._settings.model_copy(deep=True))

    @staticmethod
    def _check_section(name: str) -> None:
        if name not in SECTIONS:
            raise KeyError(f"unknown settings section {name!r}; sections: {', '.join(SECTIONS)}")


def _first_line(e: Exception) -> str:
    return str(e).strip().splitlines()[0][:200] if str(e).strip() else type(e).__name__
