# Twilio Audio Fix: Split Sample Rate

**Date:** 2026-02-15
**Status:** Approved
**Scope:** pipecat-agent/src/calllock/pipeline.py (one-line change)

## Problem

Callers hear faint, garbled noise instead of clear speech from the Pipecat voice agent. Logs confirm audio generation ("Bot started speaking" / "Bot stopped speaking"), but the audio reaching Twilio is corrupted.

## Root Cause

`PipelineParams(audio_out_sample_rate=8000)` propagates to ElevenLabs TTS, which requests `output_format=pcm_8000` from the ElevenLabs API. However, `pcm_8000` is not in the officially supported ElevenLabs format list:

```python
ElevenLabsOutputFormat = Literal["pcm_16000", "pcm_22050", "pcm_24000", "pcm_44100"]
```

When ElevenLabs receives an unsupported format, it likely falls back to a higher sample rate (e.g., 22050 Hz) without reporting an error. The audio bytes are then mislabeled as 8000 Hz by the TTS service:

```python
TTSAudioRawFrame(audio, self.sample_rate=8000, 1)  # labeled 8kHz, actually 22kHz
```

Downstream, the MediaSender resampler sees 8kHz to 8kHz (identity pass) and the TwilioFrameSerializer also sees 8kHz to 8kHz. The 22kHz audio passes through untouched, producing garbled mulaw at the wrong rate.

The official Pipecat Twilio example uses Cartesia TTS (not ElevenLabs), which natively supports 8kHz.

## Fix

Split the pipeline sample rates: 8kHz for input (Twilio's native rate), 16kHz for output (ElevenLabs' well-supported `pcm_16000` format).

```python
# Before
PipelineParams(
    audio_in_sample_rate=8000,
    audio_out_sample_rate=8000,
)

# After
PipelineParams(
    audio_in_sample_rate=8000,
    audio_out_sample_rate=16000,
)
```

## Audio Flow After Fix

**Input (caller to bot):**
1. Twilio sends 8kHz mulaw over WebSocket
2. `TwilioFrameSerializer.deserialize()`: `ulaw_to_pcm(8kHz, 8kHz)` = PCM 8kHz
3. Deepgram STT receives 8kHz PCM (supported)

**Output (bot to caller):**
1. ElevenLabs TTS outputs at `pcm_16000` (well-supported format)
2. `TTSAudioRawFrame(audio, sample_rate=16000, 1)` (correctly labeled)
3. `MediaSender.handle_audio_frame()`: resample 16kHz to 16kHz (identity, transport rate = 16kHz)
4. `TwilioFrameSerializer.serialize()`: `pcm_to_ulaw(data, 16000, 8000)` downsamples to 8kHz mulaw
5. Twilio receives correctly formatted 8kHz mulaw audio

## Verification

1. Deploy to Fly.io
2. Call the number
3. Expect to hear the bot greeting clearly
4. Speak back and verify two-way conversation
5. Check Fly.io logs for any ElevenLabs or sample rate warnings

## Risk

Low. The `TwilioFrameSerializer` was designed to handle resampling via `pcm_to_ulaw(in_rate, out_rate, resampler)`. The 16kHz to 8kHz path is a standard, well-tested conversion.
