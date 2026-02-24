# Inline AudioResampleProcessor Design

**Date:** 2026-02-16
**Status:** Approved
**Problem:** Twilio callers hear silence despite ElevenLabs TTS generating audio

## Root Cause Analysis

Three compounding issues:

1. **ElevenLabs `pcm_8000` produces near-silent audio.** Confirmed via diagnostic logging — max amplitude ≈ 0.
2. **Using `pcm_16000` requires resampling to 8kHz for Twilio.** This relies on Pipecat's `SOXRStreamAudioResampler` which uses the `soxr` library.
3. **`soxr` resampling appears broken** in the Docker deployment. Monkey-patching `SOXRStreamAudioResampler.resample` was attempted but never confirmed to be invoked by all 3 resampler instances in the pipeline.

## Pipecat Audio Output Pipeline (3 Resamplers)

| # | Location | Purpose | File |
|---|----------|---------|------|
| 1 | TTS service | Match TTS output → `audio_out_sample_rate` | `tts_service.py:577-603` |
| 2 | BaseOutputTransport.MediaSender | Match frame rate → transport rate | `base_output.py:528-530` |
| 3 | TwilioFrameSerializer | PCM→µ-law + resample → 8kHz | `twilio.py:154-157` |

All three use `SOXRStreamAudioResampler` instances.

## Solution: AudioResampleProcessor

Insert a lightweight `FrameProcessor` between TTS and transport output that resamples 16kHz→8kHz using Python's `audioop.ratecv`. Combined with `audio_out_sample_rate=8000`, this eliminates ALL soxr usage in the output path.

### Audio Flow

```
ElevenLabs API (pcm_16000) → 16kHz PCM
    ↓
TTSService → TTSAudioRawFrame(sample_rate=16000)
    (no internal resample: source_sample_rate=None for raw PCM)
    ↓
AudioResampleProcessor → OutputAudioRawFrame(sample_rate=8000)
    (audioop.ratecv 16→8kHz)
    ↓
BaseOutputTransport → 8kHz in, 8kHz expected → NO-OP
    ↓
TwilioFrameSerializer → 8kHz PCM → audioop.lin2ulaw → µ-law
    (8→8kHz resample = NO-OP)
```

### Configuration

```python
tts = ElevenLabsTTSService(sample_rate=16000)  # Explicit 16kHz
resampler = AudioResampleProcessor(target_rate=8000)

pipeline = Pipeline([transport.input(), tts, resampler, transport.output()])

task = PipelineTask(pipeline, params=PipelineParams(
    audio_in_sample_rate=8000,
    audio_out_sample_rate=8000,
))
```

### Processor Implementation

~25 lines. Intercepts `OutputAudioRawFrame` (includes `TTSAudioRawFrame`), resamples via `audioop.ratecv`, preserves state across chunks for click-free audio, logs amplitude diagnostics for first 5 frames.

## Scope

1. Implement in test pipeline (`_run_test_pipeline` in bot.py) first
2. Deploy and verify with a test call
3. Apply same pattern to main pipeline (`pipeline.py`)
4. Clean up test endpoints after confirmation
