"""SIP Lab: monthly SIP backtest with step-up, top-ups and start-date sensitivity."""
from __future__ import annotations

from datetime import date, datetime
from typing import Literal

import pandas as pd
from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from indexvault import analytics as an
from indexvault import data

from ..context import AppContext, get_ctx
from ..errors import bad_request
from .export import DATE_FORMATS
from ..jsonutil import JsonableRoute, convert_record, convert_rows, frame_payload

router = APIRouter(prefix="/analytics", route_class=JsonableRoute)

STAT_NAMES = {"SIP XIRR %": "xirr", "Lump-sum CAGR %": "lump_sum_cagr",
              "Worst SIP drawdown %": "worst_drawdown"}
LEDGER_NAMES = {"Price": "price", "Invested": "invested", "Units": "units", "Value": "value",
                "Gain": "gain", "Lump sum value": "lump_sum_value"}


class TopUp(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date: date
    amount: float = Field(gt=0, le=1e9)


class SipRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ticker: str = Field(min_length=1)
    amount: float | None = Field(None, gt=0, le=1e8, description="Defaults to sip.amount.")
    day: int | None = Field(None, ge=1, le=28, description="Defaults to sip.day.")
    step_up: float | None = Field(None, ge=0, le=1, description="Annual step-up (decimal); defaults to sip.step_up.")
    start: date | None = None
    end: date | None = None
    period: str | None = None
    source: str | None = None
    top_ups: list[TopUp] = Field(default_factory=list, max_length=100)


def monthly_ledger(ledger: pd.DataFrame) -> pd.DataFrame:
    """Last row of each month, labelled with that month's last trading day."""
    monthly = ledger.groupby(ledger.index.to_period("M")).tail(1)
    return monthly.rename(columns=LEDGER_NAMES)


def _run(body: SipRequest, ctx: AppContext):
    """Run the backtest for a request; defaults come from settings.sip."""
    d = ctx.settings.sip
    params = {"amount": body.amount or d.amount, "day": body.day or d.day,
              "step_up": d.step_up if body.step_up is None else body.step_up}
    source = ctx.explicit_source(body.source)
    start_ts, end_ts = ctx.date_range(body.period, body.start, body.end)
    close = ctx.frame(body.ticker, source, start_ts, end_ts)["Close"]
    ledger, stats = an.sip_backtest(close, amount=params["amount"], day_of_month=params["day"],
                                    step_up_pct=params["step_up"] * 100,
                                    top_ups=[(t.date, t.amount) for t in body.top_ups])
    if not stats:
        raise bad_request("Not enough data for a SIP in this range (need at least 30 trading days).")
    return params, source, start_ts, end_ts, close, ledger, stats


@router.post("/sip")
def sip(body: SipRequest, sensitivity: bool = Query(False, description="Add XIRR for every possible start month."),
        ctx: AppContext = Depends(get_ctx)):
    params, source, start_ts, end_ts, close, ledger, stats = _run(body, ctx)
    out = {
        "ticker": body.ticker,
        "params": {**params, "start": close.index[0], "end": close.index[-1], "top_ups": body.top_ups},
        "stats": convert_record(stats, renames=STAT_NAMES),
        "ledger": frame_payload(monthly_ledger(ledger)),
    }
    if sensitivity:
        d = ctx.settings.sip
        key = (str(start_ts), str(end_ts), params["amount"], params["day"], params["step_up"], d.sensitivity_min_months)
        sens = ctx.computed("sip_sensitivity", [body.ticker], source, key, lambda: an.sip_start_sensitivity(
            close, amount=params["amount"], day_of_month=params["day"], step_up_pct=params["step_up"] * 100,
            min_months=d.sensitivity_min_months))
        out["sensitivity"] = convert_rows(sens, index_key="start")
    return out


LEDGER_LABELS = {"Price": "Price", "Invested": "Invested", "Units": "Units", "Value": "Value",
                 "Gain": "Gain", "Lump sum value": "Lump-sum value"}


@router.post("/sip/export")
def sip_export(body: SipRequest, format: Literal["xlsx", "csv"] = Query("xlsx"), ctx: AppContext = Depends(get_ctx)):
    """Monthly SIP ledger as Excel (Summary + Ledger sheets) or CSV. Excel keeps
    percentages as real % cells; CSV is the ledger only."""
    params, _, _, _, close, ledger, stats = _run(body, ctx)
    s = ctx.settings
    monthly = ledger.groupby(ledger.index.to_period("M")).tail(1).rename(columns=LEDGER_LABELS)
    monthly.index.name = "Date"
    stamp = f"{body.ticker.replace('^', '')}_{datetime.now():%Y%m%d}"
    if format == "csv":
        content = monthly.round(4).to_csv().encode("utf-8-sig")
        return Response(content, media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="indexvault_sip_{stamp}.csv"'})
    api_stats = convert_record(stats, renames=STAT_NAMES)
    summary = pd.DataFrame([{
        "Series": body.ticker, "Monthly amount": params["amount"], "SIP day": params["day"],
        "Annual step-up": params["step_up"], "From": close.index[0].date(), "To": close.index[-1].date(),
        **{SUMMARY_LABELS[k]: v for k, v in api_stats.items() if k in SUMMARY_LABELS},
    }]).set_index("Series")
    pct_cols = ["Annual step-up", "XIRR", "Absolute return", "Lump-sum CAGR", "Worst drawdown vs invested"]
    content = data.to_excel_bytes(
        {"Summary": summary, "Ledger": monthly},
        header_colour=s.export.excel_header_colour, freeze_panes=s.export.excel_freeze_panes,
        number_format="#,##0.00", date_format=DATE_FORMATS[s.formats.date_format][1],
        column_formats={c: "0.00%" for c in pct_cols})
    return Response(content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="indexvault_sip_{stamp}.xlsx"'})


SUMMARY_LABELS = {"instalments": "Instalments", "top_ups": "Top-ups", "total_invested": "Total invested",
                  "final_value": "Final value", "absolute_gain": "Absolute gain", "absolute_return": "Absolute return",
                  "xirr": "XIRR", "lump_sum_final_value": "Lump-sum final value", "lump_sum_cagr": "Lump-sum CAGR",
                  "worst_drawdown": "Worst drawdown vs invested"}
