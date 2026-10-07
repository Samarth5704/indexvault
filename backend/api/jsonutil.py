"""JSON helpers: NaN-safe responses and pandas -> payload conversion.

API conventions (CLAUDE.md rule 4): dates are ISO "YYYY-MM-DD", NaN/inf become
null, percentages are decimals and keys never contain "%". `convert_record`
turns core's display keys ("Avg %") into snake_case ids ("avg"), dividing
values whose key had a "%" by 100.
"""
from __future__ import annotations

import functools
import inspect
import json
import math
import re
from collections.abc import Callable, Mapping
from datetime import date, datetime
from typing import Any

import numpy as np
import pandas as pd
from fastapi.responses import JSONResponse as _BaseJSONResponse
from fastapi.responses import Response
from fastapi.routing import APIRoute


def jsonable(obj: Any) -> Any:
    if obj is None or isinstance(obj, (bool, str, int)):
        return obj
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        return jsonable(float(obj))
    if obj is pd.NaT:
        return None
    if isinstance(obj, pd.Timestamp):  # before datetime: Timestamp subclasses it
        return obj.date().isoformat() if obj == obj.normalize() else obj.isoformat()
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, Mapping):
        return {str(k): jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [jsonable(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return [jsonable(v) for v in obj.tolist()]
    if isinstance(obj, pd.Series):
        return series_payload(obj)
    if isinstance(obj, pd.DataFrame):
        return frame_payload(obj)
    if hasattr(obj, "model_dump"):
        return jsonable(obj.model_dump(mode="json"))
    return str(obj)


class JSONResponse(_BaseJSONResponse):
    """Default response class: converts pandas/numpy values and NaN -> null."""

    def render(self, content: Any) -> bytes:
        return json.dumps(jsonable(content), ensure_ascii=False, allow_nan=False,
                          separators=(",", ":")).encode("utf-8")


# --------------------------------------------------------------------------- #
# pandas -> payload
# --------------------------------------------------------------------------- #
def iso_dates(index: pd.Index) -> list[str]:
    return pd.DatetimeIndex(index).strftime("%Y-%m-%d").tolist()


def _floats(values) -> list[float | None]:
    arr = np.asarray(values, dtype=float)
    return [None if not math.isfinite(v) else v for v in arr.tolist()]


def series_payload(s: pd.Series, scale: float = 1.0) -> dict:
    """{"dates": [...], "values": [...]} — values multiplied by `scale`."""
    s = s.dropna()
    return {"dates": iso_dates(s.index), "values": _floats(s.to_numpy(dtype=float) * scale)}


def frame_payload(df: pd.DataFrame, index_name: str = "date") -> dict:
    """{"columns": [index_name, ...], "rows": [[...], ...]} with a date index."""
    cols = [index_name, *map(str, df.columns)]
    dates = iso_dates(df.index) if isinstance(df.index, pd.DatetimeIndex) else [jsonable(i) for i in df.index]
    body = [[jsonable(v) for v in row] for row in df.itertuples(index=False, name=None)]
    return {"columns": cols, "rows": [[d, *r] for d, r in zip(dates, body)]}


# --------------------------------------------------------------------------- #
# Key conversion
# --------------------------------------------------------------------------- #
def snake(key: str) -> str:
    """'Avg %' -> 'avg', 'Peak→Trough (days)' -> 'peak_trough_days'."""
    k = key.replace("%", " ").replace("→", " ").lower()
    return re.sub(r"[^a-z0-9]+", "_", k).strip("_")


def convert_value(key: str, value: Any) -> Any:
    v = jsonable(value)
    if "%" in key and isinstance(v, (int, float)) and not isinstance(v, bool):
        return v / 100
    return v


def convert_record(rec: Mapping[str, Any], renames: Mapping[str, str] | None = None) -> dict:
    """Convert one row/dict from core display keys to API keys and units."""
    renames = renames or {}
    return {renames.get(k, snake(k)): convert_value(k, v) for k, v in rec.items()}


def convert_rows(df: pd.DataFrame, renames: Mapping[str, str] | None = None,
                 index_key: str | None = None) -> list[dict]:
    """DataFrame -> list of converted records; the index is kept under `index_key`."""
    out = []
    for idx, row in df.iterrows():
        rec = convert_record(row.to_dict(), renames)
        if index_key:
            rec = {index_key: jsonable(idx), **rec}
        out.append(rec)
    return out


# --------------------------------------------------------------------------- #
# Router integration
# --------------------------------------------------------------------------- #
class JsonableRoute(APIRoute):
    """Route class that converts an endpoint's return value with `jsonable`
    before FastAPI's own encoder sees it (which would turn pandas Timestamps
    into "YYYY-MM-DDT00:00:00" and choke on numpy integers)."""

    def __init__(self, path: str, endpoint: Callable[..., Any], **kwargs: Any):
        super().__init__(path, _jsonable_endpoint(endpoint), **kwargs)


def _jsonable_endpoint(fn: Callable[..., Any]) -> Callable[..., Any]:
    if inspect.iscoroutinefunction(fn):
        @functools.wraps(fn)
        async def async_wrapper(*args, **kwargs):
            result = await fn(*args, **kwargs)
            return result if isinstance(result, Response) else jsonable(result)
        return async_wrapper

    @functools.wraps(fn)  # FastAPI unwraps to read the real signature and globals
    def wrapper(*args, **kwargs):
        result = fn(*args, **kwargs)
        return result if isinstance(result, Response) else jsonable(result)
    return wrapper
