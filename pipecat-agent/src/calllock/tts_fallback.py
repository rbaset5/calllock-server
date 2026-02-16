"""TTS fallback service with circuit breaker pattern.

Wraps a primary TTS (Inworld) and fallback TTS (Deepgram Aura-2) so that
per-utterance failures transparently switch to the fallback provider.  Only
the first audio chunk is buffered for health-checking; after that, frames
stream directly to minimise latency.
"""

import asyncio
import logging
from typing import AsyncGenerator, Optional

from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    ErrorFrame,
    Frame,
    StartFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)
from pipecat.processors.frame_processor import FrameProcessorSetup
from pipecat.services.tts_service import TTSService

from calllock.circuit_breaker import CircuitBreaker

logger = logging.getLogger(__name__)


class FallbackTTSService(TTSService):
    """Wraps two TTS services with per-utterance failover.

    Strategy (first-chunk validation):
      1. Iterate primary's ``run_tts()`` and buffer frames until first
         ``TTSAudioRawFrame``.
      2. If audio arrives → yield buffer + stream the rest.
      3. If ``ErrorFrame``, exception, or timeout → discard buffer and
         yield from fallback.
      4. Circuit breaker skips primary entirely after repeated failures.

    The fallback service is lazily initialised on first failure to avoid
    unnecessary connections when primary is healthy (the majority case).
    """

    def __init__(
        self,
        *,
        primary: TTSService,
        fallback: TTSService,
        primary_timeout: float = 5.0,
        failure_threshold: int = 3,
        cooldown_seconds: float = 60.0,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._primary = primary
        self._fallback = fallback
        self._primary_timeout = primary_timeout
        self._circuit = CircuitBreaker(
            failure_threshold=failure_threshold,
            cooldown_seconds=cooldown_seconds,
            label="TTS",
        )
        self._fallback_started = False
        self._start_frame: Optional[StartFrame] = None
        self._setup: Optional[FrameProcessorSetup] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def setup(self, setup: FrameProcessorSetup):
        await super().setup(setup)
        # Propagate clock, task manager, observer to inner services so
        # they can use get_clock() / metrics without being in the pipeline.
        await self._primary.setup(setup)
        # Fallback setup is deferred until first failure (lazy init).
        self._setup = setup

    async def start(self, frame: StartFrame):
        logger.info("FallbackTTSService received StartFrame — forwarding to primary")
        await super().start(frame)
        self._start_frame = frame
        await self._primary.start(frame)
        # fallback is lazily started on first failure

    async def stop(self, frame: EndFrame):
        await self._primary.stop(frame)
        if self._fallback_started:
            await self._fallback.stop(frame)
        await super().stop(frame)

    async def cancel(self, frame: CancelFrame):
        await self._primary.cancel(frame)
        if self._fallback_started:
            await self._fallback.cancel(frame)
        await super().cancel(frame)

    # ------------------------------------------------------------------
    # TTS
    # ------------------------------------------------------------------

    def can_generate_metrics(self) -> bool:
        return self._primary.can_generate_metrics()

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        if self._circuit.should_try():
            async for frame in self._try_primary(text, context_id):
                yield frame
        else:
            logger.info("Circuit breaker open — using fallback TTS directly")
            async for frame in self._run_fallback(text, context_id):
                yield frame

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _try_primary(
        self, text: str, context_id: str
    ) -> AsyncGenerator[Frame, None]:
        """Buffer until first audio frame; fall back on failure."""
        buffer: list[Frame] = []
        got_audio = False

        try:
            gen = self._primary.run_tts(text, context_id)
            async for frame in self._iter_with_timeout(gen, self._primary_timeout):
                if isinstance(frame, ErrorFrame):
                    logger.warning("Primary TTS returned ErrorFrame: %s", frame.error)
                    break

                buffer.append(frame)

                if isinstance(frame, TTSAudioRawFrame):
                    got_audio = True
                    # Primary is healthy — yield buffer and stream the rest
                    for buffered in buffer:
                        yield buffered
                    async for rest in gen:
                        if isinstance(rest, ErrorFrame):
                            # Mid-stream error — can't recover this utterance
                            logger.warning("Primary TTS mid-stream error: %s", rest.error)
                            break
                        yield rest
                    self._circuit.record_success()
                    return

        except asyncio.TimeoutError:
            logger.warning(
                "Primary TTS timed out after %.1fs waiting for first audio",
                self._primary_timeout,
            )
        except Exception:
            logger.exception("Primary TTS raised exception")

        # If we reach here, primary failed — fall back
        if not got_audio:
            self._circuit.record_failure()
            logger.info("FALLBACK TTS activated for utterance")
            async for frame in self._run_fallback(text, context_id):
                yield frame

    async def _run_fallback(
        self, text: str, context_id: str
    ) -> AsyncGenerator[Frame, None]:
        await self._ensure_fallback_started()
        try:
            async for frame in self._fallback.run_tts(text, context_id):
                yield frame
        except Exception:
            logger.exception("Fallback TTS also failed")
            yield ErrorFrame(error="Both primary and fallback TTS failed")

    async def _ensure_fallback_started(self) -> None:
        if not self._fallback_started:
            if hasattr(self, "_setup") and self._setup:
                await self._fallback.setup(self._setup)
            if self._start_frame:
                await self._fallback.start(self._start_frame)
            self._fallback_started = True
            logger.info("Fallback TTS service started (lazy init)")

    @staticmethod
    async def _iter_with_timeout(
        gen: AsyncGenerator, timeout: float
    ) -> AsyncGenerator[Frame, None]:
        """Yield from *gen* but raise ``asyncio.TimeoutError`` if the
        generator doesn't yield within *timeout* seconds between frames."""
        ait = gen.__aiter__()
        while True:
            try:
                frame = await asyncio.wait_for(ait.__anext__(), timeout=timeout)
                yield frame
            except StopAsyncIteration:
                return
