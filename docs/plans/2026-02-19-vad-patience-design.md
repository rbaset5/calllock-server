# Stop Agent Talking Over Callers

**Date:** 2026-02-19
**Trigger:** Calls CA8346688d and CA5e95ec8 — agent spoke over caller mid-sentence, caller hung up both times.

## Problem

The agent interrupts callers mid-sentence. When a caller says "I am having a [pause] problem with my air conditioning", the system treats "I am having a" as a complete utterance, fires lookup_caller, speaks "One moment", and the caller hears the agent talking over them.

### Root Cause (Three Layers)

The problem spans three layers, each contributing:

1. **Deepgram STT endpointing (~10ms default)** — Deepgram finalizes "I am having a" as a complete transcript after a tiny pause. This creates fragmented TranscriptionFrames.
2. **VAD stop_secs (was 0.2s)** — Silero VAD declares speech ended after 200ms silence. Natural mid-sentence pauses are 300-800ms.
3. **StateMachineProcessor** — Acts on every TranscriptionFrame immediately. Gets "I am having a", fires lookup and speaks "One moment" before the caller finishes.

### Evidence

**CA8346688d** (stop_secs=0.2):
- "I have a problem with my" → lookup fires → "One moment" → caller still talking

**CA5e95ec8** (stop_secs=0.5, VAD fix deployed):
- "I am having a" → lookup fires → "One moment" → caller says "What?"
- VAD fix didn't help because Deepgram's endpointing is the root layer

## Fix

Two changes in `pipeline.py`:

### 1. Deepgram endpointing (primary fix)

```python
stt = DeepgramSTTService(
    api_key=os.getenv("DEEPGRAM_API_KEY"),
    live_options=LiveOptions(endpointing=500),
)
```

Deepgram now waits 500ms of silence before finalizing a transcript. Mid-sentence pauses (200-400ms) get combined into a single TranscriptionFrame.

### 2. VAD stop_secs (supporting fix)

```python
VADParams(stop_secs=0.5)  # Was 0.2
```

VAD waits 500ms before declaring speech ended. Aligns with Deepgram's endpointing.

### Why 500ms for both

- Natural mid-sentence pauses: 200-400ms → covered
- Deliberate end-of-sentence pauses: 500ms+ → detected
- Total added latency on short answers ("yes"/"no"): ~500ms — acceptable

### Alternatives considered

1. **Processor debounce (Approach B)** — buffer TranscriptionFrames in StateMachineProcessor with an 800ms timer. More control but adds async complexity. Layer on if Deepgram endpointing isn't sufficient.
2. **State-aware thresholds** — dynamic params per state. Most precise but fragile.

## Files Changed

- `pipecat-agent/src/calllock/pipeline.py`:
  - Added `LiveOptions(endpointing=500)` to DeepgramSTTService
  - Changed VAD `stop_secs` from 0.2 to 0.5
