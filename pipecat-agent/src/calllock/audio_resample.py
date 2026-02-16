"""Inline audio resampler for Pipecat pipeline.

Resamples OutputAudioRawFrame from TTS sample rate (e.g. 16kHz) to
target rate (8kHz for Twilio) using audioop.ratecv. This bypasses
Pipecat's soxr-based resampler entirely.
"""
import audioop
import struct
import logging

from pipecat.frames.frames import Frame, OutputAudioRawFrame, InputAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

logger = logging.getLogger(__name__)


class AudioResampleProcessor(FrameProcessor):
    """Resample output audio frames to target_rate using audioop.ratecv.

    Insert between TTS and transport.output() in the pipeline.
    Only resamples OutputAudioRawFrame (not InputAudioRawFrame).
    """

    def __init__(self, target_rate: int = 8000, **kwargs):
        super().__init__(**kwargs)
        self._target_rate = target_rate
        self._states: dict[tuple[int, int], object] = {}
        self._count = 0

    def _resample_audio(self, audio: bytes, in_rate: int) -> bytes:
        """Resample audio bytes from in_rate to target_rate.

        Preserves ratecv state across calls for click-free chunk boundaries.
        """
        if in_rate == self._target_rate:
            return audio

        key = (in_rate, self._target_rate)
        state = self._states.get(key)
        resampled, state = audioop.ratecv(audio, 2, 1, in_rate, self._target_rate, state)
        self._states[key] = state
        return resampled

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        """Resample output audio frames; delegate everything else to base class."""
        # Let base class handle system frames (StartFrame, EndFrame, etc.)
        await super().process_frame(frame, direction)

        if (
            isinstance(frame, OutputAudioRawFrame)
            and not isinstance(frame, InputAudioRawFrame)
            and frame.sample_rate != self._target_rate
        ):
            self._count += 1
            resampled = self._resample_audio(frame.audio, frame.sample_rate)

            # Log first 5 frames for diagnostics
            if self._count <= 5:
                n_in = len(frame.audio) // 2
                n_out = len(resampled) // 2
                in_amp = max(abs(s) for s in struct.unpack(f"<{n_in}h", frame.audio)) if n_in else 0
                out_amp = max(abs(s) for s in struct.unpack(f"<{n_out}h", resampled)) if n_out else 0
                logger.info(
                    f"RESAMPLE #{self._count}: {frame.sample_rate}->{self._target_rate}, "
                    f"in={len(frame.audio)}b amp={in_amp}, out={len(resampled)}b amp={out_amp}"
                )

            frame = OutputAudioRawFrame(
                audio=resampled,
                sample_rate=self._target_rate,
                num_channels=frame.num_channels,
            )
            await self.push_frame(frame, direction)
        else:
            await self.push_frame(frame, direction)
