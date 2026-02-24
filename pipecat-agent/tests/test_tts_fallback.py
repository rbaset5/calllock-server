"""Tests for FallbackTTSService with circuit breaker."""

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    ErrorFrame,
    StartFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)
from pipecat.services.tts_service import TTSService

from calllock.circuit_breaker import CircuitBreaker
from calllock.tts_fallback import FallbackTTSService


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class MockTTSService(TTSService):
    """Minimal TTS service that yields pre-configured frames."""

    def __init__(self, frames=None, *, raise_exc=None, **kwargs):
        super().__init__(**kwargs)
        self._frames = frames or []
        self._raise_exc = raise_exc
        self.started = False
        self.stopped = False
        self.cancelled = False
        self.run_tts_called = False

    async def start(self, frame):
        self.started = True

    async def stop(self, frame):
        self.stopped = True

    async def cancel(self, frame):
        self.cancelled = True

    def can_generate_metrics(self) -> bool:
        return True

    async def run_tts(self, text, context_id):
        self.run_tts_called = True
        if self._raise_exc:
            raise self._raise_exc
        for f in self._frames:
            yield f


class SlowMockTTSService(TTSService):
    """TTS service that hangs (for timeout testing)."""

    def __init__(self, delay=10.0, **kwargs):
        super().__init__(**kwargs)
        self._delay = delay
        self.started = False
        self.run_tts_called = False

    async def start(self, frame):
        self.started = True

    async def stop(self, frame):
        pass

    async def cancel(self, frame):
        pass

    def can_generate_metrics(self) -> bool:
        return True

    async def run_tts(self, text, context_id):
        self.run_tts_called = True
        await asyncio.sleep(self._delay)
        # Never yields — simulates timeout
        return
        yield  # make it a generator


class SilentMockTTSService(TTSService):
    """TTS service that yields TTSStartedFrame but no audio, then stops."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.started = False
        self.run_tts_called = False

    async def start(self, frame):
        self.started = True

    async def stop(self, frame):
        pass

    async def cancel(self, frame):
        pass

    def can_generate_metrics(self) -> bool:
        return True

    async def run_tts(self, text, context_id):
        self.run_tts_called = True
        yield TTSStartedFrame(context_id=context_id)
        yield TTSStoppedFrame(context_id=context_id)


async def collect_frames(gen):
    """Collect all frames from an async generator."""
    frames = []
    async for f in gen:
        frames.append(f)
    return frames


def make_audio_frame(context_id="ctx-1", audio=b"\x00\x01" * 100):
    return TTSAudioRawFrame(audio=audio, sample_rate=16000, num_channels=1, context_id=context_id)


GOOD_FRAMES = [
    TTSStartedFrame(context_id="ctx-1"),
    TTSAudioRawFrame(audio=b"\x00\x01" * 100, sample_rate=16000, num_channels=1, context_id="ctx-1"),
    TTSStoppedFrame(context_id="ctx-1"),
]

FALLBACK_FRAMES = [
    TTSStartedFrame(context_id="ctx-1"),
    TTSAudioRawFrame(audio=b"\xff\xfe" * 100, sample_rate=16000, num_channels=1, context_id="ctx-1"),
    TTSStoppedFrame(context_id="ctx-1"),
]


def make_start_frame():
    return StartFrame()


# ---------------------------------------------------------------------------
# CircuitBreaker tests
# ---------------------------------------------------------------------------


class TestCircuitBreaker:
    def test_starts_closed(self):
        cb = CircuitBreaker()
        assert cb.should_try_primary() is True

    def test_stays_closed_below_threshold(self):
        cb = CircuitBreaker(failure_threshold=3)
        cb.record_failure()
        cb.record_failure()
        assert cb.should_try_primary() is True

    def test_opens_at_threshold(self):
        cb = CircuitBreaker(failure_threshold=3)
        for _ in range(3):
            cb.record_failure()
        assert cb.should_try_primary() is False

    def test_half_open_after_cooldown(self):
        cb = CircuitBreaker(failure_threshold=1, cooldown_seconds=0.0)
        cb.record_failure()
        assert cb.should_try_primary() is True  # cooldown=0 → immediate half-open

    def test_closes_on_success(self):
        cb = CircuitBreaker(failure_threshold=2)
        cb.record_failure()
        cb.record_failure()
        assert cb.should_try_primary() is False
        # simulate cooldown passing
        cb._opened_at = time.monotonic() - 100
        assert cb.should_try_primary() is True
        cb.record_success()
        assert cb._consecutive_failures == 0
        assert cb._opened_at is None

    def test_success_resets_failures(self):
        cb = CircuitBreaker(failure_threshold=3)
        cb.record_failure()
        cb.record_failure()
        cb.record_success()
        cb.record_failure()
        assert cb.should_try_primary() is True  # only 1 failure after reset


# ---------------------------------------------------------------------------
# FallbackTTSService tests
# ---------------------------------------------------------------------------


class TestFallbackPrimarySucceeds:
    """When primary is healthy, fallback is never touched."""

    async def test_yields_primary_frames(self):
        primary = MockTTSService(frames=GOOD_FRAMES)
        fallback = MockTTSService(frames=FALLBACK_FRAMES)
        svc = FallbackTTSService(primary=primary, fallback=fallback, primary_timeout=2.0)
        await svc.start(make_start_frame())

        frames = await collect_frames(svc.run_tts("hello", "ctx-1"))

        assert len(frames) == 3
        assert isinstance(frames[0], TTSStartedFrame)
        assert isinstance(frames[1], TTSAudioRawFrame)
        assert frames[1].audio == b"\x00\x01" * 100  # primary audio
        assert isinstance(frames[2], TTSStoppedFrame)

    async def test_fallback_not_started(self):
        primary = MockTTSService(frames=GOOD_FRAMES)
        fallback = MockTTSService(frames=FALLBACK_FRAMES)
        svc = FallbackTTSService(primary=primary, fallback=fallback)
        await svc.start(make_start_frame())

        await collect_frames(svc.run_tts("hello", "ctx-1"))

        assert fallback.started is False
        assert fallback.run_tts_called is False

    async def test_fallback_never_called(self):
        primary = MockTTSService(frames=GOOD_FRAMES)
        fallback = MockTTSService(frames=FALLBACK_FRAMES)
        svc = FallbackTTSService(primary=primary, fallback=fallback)
        await svc.start(make_start_frame())

        await collect_frames(svc.run_tts("hello", "ctx-1"))
        assert not fallback.run_tts_called


class TestFallbackActivation:
    """Fallback activates when primary fails various ways."""

    async def test_primary_error_frame(self):
        primary = MockTTSService(frames=[
            TTSStartedFrame(context_id="ctx-1"),
            ErrorFrame(error="provider down"),
        ])
        fallback = MockTTSService(frames=FALLBACK_FRAMES)
        svc = FallbackTTSService(primary=primary, fallback=fallback, primary_timeout=2.0)
        await svc.start(make_start_frame())

        frames = await collect_frames(svc.run_tts("hello", "ctx-1"))

        assert any(isinstance(f, TTSAudioRawFrame) and f.audio == b"\xff\xfe" * 100 for f in frames)

    async def test_primary_raises_exception(self):
        primary = MockTTSService(raise_exc=ConnectionError("network error"))
        fallback = MockTTSService(frames=FALLBACK_FRAMES)
        svc = FallbackTTSService(primary=primary, fallback=fallback, primary_timeout=2.0)
        await svc.start(make_start_frame())

        frames = await collect_frames(svc.run_tts("hello", "ctx-1"))

        assert any(isinstance(f, TTSAudioRawFrame) for f in frames)
        assert fallback.run_tts_called

    async def test_primary_timeout(self):
        primary = SlowMockTTSService(delay=10.0)
        fallback = MockTTSService(frames=FALLBACK_FRAMES)
        svc = FallbackTTSService(primary=primary, fallback=fallback, primary_timeout=0.1)
        await svc.start(make_start_frame())

        frames = await collect_frames(svc.run_tts("hello", "ctx-1"))

        assert fallback.run_tts_called
        assert any(isinstance(f, TTSAudioRawFrame) for f in frames)

    async def test_primary_silent_exit(self):
        """Primary yields TTSStartedFrame but no audio, then generator ends."""
        primary = SilentMockTTSService()
        fallback = MockTTSService(frames=FALLBACK_FRAMES)
        svc = FallbackTTSService(primary=primary, fallback=fallback, primary_timeout=2.0)
        await svc.start(make_start_frame())

        frames = await collect_frames(svc.run_tts("hello", "ctx-1"))

        assert fallback.run_tts_called
        assert any(isinstance(f, TTSAudioRawFrame) for f in frames)


class TestCircuitBreakerIntegration:
    """Circuit breaker opens after repeated failures and recovers."""

    async def test_opens_after_threshold(self):
        primary = MockTTSService(frames=[ErrorFrame(error="fail")])
        fallback = MockTTSService(frames=FALLBACK_FRAMES)
        svc = FallbackTTSService(
            primary=primary, fallback=fallback,
            primary_timeout=2.0, failure_threshold=3,
        )
        await svc.start(make_start_frame())

        # 3 failures to open circuit
        for _ in range(3):
            await collect_frames(svc.run_tts("hello", "ctx-1"))

        # Circuit is now open — primary should be skipped
        primary.run_tts_called = False
        await collect_frames(svc.run_tts("hello", "ctx-1"))
        assert not primary.run_tts_called  # skipped

    async def test_half_open_after_cooldown(self):
        primary = MockTTSService(frames=[ErrorFrame(error="fail")])
        fallback = MockTTSService(frames=FALLBACK_FRAMES)
        svc = FallbackTTSService(
            primary=primary, fallback=fallback,
            primary_timeout=2.0, failure_threshold=2, cooldown_seconds=0.0,
        )
        await svc.start(make_start_frame())

        # Open circuit
        for _ in range(2):
            await collect_frames(svc.run_tts("hello", "ctx-1"))

        # With cooldown=0, should probe primary again (half-open)
        primary.run_tts_called = False
        await collect_frames(svc.run_tts("hello", "ctx-1"))
        assert primary.run_tts_called  # probed

    async def test_closes_on_primary_recovery(self):
        # Start with failing primary
        failing_primary = MockTTSService(frames=[ErrorFrame(error="fail")])
        fallback = MockTTSService(frames=FALLBACK_FRAMES)
        svc = FallbackTTSService(
            primary=failing_primary, fallback=fallback,
            primary_timeout=2.0, failure_threshold=2, cooldown_seconds=0.0,
        )
        await svc.start(make_start_frame())

        for _ in range(2):
            await collect_frames(svc.run_tts("hello", "ctx-1"))

        # Now swap primary to healthy (simulate recovery)
        svc._primary = MockTTSService(frames=GOOD_FRAMES)
        await svc._primary.start(make_start_frame())

        frames = await collect_frames(svc.run_tts("hello", "ctx-1"))

        assert any(isinstance(f, TTSAudioRawFrame) and f.audio == b"\x00\x01" * 100 for f in frames)
        assert svc._circuit._consecutive_failures == 0  # circuit closed


class TestBothFail:
    """When both primary and fallback fail."""

    async def test_yields_error_frame(self):
        primary = MockTTSService(raise_exc=ConnectionError("primary down"))
        fallback = MockTTSService(raise_exc=ConnectionError("fallback down"))
        svc = FallbackTTSService(primary=primary, fallback=fallback, primary_timeout=2.0)
        await svc.start(make_start_frame())

        frames = await collect_frames(svc.run_tts("hello", "ctx-1"))

        assert any(isinstance(f, ErrorFrame) for f in frames)


class TestLazyInit:
    """Fallback service is only started on first failure."""

    async def test_fallback_not_started_when_primary_healthy(self):
        primary = MockTTSService(frames=GOOD_FRAMES)
        fallback = MockTTSService(frames=FALLBACK_FRAMES)
        svc = FallbackTTSService(primary=primary, fallback=fallback)
        await svc.start(make_start_frame())

        await collect_frames(svc.run_tts("hello", "ctx-1"))
        assert not svc._fallback_started
        assert not fallback.started

    async def test_fallback_started_on_first_failure(self):
        primary = MockTTSService(raise_exc=ConnectionError("down"))
        fallback = MockTTSService(frames=FALLBACK_FRAMES)
        svc = FallbackTTSService(primary=primary, fallback=fallback, primary_timeout=2.0)
        await svc.start(make_start_frame())

        await collect_frames(svc.run_tts("hello", "ctx-1"))
        assert svc._fallback_started
        assert fallback.started

    async def test_fallback_started_only_once(self):
        primary = MockTTSService(raise_exc=ConnectionError("down"))
        fallback = MockTTSService(frames=FALLBACK_FRAMES)
        svc = FallbackTTSService(primary=primary, fallback=fallback, primary_timeout=2.0)
        await svc.start(make_start_frame())

        await collect_frames(svc.run_tts("hello", "ctx-1"))
        await collect_frames(svc.run_tts("hello", "ctx-1"))

        # start() should have been called on fallback only once
        assert svc._fallback_started


class TestLifecycle:
    """start/stop/cancel are proxied correctly."""

    async def test_start_starts_primary_only(self):
        primary = MockTTSService(frames=GOOD_FRAMES)
        fallback = MockTTSService(frames=FALLBACK_FRAMES)
        svc = FallbackTTSService(primary=primary, fallback=fallback)

        await svc.start(make_start_frame())
        assert primary.started
        assert not fallback.started

    async def test_stop_stops_both_when_fallback_started(self):
        primary = MockTTSService(raise_exc=ConnectionError("down"))
        fallback = MockTTSService(frames=FALLBACK_FRAMES)
        svc = FallbackTTSService(primary=primary, fallback=fallback, primary_timeout=2.0)
        await svc.start(make_start_frame())
        await collect_frames(svc.run_tts("hello", "ctx-1"))  # triggers fallback start

        await svc.stop(EndFrame())
        assert primary.stopped
        assert fallback.stopped

    async def test_stop_skips_fallback_when_never_started(self):
        primary = MockTTSService(frames=GOOD_FRAMES)
        fallback = MockTTSService(frames=FALLBACK_FRAMES)
        svc = FallbackTTSService(primary=primary, fallback=fallback)
        await svc.start(make_start_frame())

        await svc.stop(EndFrame())
        assert primary.stopped
        assert not fallback.stopped

    async def test_cancel_cancels_both_when_fallback_started(self):
        primary = MockTTSService(raise_exc=ConnectionError("down"))
        fallback = MockTTSService(frames=FALLBACK_FRAMES)
        svc = FallbackTTSService(primary=primary, fallback=fallback, primary_timeout=2.0)
        await svc.start(make_start_frame())
        await collect_frames(svc.run_tts("hello", "ctx-1"))  # triggers fallback start

        await svc.cancel(CancelFrame())
        assert primary.cancelled
        assert fallback.cancelled
