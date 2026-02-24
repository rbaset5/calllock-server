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
