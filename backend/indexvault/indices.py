"""Catalogue of Indian index tickers on Yahoo Finance, grouped by category.

Yahoo occasionally renames or retires index symbols. Use the "Check tickers"
button in the app's Cache tab (or `data.check_ticker`) to confirm which ones
return data, and add any other Yahoo symbol via the custom-ticker box.
"""

from collections.abc import Iterable, Mapping

CATALOG: dict[str, dict[str, str]] = {
    "Broad market": {
        "NIFTY 50": "^NSEI",
        "BSE SENSEX": "^BSESN",
        "NIFTY Next 50": "^NSMIDCP",
        "NIFTY 100": "^CNX100",
        "NIFTY 200": "^CNX200",
        "NIFTY 500": "^CRSLDX",
        "NIFTY Midcap 100": "NIFTY_MIDCAP_100.NS",
        "NIFTY Smallcap 100": "^CNXSC",
    },
    "Sectoral": {
        "NIFTY Bank": "^NSEBANK",
        "NIFTY Financial Services": "NIFTY_FIN_SERVICE.NS",
        "NIFTY PSU Bank": "^CNXPSUBANK",
        "NIFTY IT": "^CNXIT",
        "NIFTY Auto": "^CNXAUTO",
        "NIFTY FMCG": "^CNXFMCG",
        "NIFTY Pharma": "^CNXPHARMA",
        "NIFTY Metal": "^CNXMETAL",
        "NIFTY Energy": "^CNXENERGY",
        "NIFTY Realty": "^CNXREALTY",
        "NIFTY Media": "^CNXMEDIA",
        "NIFTY Infrastructure": "^CNXINFRA",
    },
    "Thematic": {
        "NIFTY PSE": "^CNXPSE",
        "NIFTY MNC": "^CNXMNC",
        "NIFTY India Consumption": "^CNXCONSUM",
        "NIFTY Services Sector": "^CNXSERVICE",
        "NIFTY Commodities": "^CNXCMDT",
    },
    "Volatility": {
        "India VIX": "^INDIAVIX",
    },
    "ETFs (tradable proxies)": {
        "Nippon Nifty BeES": "NIFTYBEES.NS",
        "Nippon Bank BeES": "BANKBEES.NS",
        "Nippon Gold BeES": "GOLDBEES.NS",
    },
    "Global & macro (for comparison)": {
        "S&P 500": "^GSPC",
        "NASDAQ Composite": "^IXIC",
        "USD/INR": "INR=X",
        "Gold futures (USD)": "GC=F",
        "Brent crude": "BZ=F",
    },
}

# Flat lookups
TICKER_TO_NAME: dict[str, str] = {
    t: n for group in CATALOG.values() for n, t in group.items()
}
NAME_TO_TICKER: dict[str, str] = {n: t for t, n in TICKER_TO_NAME.items()}

# Tickers whose "volume" on Yahoo is always zero or meaningless
NO_VOLUME = {t for t in TICKER_TO_NAME if t.startswith("^")} | {"INR=X"}


def display_name(ticker: str, extra: Mapping[str, str] | None = None) -> str:
    """Friendly name for a ticker; `extra` (ticker -> name) is checked first."""
    if extra and ticker in extra:
        return extra[ticker]
    return TICKER_TO_NAME.get(ticker, ticker)


def has_volume(ticker: str) -> bool:
    """False for indices (Yahoo "^" symbols) and FX, whose volume is always zero."""
    return ticker not in NO_VOLUME and not ticker.startswith("^")


def merge_catalog(custom: Iterable[Mapping[str, str]] = ()) -> dict[str, dict[str, str]]:
    """Built-in CATALOG plus custom entries, each a mapping with "name",
    "ticker" and "category". Built-in categories keep their order; new
    categories follow in first-seen order. A custom entry with the same name
    as a built-in in the same category replaces it."""
    out = {cat: dict(items) for cat, items in CATALOG.items()}
    for e in custom:
        out.setdefault(e["category"], {})[e["name"]] = e["ticker"]
    return out
