# Call Audit: 11 Issues Design — Feb 16, 2026

Audit of call `CA1e1edabef6a7b67a7d645bf0aa3e16c2` (38s, 22:43 UTC).

## Issues Found

### Critical Bugs

**#51 — V2 backend 401 on all tool calls**
All V2 backend HTTP calls return 401 Unauthorized. Circuit breaker opens after 3 failures.

**#52 — Phone number empty from Twilio handshake**
`call_data.get("body", {}).get("From", "")` returns empty. Dashboard webhooks fail 400.

**#55 — Agent fabricates availability**
LLM tells caller "We have openings tomorrow or Friday" — no calendar access exists.

### High-Priority Bugs

**#53 — Post-call fires 4+ minutes late**
Pipeline waits for idle timeout (~4 min) instead of terminating when WebSocket closes.

**#56 — Double response from split utterances**
STT sends partial transcriptions >200ms apart. Each triggers a separate LLM cycle.

**#57 — No active call termination**
After goodbye, call hangs 7s. EndFrame scheduling after LLM response is not implemented (just a comment).

### Medium Bugs

**#54 — Inworld TTS non-functional**
Every TTS frame errors with "StartFrame not received yet". All audio via Deepgram fallback.

**#58 — Address extraction mixes name into address**
Extraction produces "McDonald's, 5279" instead of "5279 Canterbury Court".

**#60 — callback_created unconditionally set to true**
`_tool_result_create_callback` ignores success/failure — always marks callback as created.

### Low Priority

**#59 — Fragmented user messages in LLM context**
Individual STT transcriptions accumulate as separate messages despite debouncing.

## Fix Design

### Batch 1: Data Flow (Critical)

**Fix #52 — Phone number extraction**
1. Log full `call_data` dict on WebSocket connect for debugging
2. Check Pipecat's `parse_telephony_websocket()` return structure — `body.From` may be at a different path
3. Add fallback: try `call_data.get("from")`, `call_data.get("caller")`, extract from SIP headers
4. If phone_number is still empty after extraction, log a WARNING (don't crash)

**Fix #51 — V2 backend auth**
1. Check V2 backend auth middleware — does it expect an API key header?
2. Add auth header to V2Client if needed: `Authorization: Bearer <token>` or custom header
3. If auth depends on phone number, fixing #52 may resolve this automatically
4. Verify env var `V2_BACKEND_URL` on Fly.io includes correct base URL

### Batch 2: Trust & Safety (Critical)

**Fix #55 — Fabricated availability**
Add explicit guard to CONFIRM state prompt:
```
NEVER state specific dates, times, or availability. You have NO calendar access.
If asked about availability: "The team will confirm timing when they call back."
```

**Fix #60 — callback_created on failure**
```python
def _tool_result_create_callback(self, session, result):
    if result.get("success", False) or not result.get("error"):
        session.callback_created = True
```

### Batch 3: Call Lifecycle (High)

**Fix #57 — Active call termination**
After LLM generates goodbye text, schedule an EndFrame after TTS completes:
```python
if action.end_call and action.needs_llm:
    await self.push_frame(frame, FrameDirection.DOWNSTREAM)
    # Schedule EndFrame after a brief delay for TTS to finish
    asyncio.create_task(self._delayed_end_call(delay=3.0))
```

**Fix #53 — Post-call timing**
Register `on_client_disconnected` handler on transport to push EndFrame immediately when WebSocket closes:
```python
@transport.event_handler("on_client_disconnected")
async def on_disconnected(transport, client):
    await task.queue_frames([EndFrame()])
```

### Batch 4: Voice Quality (High)

**Fix #56 — Double response**
Increase debounce window from 200ms to 400ms to exceed VAD stop_secs (300ms):
```python
self._debounce_seconds = 0.4
```

Also: suppress new LLM generation if the previous response is still being synthesized (track TTS state).

### Batch 5: Quality Improvements (Medium)

**Fix #54 — Inworld TTS investigation**
1. Check if `FallbackTTSService.setup()` properly forwards StartFrame to primary TTS
2. Verify Inworld API key is valid
3. If unfixable quickly, remove Inworld from pipeline and use Deepgram directly

**Fix #58 — Address extraction**
Update extraction prompt to explicitly separate name and address fields. Add post-processing validation: if extracted address starts with extracted name, strip the name prefix.

**Fix #59 — Context fragmentation**
Investigate whether Pipecat's context aggregator adds raw transcription frames independently of the StateMachineProcessor debounce. If so, need to suppress upstream frame forwarding for transcriptions handled by debounce.

## Fix Priority Order

1. #52 (phone extraction) — unblocks all dashboard data
2. #51 (V2 auth) — unblocks bookings and callbacks
3. #55 (fabricated availability) — stop lying to customers
4. #60 (callback_created) — stop false positives
5. #57 (call termination) — end calls cleanly
6. #53 (post-call delay) — get data to dashboard faster
7. #56 (double response) — fix stacked voice responses
8. #54 (Inworld TTS) — restore primary voice quality
9. #58 (address extraction) — fix data quality
10. #59 (context fragmentation) — reduce token waste
