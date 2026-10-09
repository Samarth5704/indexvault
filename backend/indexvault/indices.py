"""Catalogue of Indian index tickers, grouped by category.

Most come from Yahoo Finance; NSE indices that Yahoo no longer serves, and every
total return index (TRI), come from niftyindices.com (see `DEFAULT_SOURCE`).

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

# NSE indices on niftyindices.com: catalogue ticker -> (trading name the site's API
# expects, long name). From the site's own IndexMapping.json (checked 2026-10-09).
NSE_NAMES: dict[str, tuple[str, str]] = {
    "^NSEI": ("Nifty 50", "Nifty 50"),
    "^NSMIDCP": ("Nifty Next 50", "Nifty Next 50"),
    "^CNX100": ("Nifty 100", "Nifty 100"),
    "^CNX200": ("Nifty 200", "Nifty 200"),
    "^CRSLDX": ("Nifty 500", "Nifty 500"),
    "NIFTY_MIDCAP_100.NS": ("NIFTY MIDCAP 100", "NIFTY Midcap 100"),
    "^CNXSC": ("NIFTY SMLCAP 100", "Nifty Smallcap 100"),
    "^NSEBANK": ("Nifty Bank", "Nifty Bank"),
    "NIFTY_FIN_SERVICE.NS": ("Nifty Fin Service", "Nifty Financial Services"),
    "^CNXPSUBANK": ("Nifty PSU Bank", "Nifty PSU Bank"),
    "^CNXIT": ("Nifty IT", "Nifty IT"),
    "^CNXAUTO": ("Nifty Auto", "Nifty Auto"),
    "^CNXFMCG": ("Nifty FMCG", "Nifty FMCG"),
    "^CNXPHARMA": ("Nifty Pharma", "Nifty Pharma"),
    "^CNXMETAL": ("Nifty Metal", "Nifty Metal"),
    "^CNXENERGY": ("Nifty Energy", "Nifty Energy"),
    "^CNXREALTY": ("Nifty Realty", "Nifty Realty"),
    "^CNXMEDIA": ("Nifty Media", "Nifty Media"),
    "^CNXINFRA": ("Nifty Infra", "Nifty Infrastructure"),
    "^CNXPSE": ("Nifty PSE", "Nifty PSE"),
    "^CNXMNC": ("Nifty MNC", "Nifty MNC"),
    "^CNXCONSUM": ("Nifty Consumption", "Nifty India Consumption"),
    "^CNXSERVICE": ("Nifty Serv Sector", "Nifty Services Sector"),
    "^CNXCMDT": ("Nifty Commodities", "Nifty Commodities"),
}

# Total return indices (gross, dividends reinvested) from niftyindices.com, one per
# NSE index above. Ticker = price ticker + "-TRI". They are separate series, never
# mixed with the price index.
TRI_SUFFIX = "-TRI"
_NSE_DISPLAY = {t: n for group in CATALOG.values() for n, t in group.items() if t in NSE_NAMES}
CATALOG["Total return (TRI)"] = {f"{_NSE_DISPLAY[t]} TRI": t + TRI_SUFFIX for t in NSE_NAMES}

# Built-in tickers whose default source is not the global one. Yahoo now returns only
# the latest bar for these indices (checked 2026-10-09), so they come from NSE; TRI
# exists only on NSE. Users can still override per ticker (CSV import, catalogue).
DEFAULT_SOURCE: dict[str, str] = {
    **{t: "nse" for t in ("^CNXAUTO", "^CNXFMCG", "^CNXMETAL", "^CNXENERGY", "^CNXREALTY",
                          "^CNXMEDIA", "^CNXINFRA", "^CNXPSUBANK", "^CNXSC",
                          "NIFTY_MIDCAP_100.NS", "NIFTY_FIN_SERVICE.NS")},
    **{t + TRI_SUFFIX: "nse" for t in NSE_NAMES},
}


def series_kind(ticker: str) -> str:
    """'tri' for total return series, else 'price'."""
    return "tri" if ticker.endswith(TRI_SUFFIX) else "price"


# Flat lookups
TICKER_TO_NAME: dict[str, str] = {
    t: n for group in CATALOG.values() for n, t in group.items()
}
NAME_TO_TICKER: dict[str, str] = {n: t for t, n in TICKER_TO_NAME.items()}

# Tickers whose "volume" on Yahoo is always zero or meaningless
NO_VOLUME = ({t for t in TICKER_TO_NAME if t.startswith("^") or t.endswith(TRI_SUFFIX)} | {"INR=X"})


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
