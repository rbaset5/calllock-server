# Inline AudioResampleProcessor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix Twilio audio silence by replacing the fragile soxr monkey-patch with an inline `AudioResampleProcessor` that resamples ElevenLabs 16kHz TTS output to 8kHz using `audioop.ratecv` before it reaches the transport.

**Architecture:** A lightweight `FrameProcessor` sits between TTS and transport.output() in the Pipecat pipeline. It intercepts `OutputAudioRawFrame` instances, resamples 16kHz→8kHz via `audioop.ratecv`, and emits 8kHz frames. With `audio_out_sample_rate=8000`, no soxr resampler is invoked anywhere in the output path — the serializer just does `audioop.lin2ulaw()`.

**Tech Stack:** Python 3.12, Pipecat 0.0.102, audioop (stdlib), FastAPI, Fly.io

**Design doc:** `docs/plans/2026-02-16-inline-resampler-processor-design.md`

---

### Task 1: Write AudioResampleProcessor unit test

**Files:**
- Create: `pipecat-agent/tests/test_audio_resample.py`

**Step 1: Write the test file**

```python
"""Tests for AudioResampleProcessor."""
import audioop
import struct
import math
import pytest
from unittest.mock import AsyncMock

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


class FakeOutputAudioRawFrame:
    """Minimal stand-in for OutputAudioRawFrame."""

    def __init__(self, audio: bytes, sample_rate: int, num_channels: int = 1):
        self.audio = audio
        self.sample_rate = sample_rate
        self.num_channels = num_channels


class FakeInputAudioRawFrame:
    """Minimal stand-in for InputAudioRawFrame."""

    def __init__(self, audio: bytes, sample_rate: int, num_channels: int = 1):
        self.audio = audio
        self.sample_rate = sample_rate
        self.num_channels = num_channels


class FakeOtherFrame:
    """Non-audio frame (e.g. TTSSpeakFrame, TextFrame)."""
    pass


@pytest.fixture
def processor():
    return AudioResampleProcessor(target_rate=8000)


def test_resample_16k_to_8k(processor):
    """16kHz PCM input should produce 8kHz PCM output with preserved amplitude."""
    pcm_16k = _make_sine_pcm(440, 16000, 0.1)  # 100ms of 440Hz
    result = processor._resample_audio(pcm_16k, 16000)

    # Output should be roughly half the length (8kHz vs 16kHz)
    expected_len = len(pcm_16k) // 2
    assert abs(len(result) - expected_len) <= 4  # allow small rounding

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
```

**Step 2: Run the test to verify it fails**

Run: `cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/surat/pipecat-agent && python -m pytest tests/test_audio_resample.py -v`

Expected: FAIL with `ModuleNotFoundError: No module named 'calllock.audio_resample'`

**Step 3: Commit**

```bash
cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/surat
git add pipecat-agent/tests/test_audio_resample.py
git commit -m "test: add AudioResampleProcessor unit tests"
```

---

### Task 2: Implement AudioResampleProcessor

**Files:**
- Create: `pipecat-agent/src/calllock/audio_resample.py`

**Step 1: Write the implementation**

```python
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
        """Resample output audio frames; pass everything else through."""
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
```

**Step 2: Run the tests**

Run: `cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/surat/pipecat-agent && python -m pytest tests/test_audio_resample.py -v`

Expected: All 4 tests PASS.

**Step 3: Commit**

```bash
cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/surat
git add pipecat-agent/src/calllock/audio_resample.py
git commit -m "feat: add AudioResampleProcessor using audioop.ratecv"
```

---

### Task 3: Wire AudioResampleProcessor into test pipeline

**Files:**
- Modify: `pipecat-agent/src/calllock/bot.py:86-198` (the `_run_test_pipeline` function)

**Step 1: Rewrite `_run_test_pipeline`**

Replace lines 86-198 of `bot.py` with:

```python
async def _run_test_pipeline(websocket: WebSocket):
    """Minimal test pipeline: TTS(16kHz) -> AudioResampleProcessor(8kHz) -> transport."""
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineParams, PipelineTask
    from pipecat.transports.websocket.fastapi import (
        FastAPIWebsocketTransport,
        FastAPIWebsocketParams,
    )
    from pipecat.serializers.twilio import TwilioFrameSerializer
    from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
    from pipecat.frames.frames import TTSSpeakFrame
    from pipecat.runner.utils import parse_telephony_websocket
    from loguru import logger

    from calllock.audio_resample import AudioResampleProcessor

    logger.info("=== TEST PIPELINE: AudioResampleProcessor (no soxr) ===")

    # Parse Twilio handshake
    transport_type, call_data = await parse_telephony_websocket(websocket)
    stream_sid = call_data["stream_id"]
    call_sid = call_data["call_id"]
    logger.info(f"Test call: {call_sid}, stream: {stream_sid}")

    # Transport
    serializer = TwilioFrameSerializer(
        stream_sid=stream_sid,
        call_sid=call_sid,
        account_sid=os.getenv("TWILIO_ACCOUNT_SID"),
        auth_token=os.getenv("TWILIO_AUTH_TOKEN"),
    )
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=serializer,
        ),
    )

    # TTS at 16kHz (pcm_8000 is near-silent, pcm_16000 has good amplitude)
    tts = ElevenLabsTTSService(
        api_key=os.getenv("ELEVENLABS_API_KEY"),
        voice_id=os.getenv("ELEVENLABS_VOICE_ID"),
        sample_rate=16000,
    )

    # Resample 16kHz -> 8kHz using audioop (bypasses soxr entirely)
    resampler = AudioResampleProcessor(target_rate=8000)

    pipeline = Pipeline([
        transport.input(),
        tts,
        resampler,
        transport.output(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=8000,
            audio_out_sample_rate=8000,  # Serializer does 8->8 (no soxr)
        ),
    )

    @transport.event_handler("on_client_connected")
    async def on_connected(transport, client):
        logger.info("=== TEST: Client connected, sending TTS ===")
        await task.queue_frames([TTSSpeakFrame("Hello! This is a test. Can you hear me clearly?")])

    runner = PipelineRunner()
    await runner.run(task)
    logger.info("=== TEST PIPELINE ENDED ===")
```

Key changes from previous version:
- Removed ALL monkey-patching code (lines 104-146)
- Added `from calllock.audio_resample import AudioResampleProcessor`
- Set `sample_rate=16000` explicitly on `ElevenLabsTTSService`
- Inserted `resampler` between `tts` and `transport.output()` in pipeline
- Changed `audio_out_sample_rate` from `16000` to `8000`

**Step 2: Verify Python syntax**

Run: `cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/surat/pipecat-agent && python -c "import ast; ast.parse(open('src/calllock/bot.py').read()); print('OK')"`

Expected: `OK`

**Step 3: Run existing tests to make sure nothing broke**

Run: `cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/surat/pipecat-agent && python -m pytest tests/ -v --timeout=30`

Expected: All tests PASS (existing tests don't import bot.py directly).

**Step 4: Commit**

```bash
cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/surat
git add pipecat-agent/src/calllock/bot.py
git commit -m "fix: replace soxr monkey-patch with AudioResampleProcessor in test pipeline"
```

---

### Task 4: Wire AudioResampleProcessor into main pipeline

**Files:**
- Modify: `pipecat-agent/src/calllock/pipeline.py:71-107`

**Step 1: Add import and insert resampler**

Add import at top of `pipeline.py` (after line 18):
```python
from calllock.audio_resample import AudioResampleProcessor
```

Modify the ElevenLabs TTS initialization (lines 71-74) to add explicit `sample_rate`:
```python
    tts = ElevenLabsTTSService(
        api_key=os.getenv("ELEVENLABS_API_KEY"),
        voice_id=os.getenv("ELEVENLABS_VOICE_ID"),
        sample_rate=16000,
    )
```

Add resampler instance after `sm_processor` definition (after line 87):
```python
    resampler = AudioResampleProcessor(target_rate=8000)
```

Modify pipeline (lines 90-99) to insert resampler between `tts` and `transport.output()`:
```python
    pipeline = Pipeline([
        transport.input(),
        stt,
        sm_processor,
        context_aggregator.user(),
        llm,
        tts,
        resampler,
        transport.output(),
        context_aggregator.assistant(),
    ])
```

Change `audio_out_sample_rate` (line 105) from `16000` to `8000`:
```python
    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=8000,
            audio_out_sample_rate=8000,
        ),
    )
```

**Step 2: Verify Python syntax**

Run: `cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/surat/pipecat-agent && python -c "import ast; ast.parse(open('src/calllock/pipeline.py').read()); print('OK')"`

Expected: `OK`

**Step 3: Run all tests**

Run: `cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/surat/pipecat-agent && python -m pytest tests/ -v --timeout=30`

Expected: All tests PASS.

**Step 4: Commit**

```bash
cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/surat
git add pipecat-agent/src/calllock/pipeline.py
git commit -m "fix: add AudioResampleProcessor to main pipeline for Twilio audio"
```

---

### Task 5: Deploy and verify with test call

**Files:** None (deployment only)

**Step 1: Deploy to Fly.io**

Run: `cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/surat/pipecat-agent && fly deploy --remote-only`

Expected: Deployment succeeds. Watch for `1 machine started` in output.

**Step 2: Verify health endpoint**

Run: `curl -s https://calllock-voice.fly.dev/health`

Expected: `ok`

**Step 3: Ask user to make test call**

Tell the user: "Deployed. Please make a test call to the `/twiml-test` webhook. You should hear 'Hello! This is a test. Can you hear me clearly?'"

**Step 4: Check Fly.io logs for RESAMPLE diagnostics**

Run: `cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/surat/pipecat-agent && fly logs --app calllock-voice | head -80`

Look for:
- `=== TEST PIPELINE: AudioResampleProcessor (no soxr) ===`
- `RESAMPLE #1: 16000->8000, in=XXXb amp=YYYY, out=ZZZb amp=WWWW`
- `in_amp` and `out_amp` should both be > 1000 (indicating real audio, not silence)

**Step 5: If silence persists, check these log indicators:**

| Log pattern | Meaning | Next step |
|------------|---------|-----------|
| No RESAMPLE logs at all | Processor not reached; TTS not emitting frames | Check ElevenLabs API key / billing |
| `in_amp=0` | ElevenLabs returning silent audio | Try different voice_id or check API status |
| `in_amp>0` but `out_amp=0` | audioop.ratecv producing silence | Bug in audioop usage (shouldn't happen) |
| `in_amp>0` and `out_amp>0` | Resample is fine; issue is in serializer | Serializer mulaw conversion problem |
