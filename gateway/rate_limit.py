from __future__ import annotations

import math
import threading
import time
from collections import defaultdict, deque


class RateLimitExceeded(Exception):
    def __init__(self, retry_after: int):
        super().__init__("请求过于频繁")
        self.retry_after = max(1, retry_after)


class RateLimiter:
    """Small in-process sliding-window limiter.

    The gateway intentionally runs with a single worker, so an in-memory limiter is
    sufficient for the current deployment model. Reverse-proxy rate limits remain
    recommended as an outer layer.
    """

    def __init__(self) -> None:
        self._buckets: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str, *, limit: int, window_seconds: int) -> None:
        now = time.monotonic()
        cutoff = now - window_seconds
        with self._lock:
            bucket = self._buckets[key]
            while bucket and bucket[0] <= cutoff:
                bucket.popleft()
            if len(bucket) >= limit:
                retry_after = math.ceil(bucket[0] + window_seconds - now)
                raise RateLimitExceeded(retry_after)
            bucket.append(now)


def client_key(request) -> str:
    client = getattr(request, "client", None)
    host = getattr(client, "host", None)
    return host or "unknown"
