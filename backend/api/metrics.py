"""Registry of summary metrics exposed by the API.

Core (`indexvault.analytics.summary_metrics`) uses display keys such as
"CAGR %" with values ×100. The API uses stable ids ("cagr") and decimals
(0.12 = 12%), per CLAUDE.md rule 4. Settings refer to metrics by id
(kpi_cards, compare_metrics).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Literal

Kind = Literal["pct", "ratio", "level", "date", "years"]


@dataclass(frozen=True)
class Metric:
    id: str
    core_key: str
    label: str
    kind: Kind  # "pct" values are decimals in API responses


METRICS: dict[str, Metric] = {m.id: m for m in [
    Metric("start", "Start", "Start", "date"),
    Metric("end", "End", "End", "date"),
    Metric("years", "Years", "Years", "years"),
    Metric("start_level", "Start level", "Start level", "level"),
    Metric("end_level", "End level", "End level", "level"),
    Metric("total_return", "Total return %", "Total return", "pct"),
    Metric("cagr", "CAGR %", "CAGR", "pct"),
    Metric("ann_vol", "Annual volatility %", "Annual volatility", "pct"),
    Metric("sharpe", "Sharpe", "Sharpe", "ratio"),
    Metric("sortino", "Sortino", "Sortino", "ratio"),
    Metric("max_drawdown", "Max drawdown %", "Max drawdown", "pct"),
    Metric("max_dd_date", "Max DD date", "Max drawdown date", "date"),
    Metric("calmar", "Calmar", "Calmar", "ratio"),
    Metric("current_drawdown", "Current drawdown %", "Current drawdown", "pct"),
    Metric("best_day", "Best day %", "Best day", "pct"),
    Metric("worst_day", "Worst day %", "Worst day", "pct"),
    Metric("best_month", "Best month %", "Best month", "pct"),
    Metric("worst_month", "Worst month %", "Worst month", "pct"),
    Metric("best_year", "Best year %", "Best year", "pct"),
    Metric("worst_year", "Worst year %", "Worst year", "pct"),
    Metric("positive_months", "Positive months %", "Positive months", "pct"),
    Metric("var_95", "Daily VaR 95 %", "Daily VaR (95%)", "pct"),
    Metric("cvar_95", "Daily CVaR 95 %", "Daily CVaR (95%)", "pct"),
    Metric("skew", "Skew", "Skew", "ratio"),
    Metric("excess_kurtosis", "Excess kurtosis", "Excess kurtosis", "ratio"),
    Metric("high_52w", "52w high", "52-week high", "level"),
    Metric("pct_from_52w_high", "% from 52w high", "From 52-week high", "pct"),
]}

CORE_KEY_TO_ID: dict[str, str] = {m.core_key: m.id for m in METRICS.values()}


def _clean_number(v: Any) -> Any:
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return v


def from_core(core: dict[str, Any]) -> dict[str, Any]:
    """Convert a `summary_metrics` dict to API form: ids as keys, percentages
    as decimals, NaN/inf as None, dates as ISO strings. Unknown keys are dropped."""
    out: dict[str, Any] = {}
    for key, value in core.items():
        metric = METRICS.get(CORE_KEY_TO_ID.get(key, ""))
        if metric is None:
            continue
        if metric.kind == "date":
            out[metric.id] = value.isoformat() if value is not None else None
            continue
        v = float(value) if value is not None else None
        if v is not None and metric.kind == "pct":
            v /= 100
        out[metric.id] = _clean_number(v)
    return out
