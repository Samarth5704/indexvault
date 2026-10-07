"""Background jobs (bulk downloads, cache updates) with per-ticker progress.

A job runs one callable per ticker in a worker thread, sleeping
`throttle_seconds` between network calls. Clients poll `GET /jobs/{id}` or
follow `GET /jobs/{id}/stream` (server-sent events, stdlib only).
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
import uuid
from collections import OrderedDict
from collections.abc import AsyncIterator, Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any

from .jsonutil import jsonable

Work = Callable[[str], dict[str, Any]]  # ticker -> result fields (rows, first, last, …)


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


class Job:
    def __init__(self, kind: str, tickers: list[str]):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.status = "queued"            # queued | running | done | failed
        self.created = _now()
        self.started: str | None = None
        self.finished: str | None = None
        self.items: dict[str, dict[str, Any]] = {t: {"ticker": t, "status": "pending"} for t in tickers}
        self.version = 0                  # bumped on every change, drives SSE

    def snapshot(self) -> dict[str, Any]:
        items = list(self.items.values())
        done = sum(i["status"] in ("done", "error") for i in items)
        return jsonable({
            "id": self.id, "kind": self.kind, "status": self.status,
            "created": self.created, "started": self.started, "finished": self.finished,
            "total": len(items), "completed": done,
            "errors": sum(i["status"] == "error" for i in items),
            "progress": done / len(items) if items else 1.0,
            "items": [dict(i) for i in items],
        })


class JobManager:
    def __init__(self, max_workers: int = 2, keep: int = 50):
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="iv-job")
        self._jobs: OrderedDict[str, Job] = OrderedDict()
        self._lock = threading.Lock()
        self._keep = keep

    def submit(self, kind: str, tickers: list[str], work: Work, throttle_seconds: float = 0.0) -> dict:
        job = Job(kind, tickers)
        with self._lock:
            self._jobs[job.id] = job
            while len(self._jobs) > self._keep:
                self._jobs.popitem(last=False)
        self._pool.submit(self._run, job, work, throttle_seconds)
        return job.snapshot()

    def _update(self, job: Job, ticker: str | None = None, **fields) -> None:
        with self._lock:
            if ticker is None:
                for k, v in fields.items():
                    setattr(job, k, v)
            else:
                job.items[ticker].update(fields)
            job.version += 1

    def _run(self, job: Job, work: Work, throttle: float) -> None:
        self._update(job, status="running", started=_now())
        tickers = list(job.items)
        for n, ticker in enumerate(tickers):
            self._update(job, ticker, status="running")
            try:
                result = work(ticker)
                self._update(job, ticker, status="done", **result)
            except Exception as e:  # noqa: BLE001 — reported per ticker
                self._update(job, ticker, status="error", message=str(e)[:300] or type(e).__name__)
            if throttle and n < len(tickers) - 1:
                time.sleep(throttle)
        failed = bool(job.items) and all(i["status"] == "error" for i in job.items.values())
        self._update(job, status="failed" if failed else "done", finished=_now())

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return job.snapshot() if job else None

    def is_busy(self) -> bool:
        with self._lock:
            return any(j.status in ("queued", "running") for j in self._jobs.values())

    def wait(self, job_id: str, timeout: float = 30.0) -> dict | None:
        """Block until the job finishes (used by tests and the CLI-style callers)."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            snap = self.get(job_id)
            if snap is None or snap["status"] in ("done", "failed"):
                return snap
            time.sleep(0.02)
        return self.get(job_id)

    async def stream(self, job_id: str, poll_seconds: float = 0.15) -> AsyncIterator[str]:
        """SSE events: `progress` on every change, then one `done`."""
        seen = -1
        while True:
            with self._lock:
                job = self._jobs.get(job_id)
                version = job.version if job else None
            if job is None:
                yield _sse("error", {"message": "job not found"})
                return
            if version != seen:
                seen = version
                snap = self.get(job_id)
                finished = snap["status"] in ("done", "failed")
                yield _sse("done" if finished else "progress", snap)
                if finished:
                    return
            await asyncio.sleep(poll_seconds)

    def shutdown(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)


def _sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"
