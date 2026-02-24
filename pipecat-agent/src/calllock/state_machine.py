import logging
import re
from dataclasses import dataclass, field

from calllock.session import CallSession
from calllock.states import State
from calllock.validation import (
    validate_zip,
    validate_name,
    validate_address,
    is_service_area,
    classify_intent,
    detect_safety_emergency,
    detect_high_ticket,
    detect_callback_request,
    match_any_keyword,
    MANAGE_BOOKING_KEYWORDS,
    WORD_TO_DIGIT,
    words_to_digits,
)

logger = logging.getLogger(__name__)

MAX_TURNS_PER_STATE = 5
MAX_TURNS_PER_CALL = 30


@dataclass
class Action:
    speak: str = ""
    call_tool: str = ""
    tool_args: dict = field(default_factory=dict)
    end_call: bool = False
    needs_llm: bool = True


TRANSITIONS = {
    State.WELCOME: {State.LOOKUP, State.NON_SERVICE, State.CALLBACK},
    State.NON_SERVICE: {State.SAFETY, State.CALLBACK},
    State.LOOKUP: {State.SAFETY, State.FOLLOW_UP, State.MANAGE_BOOKING, State.CALLBACK},
    State.FOLLOW_UP: {State.SAFETY, State.CALLBACK},
    State.MANAGE_BOOKING: {State.CONFIRM, State.SAFETY, State.CALLBACK},
    State.SAFETY: {State.SERVICE_AREA, State.SAFETY_EXIT},
    State.SAFETY_EXIT: set(),
    State.SERVICE_AREA: {State.DISCOVERY, State.CALLBACK},
    State.DISCOVERY: {State.URGENCY},
    State.URGENCY: {State.PRE_CONFIRM, State.URGENCY_CALLBACK, State.CALLBACK},
    State.URGENCY_CALLBACK: set(),
    State.PRE_CONFIRM: {State.BOOKING, State.CALLBACK},
    State.BOOKING: {State.CONFIRM, State.BOOKING_FAILED},
    State.BOOKING_FAILED: set(),
    State.CONFIRM: set(),
    State.CALLBACK: set(),
}

STATE_TOOLS = {
    State.WELCOME: [],
    State.NON_SERVICE: ["create_callback", "end_call"],
    State.LOOKUP: ["lookup_caller"],
    State.FOLLOW_UP: ["create_callback", "end_call"],
    State.MANAGE_BOOKING: ["manage_appointment", "end_call"],
    State.SAFETY: [],
    State.SAFETY_EXIT: ["end_call"],
    State.SERVICE_AREA: ["end_call"],
    State.DISCOVERY: [],
    State.URGENCY: [],
    State.URGENCY_CALLBACK: ["create_callback", "send_sales_lead_alert", "end_call"],
    State.PRE_CONFIRM: [],
    State.BOOKING: ["book_service"],
    State.BOOKING_FAILED: ["create_callback", "end_call"],
    State.CONFIRM: ["end_call"],
    State.CALLBACK: ["create_callback", "send_sales_lead_alert", "end_call"],
}

# Module-level keyword constants (moved from handler method bodies)
SCHEDULE_SIGNALS = frozenset({"yes", "yeah", "schedule", "book", "sure", "go ahead"})
NEW_ISSUE_SIGNALS = frozenset({"new issue", "something else", "different problem", "also", "another"})
NO_SIGNALS = frozenset({
    "no", "nope", "nah", "nothing like that", "we're fine",
    "all good", "just not cooling", "just not heating",
})
URGENT_SIGNALS = frozenset({
    "today", "asap", "right away", "as soon as", "emergency", "right now", "soonest",
    "urgent", "immediately", "earliest", "soon as possible",
})
ROUTINE_SIGNALS = frozenset({"whenever", "this week", "next few days", "no rush", "not urgent"})
TIME_PATTERNS = frozenset({
    "tomorrow", "monday", "tuesday", "wednesday", "thursday",
    "friday", "saturday", "sunday", "morning", "afternoon", "evening",
    "following day", "next day",
})
YES_SIGNALS = frozenset({
    "yes", "yeah", "yep", "sounds right", "sounds good",
    "correct", "that's right", "go ahead",
})
CONFIRM_CLOSE_SIGNALS = frozenset({
    "thanks", "thank you", "bye", "goodbye",
    "that's it", "that's all", "all good", "i'm good", "nothing else",
})

# Terminal state canned responses — bypass LLM entirely
TERMINAL_SCRIPTS = {
    State.CALLBACK: "I'll have someone from the team call you back within the hour. Is this the best number to reach you?",
    State.BOOKING_FAILED: "I wasn't able to lock in that time. Let me have someone call you back to get you scheduled.",
    State.SAFETY_EXIT: "This is a safety emergency. Leave the house right now and call 911 from outside. Don't flip any light switches on the way out. Stay safe.",
}

TERMINAL_SCOPED_PROMPT = """You are briefly answering a question during a call wrap-up for ACE Cooling.
Answer in one sentence maximum.
NEVER mention scheduling, appointments, availability, booking, or next steps.
NEVER offer to help with their service issue."""

BOOKING_LANGUAGE = frozenset({"appointment", "schedule", "book", "tech out", "available", "slot", "open"})


def _transition(session: CallSession, new_state: State):
    """Helper to transition state and reset turn counter."""
    session.state = new_state
    session.state_turn_count = 0
    session.agent_has_responded = False


class StateMachine:
    def valid_transitions(self, state: State) -> set[State]:
        return TRANSITIONS.get(state, set())

    def available_tools(self, state: State) -> list[str]:
        return STATE_TOOLS.get(state, [])

    def process(self, session: CallSession, user_text: str) -> Action:
        session.turn_count += 1

        # Only count a new state turn when the agent has responded since last increment.
        # Consecutive user frames (STT fragments) are part of the same exchange.
        if session.agent_has_responded:
            session.state_turn_count += 1
            session.agent_has_responded = False

        if session.turn_count > MAX_TURNS_PER_CALL:
            logger.warning("Per-call turn limit exceeded — escalating to callback")
            _transition(session, State.CALLBACK)
            return Action(
                speak="I apologize, but let me have someone from the team call you back to help you out.",
                call_tool="create_callback",
                end_call=True,
                needs_llm=False,
            )

        if session.state_turn_count > MAX_TURNS_PER_STATE:
            logger.warning("Per-state turn limit exceeded in %s", session.state.value)
            _transition(session, State.CALLBACK)
            return Action(
                speak="Let me have someone from the team call you back.",
                call_tool="create_callback",
                needs_llm=False,
            )

        handler = getattr(self, f"_handle_{session.state.value}", None)
        if handler:
            return handler(session, user_text)
        return Action()

    def handle_tool_result(self, session: CallSession, tool: str, result: dict):
        handler = getattr(self, f"_tool_result_{tool}", None)
        if handler:
            handler(session, result)

    # ── State handlers ──

    def _handle_welcome(self, session: CallSession, text: str) -> Action:
        intent = classify_intent(text)
        session.caller_intent = intent
        if intent == "non_service":
            _transition(session, State.NON_SERVICE)
            return Action(needs_llm=True)
        # All service intents (service, follow_up, manage_booking) go through lookup first
        _transition(session, State.LOOKUP)
        return Action(call_tool="lookup_caller", needs_llm=False)

    def _handle_non_service(self, session: CallSession, text: str) -> Action:
        if match_any_keyword(text, SCHEDULE_SIGNALS):
            _transition(session, State.SAFETY)
            return Action(needs_llm=True)
        return Action(needs_llm=True)

    def _handle_lookup(self, session: CallSession, text: str) -> Action:
        return Action(call_tool="lookup_caller", needs_llm=False)

    def _handle_follow_up(self, session: CallSession, text: str) -> Action:
        if match_any_keyword(text, NEW_ISSUE_SIGNALS):
            _transition(session, State.SAFETY)
            return Action(needs_llm=True)
        if match_any_keyword(text, SCHEDULE_SIGNALS):
            _transition(session, State.SAFETY)
            return Action(needs_llm=True)
        return Action(needs_llm=True)

    def _handle_manage_booking(self, session: CallSession, text: str) -> Action:
        if match_any_keyword(text, NEW_ISSUE_SIGNALS):
            _transition(session, State.SAFETY)
            return Action(needs_llm=True)
        return Action(needs_llm=True)

    def _handle_safety(self, session: CallSession, text: str) -> Action:
        if detect_safety_emergency(text):
            _transition(session, State.SAFETY_EXIT)
            return Action(needs_llm=True)
        if match_any_keyword(text, NO_SIGNALS):
            _transition(session, State.SERVICE_AREA)
            return Action(needs_llm=True)
        return Action(needs_llm=True)

    def _handle_safety_exit(self, session: CallSession, text: str) -> Action:
        return Action(end_call=True, needs_llm=True)

    def _handle_service_area(self, session: CallSession, text: str) -> Action:
        # Try to extract ZIP if not already known
        if not session.zip_code:
            zip_match = re.search(r"\b(\d{5})\b", text)
            if zip_match:
                session.zip_code = validate_zip(zip_match.group(1))
            if not session.zip_code:
                digit_str = words_to_digits(text)
                zip_match = re.search(r"(\d{5})", digit_str)
                if zip_match:
                    session.zip_code = validate_zip(zip_match.group(1))

        if session.zip_code:
            if is_service_area(session.zip_code):
                _transition(session, State.DISCOVERY)
            else:
                _transition(session, State.CALLBACK)
            return Action(needs_llm=True)
        return Action(needs_llm=True)

    def _handle_discovery(self, session: CallSession, text: str) -> Action:
        session.customer_name = validate_name(session.customer_name)
        session.service_address = validate_address(session.service_address)

        if all([session.customer_name, session.problem_description, session.service_address]):
            # Check for high-ticket before transitioning
            if detect_high_ticket(session.problem_description):
                session.lead_type = "high_ticket"
            _transition(session, State.URGENCY)
            # All fields known — skip LLM, acknowledge briefly
            return Action(speak="Got it.", needs_llm=False)
        return Action(needs_llm=True)

    def _handle_urgency(self, session: CallSession, text: str) -> Action:
        # Check for explicit callback request
        if detect_callback_request(text):
            _transition(session, State.URGENCY_CALLBACK)
            return Action(needs_llm=True)

        # High-ticket leads go to callback
        if session.lead_type == "high_ticket":
            _transition(session, State.URGENCY_CALLBACK)
            return Action(needs_llm=True)

        # Compound request: caller wants to manage existing appointment mid-service-flow
        if session.has_appointment:
            if match_any_keyword(text, MANAGE_BOOKING_KEYWORDS):
                _transition(session, State.CALLBACK)
                return Action(needs_llm=True)

        if match_any_keyword(text, URGENT_SIGNALS):
            session.urgency_tier = "urgent"
            session.preferred_time = "soonest available"
            _transition(session, State.PRE_CONFIRM)
            return Action(needs_llm=True)

        if match_any_keyword(text, ROUTINE_SIGNALS):
            session.urgency_tier = "routine"
            session.preferred_time = "soonest available"
            _transition(session, State.PRE_CONFIRM)
            return Action(needs_llm=True)

        if match_any_keyword(text, TIME_PATTERNS):
            session.urgency_tier = "routine"
            session.preferred_time = text.strip()
            _transition(session, State.PRE_CONFIRM)
            return Action(needs_llm=True)

        return Action(needs_llm=True)

    def _handle_urgency_callback(self, session: CallSession, text: str) -> Action:
        if session.lead_type == "high_ticket":
            return Action(call_tool="send_sales_lead_alert", needs_llm=True)
        if not session.callback_created:
            return Action(call_tool="create_callback", needs_llm=True)
        return Action(end_call=True, needs_llm=True)

    def _handle_pre_confirm(self, session: CallSession, text: str) -> Action:
        if detect_callback_request(text):
            _transition(session, State.CALLBACK)
            return Action(needs_llm=True)

        if match_any_keyword(text, YES_SIGNALS):
            session.caller_confirmed = True
            session.booking_attempted = True
            _transition(session, State.BOOKING)
            return Action(
                speak="Let me check what we've got open.",
                call_tool="book_service",
                needs_llm=True,
            )

        return Action(needs_llm=True)

    def _handle_booking(self, session: CallSession, text: str) -> Action:
        # Booking already fired from pre_confirm — caller spoke during the wait
        if session.booking_attempted:
            return Action(needs_llm=False)
        session.booking_attempted = True
        return Action(call_tool="book_service", needs_llm=False)

    def _handle_booking_failed(self, session: CallSession, text: str) -> Action:
        if not session.callback_created:
            return Action(call_tool="create_callback", needs_llm=True)
        return Action(end_call=True, needs_llm=True)

    def _handle_confirm(self, session: CallSession, text: str) -> Action:
        if session.state_turn_count < 1:
            # First turn: LLM confirms appointment, asks "Anything else?"
            return Action(needs_llm=True)
        # Second turn: caller responded
        if match_any_keyword(text, CONFIRM_CLOSE_SIGNALS) or not text.strip():
            # Common close -> canned response, skip LLM
            return Action(
                speak="Alright, thanks for calling ACE Cooling - stay cool out there.",
                end_call=True,
                needs_llm=False,
            )
        # Caller asked a question -> LLM answers, then end
        return Action(end_call=True, needs_llm=True)

    def _handle_callback(self, session: CallSession, text: str) -> Action:
        if session.callback_created:
            return Action(end_call=True, needs_llm=True)
        if session.callback_attempts >= 2:
            logger.warning("Callback creation failed after %d attempts", session.callback_attempts)
            return Action(end_call=True, needs_llm=True)
        return Action(call_tool="create_callback", needs_llm=True)

    # ── Tool result handlers ──

    def _tool_result_lookup_caller(self, session: CallSession, result: dict):
        session.caller_known = result.get("found", False)
        session.customer_name = validate_name(result.get("customerName", ""))
        session.zip_code = validate_zip(result.get("zipCode", ""))
        raw_address = result.get("address", "")
        session.service_address = validate_address(raw_address)
        session.has_appointment = bool(result.get("upcomingAppointment"))
        session.callback_promise = result.get("callbackPromise", "")

        # Extract appointment details if present
        appt = result.get("upcomingAppointment")
        if appt and isinstance(appt, dict):
            session.appointment_date = appt.get("date", "")
            session.appointment_time = appt.get("time", "")
            session.appointment_uid = appt.get("uid", appt.get("jobId", ""))

        # Route based on caller intent
        if session.caller_intent == "follow_up":
            _transition(session, State.FOLLOW_UP)
        elif session.caller_intent == "manage_booking" and session.has_appointment:
            _transition(session, State.MANAGE_BOOKING)
        else:
            _transition(session, State.SAFETY)

    def _tool_result_book_service(self, session: CallSession, result: dict):
        booked = result.get("booked") or result.get("booking_confirmed")
        if booked:
            session.booking_confirmed = True
            session.booked_time = result.get("appointment_time") or result.get("booking_time", "")
            session.appointment_id = result.get("appointmentId", "")
            session.confirmation_message = result.get("confirmationMessage", "")
            _transition(session, State.CONFIRM)
        else:
            session.booking_confirmed = False
            _transition(session, State.BOOKING_FAILED)

    def _tool_result_create_callback(self, session: CallSession, result: dict):
        if result.get("error"):
            session.callback_created = False
            session.callback_attempts += 1
        else:
            session.callback_created = True

    def _tool_result_send_sales_lead_alert(self, session: CallSession, result: dict):
        # After sales alert, create callback too
        pass

    def _tool_result_manage_appointment(self, session: CallSession, result: dict):
        action = result.get("action_taken", "")
        if action == "cancel":
            session.has_appointment = False
        elif action == "reschedule" and result.get("success"):
            session.appointment_date = result.get("new_date", session.appointment_date)
            session.appointment_time = result.get("new_time", session.appointment_time)
        if result.get("success"):
            _transition(session, State.CONFIRM)
