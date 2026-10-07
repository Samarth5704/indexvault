"""Small thread-safe LRU memo for in-process caching of heavy results.

Callers build keys that include each input cache file's mtime, so a cache
update invalidates dependent entries automatically.
"""
from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Callable, Hashable
from typing import Any

_MISSING = object()


class Memo:
    def __init__(self, maxsize: int = 256):
        self.maxsize = maxsize
        self._data: OrderedDict[Hashable, Any] = OrderedDict()
        self._lock = threading.Lock()
        self.hits = self.misses = 0

    def get(self, key: Hashable, default: Any = None) -> Any:
        with self._lock:
            if key in self._data:
                self._data.move_to_end(key)
                self.hits += 1
                return self._data[key]
            self.misses += 1
            return default

    def set(self, key: Hashable, value: Any) -> None:
        with self._lock:
            self._data[key] = value
            self._data.move_to_end(key)
            while len(self._data) > self.maxsize:
                self._data.popitem(last=False)

    def get_or_compute(self, key: Hashable, fn: Callable[[], Any]) -> Any:
        """Computed outside the lock: two threads may both compute a missing key."""
        value = self.get(key, _MISSING)
        if value is _MISSING:
            value = fn()
            self.set(key, value)
        return value

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def __len__(self) -> int:
        return len(self._data)
