"""SIP Lab: monthly SIP backtest with step-up, top-ups and start-date sensitivity."""
from __future__ import annotations

from datetime import date

import pandas as pd
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field

from indexvault import analytics as an

from ..context import AppContext, get_ctx
from ..errors import bad_request
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


@router.post("/sip")
def sip(body: SipRequest, sensitivity: bool = Query(False, description="Add XIRR for every possible start month."),
        ctx: AppContext = Depends(get_ctx)):
    d = ctx.settings.sip
    amount = body.amount or d.amount
    day = body.day or d.day
    step_up = d.step_up if body.step_up is None else body.step_up
    source = ctx.source(body.source)
    start_ts, end_ts = ctx.date_range(body.period, body.start, body.end)
    close = ctx.frame(body.ticker, source, start_ts, end_ts)["Close"]
    top_ups = [(t.date, t.amount) for t in body.top_ups]
    ledger, stats = an.sip_backtest(close, amount=amount, day_of_month=day,
                                    step_up_pct=step_up * 100, top_ups=top_ups)
    if not stats:
        raise bad_request("Not enough data for a SIP in this range (need at least 30 trading days).")
    out = {
        "ticker": body.ticker,
        "params": {"amount": amount, "day": day, "step_up": step_up, "start": close.index[0],
                   "end": close.index[-1], "top_ups": body.top_ups},
        "stats": convert_record(stats, renames=STAT_NAMES),
        "ledger": frame_payload(monthly_ledger(ledger)),
    }
    if sensitivity:
        key = (str(start_ts), str(end_ts), amount, day, step_up, d.sensitivity_min_months)
        sens = ctx.computed("sip_sensitivity", [body.ticker], source, key, lambda: an.sip_start_sensitivity(
            close, amount=amount, day_of_month=day, step_up_pct=step_up * 100,
            min_months=d.sensitivity_min_months))
        out["sensitivity"] = convert_rows(sens, index_key="start")
    return out
