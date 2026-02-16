from calllock.classification import classify_tags, detect_priority, estimate_revenue_tier
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
        session.state = State.DONE
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
