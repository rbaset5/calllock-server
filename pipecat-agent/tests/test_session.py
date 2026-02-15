from calllock.session import CallSession
from calllock.states import State


def test_new_session_starts_at_welcome():
    s = CallSession(phone_number="+15125551234")
    assert s.state == State.WELCOME


def test_session_fields_default_empty():
    s = CallSession(phone_number="+15125551234")
    assert s.customer_name == ""
    assert s.zip_code == ""
    assert s.service_address == ""
    assert s.problem_description == ""
    assert s.caller_known is False
    assert s.booking_confirmed is False


def test_session_tracks_turn_count():
    s = CallSession(phone_number="+15125551234")
    assert s.turn_count == 0
    assert s.state_turn_count == 0
