from calllock.prompts import PERSONA, STATE_PROMPTS, get_system_prompt
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


class TestPersonaBrevity:
    def test_persona_has_word_limit(self):
        """PERSONA must contain an explicit word limit for voice context."""
        assert "25 words" in PERSONA

    def test_persona_mentions_phone_call(self):
        """PERSONA should remind the LLM this is a phone call."""
        lower = PERSONA.lower()
        assert "phone" in lower or "call" in lower


class TestStatePromptBrevity:
    def test_no_state_prompt_exceeds_400_chars(self):
        """State prompts should be concise for voice context."""
        for state, prompt in STATE_PROMPTS.items():
            assert len(prompt) < 400, (
                f"State {state.value} prompt is {len(prompt)} chars — "
                f"should be under 400 for voice brevity"
            )

    def test_system_prompt_under_1000_chars(self):
        """Full system prompt (persona + context + state) should stay compact."""
        session = CallSession(phone_number="+15125551234")
        session.customer_name = "John Smith"
        session.problem_description = "AC not cooling"
        session.service_address = "123 Main St"
        session.zip_code = "78701"
        session.state = State.DISCOVERY

        prompt = get_system_prompt(session)
        assert len(prompt) < 1000, (
            f"Full system prompt is {len(prompt)} chars — "
            f"should be under 1000 for fast LLM inference"
        )
