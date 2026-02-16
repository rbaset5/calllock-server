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


def test_session_has_call_metadata_fields():
    s = CallSession(phone_number="+15125551234")
    assert s.call_sid == ""
    assert s.start_time == 0.0
    assert s.transcript_log == []


def test_session_transcript_log_accumulates():
    s = CallSession(phone_number="+15125551234")
    s.transcript_log.append({"role": "agent", "content": "Hello", "timestamp": 1000.0})
    s.transcript_log.append({"role": "user", "content": "Hi", "timestamp": 1001.0})
    assert len(s.transcript_log) == 2
    assert s.transcript_log[0]["role"] == "agent"
