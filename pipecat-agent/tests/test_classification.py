from calllock.classification import classify_tags
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
