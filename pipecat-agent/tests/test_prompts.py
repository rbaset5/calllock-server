from calllock.prompts import get_system_prompt
from calllock.session import CallSession
from calllock.states import State


def test_each_state_has_a_prompt():
    session = CallSession(phone_number="+15125551234")
    for state in State:
        session.state = state
        prompt = get_system_prompt(session)
        assert isinstance(prompt, str)
        assert len(prompt) > 50, f"Prompt for {state.value} is too short"


def test_prompt_includes_known_caller_name():
    session = CallSession(phone_number="+15125551234")
    session.state = State.SAFETY
    session.customer_name = "Jonas"
    prompt = get_system_prompt(session)
    assert "Jonas" in prompt


def test_prompt_never_contains_transition_word():
    session = CallSession(phone_number="+15125551234")
    for state in State:
        session.state = state
        prompt = get_system_prompt(session)
        assert "transition" not in prompt.lower(), \
            f"Prompt for {state.value} contains 'transition'"
