"""IndexVault — Indian market index data downloader & analyser.

Run:  streamlit run app.py
"""
from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd
import streamlit as st

from indexvault import analytics as an
from indexvault import charts as ch
from indexvault import data
from indexvault.indices import CATALOG, NAME_TO_TICKER, NO_VOLUME, TICKER_TO_NAME, display_name

st.set_page_config(page_title="IndexVault", page_icon="📈", layout="wide")

st.markdown(
    """
    <style>
      .block-container {padding-top: 2rem; max-width: 1400px;}
      [data-testid="stMetricValue"] {font-size: 1.45rem;}
      [data-testid="stMetricLabel"] p {color: #52514e;}
      .iv-note {color:#52514e; font-size:0.85rem;}
      .iv-badge {display:inline-block; padding:2px 10px; border-radius:999px;
                 background:#fdf1d8; color:#7a4f00; font-size:0.8rem; font-weight:600;}
    </style>
    """,
    unsafe_allow_html=True,
)

# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
PERIODS = {"1Y": 1, "3Y": 3, "5Y": 5, "10Y": 10, "15Y": 15, "20Y": 20, "Max": None, "Custom": "custom"}
PRESETS = {
    "Custom selection": None,
    "Headline: Nifty 50, Sensex, Bank": ["NIFTY 50", "BSE SENSEX", "NIFTY Bank"],
    "Market-cap ladder": ["NIFTY 50", "NIFTY Next 50", "NIFTY Midcap 100", "NIFTY Smallcap 100"],
    "Sector rotation": ["NIFTY Bank", "NIFTY IT", "NIFTY Pharma", "NIFTY FMCG",
                        "NIFTY Auto", "NIFTY Metal", "NIFTY Energy", "NIFTY Realty"],
    "India vs world": ["NIFTY 50", "S&P 500", "NASDAQ Composite", "USD/INR"],
}


def fmt_val(v, key: str = "") -> str:
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return "—"
    if isinstance(v, (int, np.integer)) and not isinstance(v, bool):
        return f"{v:,}"
    if isinstance(v, (float, np.floating)):
        if "%" in key:
            return f"{v:,.2f}%"
        if key in ("Sharpe", "Sortino", "Calmar", "Skew", "Excess kurtosis", "Years", "Beta"):
            return f"{v:.2f}"
        return f"{v:,.2f}"
    return str(v)


def fmt_table(df: pd.DataFrame, by: str = "row") -> pd.DataFrame:
    """Format mixed-type metric tables as strings for display."""
    out = df.copy().astype(object)
    for r in out.index:
        for c in out.columns:
            out.loc[r, c] = fmt_val(df.loc[r, c], r if by == "row" else c)
    return out


def pct_style(df: pd.DataFrame, decimals: int = 2):
    df = df.copy()
    if isinstance(df.index, pd.DatetimeIndex):
        df.index = df.index.strftime("%Y-%m-%d")
    counts = [c for c in df.columns if c in ("Periods", "Observations", "Years", "Days")]
    sty = df.style.format(precision=decimals, thousands=",", na_rep="—")
    return sty.format("{:,.0f}", subset=counts, na_rep="—") if counts else sty


def inr(v: float) -> str:
    """₹ in Indian units: lakh (L) and crore (Cr)."""
    a = abs(v)
    if a >= 1e7:
        return f"₹{v / 1e7:,.2f} Cr"
    if a >= 1e5:
        return f"₹{v / 1e5:,.2f} L"
    return f"₹{v:,.0f}"


def period_start(choice: str, custom_start: date) -> pd.Timestamp | None:
    v = PERIODS[choice]
    if v == "custom":
        return pd.Timestamp(custom_start)
    if v is None:
        return None
    return pd.Timestamp.today().normalize() - pd.DateOffset(years=v)


# --------------------------------------------------------------------------- #
# Sidebar
# --------------------------------------------------------------------------- #
all_names = [n for g in CATALOG.values() for n in g]

with st.sidebar:
    st.markdown("## 📈 IndexVault")
    st.caption("Indian index data — download, cache, analyse.")

    src_label = st.radio("Data source", ["Yahoo Finance (live)", "Demo data (offline)"],
                         help="Demo data is synthetic and deterministic — handy for trying "
                              "the app without internet. Never use it for research.")
    source = "yahoo" if src_label.startswith("Yahoo") else "demo"

    preset = st.selectbox("Quick set", list(PRESETS))
    default = PRESETS[preset] or st.session_state.get("picked", ["NIFTY 50", "NIFTY Bank"])
    picked = st.multiselect(
        "Indices", all_names, default=default,
        format_func=lambda n: f"{n}",
        help="Grouped catalogue lives in indexvault/indices.py — add your own there.",
    )
    st.session_state["picked"] = picked
    custom = st.text_input("Extra Yahoo tickers (comma-separated)",
                           placeholder="RELIANCE.NS, HDFCBANK.NS, ^NSEI")

    st.divider()
    pc = st.segmented_control("Period", list(PERIODS), default="10Y")
    pc = pc or "10Y"
    c1, c2 = st.columns(2)
    cs = c1.date_input("From", date(2010, 1, 1), min_value=date(1990, 1, 1),
                       disabled=pc != "Custom")
    ce = c2.date_input("To", date.today(), disabled=pc != "Custom")
    freq = st.selectbox("Bar frequency (download & tables)", list(data.FREQUENCIES), index=0)
    rf = st.number_input("Risk-free rate % (for Sharpe/Sortino)", 0.0, 15.0, 6.5, 0.25,
                         help="≈ 91-day T-bill yield. Update to the current rate.") / 100

    st.divider()
    refresh = st.checkbox("Force full re-download", help="Ignore the local cache for this load.")
    load = st.button("Load data", type="primary", width="stretch")

# --------------------------------------------------------------------------- #
# Load
# --------------------------------------------------------------------------- #
tickers = [(n, NAME_TO_TICKER[n]) for n in picked if n in NAME_TO_TICKER]
for t in [x.strip() for x in custom.split(",") if x.strip()]:
    tickers.append((display_name(t), t))

if load:
    start = period_start(pc, cs)
    end = pd.Timestamp(ce) if pc == "Custom" else None
    frames, errors = {}, []
    bar = st.progress(0.0, text="Loading…")
    for i, (name, t) in enumerate(tickers):
        bar.progress((i + 0.5) / max(len(tickers), 1), text=f"Loading {name} ({t})…")
        try:
            df = data.get_data(t, start, end, source=source, refresh=refresh)
            if df.empty:
                errors.append(f"{name} ({t}): no data returned")
            else:
                frames[name] = df
        except Exception as e:  # noqa: BLE001
            errors.append(f"{name} ({t}): {e}")
    bar.empty()
    st.session_state.update(frames=frames, errors=errors, source=source,
                            tick={n: t for n, t in tickers}, loaded_at=pd.Timestamp.now())

frames: dict[str, pd.DataFrame] = st.session_state.get("frames", {})
tick_of: dict[str, str] = st.session_state.get("tick", {})

# --------------------------------------------------------------------------- #
# Header
# --------------------------------------------------------------------------- #
h1, h2 = st.columns([3, 1])
h1.title("IndexVault")
h1.markdown('<span class="iv-note">Download, cache and study Indian market indices. '
            "Index levels are price indices (no dividends).</span>", unsafe_allow_html=True)
if st.session_state.get("source") == "demo" and frames:
    h2.markdown('<br><span class="iv-badge">⚠ DEMO DATA — synthetic</span>', unsafe_allow_html=True)

for e in st.session_state.get("errors", []):
    st.warning(e)

if not frames:
    st.info("Pick indices and a period in the sidebar, then press **Load data**. "
            "Data is cached in `data_cache/`, so later loads only fetch new days.")
    with st.expander("What can this tool do?", expanded=True):
        st.markdown(
            "- **Download** daily / weekly / monthly / quarterly / yearly OHLCV to Excel or CSV\n"
            "- **Analyse** CAGR, volatility, Sharpe, Sortino, drawdowns, VaR, calendar-return heatmap\n"
            "- **Compare** indices rebased to 100, correlation, beta, relative strength\n"
            "- **Rolling returns** — how often did 5-year returns beat 12%? lose money?\n"
            "- **SIP simulator** with step-up and XIRR vs lump sum\n"
            "- **Seasonality** by month and weekday\n"
            "- **Data quality** checks before you trust a dataset\n"
            "- **Local cache** with incremental updates"
        )
    st.stop()

names = list(frames)
colors = ch.color_map(names)
closes = {n: f["Close"] for n, f in frames.items()}
wide = data.combine_close(frames)

tabs = st.tabs(["📥 Download", "📊 Analyse", "⚖️ Compare", "🔁 Rolling returns",
                "💰 SIP simulator", "📅 Seasonality", "🩺 Data quality", "🗄️ Cache"])

# --------------------------------------------------------------------------- #
# 1. Download
# --------------------------------------------------------------------------- #
with tabs[0]:
    resampled = {n: data.resample(f, freq) for n, f in frames.items()}
    k = st.columns(4)
    k[0].metric("Series loaded", len(frames))
    k[1].metric("Frequency", freq)
    k[2].metric("Earliest date", str(min(f.index[0] for f in frames.values()).date()))
    k[3].metric("Latest date", str(max(f.index[-1] for f in frames.values()).date()))

    view = st.selectbox("Preview", names, key="dl_view")
    cols = st.multiselect("Columns to include in exports",
                          ["Open", "High", "Low", "Close", "Adj Close", "Volume", "Return %"],
                          default=["Open", "High", "Low", "Close", "Volume", "Return %"])
    rs = resampled[view][cols]
    st.dataframe(pct_style(rs.iloc[::-1].head(500)), width="stretch", height=320)
    st.caption(f"{len(rs):,} {freq.lower()} bars · showing latest 500 · bars labelled with the last trading day in each period")

    stamp = pd.Timestamp.now().strftime("%Y%m%d")
    wide_close = data.combine_close({n: resampled[n] for n in names})
    summary = an.metrics_table(closes, rf)
    sheets = {"Summary": fmt_table(summary), "All closes": wide_close}
    sheets.update({n: resampled[n][cols] for n in names})

    d1, d2, d3 = st.columns(3)
    d1.download_button("⬇ Excel workbook (all)", data.to_excel_bytes(sheets),
                       f"indexvault_{freq.lower()}_{stamp}.xlsx", width="stretch",
                       help="Summary sheet + combined closes + one sheet per index")
    d2.download_button("⬇ CSV zip (all)", data.to_csv_zip_bytes({n: resampled[n][cols] for n in names}),
                       f"indexvault_{freq.lower()}_{stamp}.zip", width="stretch")
    d3.download_button(f"⬇ {view} CSV", rs.to_csv(float_format="%.4f"),
                       f"{tick_of.get(view, view)}_{freq.lower()}_{stamp}.csv", width="stretch")

    st.plotly_chart(ch.lines(wide_close, colors, f"Closing levels ({freq.lower()})",
                             log=st.toggle("Log scale", key="dl_log")), width="stretch")

# --------------------------------------------------------------------------- #
# 2. Analyse
# --------------------------------------------------------------------------- #
with tabs[1]:
    sel = st.selectbox("Index", names, key="an_sel")
    df, c, col = frames[sel], closes[sel], colors[sel]
    m = an.summary_metrics(c, rf)
    if not m:
        st.warning("Not enough data for statistics.")
    else:
        k = st.columns(6)
        k[0].metric("Last close", f"{m['End level']:,.2f}")
        k[1].metric("CAGR", f"{m['CAGR %']:.2f}%")
        k[2].metric("Volatility", f"{m['Annual volatility %']:.2f}%")
        k[3].metric("Max drawdown", f"{m['Max drawdown %']:.2f}%")
        k[4].metric("Sharpe", f"{m['Sharpe']:.2f}")
        k[5].metric("From 52w high", f"{m['% from 52w high']:.2f}%")

        tr = an.trailing_returns(c)
        st.markdown("**Trailing returns** <span class='iv-note'>(annualised above 1 year)</span>",
                    unsafe_allow_html=True)
        st.dataframe(pct_style(pd.DataFrame([tr], index=[sel])), width="stretch")

        o1, o2, o3, o4 = st.columns([1, 1, 1, 2])
        kind = o1.radio("Chart", ["Line", "Candlestick"], horizontal=True, key="an_kind")
        log = o2.toggle("Log scale", key="an_log")
        show_ma = o3.toggle("50/200 SMA", value=True)
        view_df = df if kind == "Line" else df.iloc[-500:]
        smas = an.moving_averages(c).loc[view_df.index] if show_ma else None
        st.plotly_chart(ch.price_chart(view_df, sel, col, kind, smas, log), width="stretch")
        if kind == "Candlestick" and len(df) > 500:
            st.caption("Candlesticks show the last 500 sessions for readability.")

        st.plotly_chart(ch.underwater(an.drawdown(c), col), width="stretch")
        st.markdown("**Worst drawdowns**")
        st.dataframe(an.drawdown_table(c).style.format({"Depth %": "{:.2f}",
                     "Trough→Recovery (days)": "{:.0f}"}, na_rep="—"),
                     width="stretch", hide_index=True)

        st.plotly_chart(ch.heatmap_returns(an.monthly_returns_table(c)), width="stretch")

        a, b = st.columns(2)
        yr = an.monthly_returns_table(c)["Year"]
        a.plotly_chart(ch.bars(yr, "Calendar-year returns"), width="stretch")
        b.plotly_chart(ch.histogram(an.daily_returns(c), col), width="stretch")

        rv = an.rolling_volatility(c).to_frame("3-month rolling volatility") * 100
        st.plotly_chart(ch.lines(rv, {rv.columns[0]: col}, "Rolling volatility (63 trading days, annualised)",
                                 pct=True, height=300), width="stretch")

        with st.expander("All statistics"):
            st.dataframe(fmt_table(pd.DataFrame({sel: m})), width="stretch")

# --------------------------------------------------------------------------- #
# 3. Compare
# --------------------------------------------------------------------------- #
with tabs[2]:
    if len(names) < 2:
        st.info("Load at least two series to compare.")
    else:
        common_start = max(s.dropna().index[0] for s in closes.values())
        rb = an.rebase(wide.loc[common_start:])
        st.plotly_chart(ch.lines(rb, colors, f"Growth of 100 since {common_start.date()}",
                                 log=st.toggle("Log scale", key="cmp_log")), width="stretch")
        st.caption("All series start on the first date every series has data, so the comparison is fair.")

        aligned = {n: s.loc[common_start:] for n, s in closes.items()}
        mt = an.metrics_table(aligned, rf)
        keep = ["CAGR %", "Annual volatility %", "Sharpe", "Sortino", "Max drawdown %", "Calmar",
                "Current drawdown %", "Best year %", "Worst year %", "Positive months %", "Daily VaR 95 %"]
        bench = st.selectbox("Benchmark for beta", names, key="cmp_bench")
        mt.loc["Beta"] = [an.beta(aligned[n], aligned[bench]) for n in mt.columns]
        st.markdown("**Side-by-side (common period)**")
        st.dataframe(fmt_table(mt.loc[keep + ["Beta"]]), width="stretch")

        st.markdown("**Trailing returns %**")
        st.dataframe(pct_style(pd.DataFrame({n: an.trailing_returns(s) for n, s in closes.items()}).T),
                     width="stretch")

        a, b = st.columns(2)
        a.plotly_chart(ch.corr_heatmap(an.correlation(wide)), width="stretch")
        with b:
            st.markdown("**Relative strength**")
            x1, x2 = st.columns(2)
            ra = x1.selectbox("Numerator", names, index=min(1, len(names) - 1), key="rs_a")
            rbn = x2.selectbox("Denominator", names, index=0, key="rs_b")
            rsr = an.relative_strength(closes[ra], closes[rbn]).to_frame(f"{ra} / {rbn}")
            st.plotly_chart(ch.lines(rsr, {rsr.columns[0]: colors[ra]}, height=300, fmt=",.1f"),
                            width="stretch")
            st.caption("Rising = numerator outperforming. A classic sector-rotation tool.")
        rc = an.rolling_correlation(closes[ra], closes[rbn]).to_frame(f"{ra} vs {rbn}")
        st.plotly_chart(ch.lines(rc, {rc.columns[0]: colors[ra]}, "Rolling 52-week correlation",
                                 height=280), width="stretch")

# --------------------------------------------------------------------------- #
# 4. Rolling returns
# --------------------------------------------------------------------------- #
with tabs[3]:
    st.markdown("Rolling returns show **every** holding period of a given length, not just "
                "one lucky start date — the way Indian fund factsheets should be read.")
    r1, r2 = st.columns([1, 3])
    win = r1.select_slider("Holding period (years)", [1, 2, 3, 5, 7, 10, 15], value=5)
    target = r1.number_input("Target CAGR %", 0.0, 40.0, 12.0, 0.5)
    rc_wide = pd.DataFrame({n: an.rolling_cagr(s, win) * 100 for n, s in closes.items()})
    if rc_wide.dropna(how="all").empty:
        st.warning(f"Need more than {win} years of data. Load a longer period.")
    else:
        r2.plotly_chart(ch.lines(rc_wide, colors, f"Rolling {win}-year CAGR", pct=True), width="stretch")
        stats = pd.DataFrame({
            n: {
                "Periods": int(s.dropna().shape[0]),
                "Min %": s.min(), "Median %": s.median(), "Max %": s.max(),
                "% negative": (s < 0).mean() * 100,
                f"% ≥ {target:g}%": (s >= target).mean() * 100,
                "Latest %": s.dropna().iloc[-1] if s.notna().any() else np.nan,
            } for n, s in rc_wide.items()
        }).T
        st.dataframe(pct_style(stats), width="stretch")
        sel_r = st.selectbox("Full rolling table for", names, key="rr_sel")
        st.dataframe(pct_style(an.rolling_summary(closes[sel_r])), width="stretch")

# --------------------------------------------------------------------------- #
# 5. SIP simulator
# --------------------------------------------------------------------------- #
with tabs[4]:
    s1, s2, s3, s4 = st.columns(4)
    sip_idx = s1.selectbox("Invest in", names, key="sip_idx")
    amt = s2.number_input("Monthly amount (₹)", 500, 1_000_000, 10_000, 500)
    dom = s3.number_input("SIP date (day of month)", 1, 28, 5)
    step = s4.number_input("Annual step-up %", 0.0, 50.0, 0.0, 5.0)
    sc = closes[sip_idx]
    sd = st.slider("SIP start", sc.index[0].date(), (sc.index[-1] - pd.DateOffset(months=13)).date(),
                   sc.index[0].date(), format="MMM YYYY") if len(sc) > 300 else sc.index[0].date()
    ledger, stt = an.sip_backtest(sc, amt, dom, step, start=pd.Timestamp(sd))
    if not stt:
        st.warning("Not enough data for a SIP simulation.")
    else:
        k = st.columns(5)
        k[0].metric(f"Invested ({stt['Instalments']} SIPs)", inr(stt["Total invested"]))
        k[1].metric("Value today", inr(stt["Final value"]), f"{stt['Absolute return %']:+.1f}%")
        k[2].metric("SIP XIRR", f"{stt['SIP XIRR %']:.2f}%")
        k[3].metric(f"Lump sum (CAGR {stt['Lump-sum CAGR %']:.1f}%)", inr(stt["Lump-sum final value"]))
        k[4].metric("Worst point vs invested", f"{stt['Worst SIP drawdown %']:.1f}%",
                    help="Lowest portfolio value relative to the money put in so far")
        st.plotly_chart(ch.sip_chart(ledger, colors[sip_idx]), width="stretch")
        st.caption("Lump sum = the same total amount invested entirely on the first SIP date. "
                   "Ignores taxes, expense ratio and tracking error; index is price-only (no dividends).")
        monthly_ledger = ledger.resample("ME").last()
        st.download_button("⬇ SIP ledger (monthly, CSV)", monthly_ledger.to_csv(float_format="%.2f"),
                           f"sip_{tick_of.get(sip_idx, sip_idx)}.csv")

# --------------------------------------------------------------------------- #
# 6. Seasonality
# --------------------------------------------------------------------------- #
with tabs[5]:
    ss = st.selectbox("Index", names, key="sea_sel")
    sea = an.seasonality(closes[ss])
    a, b = st.columns([3, 2])
    a.plotly_chart(ch.bars(sea["Avg %"], "Average return by calendar month"), width="stretch")
    b.dataframe(pct_style(sea), width="stretch", height=460)
    wd = an.weekday_stats(closes[ss])
    a2, b2 = st.columns([3, 2])
    a2.plotly_chart(ch.bars(wd["Avg %"], "Average daily return by weekday", height=280), width="stretch")
    b2.dataframe(pct_style(wd, 3), width="stretch")
    st.caption("Seasonal patterns are small relative to noise — check 'Positive %' and 'Years' "
               "before reading anything into them.")

# --------------------------------------------------------------------------- #
# 7. Data quality
# --------------------------------------------------------------------------- #
with tabs[6]:
    dq = pd.DataFrame({n: an.data_quality(f, tick_of.get(n, "") not in NO_VOLUME)
                       for n, f in frames.items()})
    st.dataframe(fmt_table(dq), width="stretch", height=36 * (len(dq) + 1) + 4)
    st.caption("Coverage below ~95% of weekdays is normal (exchange holidays). Watch for long gaps, "
               "unchanged-close runs and OHLC inconsistencies — they point to bad source data.")
    q1, q2 = st.columns([1, 3])
    qsel = q1.selectbox("Big moves in", names, key="dq_sel")
    thr = q1.slider("Threshold %", 2.0, 15.0, 5.0, 0.5)
    q2.dataframe(pct_style(an.big_moves(closes[qsel], thr / 100)), width="stretch", height=300)

# --------------------------------------------------------------------------- #
# 8. Cache
# --------------------------------------------------------------------------- #
with tabs[7]:
    inv = data.cache_inventory()
    st.markdown(f"Cache folder: `{data.CACHE_ROOT}`")
    if inv.empty:
        st.info("Cache is empty.")
    else:
        st.dataframe(inv, width="stretch", hide_index=True)
    c1, c2, c3 = st.columns(3)
    if c1.button("🔄 Update everything in cache", width="stretch", disabled=inv.empty):
        with st.spinner("Fetching new days…"):
            for _, row in inv.iterrows():
                try:
                    data.get_data(row["Ticker"], row["First date"], None, source=row["Source"])
                except Exception as e:  # noqa: BLE001
                    st.warning(f"{row['Ticker']}: {e}")
        st.rerun()
    if c2.button("🗑 Clear demo cache", width="stretch"):
        data.clear_cache(source="demo")
        st.rerun()
    if c3.button("🗑 Clear ALL cache", width="stretch"):
        data.clear_cache()
        st.rerun()

    st.divider()
    st.markdown("**Check which catalogue tickers Yahoo currently serves**")
    if st.button("Run ticker check"):
        rows = []
        prog = st.progress(0.0)
        items = list(TICKER_TO_NAME.items())
        for i, (t, n) in enumerate(items):
            ok, msg = data.check_ticker(t, source)
            rows.append({"Index": n, "Ticker": t, "OK": "✅" if ok else "❌", "Detail": msg})
            prog.progress((i + 1) / len(items))
        prog.empty()
        st.dataframe(pd.DataFrame(rows), width="stretch", hide_index=True)
