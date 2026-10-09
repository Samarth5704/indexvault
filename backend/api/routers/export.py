"""POST /export: series tables as Excel, CSV, CSV-zip or JSON downloads.

Excel keeps percentages as real decimals with a % cell format; CSV writes
decimals rounded to (decimals + 2) places so no displayed precision is lost.
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime
from typing import Literal

import pandas as pd
from fastapi import APIRouter, Depends
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from indexvault import analytics as an
from indexvault import data
from indexvault.indices import display_name, series_kind

from ..context import AppContext, get_ctx
from ..errors import bad_request, not_found
from ..jsonutil import JsonableRoute, frame_payload, jsonable
from ..metrics import METRICS, from_core
from ..settings import ExportOptions, Frequency
from .series import _WINDOWED, BASE_COLUMNS, build_columns, caveats, names, parse_columns, warmup_for

router = APIRouter(route_class=JsonableRoute)

Format = Literal["xlsx", "csv", "zip", "json"]
DATE_FORMATS = {"DD-MM-YYYY": ("%d-%m-%Y", "dd-mm-yyyy"),
                "YYYY-MM-DD": ("%Y-%m-%d", "yyyy-mm-dd"),
                "DD MMM YYYY": ("%d %b %Y", "dd mmm yyyy")}
MEDIA = {"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
         "csv": "text/csv; charset=utf-8", "zip": "application/zip",
         "json": "application/json"}
_LABELS = {**{k: v for k, v in BASE_COLUMNS.items()}, "return": "Return", "log_return": "Log return",
           "drawdown": "Drawdown", "rebased": "Rebased (100)"}
_KIND_LABEL = {"sma": "SMA", "ema": "EMA", "rsi": "RSI", "vol": "Volatility"}


class ExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    preset: str | None = Field(None, description="Name of a saved export preset; other fields override it.")
    tickers: list[str] | None = None
    start: date | None = None
    end: date | None = None
    period: str | None = None
    freq: Frequency | None = None
    columns: list[str] | None = None
    format: Format | None = None
    options: ExportOptions | None = None
    source: str | None = None


def column_label(col: str) -> str:
    if col in _LABELS:
        return _LABELS[col]
    m = _WINDOWED.match(col)
    return f"{_KIND_LABEL[m.group(1)]} {m.group(2)}"


def is_pct(col: str) -> bool:
    return col in ("return", "log_return", "drawdown") or col.startswith("vol_")


def excel_number_format(decimals: int, indian: bool) -> str:
    frac = "." + "0" * decimals if decimals else ""
    if not indian:
        return f"#,##0{frac}"
    return f"[>=10000000]##\\,##\\,##\\,##0{frac};[>=100000]##\\,##\\,##0{frac};##,##0{frac}"


def _first(*values):
    """First value that is set (not None / empty); request > preset > default."""
    return next((v for v in values if v not in (None, [], "")), None)


def _resolve(ctx: AppContext, body: ExportRequest) -> dict:
    s = ctx.settings
    preset = None
    if body.preset:
        preset = next((p for p in s.export.presets if p.name == body.preset), None)
        if preset is None:
            raise not_found(f"No export preset named {body.preset!r}.")
    opts = _first(body.options, preset and preset.options, ExportOptions())
    columns = _first(body.columns, preset and preset.columns)
    return {
        "tickers": ctx.tickers(_first(body.tickers, preset and preset.tickers)),
        "freq": _first(body.freq, preset and preset.frequency, s.data.default_frequency),
        "columns": parse_columns(",".join(columns) if columns else None),
        "format": _first(body.format, preset and preset.format, s.export.default_format),
        "decimals": s.formats.decimals if opts.decimals is None else opts.decimals,
        "date_format": opts.date_format or s.formats.date_format,
        "indian": opts.indian_number_format,
        "metadata": s.export.metadata_sheet if opts.metadata_sheet is None else opts.metadata_sheet,
    }


def _tables(ctx: AppContext, r: dict, source: str | None, start_ts, end_ts) -> dict[str, tuple[str, pd.DataFrame]]:
    """ticker -> (display name, table with id columns). TRI tables always carry NTR."""
    out = {}
    for t in r["tickers"]:
        cols = r["columns"] + (["ntr"] if series_kind(t) == "tri" and "ntr" not in r["columns"] else [])
        daily = ctx.frame(t, source, start_ts, end_ts, warmup=warmup_for(cols, r["freq"]))
        out[t] = (display_name(t, names(ctx)),
                  build_columns(daily, cols, r["freq"], start_ts, ctx.settings.analytics.trading_days))
    return out


def _round(df: pd.DataFrame, decimals: int) -> pd.DataFrame:
    return df.apply(lambda c: c.round(decimals + 2 if is_pct(c.name) else decimals)
                    if pd.api.types.is_float_dtype(c) else c)


def _labelled(df: pd.DataFrame) -> pd.DataFrame:
    out = df.rename(columns=column_label)
    out.index.name = "Date"
    return out


def _summary_sheet(ctx: AppContext, tables, source, start_ts, end_ts) -> pd.DataFrame:
    s = ctx.settings.analytics
    ids = ["start", "end", "years", *[m for m in s.compare_metrics if m not in ("start", "end", "years")]]
    rows = {}
    for t, (name, _) in tables.items():
        close = ctx.frame(t, source, start_ts, end_ts)["Close"]
        m = from_core(an.summary_metrics(close, s.risk_free_rate, s.trading_days))
        rows[name] = {METRICS[i].label: m.get(i) for i in ids}
    return pd.DataFrame(rows).T.rename_axis("Series")


def _about_sheet(ctx: AppContext, r: dict, source: str | None, tables, start_ts, end_ts) -> pd.DataFrame:
    rows = [("Generated", datetime.now().isoformat(timespec="seconds")), ("Frequency", r["freq"]),
            ("From", str(start_ts.date()) if start_ts is not None else "start of data"),
            ("To", str(end_ts.date())), ("Percent columns", "decimals (0.0123 = 1.23%)")]
    for t, (name, df) in tables.items():
        src = ctx.source_for(t, source)
        _, info = data.load_cached(t, src)
        rows.append((f"{name} ({t})", f"{data.SOURCE_INFO[src].label} · cache updated {info.get('last_update', 'n/a')}"))
        rows += [("Caveat", c) for c in caveats(t, src, df)]
    return pd.DataFrame(rows, columns=["Item", "Value"]).set_index("Item")


def _xlsx(ctx, r, source, tables, start_ts, end_ts) -> bytes:
    s = ctx.settings
    xl_date = DATE_FORMATS[r["date_format"]][1]
    sheets: dict[str, pd.DataFrame] = {"Summary": _summary_sheet(ctx, tables, source, start_ts, end_ts)}
    if len(tables) > 1 and "close" in r["columns"]:
        sheets["Closes"] = pd.DataFrame({name: df["close"] for name, df in tables.values()}).sort_index()
    sheets.update({name: _labelled(df) for name, df in tables.values()})
    if r["metadata"]:
        sheets["About"] = _about_sheet(ctx, r, source, tables, start_ts, end_ts)
    pct_formats = {column_label(c): "0." + "0" * r["decimals"] + "%" for c in r["columns"] if is_pct(c)}
    pct_formats |= {METRICS[i].label: "0." + "0" * r["decimals"] + "%" for i in METRICS if METRICS[i].kind == "pct"}
    return data.to_excel_bytes(sheets, header_colour=s.export.excel_header_colour,
                               freeze_panes=s.export.excel_freeze_panes,
                               number_format=excel_number_format(r["decimals"], r["indian"]),
                               date_format=xl_date, column_formats=pct_formats)


def _csv(r, tables) -> bytes:
    strf = DATE_FORMATS[r["date_format"]][0]
    frames = []
    for t, (_, df) in tables.items():
        f = _labelled(_round(df, r["decimals"]))
        if len(tables) > 1:
            f.insert(0, "Ticker", t)
        frames.append(f)
    return pd.concat(frames).to_csv(date_format=strf).encode("utf-8-sig")  # BOM: Excel opens ₹/UTF-8 correctly


def _filename(tickers: list[str], freq: str, ext: str) -> str:
    base = re.sub(r"[^A-Za-z0-9_.-]", "", tickers[0].replace("^", "")) or "series"
    more = f"+{len(tickers) - 1}" if len(tickers) > 1 else ""
    return f"indexvault_{base}{more}_{freq.lower()}_{datetime.now():%Y%m%d}.{ext}"


@router.post("/export")
def export(body: ExportRequest, ctx: AppContext = Depends(get_ctx)):
    r = _resolve(ctx, body)
    if not r["tickers"]:
        raise bad_request("No tickers to export.")
    source = ctx.explicit_source(body.source)  # None = each ticker's own source
    start_ts, end_ts = ctx.date_range(body.period, body.start, body.end)
    tables = _tables(ctx, r, source, start_ts, end_ts)
    fmt = r["format"]
    if fmt == "xlsx":
        content = _xlsx(ctx, r, source, tables, start_ts, end_ts)
    elif fmt == "csv":
        content = _csv(r, tables)
    elif fmt == "zip":
        content = data.to_csv_zip_bytes({name: _labelled(_round(df, r["decimals"])) for name, df in tables.values()},
                                        float_format=None, date_format=DATE_FORMATS[r["date_format"]][0])
    else:
        payload = {"freq": r["freq"],
                   "series": {t: {"name": name, "source": ctx.source_for(t, source), **frame_payload(df),
                                  "caveats": caveats(t, ctx.source_for(t, source), df)}
                              for t, (name, df) in tables.items()}}
        content = json.dumps(jsonable(payload), ensure_ascii=False, indent=1).encode("utf-8")
    name = _filename(r["tickers"], r["freq"], fmt)
    return Response(content, media_type=MEDIA[fmt],
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})
