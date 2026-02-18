from calllock.transcript import to_plain_text, to_json_array, to_timestamped_dump


class TestToPlainText:
    def test_basic_conversation(self):
        log = [
            {"role": "agent", "content": "Thanks for calling ACE Cooling.", "timestamp": 1000.0, "state": "welcome"},
            {"role": "user", "content": "My AC is broken.", "timestamp": 1002.0, "state": "welcome"},
            {"role": "agent", "content": "Let me look into that.", "timestamp": 1004.0, "state": "welcome"},
        ]
        result = to_plain_text(log)
        assert result == (
            "Agent: Thanks for calling ACE Cooling.\n"
            "Caller: My AC is broken.\n"
            "Agent: Let me look into that."
        )

    def test_includes_tool_invocations(self):
        log = [
            {"role": "agent", "content": "Pulling that up now.", "timestamp": 1000.0, "state": "lookup"},
            {"role": "tool", "name": "lookup_caller", "result": {"found": True}, "timestamp": 1001.0, "state": "lookup"},
            {"role": "agent", "content": "I found your account.", "timestamp": 1002.0, "state": "lookup"},
        ]
        result = to_plain_text(log)
        assert "[Tool: lookup_caller]" in result

    def test_empty_log(self):
        assert to_plain_text([]) == ""


class TestToJsonArray:
    def test_basic_conversation(self):
        log = [
            {"role": "agent", "content": "Hello.", "timestamp": 1000.0, "state": "welcome"},
            {"role": "user", "content": "Hi.", "timestamp": 1001.0, "state": "welcome"},
        ]
        result = to_json_array(log)
        assert len(result) == 2
        assert result[0]["role"] == "agent"
        assert result[0]["content"] == "Hello."
        assert result[1]["role"] == "user"
        assert result[1]["content"] == "Hi."

    def test_tool_entries_included(self):
        log = [
            {"role": "tool", "name": "book_service", "result": {"booked": True}, "timestamp": 1000.0, "state": "booking"},
        ]
        result = to_json_array(log)
        assert len(result) == 1
        assert result[0]["role"] == "tool"
        assert result[0]["name"] == "book_service"

    def test_empty_log(self):
        assert to_json_array([]) == []


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
