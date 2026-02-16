"""Shared circuit breaker for external service calls.

Used by both FallbackTTSService and V2Client to skip calls to
down services for a cooldown period after repeated failures.
"""

import logging
import time
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class CircuitBreaker:
    """Simple circuit breaker: closed -> open (after N failures) -> half-open (after cooldown)."""

    failure_threshold: int = 3
    cooldown_seconds: float = 60.0
    label: str = "service"

    _consecutive_failures: int = field(default=0, init=False, repr=False)
    _opened_at: Optional[float] = field(default=None, init=False, repr=False)

    def should_try(self) -> bool:
        if self._consecutive_failures < self.failure_threshold:
            return True  # closed
        # open — check if cooldown elapsed (half-open)
        if self._opened_at and (time.monotonic() - self._opened_at) >= self.cooldown_seconds:
            return True  # half-open probe
        return False

    def should_try_primary(self) -> bool:
        """Alias for should_try() — used by TTS fallback tests."""
        return self.should_try()

    def record_success(self) -> None:
        self._consecutive_failures = 0
        self._opened_at = None

    def record_failure(self) -> None:
        self._consecutive_failures += 1
        if self._consecutive_failures >= self.failure_threshold and self._opened_at is None:
            self._opened_at = time.monotonic()
            logger.warning(
                "Circuit breaker OPENED for %s after %d consecutive failures — "
                "skipping for %.0fs",
                self.label,
                self._consecutive_failures,
                self.cooldown_seconds,
            )
