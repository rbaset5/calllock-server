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
    State.URGENCY: {State.PRE_CONFIRM, State.URGENCY_CALLBACK},
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


WORD_TO_DIGIT = {
    "zero": "0", "oh": "0", "o": "0",
    "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
}


def words_to_digits(text: str) -> str:
    tokens = re.findall(r"[a-zA-Z]+|\d", text.lower())
    digits = []
    for tok in tokens:
        if tok in WORD_TO_DIGIT:
            digits.append(WORD_TO_DIGIT[tok])
        elif tok.isdigit():
            digits.append(tok)
    return "".join(digits)


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
        return Action(call_tool="lookup_caller", speak="One moment.", needs_llm=False)

    def _handle_non_service(self, session: CallSession, text: str) -> Action:
        lower = text.lower()
        # If they want to schedule after hearing pricing
        schedule_signals = ["yes", "yeah", "schedule", "book", "sure", "go ahead"]
        if any(s in lower for s in schedule_signals):
            _transition(session, State.SAFETY)
            return Action(needs_llm=True)
        return Action(needs_llm=True)

    def _handle_lookup(self, session: CallSession, text: str) -> Action:
        return Action(call_tool="lookup_caller", needs_llm=False)

    def _handle_follow_up(self, session: CallSession, text: str) -> Action:
        lower = text.lower()
        # Check if they mention a new issue
        new_issue_signals = ["new issue", "something else", "different problem", "also", "another"]
        if any(s in lower for s in new_issue_signals):
            _transition(session, State.SAFETY)
            return Action(needs_llm=True)
        # Check if they want to schedule
        schedule_signals = ["schedule", "book", "appointment"]
        if any(s in lower for s in schedule_signals):
            _transition(session, State.SAFETY)
            return Action(needs_llm=True)
        # Default: stay for LLM to handle
        return Action(needs_llm=True)

    def _handle_manage_booking(self, session: CallSession, text: str) -> Action:
        lower = text.lower()
        # Check for new issue
        new_issue_signals = ["new issue", "something else", "different problem", "also broken"]
        if any(s in lower for s in new_issue_signals):
            _transition(session, State.SAFETY)
            return Action(needs_llm=True)
        # Default: LLM handles reschedule/cancel/status conversation
        return Action(needs_llm=True)

    def _handle_safety(self, session: CallSession, text: str) -> Action:
        if detect_safety_emergency(text):
            _transition(session, State.SAFETY_EXIT)
            return Action(needs_llm=True)
        lower = text.lower()
        no_signals = ["no", "nope", "nah", "nothing like that", "we're fine",
                      "all good", "just not cooling", "just not heating"]
        if any(signal in lower for signal in no_signals):
            _transition(session, State.SERVICE_AREA)
            return Action(needs_llm=True)
        # Unclear — stay in safety, LLM asks follow-up
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
        return Action(needs_llm=True)

    def _handle_urgency(self, session: CallSession, text: str) -> Action:
        lower = text.lower()

        # Check for explicit callback request
        if detect_callback_request(text):
            _transition(session, State.URGENCY_CALLBACK)
            return Action(needs_llm=True)

        # High-ticket leads go to callback
        if session.lead_type == "high_ticket":
            _transition(session, State.URGENCY_CALLBACK)
            return Action(needs_llm=True)

        # Extract timing from response
        urgent_signals = ["today", "asap", "right away", "as soon as", "emergency", "right now"]
        routine_signals = ["whenever", "this week", "next few days", "no rush", "not urgent"]

        if any(s in lower for s in urgent_signals):
            session.urgency_tier = "urgent"
            session.preferred_time = "soonest available"
            _transition(session, State.PRE_CONFIRM)
            return Action(needs_llm=True)

        if any(s in lower for s in routine_signals):
            session.urgency_tier = "routine"
            session.preferred_time = "soonest available"
            _transition(session, State.PRE_CONFIRM)
            return Action(needs_llm=True)

        # Check for specific day/time mentions
        time_patterns = [
            "tomorrow", "monday", "tuesday", "wednesday", "thursday",
            "friday", "saturday", "sunday", "morning", "afternoon", "evening",
        ]
        if any(p in lower for p in time_patterns):
            session.urgency_tier = "routine"
            session.preferred_time = text.strip()
            _transition(session, State.PRE_CONFIRM)
            return Action(needs_llm=True)

        # Unclear — LLM asks about timing
        return Action(needs_llm=True)

    def _handle_urgency_callback(self, session: CallSession, text: str) -> Action:
        if session.lead_type == "high_ticket":
            return Action(call_tool="send_sales_lead_alert", needs_llm=True)
        if not session.callback_created:
            return Action(call_tool="create_callback", needs_llm=True)
        return Action(end_call=True, needs_llm=True)

    def _handle_pre_confirm(self, session: CallSession, text: str) -> Action:
        lower = text.lower()

        if detect_callback_request(text):
            _transition(session, State.CALLBACK)
            return Action(needs_llm=True)

        yes_signals = ["yes", "yeah", "yep", "sounds right", "sounds good",
                       "correct", "that's right", "go ahead"]
        if any(signal in lower for signal in yes_signals):
            session.caller_confirmed = True
            session.booking_attempted = True
            _transition(session, State.BOOKING)
            return Action(
                speak="Let me check what we've got open.",
                call_tool="book_service",
                needs_llm=True,
            )

        # Stay for corrections or re-confirmation
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
            session.booked_time = result.get("booking_time", result.get("appointment_time", ""))
            session.appointment_id = result.get("appointmentId", "")
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
