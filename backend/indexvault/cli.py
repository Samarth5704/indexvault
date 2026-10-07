"""Command-line access — handy for scripts, cron jobs and your backtester.

Examples
    python -m indexvault.cli list
    python -m indexvault.cli fetch ^NSEI ^NSEBANK --start 2005-01-01 --freq Monthly --out nifty.xlsx
    python -m indexvault.cli update           # refresh everything already cached
    python -m indexvault.cli stats ^NSEI --start 2010-01-01
"""
from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

from . import analytics as an
from . import data
from .indices import CATALOG, display_name


def main(argv=None):
    p = argparse.ArgumentParser(prog="indexvault")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="show the index catalogue")

    f = sub.add_parser("fetch", help="download tickers and export")
    f.add_argument("tickers", nargs="+")
    f.add_argument("--start", default=None)
    f.add_argument("--end", default=None)
    f.add_argument("--freq", default="Daily", choices=list(data.FREQUENCIES))
    f.add_argument("--out", default=None, help=".xlsx, .csv (single ticker) or .zip")
    f.add_argument("--source", default="yahoo", choices=list(data.SOURCES))

    u = sub.add_parser("update", help="incrementally update every cached ticker")
    u.add_argument("--source", default="yahoo", choices=list(data.SOURCES))

    s = sub.add_parser("stats", help="print summary statistics")
    s.add_argument("ticker")
    s.add_argument("--start", default=None)
    s.add_argument("--rf", type=float, default=6.5)
    s.add_argument("--source", default="yahoo", choices=list(data.SOURCES))

    a = p.parse_args(argv)

    if a.cmd == "list":
        for cat, items in CATALOG.items():
            print(f"\n{cat}")
            for name, t in items.items():
                print(f"  {t:<24} {name}")

    elif a.cmd == "fetch":
        frames = {}
        for t in a.tickers:
            df = data.get_data(t, a.start, a.end, source=a.source)
            print(f"{t:<24} {len(df):>6} rows  {df.index.min().date() if len(df) else '-'} -> "
                  f"{df.index.max().date() if len(df) else '-'}")
            if not df.empty:
                frames[display_name(t)] = data.resample(df, a.freq)
        if a.out and frames:
            out = Path(a.out)
            if out.suffix == ".xlsx":
                out.write_bytes(data.to_excel_bytes(frames))
            elif out.suffix == ".zip":
                out.write_bytes(data.to_csv_zip_bytes(frames))
            else:
                next(iter(frames.values())).to_csv(out, float_format="%.4f")
            print(f"saved -> {out}")

    elif a.cmd == "update":
        inv = data.cache_inventory()
        inv = inv[inv["Source"] == a.source] if not inv.empty else inv
        for _, row in inv.iterrows():
            df = data.get_data(row["Ticker"], row["First date"], None, source=a.source)
            print(f"{row['Ticker']:<24} now to {df.index.max().date()}")
        if inv.empty:
            print("cache is empty")

    elif a.cmd == "stats":
        c = data.get_data(a.ticker, a.start, None, source=a.source)["Close"]
        m = an.summary_metrics(c, a.rf / 100)
        w = max(len(k) for k in m)
        for k, v in m.items():
            print(f"{k:<{w}}  {v:,.2f}" if isinstance(v, float) else f"{k:<{w}}  {v}")


if __name__ == "__main__":
    pd.set_option("display.width", 140)
    main()
