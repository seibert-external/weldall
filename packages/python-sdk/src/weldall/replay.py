"""Replay-store implementations and fail-closed consumption."""

from __future__ import annotations

import threading
import warnings
from datetime import UTC, datetime

from .errors import WeldallAuthError
from .types import Replay, ReplayStore

_warned = False
_warn_lock = threading.Lock()


class InMemoryReplayStore:
    def __init__(self, max_entries: int) -> None:
        self._max_entries = max_entries
        self._values: dict[str, float] = {}
        self._lock = threading.Lock()

    def consume(self, key: str, expires_at: datetime) -> bool:
        now = datetime.now(UTC).timestamp()
        try:
            expiry = expires_at.timestamp()
        except (ValueError, OverflowError, OSError):
            return False
        with self._lock:
            self._values = {candidate: end for candidate, end in self._values.items() if end > now}
            if not key or expiry <= now:
                return False
            if key in self._values:
                return False
            if len(self._values) >= self._max_entries:
                raise RuntimeError("replay store capacity reached")
            self._values[key] = expiry
            return True


def in_memory(max_entries: int = 10_000, suppress_warning: bool = False) -> ReplayStore:
    global _warned
    if isinstance(max_entries, bool) or not isinstance(max_entries, int) or max_entries < 1:
        raise TypeError("max_entries must be a positive integer")
    if not suppress_warning:
        with _warn_lock:
            if not _warned:
                _warned = True
                warnings.warn(
                    "weldall-sdk: in_memory() replay protection is process-local and is not safe "
                    "for horizontally scaled deployments",
                    RuntimeWarning,
                    stacklevel=2,
                )
    return InMemoryReplayStore(max_entries)


def consume_replay(
    store: Replay,
    namespace: str,
    key: str,
    expires_at: datetime,
    replay_error: dict[str, object],
) -> None:
    if store == "disabled":
        return
    try:
        first = store.consume(f"{namespace}:{key}", expires_at)
    except Exception as error:
        raise WeldallAuthError(
            "temporarily_unavailable", "replay protection unavailable", 503
        ) from error
    if not first:
        raw_status = replay_error.get("status", 400)
        status = raw_status if isinstance(raw_status, int) else 400
        raise WeldallAuthError(
            str(replay_error["code"]),
            str(replay_error["message"]),
            status,
            reason="replay_detected",
        )
