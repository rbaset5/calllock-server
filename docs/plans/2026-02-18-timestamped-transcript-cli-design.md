# Timestamped Transcript CLI — Design

**Date:** 2026-02-18
**Branch:** rbaset5/pipecat-post-call
**Status:** Approved (post-review)

## Problem

After a test call, there's no quick way to get a timestamped transcript showing exactly when each utterance, tool call, and state transition happened. Fly.io's log buffer is shallow (~200 lines) and the earlier portions of a call scroll out before you can review them. The agent already captures `time.time()` timestamps on every transcript entry, but neither `transcript.py` nor the post-call handler surface them.

## Solution: Structured Post-Call Log Dump + CLI Parser

Two pieces:

1. **Agent-side:** Emit structured JSON log lines at the end of every call containing the full timestamped transcript (chunked if necessary to stay within Fly.io's 4KB log line limit).
2. **CLI script:** Parse those log lines from `fly logs` output, reassemble chunks, and pretty-print with latency gap highlighting.

## Agent-Side Changes

### 1. Add `state` field to transcript entries (`processor.py`)

At the three `transcript_log.append()` call sites in `processor.py`, add `"state": self.session.state.value`:

- Line ~79 (agent entries): add `"state": self.session.state.value`
- Line ~103 (user entries): add `"state": self.session.state.value`
- Line ~203 (tool entries): add `"state": self.session.state.value`

### 2. Add `to_timestamped_dump()` formatter (`transcript.py`)

New function in `transcript.py` (DRY — all formatters live here):

```python
def to_timestamped_dump(log: list[dict], start_time: float, call_sid: str, phone: str, final_state: str) -> dict:
```

Builds the dump dict from the transcript log. Handles edge cases:
- `start_time == 0` → use first entry's timestamp as base
- Empty log → `{"entries": []}`
- Entry missing `timestamp` key → skip that entry

### 3. Chunk and emit the dump (`post_call.py`)

At the end of `handle_call_ended()`, call `to_timestamped_dump()` then chunk the JSON:

```python
def chunk_transcript_dump(dump_dict: dict, max_bytes: int = 3500) -> list[str]:
```

Output format:
- Single chunk: `TRANSCRIPT_DUMP|1/1|{...json...}`
- Multiple chunks: `TRANSCRIPT_DUMP|1/3|{...}`, `TRANSCRIPT_DUMP|2/3|{...}`, `TRANSCRIPT_DUMP|3/3|{...}`

Chunks split at entry boundaries (never mid-JSON-object). The first chunk contains the header (call_sid, phone, final_state, duration_s) plus as many entries as fit. Subsequent chunks contain remaining entries.

### Log entry schema

```json
{
  "call_sid": "CAa5b28ed3...",
  "phone": "+15125559876",
  "final_state": "booking_failed",
  "duration_s": 52.1,
  "entries": [
    {"t": 0.0, "role": "agent", "state": "welcome", "content": "Thanks for calling ACE Cooling..."},
    {"t": 2.3, "role": "user", "state": "welcome", "content": "Yeah. I'm having a problem..."},
    {"t": 5.2, "role": "tool", "state": "lookup", "name": "lookup_caller", "result": {"known": true}}
  ]
}
```

`t` = seconds elapsed since call start (not raw Unix epoch).

## CLI Script (`pipecat-agent/scripts/call_transcript.py`)

### Usage

```bash
python scripts/call_transcript.py                    # last call, human-readable
python scripts/call_transcript.py --raw              # last call, raw JSON
python scripts/call_transcript.py --call-sid CA...   # specific call
python scripts/call_transcript.py --gap-threshold 3  # custom gap threshold (default: 2s)
python scripts/call_transcript.py --since 2h         # look back 2 hours (default: 1h)
```

### Human-readable output

```
Call CAa5b28ed3... | +15125559876 | 52s | booking_failed
═══════════════════════════════════════════════════════

 0.0s [welcome]        Agent: Thanks for calling ACE Cooling, how can I help you?
 2.3s [welcome]        Caller: Yeah. I'm having a problem with my air conditioning unit
      ┊ +2.8s
 5.1s [lookup]         Agent: One moment.
 5.2s [lookup]         ⚙ lookup_caller → {known: true, name: "Jonas"}
      ┊ +3.7s ⚠ SLOW
 8.9s [safety]         Agent: Quick safety check — any gas smell...
10.1s [safety]         Caller: No.
43.2s [pre_confirm]    Caller: Yes.
43.3s [booking]        ⚙ book_service → {booked: false, error: "500"}
43.4s [booking_failed] Agent: I'm sorry — I wasn't able to lock in that time.
      ┊ +8.7s ⚠ SLOW
52.1s                  ☎ Call ended
```

### Latency gap rules

| Gap | Annotation |
|-----|-----------|
| < threshold (default 2s) | No annotation |
| >= threshold, < 5s | `┊ +Xs` (notable) |
| >= 5s | `┊ +Xs ⚠ SLOW` (potential dead-air) |

### Implementation

1. Run `fly logs -a calllock-voice --no-tail --since 1h` via subprocess
2. Grep for `TRANSCRIPT_DUMP|`
3. Reassemble chunks by call_sid (match `|N/M|` numbering)
4. Take the last complete call (or `--call-sid` if specified)
5. Strip prefix, parse JSON
6. Pretty-print with gap annotations

### Error handling

| Failure | Behavior |
|---------|----------|
| `fly` CLI not installed | `Error: flyctl not found. Install: https://fly.io/docs/flyctl/install/` |
| Not authenticated | `Error: Not authenticated with Fly.io. Run: fly auth login` |
| No TRANSCRIPT_DUMP lines | `No recent calls found in the last 1h. Try --since 2h` |
| JSON parse error (truncated) | `Error: Transcript data corrupted. Raw line: ...` |
| Incomplete chunks (some missing) | `Warning: Incomplete transcript (chunks 1,3 of 3 found). Showing partial.` |

### `--raw` mode

Outputs the reassembled JSON directly for piping into `jq` or other tools.

## Files Modified

| File | Change |
|------|--------|
| `pipecat-agent/src/calllock/processor.py` | Add `"state"` field to 3 `transcript_log.append()` calls |
| `pipecat-agent/src/calllock/transcript.py` | Add `to_timestamped_dump()` formatter |
| `pipecat-agent/src/calllock/post_call.py` | Add `chunk_transcript_dump()` + emit chunked log lines at end of `handle_call_ended()` |
| `pipecat-agent/scripts/call_transcript.py` | **New** CLI script |

## Files NOT Modified

- `session.py` — no schema changes needed (timestamp field already exists on entries)

## Testing

### Existing test updates
- Update all test entries in `test_session.py` and `test_processor.py` to include `state` field

### New tests for `to_timestamped_dump()` (in test_transcript.py)
1. Happy path: multi-entry log with agent, user, and tool entries
2. Empty log → `{"entries": []}`
3. `start_time == 0` → falls back to first entry's timestamp as base
4. Entry missing `timestamp` key → entry skipped
5. Verify `t` values are relative seconds (not absolute Unix epochs)

### New tests for `chunk_transcript_dump()` (in test_post_call.py or test_transcript.py)
1. Small transcript → 1 chunk, no splitting
2. Large transcript → multiple chunks that reassemble correctly
3. Chunk boundaries align to entry boundaries (never mid-JSON)

### New tests for CLI script (in test_call_transcript.py)
1. Parser: feed mock log lines, verify extraction and chunk reassembly
2. Parser: `--call-sid` filtering selects correct call
3. Formatter: verify gap annotations appear at correct thresholds
4. Formatter: verify `--gap-threshold` override works
5. Error cases: no lines found, truncated JSON, missing chunks

### Manual verification
- Deploy, make a test call, run `python scripts/call_transcript.py`
- Verify complete transcript with timestamps and gap annotations

## Performance

- CLI uses `fly logs --since 1h` to limit data fetched (configurable via `--since`)
- `json.dumps()` cost for transcript serialization is negligible vs. HTTP calls in post-call handler
