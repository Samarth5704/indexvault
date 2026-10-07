"""Health, settings and catalogue routes."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, Query
from fastapi.responses import Response

from indexvault import __version__, data

from ..catalog import CatalogFile
from ..context import AppContext, get_ctx
from ..errors import bad_request, conflict, not_found
from ..jsonutil import JSONResponse, JsonableRoute
from ..settings import SECTIONS
from ..settings_store import MigrationError, parse_settings

router = APIRouter(route_class=JsonableRoute)

BACKUP_KIND = "indexvault-backup"


# --------------------------------------------------------------------------- #
# Health
# --------------------------------------------------------------------------- #
@router.get("/health")
def health(check: bool = Query(False, description="Also probe the default source with ^NSEI (slow for Yahoo)."),
           ctx: AppContext = Depends(get_ctx)):
    s = ctx.settings
    out: dict[str, Any] = {
        "status": "ok",
        "version": __version__,
        "source": s.data.source,
        "sources": [vars(i) for i in data.available_sources()],
        "cache_dir": str(data.get_cache_root()),
        "jobs_running": ctx.jobs.is_busy(),
        "warnings": ctx.warnings(),
    }
    if check:
        ok, message = data.check_ticker("^NSEI", s.data.source)
        out["source_check"] = {"ok": ok, "message": message}
    return out


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #
def _guard_cache_dir(ctx: AppContext, new_data: dict | None) -> None:
    """Moving the cache while a job writes to it would split the data."""
    if new_data and "cache_dir" in new_data and new_data["cache_dir"] != ctx.settings.data.cache_dir \
            and ctx.jobs.is_busy():
        raise conflict("Can't change the cache folder while a download job is running.")


@router.get("/settings")
def get_settings(ctx: AppContext = Depends(get_ctx)):
    return ctx.settings


@router.put("/settings")
def put_settings(body: dict = Body(...), ctx: AppContext = Depends(get_ctx)):
    _guard_cache_dir(ctx, body.get("data"))
    return ctx.settings_store.replace(body)


@router.get("/settings/schema")
def settings_schema(ctx: AppContext = Depends(get_ctx)):
    return ctx.settings_store.schema()


@router.get("/settings/backup")
def settings_backup(ctx: AppContext = Depends(get_ctx)):
    """Settings + catalogue (custom indices, watchlists) + dashboard in one file."""
    payload = {"kind": BACKUP_KIND, "version": 1,
               "created": datetime.now().isoformat(timespec="seconds"),
               "settings": ctx.settings.model_dump(mode="json"),
               "catalog": ctx.catalog.get().model_dump(mode="json")}
    name = f"indexvault-backup-{datetime.now():%Y%m%d-%H%M}.json"
    return JSONResponse(payload, headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.post("/settings/restore")
def settings_restore(body: dict = Body(...), ctx: AppContext = Depends(get_ctx)):
    """Restore a backup. Older settings schemas are migrated. All-or-nothing."""
    if body.get("kind") != BACKUP_KIND:
        raise bad_request("Not an IndexVault backup file.")
    try:
        settings = parse_settings(body.get("settings"))
    except MigrationError as e:
        raise bad_request(str(e)) from None
    catalog = CatalogFile.model_validate(body.get("catalog") or {})
    _guard_cache_dir(ctx, settings.data.model_dump())
    ctx.settings_store.replace(settings)
    ctx.catalog.replace(catalog)
    return {"settings": ctx.settings, "catalog": ctx.catalog.merged()}


@router.post("/settings/reset")
def settings_reset(section: str | None = None, ctx: AppContext = Depends(get_ctx)):
    if section is not None and section not in SECTIONS:
        raise not_found(f"Unknown settings section {section!r}.", sections=list(SECTIONS))
    if section in (None, "data"):
        _guard_cache_dir(ctx, {"cache_dir": "backend/data_cache"})
    return ctx.settings_store.reset(section)


@router.patch("/settings/{section}")
def patch_settings(section: str, body: Any = Body(...), ctx: AppContext = Depends(get_ctx)):
    if section not in SECTIONS:
        raise not_found(f"Unknown settings section {section!r}.", sections=list(SECTIONS))
    if not isinstance(body, dict):
        raise bad_request("Body must be a JSON object.")
    if section == "data":
        _guard_cache_dir(ctx, body)
    return ctx.settings_store.patch_section(section, body)


# --------------------------------------------------------------------------- #
# Catalogue
# --------------------------------------------------------------------------- #
@router.get("/catalog")
def get_catalog(ctx: AppContext = Depends(get_ctx)):
    return ctx.catalog.merged()


def _exists(items, id: str) -> bool:
    return any(i.id == id for i in items)


@router.post("/catalog/indices/{id}", status_code=201)
def create_index(id: str, body: dict = Body(...), ctx: AppContext = Depends(get_ctx)):
    if _exists(ctx.catalog.get().custom_indices, id):
        raise conflict(f"Custom index {id!r} already exists; use PUT to replace it.")
    return ctx.catalog.upsert_index(id, body)


@router.put("/catalog/indices/{id}")
def put_index(id: str, body: dict = Body(...), ctx: AppContext = Depends(get_ctx)):
    return ctx.catalog.upsert_index(id, body)


@router.delete("/catalog/indices/{id}", status_code=204)
def delete_index(id: str, ctx: AppContext = Depends(get_ctx)):
    try:
        ctx.catalog.delete_index(id)
    except KeyError:
        raise not_found(f"No custom index {id!r}.") from None
    return Response(status_code=204)


@router.put("/catalog/watchlists/order")
def reorder_watchlists(body: dict = Body(..., examples=[{"ids": ["core", "sectors"]}]),
                       ctx: AppContext = Depends(get_ctx)):
    try:
        return ctx.catalog.reorder_watchlists(list(body.get("ids") or []))
    except ValueError as e:
        raise bad_request(str(e)) from None


@router.post("/catalog/watchlists/{id}", status_code=201)
def create_watchlist(id: str, body: dict = Body(...), ctx: AppContext = Depends(get_ctx)):
    if _exists(ctx.catalog.get().watchlists, id):
        raise conflict(f"Watchlist {id!r} already exists; use PUT to replace it.")
    return ctx.catalog.upsert_watchlist(id, body)


@router.put("/catalog/watchlists/{id}")
def put_watchlist(id: str, body: dict = Body(...), ctx: AppContext = Depends(get_ctx)):
    return ctx.catalog.upsert_watchlist(id, body)


@router.delete("/catalog/watchlists/{id}", status_code=204)
def delete_watchlist(id: str, ctx: AppContext = Depends(get_ctx)):
    try:
        ctx.catalog.delete_watchlist(id)
    except KeyError:
        raise not_found(f"No watchlist {id!r}.") from None
    return Response(status_code=204)
