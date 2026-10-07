"""FastAPI app: JSON API under /api, the static frontend at /.

Run from backend/:  .venv\\Scripts\\python -m uvicorn api.main:app --reload --port 8000
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from indexvault import __version__

from . import errors
from .catalog import CatalogStore
from .context import AppContext
from .jsonutil import JSONResponse
from .routers import analytics, cache, compare, export, series, settings, sip
from .settings_store import SettingsStore
from .storage import PROJECT_ROOT

FRONTEND_DIR = PROJECT_ROOT / "frontend"


def create_app(config_dir: Path | None = None, frontend_dir: Path | None = FRONTEND_DIR) -> FastAPI:
    """Build the app. Tests pass a temporary `config_dir`."""
    settings_store = SettingsStore(config_dir / "settings.json" if config_dir else None)
    catalog_store = CatalogStore(config_dir / "catalog.json" if config_dir else None)
    ctx = AppContext(settings_store, catalog_store)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        ctx.jobs.shutdown()

    app = FastAPI(title="IndexVault API", version=__version__, default_response_class=JSONResponse,
                  lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)
    app.state.ctx = ctx
    errors.install(app)
    for module in (settings, series, analytics, compare, sip, export, cache):
        app.include_router(module.router, prefix="/api")
    if frontend_dir is not None and frontend_dir.is_dir():
        app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
    return app


_app: FastAPI | None = None


def __getattr__(name: str):
    """`api.main.app` is built on first access (uvicorn's "api.main:app"), so
    importing this module — e.g. in tests — doesn't touch the real config/cache."""
    global _app
    if name == "app":
        if _app is None:
            _app = create_app()
        return _app
    raise AttributeError(name)
