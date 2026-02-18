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


def test_prompt_includes_appointment_info():
    session = CallSession(phone_number="+15125551234")
    session.state = State.MANAGE_BOOKING
    session.has_appointment = True
    session.appointment_date = "2026-02-20"
    session.appointment_time = "10:00 AM"
    prompt = get_system_prompt(session)
    assert "2026-02-20" in prompt
    assert "10:00 AM" in prompt


def test_prompt_includes_high_ticket_marker():
    session = CallSession(phone_number="+15125551234")
    session.state = State.URGENCY_CALLBACK
    session.lead_type = "high_ticket"
    prompt = get_system_prompt(session)
    assert "HIGH-TICKET" in prompt


class TestPersonaContent:
    def test_persona_mentions_ace_cooling(self):
        assert "ACE Cooling" in PERSONA

    def test_persona_has_booking_firewall(self):
        assert "BOOKING FIREWALL" in PERSONA

    def test_persona_has_tone_matching(self):
        lower = PERSONA.lower()
        assert "tone matching" in lower or "mirror" in lower

    def test_persona_has_paraphrasing_examples(self):
        assert "blowing warm air" in PERSONA


class TestBookingFirewall:
    def test_booking_prompt_warns_against_fabrication(self):
        prompt = STATE_PROMPTS[State.BOOKING]
        assert "NEVER" in prompt
        assert "confirmed" in prompt.lower() or "booked" in prompt.lower()


class TestPreConfirmGuardrails:
    def test_pre_confirm_requires_explicit_approval(self):
        prompt = STATE_PROMPTS[State.PRE_CONFIRM]
        assert "NEVER" in prompt
        assert "approval" in prompt.lower() or "explicit" in prompt.lower()


class TestSafetyPrompt:
    def test_safety_prompt_mentions_retraction(self):
        prompt = STATE_PROMPTS[State.SAFETY]
        assert "RETRACTED" in prompt or "retract" in prompt.lower()
