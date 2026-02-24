import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from calllock.classification import classify_tags, detect_priority, estimate_revenue_tier, classify_call
from calllock.session import CallSession
from calllock.states import State


class TestClassifyTags:
    def test_safety_exit_produces_hazard_tag(self):
        session = CallSession(phone_number="+15125551234")
        session.state = State.SAFETY_EXIT
        transcript_text = "I smell gas in my house"
        tags = classify_tags(session, transcript_text)
        assert "GAS_LEAK" in tags["HAZARD"]

    def test_co_detector_produces_co_tag(self):
        session = CallSession(phone_number="+15125551234")
        session.state = State.SAFETY_EXIT
        transcript_text = "my CO detector is going off"
        tags = classify_tags(session, transcript_text)
        assert "CO_EVENT" in tags["HAZARD"]

    def test_emergency_urgency_tag(self):
        session = CallSession(phone_number="+15125551234")
        session.urgency_tier = "emergency"
        tags = classify_tags(session, "")
        assert "EMERGENCY_SAMEDAY" in tags["URGENCY"]

    def test_standard_urgency_default(self):
        session = CallSession(phone_number="+15125551234")
        session.urgency_tier = "routine"
        tags = classify_tags(session, "")
        assert "STANDARD" in tags["URGENCY"]

    def test_high_ticket_produces_revenue_tag(self):
        session = CallSession(phone_number="+15125551234")
        session.problem_description = "I want a new AC system"
        tags = classify_tags(session, "")
        assert "HOT_LEAD" in tags["REVENUE"]

    def test_new_customer_tag(self):
        session = CallSession(phone_number="+15125551234")
        session.caller_known = False
        tags = classify_tags(session, "")
        assert "NEW_CUSTOMER" in tags["CUSTOMER"]

    def test_existing_customer_tag(self):
        session = CallSession(phone_number="+15125551234")
        session.caller_known = True
        tags = classify_tags(session, "")
        assert "EXISTING_CUSTOMER" in tags["CUSTOMER"]

    def test_non_service_vendor_tag(self):
        session = CallSession(phone_number="+15125551234")
        session.state = State.CALLBACK
        transcript_text = "I'm a parts supplier"
        tags = classify_tags(session, transcript_text)
        assert len(tags["NON_CUSTOMER"]) > 0

    def test_repair_ac_service_type(self):
        session = CallSession(phone_number="+15125551234")
        session.problem_description = "my AC is broken and not cooling"
        tags = classify_tags(session, "")
        assert "REPAIR_AC" in tags["SERVICE_TYPE"]

    def test_all_nine_categories_present(self):
        session = CallSession(phone_number="+15125551234")
        tags = classify_tags(session, "")
        expected_categories = {
            "HAZARD", "URGENCY", "SERVICE_TYPE", "REVENUE",
            "RECOVERY", "LOGISTICS", "CUSTOMER", "NON_CUSTOMER", "CONTEXT",
        }
        assert set(tags.keys()) == expected_categories

    def test_booking_confirmed_produces_service_type(self):
        session = CallSession(phone_number="+15125551234")
        session.state = State.CONFIRM
        session.booking_confirmed = True
        session.problem_description = "heating not working"
        tags = classify_tags(session, "")
        assert "REPAIR_HEATING" in tags["SERVICE_TYPE"]


class TestDetectPriority:
    def test_hazard_tags_produce_red(self):
        tags = {"HAZARD": ["GAS_LEAK"], "RECOVERY": [], "REVENUE": [], "NON_CUSTOMER": []}
        result = detect_priority(tags, "attempted_failed")
        assert result["color"] == "red"

    def test_recovery_tags_produce_red(self):
        tags = {"HAZARD": [], "RECOVERY": ["COMPLAINT_NOFIX"], "REVENUE": [], "NON_CUSTOMER": []}
        result = detect_priority(tags, "confirmed")
        assert result["color"] == "red"

    def test_commercial_produces_green(self):
        tags = {"HAZARD": [], "RECOVERY": [], "REVENUE": ["HOT_LEAD"], "NON_CUSTOMER": []}
        result = detect_priority(tags, "confirmed")
        assert result["color"] == "green"

    def test_vendor_produces_gray(self):
        tags = {"HAZARD": [], "RECOVERY": [], "REVENUE": [], "NON_CUSTOMER": ["VENDOR_SALES"]}
        result = detect_priority(tags, "not_requested")
        assert result["color"] == "gray"

    def test_standard_call_produces_blue(self):
        tags = {"HAZARD": [], "RECOVERY": [], "REVENUE": [], "NON_CUSTOMER": []}
        result = detect_priority(tags, "confirmed")
        assert result["color"] == "blue"

    def test_result_has_reason(self):
        tags = {"HAZARD": ["GAS_LEAK"], "RECOVERY": [], "REVENUE": [], "NON_CUSTOMER": []}
        result = detect_priority(tags, "confirmed")
        assert isinstance(result["reason"], str)
        assert len(result["reason"]) > 0


class TestEstimateRevenueTier:
    def test_replacement_keywords(self):
        result = estimate_revenue_tier("I want a new AC system installed", [])
        assert result["tier"] == "replacement"
        assert result["tier_label"] == "$$$$"

    def test_major_repair_keywords(self):
        result = estimate_revenue_tier("compressor is dead", [])
        assert result["tier"] == "major_repair"
        assert result["tier_label"] == "$$$"

    def test_standard_repair_default(self):
        result = estimate_revenue_tier("AC is broken not cooling", [])
        assert result["tier"] == "standard_repair"
        assert result["tier_label"] == "$$"

    def test_minor_keywords(self):
        result = estimate_revenue_tier("thermostat is not responding", [])
        assert result["tier"] == "minor"
        assert result["tier_label"] == "$"

    def test_diagnostic_fallback(self):
        result = estimate_revenue_tier("", [])
        assert result["tier"] == "diagnostic"
        assert result["tier_label"] == "$$?"

    def test_r22_signals_replacement(self):
        result = estimate_revenue_tier("needs freon recharge", ["R22_RETROFIT"])
        assert result["tier"] == "replacement"

    def test_result_has_signals(self):
        result = estimate_revenue_tier("compressor failed", [])
        assert isinstance(result["signals"], list)
        assert len(result["signals"]) > 0

    def test_result_has_confidence(self):
        result = estimate_revenue_tier("new system replacement", [])
        assert result["confidence"] in ("low", "medium", "high")


def _mock_openai_response(content: str):
    """Helper to create a mock httpx response for OpenAI chat completions."""
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "choices": [{"message": {"content": content}}]
    }
    mock_resp.raise_for_status = MagicMock()
    return mock_resp


class TestClassifyCall:
    @pytest.mark.asyncio
    @patch("calllock.classification.httpx.AsyncClient")
    async def test_returns_all_fields(self, mock_client_cls, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        mock_resp = _mock_openai_response(
            '{"ai_summary": "Customer called about AC not cooling.", '
            '"card_headline": "AC Not Blowing Cold", '
            '"card_summary": "Jonas called about AC unit not blowing cold air.", '
            '"call_type": "SERVICE", '
            '"call_subtype": "REPAIR_AC", '
            '"sentiment_score": 4}'
        )
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        session = CallSession(phone_number="+15125551234")
        session.state = State.CONFIRM
        session.customer_name = "Jonas"
        session.booking_confirmed = True
        result = await classify_call(session, "Customer called about AC issue.")

        assert result["ai_summary"] == "Customer called about AC not cooling."
        assert result["card_headline"] == "AC Not Blowing Cold"
        assert result["call_type"] == "SERVICE"
        assert result["sentiment_score"] == 4

    @pytest.mark.asyncio
    @patch("calllock.classification.httpx.AsyncClient")
    async def test_returns_empty_on_api_failure(self, mock_client_cls, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=Exception("API timeout"))
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        session = CallSession(phone_number="+15125551234")
        result = await classify_call(session, "Some transcript")

        assert result == {}

    @pytest.mark.asyncio
    @patch("calllock.classification.httpx.AsyncClient")
    async def test_clamps_sentiment_score(self, mock_client_cls, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        mock_resp = _mock_openai_response(
            '{"ai_summary": "Test.", "card_headline": "Test", '
            '"card_summary": "Test.", "call_type": "SERVICE", '
            '"call_subtype": null, "sentiment_score": 7}'
        )
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        session = CallSession(phone_number="+15125551234")
        result = await classify_call(session, "Transcript text")

        assert result["sentiment_score"] == 5  # clamped to max

    @pytest.mark.asyncio
    async def test_returns_empty_on_missing_api_key(self, monkeypatch):
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)

        session = CallSession(phone_number="+15125551234")
        result = await classify_call(session, "Some transcript")
        assert result == {}

    @pytest.mark.asyncio
    async def test_returns_empty_on_empty_transcript(self, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")

        session = CallSession(phone_number="+15125551234")
        result = await classify_call(session, "   ")
        assert result == {}
