"""IndexVault — download, cache and analyse Indian market index data.

The core modules are plain Python (no Streamlit), so you can import them
from notebooks or from your backtesting engine:

    from indexvault.data import get_data, resample
    from indexvault import analytics as an

    df = get_data("^NSEI", start="2010-01-01")
    print(an.summary_metrics(df["Close"]))
"""

__version__ = "1.0.0"
