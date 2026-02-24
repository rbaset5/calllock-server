"""Tests for AudioResampleProcessor."""
import audioop
import struct
import math
import pytest

from calllock.audio_resample import AudioResampleProcessor


def _make_sine_pcm(freq: float, sample_rate: int, duration: float) -> bytes:
    """Generate a sine wave as 16-bit PCM bytes."""
    n = int(sample_rate * duration)
    samples = []
    for i in range(n):
        s = int(16000 * math.sin(2 * math.pi * freq * i / sample_rate))
        samples.append(struct.pack("<h", s))
    return b"".join(samples)


def _max_amplitude(pcm: bytes) -> int:
    """Get max absolute amplitude from 16-bit PCM."""
    n = len(pcm) // 2
    if n == 0:
        return 0
    samples = struct.unpack(f"<{n}h", pcm)
    return max(abs(s) for s in samples)


@pytest.fixture
def processor():
    return AudioResampleProcessor(target_rate=8000)


def test_resample_16k_to_8k(processor):
    """16kHz PCM input should produce 8kHz PCM output with preserved amplitude."""
    pcm_16k = _make_sine_pcm(440, 16000, 0.1)
    result = processor._resample_audio(pcm_16k, 16000)

    # Output should be roughly half the length (8kHz vs 16kHz)
    expected_len = len(pcm_16k) // 2
    assert abs(len(result) - expected_len) <= 4

    # Amplitude should be preserved (within 20%)
    in_amp = _max_amplitude(pcm_16k)
    out_amp = _max_amplitude(result)
    assert out_amp > in_amp * 0.8, f"Amplitude lost: in={in_amp}, out={out_amp}"


def test_no_resample_when_already_8k(processor):
    """8kHz input should pass through unchanged."""
    pcm_8k = _make_sine_pcm(440, 8000, 0.1)
    result = processor._resample_audio(pcm_8k, 8000)
    assert result == pcm_8k


def test_resample_24k_to_8k(processor):
    """24kHz input should also resample correctly."""
    pcm_24k = _make_sine_pcm(440, 24000, 0.1)
    result = processor._resample_audio(pcm_24k, 24000)

    expected_len = len(pcm_24k) // 3
    assert abs(len(result) - expected_len) <= 4

    in_amp = _max_amplitude(pcm_24k)
    out_amp = _max_amplitude(result)
    assert out_amp > in_amp * 0.8


def test_state_preserved_across_chunks(processor):
    """Resampling state should be preserved across calls to avoid clicks."""
    pcm_16k = _make_sine_pcm(440, 16000, 0.2)
    mid = len(pcm_16k) // 2

    # Process in two chunks
    chunk1 = processor._resample_audio(pcm_16k[:mid], 16000)
    chunk2 = processor._resample_audio(pcm_16k[mid:], 16000)

    # Process as one chunk
    processor2 = AudioResampleProcessor(target_rate=8000)
    full = processor2._resample_audio(pcm_16k, 16000)

    # Combined chunks should be same length as full (state preserved)
    assert abs(len(chunk1) + len(chunk2) - len(full)) <= 4
