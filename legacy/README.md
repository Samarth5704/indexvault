# Legacy prototype (reference only)

`streamlit_app.py` and `charts.py` are the first working prototype of IndexVault.
They are **not** part of the new app. Use them only as a reference for:

- which features exist and how each tab behaves
- the validated chart palette (`charts.py`, `SERIES` list)
- formatting helpers (Indian ₹ lakh/crore in `inr()`)

Do not import from this folder. Port behaviour into `backend/` and `frontend/` instead.
Delete this folder at the end of Milestone 9.
