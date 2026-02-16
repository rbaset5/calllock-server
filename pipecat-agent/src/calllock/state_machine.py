from dataclasses import dataclass, field
from calllock.session import CallSession
from calllock.states import State
from calllock.validation import (
    validate_zip,
    validate_name,
    is_service_area,
    classify_intent,
    detect_safety_emergency,
    detect_high_ticket,
)
import re


@dataclass
class Action:
    """What the pipeline should do after state machine processes a turn."""
    speak: str = ""            # Text for TTS (empty = LLM generates it)
    call_tool: str = ""        # Tool to invoke (empty = no tool)
    tool_args: dict = field(default_factory=dict)
    end_call: bool = False
    needs_llm: bool = True     # Whether LLM should generate a response


# Valid transitions: state -> set of reachable states
TRANSITIONS = {
    State.WELCOME: {State.LOOKUP, State.CALLBACK},
    State.LOOKUP: {State.SAFETY, State.CALLBACK},
    State.SAFETY: {State.SERVICE_AREA, State.SAFETY_EXIT},
    State.SAFETY_EXIT: set(),
    State.SERVICE_AREA: {State.DISCOVERY, State.CALLBACK},
    State.DISCOVERY: {State.CONFIRM},
    State.CONFIRM: {State.BOOKING, State.CALLBACK},
    State.BOOKING: {State.DONE, State.CALLBACK},
    State.DONE: set(),
    State.CALLBACK: set(),
}

# Tools available per state
STATE_TOOLS = {
    State.WELCOME: [],
    State.LOOKUP: ["lookup_caller"],
    State.SAFETY: [],
    State.SAFETY_EXIT: ["end_call"],
    State.SERVICE_AREA: ["end_call"],
    State.DISCOVERY: [],
    State.CONFIRM: [],
    State.BOOKING: ["book_service"],
    State.DONE: ["end_call"],
    State.CALLBACK: ["create_callback", "send_sales_lead_alert", "end_call"],
}


WORD_TO_DIGIT = {
    "zero": "0", "oh": "0", "o": "0",
    "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
}


def words_to_digits(text: str) -> str:
    """Convert spoken number words to digit string.

    'seven eight seven zero one' -> '78701'
    'seven eight seven oh one' -> '78701'
    """
    tokens = re.findall(r"[a-zA-Z]+|\d", text.lower())
    digits = []
    for tok in tokens:
        if tok in WORD_TO_DIGIT:
            digits.append(WORD_TO_DIGIT[tok])
        elif tok.isdigit():
            digits.append(tok)
    return "".join(digits)


class StateMachine:
    def valid_transitions(self, state: State) -> set[State]:
        return TRANSITIONS.get(state, set())

    def available_tools(self, state: State) -> list[str]:
        return STATE_TOOLS.get(state, [])

    def process(self, session: CallSession, user_text: str) -> Action:
        """Process a user turn. Returns an Action for the pipeline."""
        session.turn_count += 1
        session.state_turn_count += 1

        handler = getattr(self, f"_handle_{session.state.value}", None)
        if handler:
            return handler(session, user_text)
        return Action()

    def handle_tool_result(self, session: CallSession, tool: str, result: dict):
        """Process a tool result and advance state."""
        handler = getattr(self, f"_tool_result_{tool}", None)
        if handler:
            handler(session, result)

    # --- State handlers ---

    def _handle_welcome(self, session: CallSession, text: str) -> Action:
        intent = classify_intent(text)
        if intent == "non_service":
            session.state = State.CALLBACK
            return Action(needs_llm=True)
        session.state = State.LOOKUP
        return Action(call_tool="lookup_caller", needs_llm=False)

    def _handle_lookup(self, session: CallSession, text: str) -> Action:
        return Action(call_tool="lookup_caller", needs_llm=False)

    def _handle_safety(self, session: CallSession, text: str) -> Action:
        if detect_safety_emergency(text):
            session.state = State.SAFETY_EXIT
            return Action(needs_llm=True)
        # Look for clear "no" signals
        lower = text.lower()
        no_signals = ["no", "nope", "nah", "nothing like that", "we're fine", "all good"]
        if any(signal in lower for signal in no_signals):
            session.state = State.SERVICE_AREA
            return Action(needs_llm=True)
        # Unclear — stay in safety, LLM asks again
        return Action(needs_llm=True)

    def _handle_safety_exit(self, session: CallSession, text: str) -> Action:
        return Action(end_call=True, needs_llm=True)

    def _handle_service_area(self, session: CallSession, text: str) -> Action:
        # Try to extract ZIP from text if not already known
        if not session.zip_code:
            # First try raw digits: "78701"
            zip_match = re.search(r"\b(\d{5})\b", text)
            if zip_match:
                session.zip_code = validate_zip(zip_match.group(1))

            # Then try spoken words: "seven eight seven zero one"
            if not session.zip_code:
                digit_str = words_to_digits(text)
                zip_match = re.search(r"(\d{5})", digit_str)
                if zip_match:
                    session.zip_code = validate_zip(zip_match.group(1))

        if session.zip_code:
            if is_service_area(session.zip_code):
                session.state = State.DISCOVERY
            else:
                session.state = State.CALLBACK
            session.state_turn_count = 0
            return Action(needs_llm=True)
        # No valid ZIP yet — stay, LLM asks
        return Action(needs_llm=True)

    def _handle_discovery(self, session: CallSession, text: str) -> Action:
        # Validate current fields
        session.customer_name = validate_name(session.customer_name)

        if all([session.customer_name, session.problem_description, session.service_address]):
            session.state = State.CONFIRM
        return Action(needs_llm=True)

    def _handle_confirm(self, session: CallSession, text: str) -> Action:
        lower = text.lower()

        # Check for callback request
        callback_signals = ["call me back", "callback", "just call", "have someone call"]
        if any(signal in lower for signal in callback_signals):
            session.state = State.CALLBACK
            return Action(needs_llm=True)

        # Check for high-ticket lead
        if detect_high_ticket(text):
            session.lead_type = "high_ticket"

        # Check for confirmation
        yes_signals = ["yes", "yeah", "yep", "sounds right", "sounds good", "schedule", "book"]
        if any(signal in lower for signal in yes_signals):
            session.caller_confirmed = True
            if session.lead_type == "high_ticket":
                session.state = State.CALLBACK
                return Action(call_tool="send_sales_lead_alert", needs_llm=True)
            session.state = State.BOOKING
            return Action(needs_llm=True)

        return Action(needs_llm=True)

    def _handle_booking(self, session: CallSession, text: str) -> Action:
        return Action(call_tool="book_service", end_call=False, needs_llm=False)

    def _handle_done(self, session: CallSession, text: str) -> Action:
        return Action(end_call=True, needs_llm=True)

    def _handle_callback(self, session: CallSession, text: str) -> Action:
        if session.callback_created:
            return Action(end_call=True, needs_llm=True)
        return Action(call_tool="create_callback", needs_llm=True)

    # --- Tool result handlers ---

    def _tool_result_lookup_caller(self, session: CallSession, result: dict):
        session.caller_known = result.get("found", False)
        session.customer_name = validate_name(result.get("customerName", ""))
        session.zip_code = validate_zip(result.get("zipCode", ""))
        session.has_appointment = bool(result.get("upcomingAppointment"))
        session.callback_promise = result.get("callbackPromise", "")
        session.state = State.SAFETY
        session.state_turn_count = 0

    def _tool_result_book_service(self, session: CallSession, result: dict):
        if result.get("booked"):
            session.booking_confirmed = True
            session.booked_time = result.get("booking_time", "")
            session.state = State.DONE
        else:
            session.booking_confirmed = False
            session.state = State.CALLBACK
        session.state_turn_count = 0

    def _tool_result_create_callback(self, session: CallSession, result: dict):
        session.callback_created = True

    def _tool_result_send_sales_lead_alert(self, session: CallSession, result: dict):
        # Alert sent — state already set to CALLBACK
        pass
