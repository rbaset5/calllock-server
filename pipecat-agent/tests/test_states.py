from calllock.states import State


def test_all_sixteen_states_exist():
    expected = {
        "welcome", "non_service", "lookup", "follow_up", "manage_booking",
        "safety", "safety_exit", "service_area", "discovery",
        "urgency", "urgency_callback", "pre_confirm",
        "booking", "booking_failed", "confirm", "callback",
    }
    assert {s.value for s in State} == expected


def test_decision_states():
    assert State.WELCOME.is_decision
    assert State.SAFETY.is_decision
    assert State.SERVICE_AREA.is_decision
    assert State.DISCOVERY.is_decision
    assert State.URGENCY.is_decision
    assert State.PRE_CONFIRM.is_decision


def test_action_states():
    assert State.LOOKUP.is_action
    assert State.BOOKING.is_action


def test_terminal_states():
    assert State.SAFETY_EXIT.is_terminal
    assert State.CONFIRM.is_terminal
    assert State.CALLBACK.is_terminal
    assert State.BOOKING_FAILED.is_terminal
    assert State.URGENCY_CALLBACK.is_terminal
