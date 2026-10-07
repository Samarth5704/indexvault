"""Project paths and crash-safe JSON files for config/."""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def config_dir() -> Path:
    """config/ at the project root, or $INDEXVAULT_CONFIG (used by tests)."""
    return Path(os.environ.get("INDEXVAULT_CONFIG", PROJECT_ROOT / "config"))


def resolve_path(p: str | os.PathLike) -> Path:
    """Resolve a settings path. Relative paths are relative to the project root,
    never the process's working directory."""
    path = Path(p).expanduser()
    return (path if path.is_absolute() else PROJECT_ROOT / path).resolve()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json_atomic(path: Path, data: Any) -> None:
    """Write JSON via a temp file + rename so a crash never leaves a half-written file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.stem}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def set_aside(path: Path, reason: str) -> Path:
    """Rename an unusable file out of the way (never delete user data).
    e.g. settings.json -> settings.invalid-20261008-142501.json"""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = path.with_name(f"{path.stem}.{reason}-{stamp}{path.suffix}")
    n = 1
    while target.exists():
        target = path.with_name(f"{path.stem}.{reason}-{stamp}-{n}{path.suffix}")
        n += 1
    os.replace(path, target)
    return target
