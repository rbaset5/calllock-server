import pytest
from calllock.session import CallSession
from calllock.states import State
from calllock.state_machine import StateMachine, Action


@pytest.fixture
def sm():
    return StateMachine()


@pytest.fixture
def session():
    return CallSession(phone_number="+15125551234")


# --- WELCOME state ---

class TestWelcomeState:
    def test_service_intent_routes_to_lookup(self, sm, session):
        action = sm.process(session, "my AC is broken")
        assert session.state == State.LOOKUP

    def test_billing_intent_routes_to_callback(self, sm, session):
        action = sm.process(session, "I have a billing question")
        assert session.state == State.CALLBACK

    def test_vendor_intent_routes_to_callback(self, sm, session):
        action = sm.process(session, "I'm a parts supplier")
        assert session.state == State.CALLBACK

    def test_ambiguous_defaults_to_lookup(self, sm, session):
        action = sm.process(session, "hello")
        assert session.state == State.LOOKUP


# --- LOOKUP state ---

class TestLookupState:
    def test_routes_to_safety_after_lookup(self, sm, session):
        session.state = State.LOOKUP
        action = sm.process(session, "")
        assert action.call_tool == "lookup_caller"

    def test_populates_session_from_lookup_result(self, sm, session):
        session.state = State.LOOKUP
        sm.handle_tool_result(session, "lookup_caller", {
            "found": True,
            "customerName": "Jonas",
            "zipCode": "78745",
        })
        assert session.caller_known is True
        assert session.customer_name == "Jonas"
        assert session.zip_code == "78745"
        assert session.state == State.SAFETY

    def test_unknown_caller_still_routes_to_safety(self, sm, session):
        session.state = State.LOOKUP
        sm.handle_tool_result(session, "lookup_caller", {"found": False})
        assert session.caller_known is False
        assert session.state == State.SAFETY


# --- SAFETY state ---

class TestSafetyState:
    def test_emergency_routes_to_safety_exit(self, sm, session):
        session.state = State.SAFETY
        action = sm.process(session, "yes I smell gas right now")
        assert session.state == State.SAFETY_EXIT

    def test_no_emergency_routes_to_service_area(self, sm, session):
        session.state = State.SAFETY
        action = sm.process(session, "no nothing like that")
        assert session.state == State.SERVICE_AREA

    def test_unclear_stays_in_safety(self, sm, session):
        session.state = State.SAFETY
        action = sm.process(session, "what do you mean")
        assert session.state == State.SAFETY


# --- SAFETY_EXIT state ---

class TestSafetyExitState:
    def test_ends_call(self, sm, session):
        session.state = State.SAFETY_EXIT
        action = sm.process(session, "")
        assert action.end_call is True


# --- SERVICE_AREA state ---

class TestServiceAreaState:
    def test_known_valid_zip_routes_to_discovery(self, sm, session):
        session.state = State.SERVICE_AREA
        session.zip_code = "78745"
        action = sm.process(session, "")
        assert session.state == State.DISCOVERY

    def test_caller_provides_valid_zip(self, sm, session):
        session.state = State.SERVICE_AREA
        action = sm.process(session, "my ZIP is 78701")
        assert session.zip_code == "78701"
        assert session.state == State.DISCOVERY

    def test_out_of_area_zip_routes_to_callback(self, sm, session):
        session.state = State.SERVICE_AREA
        action = sm.process(session, "my ZIP is 90210")
        assert session.state == State.CALLBACK

    def test_invalid_zip_stays_in_state(self, sm, session):
        session.state = State.SERVICE_AREA
        action = sm.process(session, "it's 787")
        assert session.state == State.SERVICE_AREA


# --- DISCOVERY state ---

class TestDiscoveryState:
    def test_all_fields_routes_to_confirm(self, sm, session):
        session.state = State.DISCOVERY
        session.customer_name = "Jonas"
        session.problem_description = "AC blowing warm air"
        session.service_address = "4210 South Lamar Blvd"
        action = sm.process(session, "")
        assert session.state == State.CONFIRM

    def test_missing_name_stays(self, sm, session):
        session.state = State.DISCOVERY
        session.problem_description = "AC broken"
        session.service_address = "123 Main St"
        action = sm.process(session, "")
        assert session.state == State.DISCOVERY

    def test_phone_number_as_name_rejected(self, sm, session):
        session.state = State.DISCOVERY
        session.customer_name = "5125551234"
        session.problem_description = "AC broken"
        session.service_address = "123 Main St"
        action = sm.process(session, "")
        assert session.customer_name == ""
        assert session.state == State.DISCOVERY


# --- CONFIRM state ---

class TestConfirmState:
    def test_yes_routes_to_booking(self, sm, session):
        session.state = State.CONFIRM
        session.caller_confirmed = True
        action = sm.process(session, "yes that sounds right, schedule me")
        assert session.state == State.BOOKING

    def test_callback_request_routes_to_callback(self, sm, session):
        session.state = State.CONFIRM
        action = sm.process(session, "just have someone call me back")
        assert session.state == State.CALLBACK

    def test_high_ticket_routes_to_callback(self, sm, session):
        session.state = State.CONFIRM
        session.lead_type = "high_ticket"
        session.caller_confirmed = True
        action = sm.process(session, "yes I want a new system")
        assert session.state == State.CALLBACK
        assert action.call_tool == "send_sales_lead_alert"


# --- BOOKING state ---

class TestBookingState:
    def test_enters_booking_calls_tool(self, sm, session):
        session.state = State.BOOKING
        action = sm.process(session, "")
        assert action.call_tool == "book_service"

    def test_booking_success_routes_to_done(self, sm, session):
        session.state = State.BOOKING
        sm.handle_tool_result(session, "book_service", {
            "booked": True,
            "booking_time": "2026-02-15T10:00:00",
        })
        assert session.booking_confirmed is True
        assert session.state == State.DONE

    def test_booking_failure_routes_to_callback(self, sm, session):
        session.state = State.BOOKING
        sm.handle_tool_result(session, "book_service", {"booked": False})
        assert session.booking_confirmed is False
        assert session.state == State.CALLBACK

    def test_booking_has_no_end_call(self, sm, session):
        """The critical structural guarantee: booking cannot end a call."""
        session.state = State.BOOKING
        action = sm.process(session, "")
        assert action.end_call is False


# --- DONE state ---

class TestDoneState:
    def test_ends_call(self, sm, session):
        session.state = State.DONE
        action = sm.process(session, "")
        assert action.end_call is True


# --- CALLBACK state ---

class TestCallbackState:
    def test_fires_callback_tool(self, sm, session):
        session.state = State.CALLBACK
        action = sm.process(session, "")
        assert action.call_tool == "create_callback"

    def test_ends_call_after_callback(self, sm, session):
        session.state = State.CALLBACK
        sm.handle_tool_result(session, "create_callback", {"success": True})
        action = sm.process(session, "")
        assert action.end_call is True


# --- Structural guarantees ---

class TestStructuralGuarantees:
    def test_no_backward_transitions(self, sm, session):
        """States can only move forward in the flow."""
        forward_order = [
            State.WELCOME, State.LOOKUP, State.SAFETY,
            State.SERVICE_AREA, State.DISCOVERY, State.CONFIRM,
            State.BOOKING, State.DONE,
        ]
        for i, state in enumerate(forward_order[:-1]):
            valid_nexts = sm.valid_transitions(state)
            for prev_state in forward_order[:i]:
                assert prev_state not in valid_nexts, \
                    f"{state.value} should not transition back to {prev_state.value}"

    def test_decision_states_have_no_tools(self, sm):
        for state in [State.WELCOME, State.SAFETY, State.DISCOVERY, State.CONFIRM]:
            assert sm.available_tools(state) == [], \
                f"Decision state {state.value} should have no tools"

    def test_booking_has_no_end_call(self, sm):
        assert "end_call" not in sm.available_tools(State.BOOKING)
