"""Consistent error envelope for every failure:

    {"error": {"code": "not_found", "message": "…", "detail": {...}}}
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from .jsonutil import JSONResponse

log = logging.getLogger("indexvault.api")

_STATUS_CODES = {400: "bad_request", 404: "not_found", 405: "method_not_allowed",
                 409: "conflict", 413: "too_large", 422: "validation_error",
                 502: "source_error", 500: "internal_error"}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, detail: Any = None):
        super().__init__(message)
        self.status, self.code, self.message, self.detail = status, code, message, detail


def bad_request(message: str, **detail) -> ApiError:
    return ApiError(400, "bad_request", message, detail or None)


def not_found(message: str, **detail) -> ApiError:
    return ApiError(404, "not_found", message, detail or None)


def conflict(message: str, **detail) -> ApiError:
    return ApiError(409, "conflict", message, detail or None)


def envelope(status: int, code: str, message: str, detail: Any = None) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message, "detail": detail}}, status_code=status)


def _validation_detail(errors: list[dict]) -> list[dict]:
    return [{"loc": list(e.get("loc", ())), "msg": e.get("msg", ""), "type": e.get("type", "")}
            for e in errors]


def install(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, e: ApiError):
        return envelope(e.status, e.code, e.message, e.detail)

    @app.exception_handler(RequestValidationError)
    async def _request_invalid(_: Request, e: RequestValidationError):
        return envelope(422, "validation_error", "Request is invalid.", _validation_detail(e.errors()))

    @app.exception_handler(ValidationError)
    async def _model_invalid(_: Request, e: ValidationError):
        return envelope(422, "validation_error", "Values are invalid.", _validation_detail(e.errors()))

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, e: StarletteHTTPException):
        code = _STATUS_CODES.get(e.status_code, "http_error")
        message = e.detail if isinstance(e.detail, str) else code.replace("_", " ").capitalize()
        return envelope(e.status_code, code, message)

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, e: Exception):
        log.exception("unhandled error")
        return envelope(500, "internal_error", "Something went wrong on the server.",
                        {"type": type(e).__name__, "message": str(e)[:300]})
