"""Settings model: the single source of truth for every user-tunable value.

Stored in config/settings.json (created from defaults on first run). Conventions:
- Percentages are decimals (0.065 = 6.5%) and no key contains "%" (CLAUDE.md rule 4).
- Metrics are referred to by id (see api/metrics.py).
- `schema_version` + api/settings_store.py migrations upgrade old files.
"""
from __future__ import annotations

import re
import uuid
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from indexvault.analytics import period_offset
from indexvault.data import FREQUENCIES, SOURCES

from .metrics import METRICS

SCHEMA_VERSION = 1

BUILTIN_THEMES = ("midnight", "paper", "terminal", "saffron")
BUILTIN_PALETTES = ("default",)
PERIODS = ("1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "10Y", "15Y", "20Y", "Max")
WIDGETS = ("snapshot", "mini_chart", "heatmap", "vix_gauge", "drawdown_monitor",
           "rolling_snapshot", "notes")

_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
_TOKEN_RE = re.compile(r"^--[a-z0-9-]{1,48}$")
_KEY = r"(?:(?:mod|ctrl|alt|shift|meta)\+)*(?:[a-z0-9/.,;'`\[\]=-]|f[1-9]|f1[0-2]|enter|escape|space|tab|up|down|left|right)"
_SHORTCUT_RE = re.compile(rf"^{_KEY}(?: {_KEY})?$")


# --------------------------------------------------------------------------- #
# Reusable validated types
# --------------------------------------------------------------------------- #
def _hex(v: str) -> str:
    if not _HEX_RE.match(v):
        raise ValueError("must be a hex colour like #2a78d6")
    return v.lower()


def _slug(v: str) -> str:
    if not _SLUG_RE.match(v):
        raise ValueError("use 1–32 lowercase letters, digits or hyphens")
    return v


def _unique(v: list) -> list:
    if len(set(v)) != len(v):
        raise ValueError("values must be unique")
    return v


def _period(v: str) -> str:
    period_offset(v)  # raises ValueError with a helpful message
    return v


def _metric_id(v: str) -> str:
    if v not in METRICS:
        raise ValueError(f"unknown metric {v!r}")
    return v


def _source(v: str) -> str:
    if v not in SOURCES:
        raise ValueError(f"unknown data source {v!r}; available: {sorted(SOURCES)}")
    return v


def _css_value(v: str) -> str:
    if any(c in v for c in ";{}<>"):
        raise ValueError("CSS values cannot contain ; { } < >")
    return v


HexColour = Annotated[str, AfterValidator(_hex)]
Slug = Annotated[str, AfterValidator(_slug)]
MetricId = Annotated[str, AfterValidator(_metric_id)]
PeriodLabel = Annotated[str, AfterValidator(_period)]
Frequency = Literal["Daily", "Weekly", "Monthly", "Quarterly", "Yearly"]
assert set(Frequency.__args__) == set(FREQUENCIES), "keep Frequency in sync with core"


class Section(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True)


# --------------------------------------------------------------------------- #
# Sections
# --------------------------------------------------------------------------- #
class Appearance(Section):
    theme: str = Field("midnight", description="Built-in theme (midnight, paper, terminal, saffron) or a custom theme name.")
    mode: Literal["light", "dark", "system"] = Field("system", description="Colour mode; 'system' follows the OS.")
    accent: HexColour | None = Field(None, description="Accent colour override; null uses the theme's accent.")
    chart_palette: str = Field("default", description="Chart series palette: 'default' or a custom palette name.")
    font_scale: float = Field(1.0, ge=0.875, le=1.25, description="Multiplier for every font size.")
    density: Literal["comfortable", "compact"] = Field("comfortable", description="Compact shrinks padding and table rows.")
    radius: Literal["none", "sm", "md", "lg"] = Field("md", description="Corner radius preset.")
    motion: Literal["full", "reduced", "off"] = Field("full", description="Animation level; 'full' still honours the OS reduced-motion setting.")
    sidebar: Literal["expanded", "collapsed"] = Field("expanded", description="Left rail state on load.")
    gain_loss: Literal["market", "colorblind"] = Field("market", description="Gain/loss colours: market green/red or colour-blind-safe blue/red.")
    market_pulse: bool = Field(True, description="Show the scrolling market-pulse strip under the top bar.")


class CustomTheme(Section):
    base: Literal["midnight", "paper", "terminal", "saffron"] = Field(description="Built-in theme this one starts from.")
    tokens: dict[Annotated[str, Field(pattern=_TOKEN_RE.pattern)], Annotated[str, Field(max_length=64), AfterValidator(_css_value)]] = Field(
        default_factory=dict, description="CSS token overrides, e.g. {'--accent': '#ff8800'}.")


class Formats(Section):
    number_system: Literal["indian", "international"] = Field("indian", description="Indian (12,34,567.89; lakh/crore) or international (1,234,567.89) grouping.")
    decimals: int = Field(2, ge=0, le=6, description="Decimal places for displayed numbers.")
    date_format: Literal["DD-MM-YYYY", "YYYY-MM-DD", "DD MMM YYYY"] = Field("DD-MM-YYYY", description="Date display format.")
    currency: str = Field("₹", min_length=1, max_length=4, description="Currency symbol.")


class DataSettings(Section):
    source: Annotated[str, AfterValidator(_source)] = Field("yahoo", description="Default data source.")
    cache_dir: str = Field("backend/data_cache", min_length=1, description="Cache folder; relative paths are relative to the project root.")
    auto_update_on_open: bool = Field(True, description="Update cached series when the app opens.")
    stale_after_hours: float = Field(3, ge=0, le=168, description="Refetch recent data once the cache is older than this.")
    request_throttle_seconds: float = Field(0.5, ge=0, le=10, description="Pause between downloads in bulk jobs, to be polite to the source.")
    default_period: Literal[PERIODS] = Field("10Y", description="Date range selected on first load.")
    default_frequency: Frequency = Field("Daily", description="Frequency selected on first load.")
    default_series: Annotated[list[Annotated[str, Field(min_length=1, max_length=40)]], AfterValidator(_unique)] = Field(
        default_factory=lambda: ["^NSEI", "^NSEBANK"], max_length=20, description="Series selected on first load.")


class Analytics(Section):
    risk_free_rate: float = Field(0.065, ge=0, le=0.5, description="Annual risk-free rate (decimal) for Sharpe/Sortino.")
    trading_days: int = Field(252, ge=200, le=366, description="Trading days per year, for annualising.")
    sma_windows: Annotated[list[Annotated[int, Field(ge=2, le=1000)]], AfterValidator(_unique)] = Field(
        default_factory=lambda: [50, 200], max_length=6, description="Simple moving-average windows (days) overlaid on price charts.")
    ema_windows: Annotated[list[Annotated[int, Field(ge=2, le=1000)]], AfterValidator(_unique)] = Field(
        default_factory=list, max_length=6, description="Exponential moving-average windows (days).")
    rolling_windows_years: Annotated[list[Annotated[int, Field(ge=1, le=30)]], AfterValidator(_unique)] = Field(
        default_factory=lambda: [1, 3, 5, 7, 10], min_length=1, max_length=8, description="Holding periods (years) for rolling returns.")
    rolling_vol_window: int = Field(63, ge=5, le=1000, description="Window (days) for rolling volatility.")
    correlation_frequency: Literal["D", "W", "M"] = Field("W", description="Return frequency for correlation and beta: daily, weekly or monthly.")
    rolling_corr_window: int = Field(52, ge=5, le=520, description="Rolling-correlation window, in periods of the correlation frequency.")
    big_move_threshold: float = Field(0.05, gt=0, le=0.5, description="Daily move (decimal) flagged as a big move.")
    quality_gap_days: int = Field(5, ge=2, le=60, description="Calendar-day gap counted as a hole in the data.")
    drawdown_table_size: int = Field(5, ge=1, le=50, description="Rows in the worst-drawdowns table.")
    histogram_bins: int = Field(50, ge=10, le=200, description="Bins in the daily-return histogram.")
    trailing_periods: Annotated[list[PeriodLabel], AfterValidator(_unique)] = Field(
        default_factory=lambda: ["1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "10Y"], min_length=1, max_length=12,
        description="Trailing-return periods, e.g. 1M, 3Y, YTD.")
    target_cagr: float = Field(0.12, ge=-0.5, le=1, description="Target CAGR (decimal) for rolling-return hit rates.")
    kpi_cards: Annotated[list[MetricId], AfterValidator(_unique)] = Field(
        default_factory=lambda: ["end_level", "cagr", "ann_vol", "max_drawdown", "sharpe", "pct_from_52w_high"],
        min_length=1, max_length=12, description="KPI cards on the Analyse page, in order.")
    compare_metrics: Annotated[list[MetricId], AfterValidator(_unique)] = Field(
        default_factory=lambda: ["cagr", "ann_vol", "sharpe", "sortino", "max_drawdown", "calmar"],
        min_length=1, max_length=27, description="Metrics shown in the Compare table, in order.")


class Sip(Section):
    amount: float = Field(10_000, gt=0, le=1e8, description="Monthly SIP amount.")
    day: int = Field(5, ge=1, le=28, description="Day of month to invest (next trading day if a holiday).")
    step_up: float = Field(0.0, ge=0, le=1, description="Annual step-up of the SIP amount (decimal, 0.10 = +10%/yr).")
    sensitivity_min_months: int = Field(12, ge=1, le=240, description="Shortest SIP included in the start-date sensitivity strip.")


class ExportOptions(Section):
    date_format: Literal["DD-MM-YYYY", "YYYY-MM-DD", "DD MMM YYYY"] | None = Field(None, description="Overrides formats.date_format.")
    decimals: int | None = Field(None, ge=0, le=8, description="Overrides formats.decimals.")
    indian_number_format: bool = Field(False, description="Use lakh/crore grouping in Excel cells.")
    metadata_sheet: bool | None = Field(None, description="Overrides export.metadata_sheet.")


class ExportPreset(Section):
    name: str = Field(min_length=1, max_length=60)
    tickers: list[str] = Field(default_factory=list, max_length=50)
    frequency: Frequency = "Daily"
    columns: list[str] = Field(default_factory=list, max_length=60)
    format: Literal["xlsx", "csv", "zip", "json"] = "xlsx"
    options: ExportOptions = Field(default_factory=ExportOptions)


class Export(Section):
    default_format: Literal["xlsx", "csv", "zip", "json"] = Field("xlsx", description="Default export format.")
    presets: list[ExportPreset] = Field(default_factory=list, max_length=50, description="Saved export presets.")
    metadata_sheet: bool = Field(True, description="Add a sheet with source, fetch time and caveats to Excel exports.")
    excel_header_colour: HexColour = Field("#1c5cab", description="Header row fill in Excel exports.")
    excel_freeze_panes: bool = Field(True, description="Freeze the header row and date column in Excel exports.")

    @model_validator(mode="after")
    def _unique_preset_names(self):
        _unique([p.name for p in self.presets])
        return self


class Widget(Section):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:8], min_length=1, max_length=40)
    widget: Literal[WIDGETS]
    x: int = Field(ge=0, le=11)
    y: int = Field(ge=0, le=500)
    w: int = Field(ge=1, le=12)
    h: int = Field(ge=1, le=12)
    config: dict[str, Any] = Field(default_factory=dict)


class Dashboard(Section):
    layout: list[Widget] = Field(default_factory=list, max_length=60, description="Widget grid; empty = default layout (built in M8).")


def _shortcut_map(v: dict[str, str]) -> dict[str, str]:
    for action, combo in v.items():
        if not _SHORTCUT_RE.match(combo):
            raise ValueError(f"{action}: invalid shortcut {combo!r} (e.g. 'mod+k', 'mod+shift+l', 'g d')")
    dupes = {c for c in v.values() if list(v.values()).count(c) > 1}
    if dupes:
        raise ValueError(f"shortcut used twice: {', '.join(sorted(dupes))}")
    return v


DEFAULT_SHORTCUTS = {
    "palette": "mod+k",
    "toggle_theme": "mod+shift+l",
    "toggle_sidebar": "mod+b",
    "focus_series_picker": "/",
}


# --------------------------------------------------------------------------- #
# Root
# --------------------------------------------------------------------------- #
class Settings(Section):
    schema_version: Literal[1] = Field(SCHEMA_VERSION, description="Settings file format version.")
    appearance: Appearance = Field(default_factory=Appearance)
    custom_themes: dict[Slug, CustomTheme] = Field(default_factory=dict, description="User-made themes by name.")
    custom_palettes: dict[Slug, Annotated[list[HexColour], Field(min_length=2, max_length=12)]] = Field(
        default_factory=dict, description="User-made chart palettes by name.")
    formats: Formats = Field(default_factory=Formats)
    data: DataSettings = Field(default_factory=DataSettings)
    analytics: Analytics = Field(default_factory=Analytics)
    sip: Sip = Field(default_factory=Sip)
    export: Export = Field(default_factory=Export)
    dashboard: Dashboard = Field(default_factory=Dashboard)
    shortcuts: Annotated[dict[str, str], AfterValidator(_shortcut_map)] = Field(
        default_factory=lambda: dict(DEFAULT_SHORTCUTS), description="Action -> key combo ('mod' = Ctrl/⌘).")

    @model_validator(mode="after")
    def _cross_checks(self):
        clash = set(self.custom_themes) & set(BUILTIN_THEMES)
        if clash:
            raise ValueError(f"custom theme names clash with built-ins: {sorted(clash)}")
        if self.appearance.theme not in (*BUILTIN_THEMES, *self.custom_themes):
            raise ValueError(f"appearance.theme {self.appearance.theme!r} is not a built-in or custom theme")
        if self.appearance.chart_palette not in (*BUILTIN_PALETTES, *self.custom_palettes):
            raise ValueError(f"appearance.chart_palette {self.appearance.chart_palette!r} does not exist")
        return self


SECTIONS: tuple[str, ...] = tuple(k for k in Settings.model_fields if k != "schema_version")
