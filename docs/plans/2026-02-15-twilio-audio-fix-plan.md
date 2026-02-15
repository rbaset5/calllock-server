# Twilio Audio Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix garbled Twilio audio by changing `audio_out_sample_rate` from 8000 to 16000 so ElevenLabs outputs at a supported format (`pcm_16000`) and the TwilioFrameSerializer handles the 16k-to-8k downsampling.

**Architecture:** One-line change in `PipelineParams`. ElevenLabs generates 16kHz PCM, the Pipecat `TwilioFrameSerializer` downsamples to 8kHz mulaw internally via `pcm_to_ulaw(16000, 8000, resampler)`. Input stays at 8kHz (Twilio's native rate).

**Tech Stack:** Pipecat 0.0.102, ElevenLabs TTS, Twilio Media Streams, Fly.io

---

### Task 1: Change audio_out_sample_rate to 16000

**Files:**
- Modify: `pipecat-agent/src/calllock/pipeline.py:105`

**Step 1: Edit PipelineParams**

In `pipecat-agent/src/calllock/pipeline.py`, line 105, change `audio_out_sample_rate=8000` to `audio_out_sample_rate=16000`:

```python
    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=8000,
            audio_out_sample_rate=16000,
        ),
    )
```

**Step 2: Verify existing tests still pass**

Run:
```bash
cd pipecat-agent && .venv/bin/python -m pytest tests/ -v
```

Expected: All tests pass (this change doesn't affect unit tests since they mock the pipeline).

**Step 3: Commit**

```bash
git add pipecat-agent/src/calllock/pipeline.py
git commit -m "fix: set audio_out_sample_rate=16000 for ElevenLabs compatibility

ElevenLabs does not support pcm_8000 output format. Setting the output
rate to 16000 lets ElevenLabs produce pcm_16000 (well-supported) and
the TwilioFrameSerializer handles 16k→8k downsampling internally."
```

---

### Task 2: Deploy to Fly.io

**Step 1: Deploy**

Run from `pipecat-agent/` directory:
```bash
cd pipecat-agent && flyctl deploy
```

Expected: Build and deployment succeed. Watch for any errors in the build output.

**Step 2: Verify the app is running**

```bash
curl https://calllock-voice.fly.dev/health
```

Expected: `ok`

**Step 3: Check logs for startup errors**

```bash
flyctl logs -a calllock-voice | head -30
```

Expected: No errors related to ElevenLabs or sample rate. Look for the startup message.

---

### Task 3: Live Call Verification

**Step 1: Place a test call**

Call the Twilio number configured to forward to `https://calllock-voice.fly.dev/twiml`.

Expected: Hear the bot greeting **clearly** (not garbled or faint).

**Step 2: Verify two-way conversation**

Speak to the bot. Expected: Bot responds to what you said (STT + LLM + TTS working).

**Step 3: Check logs after call**

```bash
flyctl logs -a calllock-voice | tail -50
```

Expected:
- `Call started: <call_sid>` log line
- `Bot started speaking` / `Bot stopped speaking` log lines
- No `ElevenLabsTTSService: No output format available` warnings
- No resampler or audio errors

**Step 4: Commit nothing** (no code changes in this task — just verification)

---

### Task 4: Update AGENT-STATUS.md (if call works)

**Files:**
- Modify: `voice-agent/AGENT-STATUS.md`

**Step 1: Update status**

Add a note to `voice-agent/AGENT-STATUS.md` documenting:
- Audio fix deployed: `audio_out_sample_rate=16000`
- ElevenLabs uses `pcm_16000` format
- Call verified working on `<date>`

**Step 2: Commit**

```bash
git add voice-agent/AGENT-STATUS.md
git commit -m "docs: update agent status with audio fix verification"
```
