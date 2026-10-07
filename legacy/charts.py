"""Plotly chart builders with a consistent, colour-blind-validated palette."""
from __future__ import annotations

import numpy as np
import pandas as pd
import plotly.graph_objects as go

# Validated categorical order (light surface). Assigned by entity, never cycled.
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100",
          "#e87ba4", "#008300", "#4a3aa7", "#e34948"]
NEUTRAL = "#898781"
SURFACE = "#fcfcfb"
GRID = "#e1e0d9"
AXIS = "#c3c2b7"
INK = "#0b0b0b"
INK2 = "#52514e"
UP = "#2a78d6"     # diverging positive pole (blue)
DOWN = "#e34948"   # diverging negative pole (red)
MID = "#f0efec"    # diverging neutral midpoint
FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif"


def color_map(names: list[str]) -> dict[str, str]:
    """Stable colour per series name, in selection order. >8 series fold to grey."""
    return {n: (SERIES[i] if i < len(SERIES) else NEUTRAL) for i, n in enumerate(names)}


def _layout(fig: go.Figure, title: str = "", height: int = 420, y_title: str = "",
            log: bool = False, pct: bool = False) -> go.Figure:
    fig.update_layout(
        title=dict(text=title, font=dict(size=15, color=INK), x=0, xanchor="left"),
        height=height,
        margin=dict(l=10, r=10, t=48 if title else 16, b=10),
        paper_bgcolor=SURFACE,
        plot_bgcolor=SURFACE,
        font=dict(family=FONT, size=12, color=INK2),
        hovermode="x unified",
        hoverlabel=dict(bgcolor="white", font=dict(family=FONT, color=INK)),
        legend=dict(orientation="h", yanchor="bottom", y=1.0, xanchor="right", x=1,
                    font=dict(color=INK2), bgcolor="rgba(0,0,0,0)"),
    )
    fig.update_xaxes(showgrid=False, linecolor=AXIS, tickfont=dict(color=NEUTRAL))
    fig.update_yaxes(gridcolor=GRID, zeroline=False, linecolor=AXIS,
                     tickfont=dict(color=NEUTRAL), title=y_title,
                     type="log" if log else "linear",
                     ticksuffix="%" if pct else "")
    return fig


def lines(wide: pd.DataFrame, colors: dict[str, str], title="", y_title="",
          log=False, pct=False, height=420, fmt=",.2f") -> go.Figure:
    fig = go.Figure()
    for col in wide.columns:
        s = wide[col].dropna()
        fig.add_trace(go.Scatter(
            x=s.index, y=s.values, name=col, mode="lines",
            line=dict(width=2, color=colors.get(col, NEUTRAL)),
            hovertemplate=f"%{{y:{fmt}}}{'%' if pct else ''}",
        ))
    return _layout(fig, title, height, y_title, log, pct)


def price_chart(df: pd.DataFrame, name: str, color: str, kind="Line", smas: pd.DataFrame | None = None,
                log=False, height=460) -> go.Figure:
    fig = go.Figure()
    if kind == "Candlestick":
        fig.add_trace(go.Candlestick(
            x=df.index, open=df["Open"], high=df["High"], low=df["Low"], close=df["Close"],
            name=name, increasing_line_color=UP, decreasing_line_color=DOWN,
            increasing_fillcolor=UP, decreasing_fillcolor=DOWN,
        ))
        fig.update_xaxes(rangeslider_visible=False)
    else:
        fig.add_trace(go.Scatter(x=df.index, y=df["Close"], name=name, mode="lines",
                                 line=dict(width=2, color=color),
                                 hovertemplate="%{y:,.2f}"))
    if smas is not None:
        dashes = ["dot", "dash", "dashdot"]
        for i, c in enumerate(smas.columns):
            fig.add_trace(go.Scatter(x=smas.index, y=smas[c], name=c, mode="lines",
                                     line=dict(width=1.5, color=NEUTRAL, dash=dashes[i % 3]),
                                     hovertemplate="%{y:,.2f}"))
    return _layout(fig, f"{name} — price", height, "", log)


def underwater(dd: pd.Series, color: str, title="Drawdown from peak") -> go.Figure:
    fig = go.Figure(go.Scatter(
        x=dd.index, y=dd.values * 100, mode="lines", fill="tozeroy",
        line=dict(width=1.5, color=DOWN), fillcolor="rgba(227,73,72,0.18)",
        name="Drawdown", hovertemplate="%{y:.2f}%",
    ))
    return _layout(fig, title, 280, "", pct=True)


def heatmap_returns(grid: pd.DataFrame, title="Monthly returns (%)") -> go.Figure:
    z = grid.values.astype(float)
    lim = np.nanpercentile(np.abs(z), 95) if np.isfinite(z).any() else 1
    text = np.where(np.isnan(z), "", np.vectorize(lambda v: f"{v:.1f}")(np.nan_to_num(z)))
    fig = go.Figure(go.Heatmap(
        z=z, x=list(grid.columns), y=[str(y) for y in grid.index],
        text=text, texttemplate="%{text}", textfont=dict(size=10, color=INK),
        colorscale=[[0, DOWN], [0.5, MID], [1, UP]], zmid=0, zmin=-lim, zmax=lim,
        xgap=2, ygap=2, hovertemplate="%{y} %{x}: %{z:.2f}%<extra></extra>",
        colorbar=dict(ticksuffix="%", thickness=10, outlinewidth=0),
    ))
    fig = _layout(fig, title, max(300, 22 * len(grid) + 90))
    fig.update_yaxes(autorange="reversed", gridcolor="rgba(0,0,0,0)", type="category")
    fig.update_xaxes(side="top")
    fig.update_layout(hovermode="closest")
    return fig


def bars(s: pd.Series, title="", pct=True, height=320, signed=True, color=UP) -> go.Figure:
    colors = [UP if v >= 0 else DOWN for v in s.values] if signed else color
    fig = go.Figure(go.Bar(
        x=[str(i) for i in s.index], y=s.values, marker=dict(color=colors, line=dict(width=0)),
        hovertemplate="%{x}: %{y:.2f}" + ("%" if pct else "") + "<extra></extra>",
    ))
    fig.update_layout(bargap=0.25)
    fig = _layout(fig, title, height, pct=pct)
    fig.update_layout(hovermode="closest")
    return fig


def histogram(r: pd.Series, color: str, title="Distribution of daily returns") -> go.Figure:
    fig = go.Figure(go.Histogram(x=r * 100, nbinsx=120, marker=dict(color=color, line=dict(width=0)),
                                 hovertemplate="%{x:.2f}%: %{y} days<extra></extra>"))
    fig = _layout(fig, title, 300)
    fig.update_xaxes(ticksuffix="%")
    fig.update_layout(hovermode="closest", bargap=0.05)
    return fig


def corr_heatmap(c: pd.DataFrame, title="Correlation of weekly returns") -> go.Figure:
    z = c.values
    fig = go.Figure(go.Heatmap(
        z=z, x=list(c.columns), y=list(c.index),
        text=np.vectorize(lambda v: f"{v:.2f}")(z), texttemplate="%{text}",
        textfont=dict(size=11, color=INK),
        colorscale=[[0, DOWN], [0.5, MID], [1, UP]], zmin=-1, zmax=1,
        xgap=2, ygap=2, hovertemplate="%{y} vs %{x}: %{z:.2f}<extra></extra>",
        colorbar=dict(thickness=10, outlinewidth=0),
    ))
    fig = _layout(fig, title, max(320, 40 * len(c) + 120))
    fig.update_yaxes(autorange="reversed", gridcolor="rgba(0,0,0,0)")
    fig.update_layout(hovermode="closest")
    return fig


def sip_chart(ledger: pd.DataFrame, color: str) -> go.Figure:
    fig = go.Figure()
    fig.add_trace(go.Scatter(x=ledger.index, y=ledger["Invested"], name="Invested",
                             line=dict(width=2, color=NEUTRAL, shape="hv"), hovertemplate="₹%{y:,.0f}"))
    fig.add_trace(go.Scatter(x=ledger.index, y=ledger["Value"], name="SIP value",
                             line=dict(width=2, color=color), hovertemplate="₹%{y:,.0f}"))
    fig.add_trace(go.Scatter(x=ledger.index, y=ledger["Lump sum value"], name="Same total as lump sum on day 1",
                             line=dict(width=2, color=SERIES[1], dash="dot"), hovertemplate="₹%{y:,.0f}"))
    fig = _layout(fig, "SIP growth", 420)
    fig.update_yaxes(tickprefix="₹", tickformat=",.0f")
    return fig
