from calllock.states import State


def test_all_ten_states_exist():
    expected = {
        "welcome", "lookup", "safety", "safety_exit",
        "service_area", "discovery", "confirm",
        "booking", "done", "callback",
    }
    assert {s.value for s in State} == expected


def test_decision_states():
    assert State.WELCOME.is_decision
    assert State.SAFETY.is_decision
    assert State.SERVICE_AREA.is_decision
    assert State.DISCOVERY.is_decision
    assert State.CONFIRM.is_decision


def test_action_states():
    assert State.LOOKUP.is_action
    assert State.BOOKING.is_action


def test_terminal_states():
    assert State.SAFETY_EXIT.is_terminal
    assert State.DONE.is_terminal
    assert State.CALLBACK.is_terminal
