from calllock.transcript import to_plain_text, to_json_array


class TestToPlainText:
    def test_basic_conversation(self):
        log = [
            {"role": "agent", "content": "Thanks for calling ACE Cooling.", "timestamp": 1000.0},
            {"role": "user", "content": "My AC is broken.", "timestamp": 1002.0},
            {"role": "agent", "content": "Let me look into that.", "timestamp": 1004.0},
        ]
        result = to_plain_text(log)
        assert result == (
            "Agent: Thanks for calling ACE Cooling.\n"
            "Caller: My AC is broken.\n"
            "Agent: Let me look into that."
        )

    def test_includes_tool_invocations(self):
        log = [
            {"role": "agent", "content": "Pulling that up now.", "timestamp": 1000.0},
            {"role": "tool", "name": "lookup_caller", "result": {"found": True}, "timestamp": 1001.0},
            {"role": "agent", "content": "I found your account.", "timestamp": 1002.0},
        ]
        result = to_plain_text(log)
        assert "[Tool: lookup_caller]" in result

    def test_empty_log(self):
        assert to_plain_text([]) == ""


class TestToJsonArray:
    def test_basic_conversation(self):
        log = [
            {"role": "agent", "content": "Hello.", "timestamp": 1000.0},
            {"role": "user", "content": "Hi.", "timestamp": 1001.0},
        ]
        result = to_json_array(log)
        assert len(result) == 2
        assert result[0]["role"] == "agent"
        assert result[0]["content"] == "Hello."
        assert result[1]["role"] == "user"
        assert result[1]["content"] == "Hi."

    def test_tool_entries_included(self):
        log = [
            {"role": "tool", "name": "book_service", "result": {"booked": True}, "timestamp": 1000.0},
        ]
        result = to_json_array(log)
        assert len(result) == 1
        assert result[0]["role"] == "tool"
        assert result[0]["name"] == "book_service"

    def test_empty_log(self):
        assert to_json_array([]) == []
