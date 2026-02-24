# Timestamped Transcript CLI — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Emit a structured timestamped transcript at the end of every call and provide a CLI to pull/display it with latency gap highlighting.

**Architecture:** Post-call handler emits chunked `TRANSCRIPT_DUMP` log lines containing the full timestamped transcript. A local CLI script parses these from `fly logs` output and pretty-prints with gap annotations. Formatting logic lives in `transcript.py` (DRY — all formatters in one place), chunking logic in `post_call.py`.

**Tech Stack:** Python 3.12, argparse, subprocess (for `fly` CLI), json, pytest

---

### Task 1: Add `state` field to transcript entries in processor.py

**Files:**
- Modify: `pipecat-agent/src/calllock/processor.py:79-83` (agent entries)
- Modify: `pipecat-agent/src/calllock/processor.py:103-107` (user entries)
- Modify: `pipecat-agent/src/calllock/processor.py:203-208` (tool entries)

**Step 1: Add `state` to the agent transcript entry (line 79-83)**

Change:
```python
self.session.transcript_log.append({
    "role": "agent",
    "content": msg["content"],
    "timestamp": _time.time(),
})
```

To:
```python
self.session.transcript_log.append({
    "role": "agent",
    "content": msg["content"],
    "timestamp": _time.time(),
    "state": self.session.state.value,
})
```

**Step 2: Add `state` to the user transcript entry (line 103-107)**

Change:
```python
self.session.transcript_log.append({
    "role": "user",
    "content": text,
    "timestamp": _time.time(),
})
```

To:
```python
self.session.transcript_log.append({
    "role": "user",
    "content": text,
    "timestamp": _time.time(),
    "state": self.session.state.value,
})
```

**Step 3: Add `state` to the tool transcript entry (line 203-208)**

Change:
```python
self.session.transcript_log.append({
    "role": "tool",
    "name": tool,
    "result": result,
    "timestamp": _time.time(),
})
```

To:
```python
self.session.transcript_log.append({
    "role": "tool",
    "name": tool,
    "result": result,
    "timestamp": _time.time(),
    "state": self.session.state.value,
})
```

**Step 4: Run existing processor tests to verify nothing breaks**

Run: `pytest pipecat-agent/tests/test_processor.py -v`
Expected: All tests PASS (existing assertions only check `role` and `content`, not `state`)

**Step 5: Update test_session.py entries to include `state`**

In `pipecat-agent/tests/test_session.py:35-36`, change:
```python
s.transcript_log.append({"role": "agent", "content": "Hello", "timestamp": 1000.0})
s.transcript_log.append({"role": "user", "content": "Hi", "timestamp": 1001.0})
```

To:
```python
s.transcript_log.append({"role": "agent", "content": "Hello", "timestamp": 1000.0, "state": "welcome"})
s.transcript_log.append({"role": "user", "content": "Hi", "timestamp": 1001.0, "state": "welcome"})
```

**Step 6: Run session tests**

Run: `pytest pipecat-agent/tests/test_session.py -v`
Expected: All tests PASS

**Step 7: Update test_transcript.py entries to include `state`**

Add `"state": "welcome"` (or appropriate state) to every dict in the test `log` lists:
- `TestToPlainText.test_basic_conversation` (line 6-10): add `"state": "welcome"` to all 3 entries
- `TestToPlainText.test_includes_tool_invocations` (line 20-23): add `"state": "lookup"` to all 3 entries
- `TestToJsonArray.test_basic_conversation` (line 33-35): add `"state": "welcome"` to both entries
- `TestToJsonArray.test_tool_entries_included` (line 45-46): add `"state": "booking"` to the entry

**Step 8: Run transcript tests**

Run: `pytest pipecat-agent/tests/test_transcript.py -v`
Expected: All tests PASS

**Step 9: Update test_post_call.py fixture entries to include `state`**

In the `completed_session` fixture (line 26-31):
```python
s.transcript_log = [
    {"role": "agent", "content": "Thanks for calling ACE Cooling.", "timestamp": 1000.0, "state": "welcome"},
    {"role": "user", "content": "My AC is blowing warm air.", "timestamp": 1002.0, "state": "welcome"},
    {"role": "tool", "name": "book_service", "result": {"booked": True}, "timestamp": 1010.0, "state": "booking"},
    {"role": "agent", "content": "You're all set for tomorrow morning.", "timestamp": 1012.0, "state": "confirm"},
]
```

In the `safety_session` fixture (line 43-47):
```python
s.transcript_log = [
    {"role": "agent", "content": "Any safety concerns?", "timestamp": 2000.0, "state": "safety"},
    {"role": "user", "content": "I smell gas in my house", "timestamp": 2002.0, "state": "safety"},
    {"role": "agent", "content": "Please call 911 immediately.", "timestamp": 2003.0, "state": "safety_exit"},
]
```

**Step 10: Run post_call tests**

Run: `pytest pipecat-agent/tests/test_post_call.py -v`
Expected: All tests PASS

**Step 11: Run full test suite**

Run: `pytest pipecat-agent/tests/ -v`
Expected: All tests PASS

**Step 12: Commit**

```bash
git add pipecat-agent/src/calllock/processor.py pipecat-agent/tests/test_session.py pipecat-agent/tests/test_transcript.py pipecat-agent/tests/test_post_call.py
git commit -m "feat: add state field to transcript log entries"
```

---

### Task 2: Add `to_timestamped_dump()` formatter to transcript.py (TDD)

**Files:**
- Test: `pipecat-agent/tests/test_transcript.py`
- Modify: `pipecat-agent/src/calllock/transcript.py`

**Step 1: Write failing tests for `to_timestamped_dump()`**

Append to `pipecat-agent/tests/test_transcript.py`:

```python
from calllock.transcript import to_timestamped_dump


class TestToTimestampedDump:
    def test_happy_path_multi_entry(self):
        log = [
            {"role": "agent", "content": "Hello.", "timestamp": 1000.0, "state": "welcome"},
            {"role": "user", "content": "Hi.", "timestamp": 1002.3, "state": "welcome"},
            {"role": "tool", "name": "lookup_caller", "result": {"found": True}, "timestamp": 1005.2, "state": "lookup"},
            {"role": "agent", "content": "Found your account.", "timestamp": 1008.9, "state": "safety"},
        ]
        result = to_timestamped_dump(
            log, start_time=1000.0, call_sid="CA_test", phone="+15125551234", final_state="done"
        )
        assert result["call_sid"] == "CA_test"
        assert result["phone"] == "+15125551234"
        assert result["final_state"] == "done"
        assert result["duration_s"] == 0  # duration_s not computed here, caller provides it
        assert len(result["entries"]) == 4
        # Verify relative timestamps
        assert result["entries"][0]["t"] == 0.0
        assert result["entries"][1]["t"] == 2.3
        assert result["entries"][2]["t"] == 5.2
        assert result["entries"][3]["t"] == 8.9
        # Verify fields
        assert result["entries"][0]["role"] == "agent"
        assert result["entries"][0]["content"] == "Hello."
        assert result["entries"][0]["state"] == "welcome"
        assert result["entries"][2]["name"] == "lookup_caller"
        assert result["entries"][2]["result"] == {"found": True}

    def test_empty_log(self):
        result = to_timestamped_dump(
            [], start_time=1000.0, call_sid="CA_empty", phone="+15125551234", final_state="welcome"
        )
        assert result["entries"] == []
        assert result["call_sid"] == "CA_empty"

    def test_start_time_zero_falls_back_to_first_entry(self):
        log = [
            {"role": "agent", "content": "Hello.", "timestamp": 5000.0, "state": "welcome"},
            {"role": "user", "content": "Hi.", "timestamp": 5003.0, "state": "welcome"},
        ]
        result = to_timestamped_dump(
            log, start_time=0.0, call_sid="CA_nostart", phone="+1", final_state="done"
        )
        assert result["entries"][0]["t"] == 0.0
        assert result["entries"][1]["t"] == 3.0

    def test_entry_missing_timestamp_is_skipped(self):
        log = [
            {"role": "agent", "content": "Hello.", "timestamp": 1000.0, "state": "welcome"},
            {"role": "user", "content": "Oops no timestamp", "state": "welcome"},
            {"role": "agent", "content": "Next.", "timestamp": 1002.0, "state": "safety"},
        ]
        result = to_timestamped_dump(
            log, start_time=1000.0, call_sid="CA_skip", phone="+1", final_state="done"
        )
        assert len(result["entries"]) == 2
        assert result["entries"][0]["content"] == "Hello."
        assert result["entries"][1]["content"] == "Next."

    def test_t_values_are_relative_not_absolute(self):
        log = [
            {"role": "user", "content": "Hi.", "timestamp": 1739900000.0, "state": "welcome"},
        ]
        result = to_timestamped_dump(
            log, start_time=1739900000.0, call_sid="CA_abs", phone="+1", final_state="done"
        )
        assert result["entries"][0]["t"] == 0.0
        assert result["entries"][0]["t"] < 1000  # Must not be a Unix epoch
```

**Step 2: Run tests to verify they fail**

Run: `pytest pipecat-agent/tests/test_transcript.py::TestToTimestampedDump -v`
Expected: FAIL with `ImportError: cannot import name 'to_timestamped_dump'`

**Step 3: Implement `to_timestamped_dump()` in transcript.py**

Add to the end of `pipecat-agent/src/calllock/transcript.py`:

```python
def to_timestamped_dump(
    log: list[dict],
    start_time: float,
    call_sid: str,
    phone: str,
    final_state: str,
) -> dict:
    """Build a timestamped transcript dump dict for structured logging.

    Timestamps are converted to relative seconds from call start.
    If start_time is 0, uses the first entry's timestamp as base.
    Entries missing a timestamp key are skipped.
    """
    # Determine base time
    base_time = start_time
    if base_time <= 0 and log:
        for entry in log:
            if "timestamp" in entry:
                base_time = entry["timestamp"]
                break

    entries = []
    for entry in log:
        if "timestamp" not in entry:
            continue
        e = {
            "t": round(entry["timestamp"] - base_time, 1),
            "role": entry["role"],
            "state": entry.get("state", ""),
        }
        if "content" in entry:
            e["content"] = entry["content"]
        if "name" in entry:
            e["name"] = entry["name"]
        if "result" in entry:
            e["result"] = entry["result"]
        entries.append(e)

    return {
        "call_sid": call_sid,
        "phone": phone,
        "final_state": final_state,
        "entries": entries,
    }
```

**Step 4: Run tests to verify they pass**

Run: `pytest pipecat-agent/tests/test_transcript.py::TestToTimestampedDump -v`
Expected: All 5 tests PASS

**Step 5: Run full transcript test suite**

Run: `pytest pipecat-agent/tests/test_transcript.py -v`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add pipecat-agent/src/calllock/transcript.py pipecat-agent/tests/test_transcript.py
git commit -m "feat: add to_timestamped_dump() formatter for structured transcript logging"
```

---

### Task 3: Add chunking logic and emit TRANSCRIPT_DUMP in post_call.py (TDD)

**Files:**
- Test: `pipecat-agent/tests/test_post_call.py`
- Modify: `pipecat-agent/src/calllock/post_call.py`

**Step 1: Write failing tests for `chunk_transcript_dump()` and the log emission**

Append to `pipecat-agent/tests/test_post_call.py`:

```python
import json
from calllock.post_call import chunk_transcript_dump


class TestChunkTranscriptDump:
    def test_small_transcript_single_chunk(self):
        dump = {
            "call_sid": "CA_test",
            "phone": "+15125551234",
            "final_state": "done",
            "entries": [
                {"t": 0.0, "role": "agent", "state": "welcome", "content": "Hello."},
            ],
        }
        chunks = chunk_transcript_dump(dump, max_bytes=3500)
        assert len(chunks) == 1
        assert chunks[0].startswith("TRANSCRIPT_DUMP|1/1|")
        payload = json.loads(chunks[0].split("|", 2)[2])
        assert payload["call_sid"] == "CA_test"
        assert len(payload["entries"]) == 1

    def test_large_transcript_multiple_chunks(self):
        entries = [
            {"t": float(i), "role": "user", "state": "discovery", "content": f"Message number {i} with some padding text to take up space."}
            for i in range(50)
        ]
        dump = {
            "call_sid": "CA_big",
            "phone": "+15125551234",
            "final_state": "done",
            "entries": entries,
        }
        chunks = chunk_transcript_dump(dump, max_bytes=1000)
        assert len(chunks) > 1
        # Verify numbering
        for i, chunk in enumerate(chunks, 1):
            prefix = chunk.split("|", 2)
            assert prefix[0] == "TRANSCRIPT_DUMP"
            assert prefix[1] == f"{i}/{len(chunks)}"
        # Verify all entries are present when reassembled
        all_entries = []
        for chunk in chunks:
            payload = json.loads(chunk.split("|", 2)[2])
            all_entries.extend(payload.get("entries", []))
        assert len(all_entries) == 50

    def test_chunks_never_split_mid_entry(self):
        entries = [
            {"t": float(i), "role": "agent", "state": "welcome", "content": "A" * 200}
            for i in range(20)
        ]
        dump = {
            "call_sid": "CA_mid",
            "phone": "+1",
            "final_state": "done",
            "entries": entries,
        }
        chunks = chunk_transcript_dump(dump, max_bytes=1000)
        for chunk in chunks:
            payload = json.loads(chunk.split("|", 2)[2])
            # Each chunk's JSON must be valid (not truncated)
            assert isinstance(payload, dict)
            for entry in payload.get("entries", []):
                assert "t" in entry
                assert "role" in entry

    def test_first_chunk_has_header_fields(self):
        dump = {
            "call_sid": "CA_hdr",
            "phone": "+15125559876",
            "final_state": "booking_failed",
            "entries": [
                {"t": float(i), "role": "user", "state": "discovery", "content": "X" * 300}
                for i in range(20)
            ],
        }
        chunks = chunk_transcript_dump(dump, max_bytes=1000)
        first = json.loads(chunks[0].split("|", 2)[2])
        assert first["call_sid"] == "CA_hdr"
        assert first["phone"] == "+15125559876"
        assert first["final_state"] == "booking_failed"


class TestTranscriptDumpEmission:
    @respx.mock
    @pytest.mark.asyncio
    async def test_handle_call_ended_emits_transcript_dump(self, completed_session, monkeypatch, caplog):
        monkeypatch.setenv("DASHBOARD_JOBS_URL", "https://app.example.com/api/webhook/jobs")
        monkeypatch.setenv("DASHBOARD_CALLS_URL", "https://app.example.com/api/webhook/calls")
        monkeypatch.setenv("DASHBOARD_ALERTS_URL", "https://app.example.com/api/webhook/emergency-alerts")
        monkeypatch.setenv("DASHBOARD_WEBHOOK_SECRET", "test-secret")
        monkeypatch.setenv("DASHBOARD_USER_EMAIL", "owner@test.com")

        respx.post("https://app.example.com/api/webhook/jobs").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        respx.post("https://app.example.com/api/webhook/calls").mock(
            return_value=httpx.Response(200, json={"success": True})
        )

        import logging
        with caplog.at_level(logging.INFO, logger="calllock.post_call"):
            await handle_call_ended(completed_session)

        dump_lines = [r.message for r in caplog.records if "TRANSCRIPT_DUMP|" in r.message]
        assert len(dump_lines) >= 1, "Expected at least one TRANSCRIPT_DUMP log line"
        # Parse the first chunk
        payload = json.loads(dump_lines[0].split("|", 2)[2])
        assert payload["call_sid"] == "CA_test_123"
        assert len(payload["entries"]) > 0
```

**Step 2: Run tests to verify they fail**

Run: `pytest pipecat-agent/tests/test_post_call.py::TestChunkTranscriptDump -v`
Expected: FAIL with `ImportError: cannot import name 'chunk_transcript_dump'`

**Step 3: Implement `chunk_transcript_dump()` and emit in `handle_call_ended()`**

In `pipecat-agent/src/calllock/post_call.py`, add `import json` to the imports (line 1 area), then add the import for the new formatter:

```python
import json
```

And update the transcript import:
```python
from calllock.transcript import to_plain_text, to_json_array, to_timestamped_dump
```

Add the `chunk_transcript_dump` function before `handle_call_ended`:

```python
def chunk_transcript_dump(dump: dict, max_bytes: int = 3500) -> list[str]:
    """Split a transcript dump into chunks that fit within log line limits.

    Each chunk is a string: TRANSCRIPT_DUMP|N/M|{json}
    The first chunk contains header fields + as many entries as fit.
    Subsequent chunks contain only entries.
    """
    header = {k: v for k, v in dump.items() if k != "entries"}
    entries = dump.get("entries", [])

    if not entries:
        payload = json.dumps({**header, "entries": []})
        return [f"TRANSCRIPT_DUMP|1/1|{payload}"]

    # Build chunks by adding entries one at a time
    chunks_entries: list[list[dict]] = []
    current_chunk: list[dict] = []
    # Reserve space for header in first chunk
    current_size = len(json.dumps({**header, "entries": []}).encode("utf-8"))
    is_first = True

    for entry in entries:
        entry_json = json.dumps(entry)
        entry_size = len(entry_json.encode("utf-8")) + 2  # +2 for comma and bracket overhead

        if current_chunk and (current_size + entry_size) > max_bytes:
            chunks_entries.append(current_chunk)
            current_chunk = []
            # Subsequent chunks: only {"entries": [...]}
            current_size = len(json.dumps({"entries": []}).encode("utf-8"))
            is_first = False

        current_chunk.append(entry)
        current_size += entry_size

    if current_chunk:
        chunks_entries.append(current_chunk)

    total = len(chunks_entries)
    result = []
    for i, chunk_entries in enumerate(chunks_entries):
        if i == 0:
            payload = json.dumps({**header, "entries": chunk_entries})
        else:
            payload = json.dumps({"entries": chunk_entries})
        result.append(f"TRANSCRIPT_DUMP|{i + 1}/{total}|{payload}")

    return result
```

At the end of `handle_call_ended()`, before the final log line (line 176), add:

```python
    # 4. Emit structured transcript dump for CLI retrieval
    end_duration = round(end_time - session.start_time, 1) if session.start_time > 0 else 0
    dump = to_timestamped_dump(
        session.transcript_log,
        start_time=session.start_time,
        call_sid=session.call_sid,
        phone=session.phone_number,
        final_state=session.state.value,
    )
    dump["duration_s"] = end_duration
    for line in chunk_transcript_dump(dump):
        logger.info(line)
```

**Step 4: Run the chunk tests**

Run: `pytest pipecat-agent/tests/test_post_call.py::TestChunkTranscriptDump -v`
Expected: All 4 tests PASS

**Step 5: Run the emission test**

Run: `pytest pipecat-agent/tests/test_post_call.py::TestTranscriptDumpEmission -v`
Expected: PASS

**Step 6: Run full post_call test suite**

Run: `pytest pipecat-agent/tests/test_post_call.py -v`
Expected: All tests PASS

**Step 7: Run full test suite**

Run: `pytest pipecat-agent/tests/ -v`
Expected: All tests PASS

**Step 8: Commit**

```bash
git add pipecat-agent/src/calllock/post_call.py pipecat-agent/tests/test_post_call.py
git commit -m "feat: emit chunked TRANSCRIPT_DUMP log lines after each call"
```

---

### Task 4: Create CLI script with parser and formatter (TDD)

**Files:**
- Create: `pipecat-agent/scripts/call_transcript.py`
- Create: `pipecat-agent/tests/test_call_transcript.py`

**Step 1: Create the test file first**

Create `pipecat-agent/tests/test_call_transcript.py`:

```python
import json
import sys
import os
import pytest

# Add scripts to path so we can import the module
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from call_transcript import parse_transcript_lines, format_transcript


class TestParseTranscriptLines:
    def test_single_chunk(self):
        dump = {
            "call_sid": "CA_test",
            "phone": "+15125551234",
            "final_state": "done",
            "duration_s": 52.1,
            "entries": [
                {"t": 0.0, "role": "agent", "state": "welcome", "content": "Hello."},
                {"t": 2.3, "role": "user", "state": "welcome", "content": "Hi."},
            ],
        }
        lines = [f"TRANSCRIPT_DUMP|1/1|{json.dumps(dump)}"]
        result = parse_transcript_lines(lines)
        assert len(result) == 1
        assert result[0]["call_sid"] == "CA_test"
        assert len(result[0]["entries"]) == 2

    def test_multi_chunk_reassembly(self):
        chunk1 = json.dumps({
            "call_sid": "CA_multi",
            "phone": "+1",
            "final_state": "done",
            "duration_s": 10.0,
            "entries": [{"t": 0.0, "role": "agent", "state": "welcome", "content": "A"}],
        })
        chunk2 = json.dumps({
            "entries": [{"t": 5.0, "role": "user", "state": "discovery", "content": "B"}],
        })
        lines = [
            f"TRANSCRIPT_DUMP|1/2|{chunk1}",
            f"TRANSCRIPT_DUMP|2/2|{chunk2}",
        ]
        result = parse_transcript_lines(lines)
        assert len(result) == 1
        assert result[0]["call_sid"] == "CA_multi"
        assert len(result[0]["entries"]) == 2
        assert result[0]["entries"][1]["content"] == "B"

    def test_call_sid_filter(self):
        dump1 = {"call_sid": "CA_first", "phone": "+1", "final_state": "done", "duration_s": 5, "entries": []}
        dump2 = {"call_sid": "CA_second", "phone": "+1", "final_state": "done", "duration_s": 5, "entries": []}
        lines = [
            f"TRANSCRIPT_DUMP|1/1|{json.dumps(dump1)}",
            f"TRANSCRIPT_DUMP|1/1|{json.dumps(dump2)}",
        ]
        result = parse_transcript_lines(lines, call_sid="CA_first")
        assert len(result) == 1
        assert result[0]["call_sid"] == "CA_first"

    def test_no_transcript_lines_returns_empty(self):
        lines = ["some random log line", "another line"]
        result = parse_transcript_lines(lines)
        assert result == []

    def test_corrupted_json_skipped(self):
        lines = [
            "TRANSCRIPT_DUMP|1/1|{not valid json",
            f"TRANSCRIPT_DUMP|1/1|{json.dumps({'call_sid': 'CA_ok', 'phone': '+1', 'final_state': 'done', 'duration_s': 5, 'entries': []})}",
        ]
        result = parse_transcript_lines(lines)
        assert len(result) == 1
        assert result[0]["call_sid"] == "CA_ok"


class TestFormatTranscript:
    def test_basic_formatting(self):
        transcript = {
            "call_sid": "CA_fmt",
            "phone": "+15125551234",
            "final_state": "done",
            "duration_s": 10.0,
            "entries": [
                {"t": 0.0, "role": "agent", "state": "welcome", "content": "Hello."},
                {"t": 2.3, "role": "user", "state": "welcome", "content": "Hi."},
            ],
        }
        output = format_transcript(transcript, gap_threshold=2.0)
        assert "CA_fmt" in output
        assert "+15125551234" in output
        assert "0.0s" in output
        assert "Agent: Hello." in output
        assert "Caller: Hi." in output

    def test_gap_annotation_shown_for_notable_gap(self):
        transcript = {
            "call_sid": "CA_gap",
            "phone": "+1",
            "final_state": "done",
            "duration_s": 10.0,
            "entries": [
                {"t": 0.0, "role": "agent", "state": "welcome", "content": "Hello."},
                {"t": 3.5, "role": "user", "state": "welcome", "content": "Hi."},
            ],
        }
        output = format_transcript(transcript, gap_threshold=2.0)
        assert "+3.5s" in output

    def test_slow_annotation_for_large_gap(self):
        transcript = {
            "call_sid": "CA_slow",
            "phone": "+1",
            "final_state": "done",
            "duration_s": 40.0,
            "entries": [
                {"t": 0.0, "role": "agent", "state": "welcome", "content": "Hello."},
                {"t": 30.0, "role": "user", "state": "welcome", "content": "Hi."},
            ],
        }
        output = format_transcript(transcript, gap_threshold=2.0)
        assert "SLOW" in output

    def test_no_gap_annotation_for_small_gap(self):
        transcript = {
            "call_sid": "CA_fast",
            "phone": "+1",
            "final_state": "done",
            "duration_s": 5.0,
            "entries": [
                {"t": 0.0, "role": "agent", "state": "welcome", "content": "Hello."},
                {"t": 1.0, "role": "user", "state": "welcome", "content": "Hi."},
            ],
        }
        output = format_transcript(transcript, gap_threshold=2.0)
        # No gap annotation lines
        lines = output.split("\n")
        gap_lines = [l for l in lines if "+" in l and "s" in l and l.strip().startswith("\u2506")]
        assert len(gap_lines) == 0

    def test_tool_entry_formatted(self):
        transcript = {
            "call_sid": "CA_tool",
            "phone": "+1",
            "final_state": "done",
            "duration_s": 5.0,
            "entries": [
                {"t": 1.0, "role": "tool", "state": "lookup", "name": "lookup_caller", "result": {"found": True}},
            ],
        }
        output = format_transcript(transcript, gap_threshold=2.0)
        assert "lookup_caller" in output

    def test_custom_gap_threshold(self):
        transcript = {
            "call_sid": "CA_thresh",
            "phone": "+1",
            "final_state": "done",
            "duration_s": 10.0,
            "entries": [
                {"t": 0.0, "role": "agent", "state": "welcome", "content": "Hello."},
                {"t": 2.5, "role": "user", "state": "welcome", "content": "Hi."},
            ],
        }
        # With threshold=2.0, this gap should be annotated
        output_low = format_transcript(transcript, gap_threshold=2.0)
        # With threshold=3.0, this gap should NOT be annotated
        output_high = format_transcript(transcript, gap_threshold=3.0)
        assert "+2.5s" in output_low
        gap_lines = [l for l in output_high.split("\n") if l.strip().startswith("\u2506")]
        assert len(gap_lines) == 0

    def test_call_ended_marker(self):
        transcript = {
            "call_sid": "CA_end",
            "phone": "+1",
            "final_state": "done",
            "duration_s": 5.0,
            "entries": [
                {"t": 0.0, "role": "agent", "state": "welcome", "content": "Hello."},
            ],
        }
        output = format_transcript(transcript, gap_threshold=2.0)
        assert "Call ended" in output
```

**Step 2: Run tests to verify they fail**

Run: `pytest pipecat-agent/tests/test_call_transcript.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'call_transcript'`

**Step 3: Create the CLI script**

Create directory and script:

```bash
mkdir -p pipecat-agent/scripts
```

Create `pipecat-agent/scripts/call_transcript.py`:

```python
#!/usr/bin/env python3
"""Pull timestamped transcript from the last call via Fly.io logs.

Usage:
    python scripts/call_transcript.py                    # last call, human-readable
    python scripts/call_transcript.py --raw              # last call, raw JSON
    python scripts/call_transcript.py --call-sid CA...   # specific call
    python scripts/call_transcript.py --gap-threshold 3  # custom gap threshold
    python scripts/call_transcript.py --since 2h         # look back 2 hours
"""

import argparse
import json
import shutil
import subprocess
import sys


def parse_transcript_lines(lines: list[str], call_sid: str | None = None) -> list[dict]:
    """Parse TRANSCRIPT_DUMP lines from log output into transcript dicts.

    Handles multi-chunk reassembly. Returns list of complete transcripts
    (most recent last). If call_sid is specified, filters to that call only.
    """
    # Group chunks by their position in the line stream
    # Each set of N/M chunks forms one transcript
    chunk_groups: dict[int, dict[int, str]] = {}  # group_id -> {chunk_num: payload}
    group_counter = 0
    current_total = None

    for line in lines:
        if "TRANSCRIPT_DUMP|" not in line:
            continue

        # Extract the TRANSCRIPT_DUMP|N/M|{json} part
        # Log lines may have a prefix (timestamp, etc.)
        idx = line.index("TRANSCRIPT_DUMP|")
        dump_part = line[idx:]

        parts = dump_part.split("|", 2)
        if len(parts) < 3:
            continue

        try:
            chunk_info = parts[1]  # "N/M"
            chunk_num, total = chunk_info.split("/")
            chunk_num = int(chunk_num)
            total = int(total)
        except (ValueError, IndexError):
            continue

        # Detect new group when we see chunk 1
        if chunk_num == 1:
            group_counter += 1

        if group_counter not in chunk_groups:
            chunk_groups[group_counter] = {}
        chunk_groups[group_counter][chunk_num] = parts[2]

    # Reassemble each group
    transcripts = []
    for group_id in sorted(chunk_groups.keys()):
        chunks = chunk_groups[group_id]
        if not chunks:
            continue

        # Parse first chunk for header
        try:
            first = json.loads(chunks.get(1, "{}"))
        except json.JSONDecodeError:
            continue

        if call_sid and first.get("call_sid") != call_sid:
            continue

        # Merge entries from all chunks
        all_entries = list(first.get("entries", []))
        for i in sorted(chunks.keys()):
            if i == 1:
                continue
            try:
                chunk_data = json.loads(chunks[i])
                all_entries.extend(chunk_data.get("entries", []))
            except json.JSONDecodeError:
                continue

        first["entries"] = all_entries
        transcripts.append(first)

    return transcripts


def format_transcript(transcript: dict, gap_threshold: float = 2.0) -> str:
    """Format a transcript dict into human-readable output with gap annotations."""
    lines = []

    # Header
    sid = transcript.get("call_sid", "unknown")
    phone = transcript.get("phone", "unknown")
    duration = transcript.get("duration_s", 0)
    final_state = transcript.get("final_state", "unknown")
    lines.append(f"Call {sid} | {phone} | {duration}s | {final_state}")
    lines.append("\u2550" * 55)
    lines.append("")

    entries = transcript.get("entries", [])
    prev_t = None

    for entry in entries:
        t = entry.get("t", 0.0)
        role = entry.get("role", "")
        state = entry.get("state", "")

        # Gap annotation
        if prev_t is not None:
            gap = t - prev_t
            if gap >= gap_threshold:
                if gap >= 5.0:
                    lines.append(f"      \u2506 +{gap:.1f}s \u26a0 SLOW")
                else:
                    lines.append(f"      \u2506 +{gap:.1f}s")

        # Format the entry
        state_tag = f"[{state}]" if state else ""
        t_str = f"{t:5.1f}s"

        if role == "agent":
            content = entry.get("content", "")
            lines.append(f"{t_str} {state_tag:<18} Agent: {content}")
        elif role == "user":
            content = entry.get("content", "")
            lines.append(f"{t_str} {state_tag:<18} Caller: {content}")
        elif role == "tool":
            name = entry.get("name", "unknown")
            result = entry.get("result", {})
            result_short = json.dumps(result) if len(json.dumps(result)) < 80 else json.dumps(result)[:77] + "..."
            lines.append(f"{t_str} {state_tag:<18} \u2699 {name} \u2192 {result_short}")

        prev_t = t

    # Call ended marker
    if entries:
        lines.append(f"{duration:5.1f}s {'':18} \u260e Call ended")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Pull timestamped transcript from last call")
    parser.add_argument("--raw", action="store_true", help="Output raw JSON")
    parser.add_argument("--call-sid", type=str, default=None, help="Filter by specific call SID")
    parser.add_argument("--gap-threshold", type=float, default=2.0, help="Gap threshold in seconds (default: 2.0)")
    parser.add_argument("--since", type=str, default="1h", help="How far back to search (default: 1h)")
    parser.add_argument("--app", type=str, default="calllock-voice", help="Fly.io app name")
    args = parser.parse_args()

    # Check fly CLI is installed
    if not shutil.which("fly") and not shutil.which("flyctl"):
        print("Error: flyctl not found. Install: https://fly.io/docs/flyctl/install/", file=sys.stderr)
        sys.exit(1)

    fly_cmd = "fly" if shutil.which("fly") else "flyctl"

    # Fetch logs
    try:
        result = subprocess.run(
            [fly_cmd, "logs", "-a", args.app, "--no-tail", "--since", args.since],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError:
        print("Error: flyctl not found. Install: https://fly.io/docs/flyctl/install/", file=sys.stderr)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print("Error: fly logs timed out after 30s", file=sys.stderr)
        sys.exit(1)

    if result.returncode != 0:
        stderr = result.stderr.strip()
        if "not authenticated" in stderr.lower() or "login" in stderr.lower():
            print("Error: Not authenticated with Fly.io. Run: fly auth login", file=sys.stderr)
        else:
            print(f"Error: fly logs failed: {stderr}", file=sys.stderr)
        sys.exit(1)

    lines = result.stdout.strip().split("\n")

    # Parse
    transcripts = parse_transcript_lines(lines, call_sid=args.call_sid)

    if not transcripts:
        print(f"No recent calls found in the last {args.since}. Try --since 2h", file=sys.stderr)
        sys.exit(1)

    # Take the last transcript (most recent call)
    transcript = transcripts[-1]

    if args.raw:
        print(json.dumps(transcript, indent=2))
    else:
        print(format_transcript(transcript, gap_threshold=args.gap_threshold))


if __name__ == "__main__":
    main()
```

**Step 4: Run CLI tests**

Run: `pytest pipecat-agent/tests/test_call_transcript.py -v`
Expected: All tests PASS

**Step 5: Run full test suite**

Run: `pytest pipecat-agent/tests/ -v`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add pipecat-agent/scripts/call_transcript.py pipecat-agent/tests/test_call_transcript.py
git commit -m "feat: add CLI script to pull timestamped transcripts from Fly.io logs"
```

---

### Task 5: Integration test — full test suite + manual verification

**Step 1: Run the complete test suite**

Run: `pytest pipecat-agent/tests/ -v`
Expected: All tests PASS, no regressions

**Step 2: Verify the CLI script runs without errors locally**

Run: `cd pipecat-agent && python scripts/call_transcript.py --help`
Expected: Help text prints with all flags (--raw, --call-sid, --gap-threshold, --since)

**Step 3: Commit any fixes if needed, then deploy**

```bash
cd pipecat-agent
fly deploy -a calllock-voice
```

Wait for deploy to complete. Verify health:
```bash
curl -s https://calllock-voice.fly.dev/health
```

**Step 4: Make a test call, then pull the transcript**

After a test call completes:
```bash
cd pipecat-agent
python scripts/call_transcript.py
```

Expected: Formatted transcript with timestamps, state tags, and gap annotations.

**Step 5: Verify --raw mode**

```bash
python scripts/call_transcript.py --raw | python -m json.tool
```

Expected: Valid JSON output with all entries.

**Step 6: Final commit if any adjustments needed**

```bash
git add -A
git commit -m "chore: integration test adjustments for timestamped transcript CLI"
```
