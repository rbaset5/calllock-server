# Pipecat Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Retell AI with a Pipecat-based voice pipeline where a deterministic Python state machine controls all flow, tool invocations, and call lifecycle.

**Architecture:** Pipecat handles audio transport (Twilio WebSocket, Deepgram STT, ElevenLabs TTS). A custom Python state machine sits in the pipeline and controls everything: state transitions, LLM prompt injection, data extraction, validation, and tool calls to the existing V2 backend via HTTP. The LLM generates conversational text only.

**Tech Stack:** Python 3.12, Pipecat, FastAPI, Deepgram Nova-3, ElevenLabs TTS, OpenAI GPT-4o, Twilio Programmable Voice, httpx, pytest, Fly.io

**Design Doc:** `docs/plans/2026-02-14-pipecat-migration-design.md`

---

## Git Setup (Pre-Task)

```bash
# Merge v10 branch to main first
cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/yokohama
git checkout main
git merge rbaset5/v10-state-machine-simplification

# Create migration branch
git checkout -b rbaset5/pipecat-migration
```

## Project Structure

```
pipecat-agent/
  pyproject.toml
  .env.example
  Dockerfile
  fly.toml
  src/
    calllock/
      __init__.py
      bot.py                  # FastAPI app + Twilio WebSocket handler
      pipeline.py             # Pipecat pipeline assembly
      session.py              # CallSession dataclass
      states.py               # State enum
      state_machine.py        # StateMachine class (deterministic transitions)
      extraction.py           # LLM-based structured data extraction
      validation.py           # Deterministic validators (ZIP, name, etc.)
      prompts.py              # State-specific LLM system prompts
      tools.py                # HTTP clients for V2 backend tools
  tests/
    __init__.py
    conftest.py               # Shared fixtures
    test_session.py
    test_states.py
    test_state_machine.py
    test_validation.py
    test_extraction.py
    test_tools.py
    test_prompts.py
```

---

## Task 1: Project Scaffold

**Files:**
- Create: `pipecat-agent/pyproject.toml`
- Create: `pipecat-agent/.env.example`
- Create: `pipecat-agent/src/calllock/__init__.py`
- Create: `pipecat-agent/tests/__init__.py`
- Create: `pipecat-agent/tests/conftest.py`

**Step 1: Create project directory and pyproject.toml**

```toml
# pipecat-agent/pyproject.toml
[project]
name = "calllock-voice"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "pipecat-ai[silero,deepgram,openai,elevenlabs]>=0.0.60",
    "fastapi>=0.115.0",
    "uvicorn>=0.32.0",
    "httpx>=0.27.0",
    "python-dotenv>=1.0.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.24.0",
    "pytest-mock>=3.14.0",
    "respx>=0.22.0",
]

[build-system]
requires = ["setuptools>=75.0"]
build-backend = "setuptools.backends._legacy:_Backend"

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

**Step 2: Create .env.example**

```bash
# pipecat-agent/.env.example
OPENAI_API_KEY=sk-...
DEEPGRAM_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
V2_BACKEND_URL=https://calllock-server.onrender.com
PORT=8765
```

**Step 3: Create __init__.py and conftest.py**

```python
# pipecat-agent/src/calllock/__init__.py
```

```python
# pipecat-agent/tests/__init__.py
```

```python
# pipecat-agent/tests/conftest.py
import pytest
from calllock.session import CallSession
from calllock.states import State
from calllock.state_machine import StateMachine


@pytest.fixture
def session():
    return CallSession(phone_number="+15125551234")


@pytest.fixture
def machine():
    return StateMachine()
```

**Step 4: Install and verify**

Run: `cd pipecat-agent && pip install -e ".[dev]"`
Expected: installs cleanly

**Step 5: Commit**

```bash
git add pipecat-agent/
git commit -m "chore: scaffold pipecat-agent project"
```

---

## Task 2: CallSession + State Enum (TDD)

**Files:**
- Create: `pipecat-agent/src/calllock/states.py`
- Create: `pipecat-agent/src/calllock/session.py`
- Test: `pipecat-agent/tests/test_session.py`
- Test: `pipecat-agent/tests/test_states.py`

**Step 1: Write failing tests**

```python
# pipecat-agent/tests/test_states.py
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
```

```python
# pipecat-agent/tests/test_session.py
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
```

**Step 2: Run tests to verify they fail**

Run: `cd pipecat-agent && python -m pytest tests/test_states.py tests/test_session.py -v`
Expected: FAIL — modules not found

**Step 3: Implement states.py**

```python
# pipecat-agent/src/calllock/states.py
from enum import Enum

DECISION_STATES = {"welcome", "safety", "service_area", "discovery", "confirm"}
ACTION_STATES = {"lookup", "booking"}
TERMINAL_STATES = {"safety_exit", "done", "callback"}


class State(Enum):
    WELCOME = "welcome"
    LOOKUP = "lookup"
    SAFETY = "safety"
    SAFETY_EXIT = "safety_exit"
    SERVICE_AREA = "service_area"
    DISCOVERY = "discovery"
    CONFIRM = "confirm"
    BOOKING = "booking"
    DONE = "done"
    CALLBACK = "callback"

    @property
    def is_decision(self) -> bool:
        return self.value in DECISION_STATES

    @property
    def is_action(self) -> bool:
        return self.value in ACTION_STATES

    @property
    def is_terminal(self) -> bool:
        return self.value in TERMINAL_STATES
```

**Step 4: Implement session.py**

```python
# pipecat-agent/src/calllock/session.py
from dataclasses import dataclass, field
from calllock.states import State


@dataclass
class CallSession:
    phone_number: str
    state: State = State.WELCOME

    # From lookup
    caller_known: bool = False
    customer_name: str = ""
    zip_code: str = ""
    service_address: str = ""
    has_appointment: bool = False
    callback_promise: str = ""

    # From discovery
    problem_description: str = ""

    # From confirm
    preferred_time: str = ""
    urgency_tier: str = "routine"
    lead_type: str = ""
    caller_confirmed: bool = False

    # From booking
    booking_confirmed: bool = False
    booked_time: str = ""

    # Metadata
    turn_count: int = 0
    state_turn_count: int = 0
    conversation_history: list = field(default_factory=list)
```

**Step 5: Run tests to verify they pass**

Run: `cd pipecat-agent && python -m pytest tests/test_states.py tests/test_session.py -v`
Expected: all PASS

**Step 6: Commit**

```bash
git add pipecat-agent/src/calllock/states.py pipecat-agent/src/calllock/session.py pipecat-agent/tests/test_states.py pipecat-agent/tests/test_session.py
git commit -m "feat: add State enum and CallSession dataclass"
```

---

## Task 3: Deterministic Validators (TDD)

**Files:**
- Create: `pipecat-agent/src/calllock/validation.py`
- Test: `pipecat-agent/tests/test_validation.py`

**Step 1: Write failing tests**

```python
# pipecat-agent/tests/test_validation.py
from calllock.validation import (
    validate_zip,
    validate_name,
    is_service_area,
    classify_intent,
    detect_safety_emergency,
    detect_high_ticket,
)


class TestValidateZip:
    def test_valid_zip(self):
        assert validate_zip("78745") == "78745"

    def test_valid_zip_787_prefix(self):
        assert validate_zip("78701") == "78701"

    def test_rejects_partial_zip(self):
        assert validate_zip("787") == ""

    def test_rejects_non_numeric(self):
        assert validate_zip("abcde") == ""

    def test_rejects_six_digits(self):
        assert validate_zip("787456") == ""

    def test_rejects_empty(self):
        assert validate_zip("") == ""

    def test_rejects_none(self):
        assert validate_zip(None) == ""

    def test_strips_whitespace(self):
        assert validate_zip(" 78745 ") == "78745"


class TestValidateName:
    def test_valid_name(self):
        assert validate_name("Jonas") == "Jonas"

    def test_rejects_phone_number(self):
        assert validate_name("+15125551234") == ""

    def test_rejects_phone_digits_only(self):
        assert validate_name("5125551234") == ""

    def test_rejects_not_provided(self):
        assert validate_name("Not provided") == ""

    def test_rejects_na(self):
        assert validate_name("N/A") == ""

    def test_rejects_unknown(self):
        assert validate_name("unknown") == ""

    def test_rejects_empty(self):
        assert validate_name("") == ""

    def test_rejects_none(self):
        assert validate_name(None) == ""

    def test_rejects_placeholder_template(self):
        assert validate_name("{{customer_name}}") == ""


class TestIsServiceArea:
    def test_787_prefix_in_area(self):
        assert is_service_area("78745") is True

    def test_non_787_out_of_area(self):
        assert is_service_area("90210") is False

    def test_empty_zip_not_in_area(self):
        assert is_service_area("") is False


class TestClassifyIntent:
    def test_ac_is_service(self):
        assert classify_intent("my AC is broken") == "service"

    def test_billing_is_non_service(self):
        assert classify_intent("I have a billing question") == "non_service"

    def test_vendor_is_non_service(self):
        assert classify_intent("I'm a parts supplier") == "non_service"

    def test_hiring_is_non_service(self):
        assert classify_intent("are you hiring") == "non_service"

    def test_ambiguous_defaults_to_service(self):
        assert classify_intent("hello") == "service"


class TestDetectSafetyEmergency:
    def test_gas_smell(self):
        assert detect_safety_emergency("I smell gas") is True

    def test_burning(self):
        assert detect_safety_emergency("something is burning") is True

    def test_co_alarm(self):
        assert detect_safety_emergency("my CO detector is going off") is True

    def test_normal_issue(self):
        assert detect_safety_emergency("my AC isn't cooling") is False


class TestDetectHighTicket:
    def test_replacement(self):
        assert detect_high_ticket("I want a new AC system") is True

    def test_quote(self):
        assert detect_high_ticket("can I get a quote for a new unit") is True

    def test_repair(self):
        assert detect_high_ticket("my thermostat is broken") is False
```

**Step 2: Run tests to verify they fail**

Run: `cd pipecat-agent && python -m pytest tests/test_validation.py -v`
Expected: FAIL — module not found

**Step 3: Implement validation.py**

```python
# pipecat-agent/src/calllock/validation.py
import re

SENTINEL_VALUES = {
    "not provided", "n/a", "na", "unknown", "none", "tbd",
    "{{customer_name}}", "{{zip_code}}", "{{service_address}}",
}

SERVICE_KEYWORDS = {
    "ac", "heat", "furnace", "cooling", "heating", "broken", "noise",
    "leak", "thermostat", "unit", "system", "not working", "appointment",
    "booking", "schedule", "service", "someone to come out", "repair",
    "maintenance", "hvac", "air conditioning", "compressor", "duct",
}

NON_SERVICE_KEYWORDS = {
    "billing", "bill", "charge", "payment", "warranty", "invoice",
    "vendor", "supplier", "selling", "partnership", "parts supplier",
    "hiring", "job", "apply", "position", "employment",
    "wrong number",
}

SAFETY_KEYWORDS = {"gas", "burning", "smoke", "co detector", "carbon monoxide", "sparks", "fire"}

HIGH_TICKET_KEYWORDS = {
    "new system", "new unit", "new ac", "replacement", "replace",
    "quote", "estimate", "install", "installation", "upgrade",
}


def validate_zip(value: str | None) -> str:
    if not value:
        return ""
    cleaned = value.strip()
    if re.match(r"^\d{5}$", cleaned):
        return cleaned
    return ""


def validate_name(value: str | None) -> str:
    if not value:
        return ""
    cleaned = value.strip()
    if cleaned.lower() in SENTINEL_VALUES:
        return ""
    if re.match(r"^[\d+\-() ]{7,}$", cleaned):
        return ""
    return cleaned


def is_service_area(zip_code: str) -> bool:
    validated = validate_zip(zip_code)
    if not validated:
        return False
    return validated.startswith("787")


def classify_intent(text: str) -> str:
    lower = text.lower()
    for keyword in NON_SERVICE_KEYWORDS:
        if keyword in lower:
            return "non_service"
    return "service"


def detect_safety_emergency(text: str) -> bool:
    lower = text.lower()
    return any(keyword in lower for keyword in SAFETY_KEYWORDS)


def detect_high_ticket(text: str) -> bool:
    lower = text.lower()
    return any(keyword in lower for keyword in HIGH_TICKET_KEYWORDS)
```

**Step 4: Run tests**

Run: `cd pipecat-agent && python -m pytest tests/test_validation.py -v`
Expected: all PASS

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/validation.py pipecat-agent/tests/test_validation.py
git commit -m "feat: add deterministic validators (ZIP, name, intent, safety, high-ticket)"
```

---

## Task 4: State Machine Transitions (TDD)

This is the core. Every transition is deterministic and tested.

**Files:**
- Create: `pipecat-agent/src/calllock/state_machine.py`
- Test: `pipecat-agent/tests/test_state_machine.py`

**Step 1: Write failing tests**

```python
# pipecat-agent/tests/test_state_machine.py
import pytest
from calllock.session import CallSession
from calllock.states import State
from calllock.state_machine import StateMachine, Action


@pytest.fixture
def sm():
    return StateMachine()


@pytest.fixture
def session():
    return CallSession(phone_number="+15125551234")


# --- WELCOME state ---

class TestWelcomeState:
    def test_service_intent_routes_to_lookup(self, sm, session):
        action = sm.process(session, "my AC is broken")
        assert session.state == State.LOOKUP

    def test_billing_intent_routes_to_callback(self, sm, session):
        action = sm.process(session, "I have a billing question")
        assert session.state == State.CALLBACK

    def test_vendor_intent_routes_to_callback(self, sm, session):
        action = sm.process(session, "I'm a parts supplier")
        assert session.state == State.CALLBACK

    def test_ambiguous_defaults_to_lookup(self, sm, session):
        action = sm.process(session, "hello")
        assert session.state == State.LOOKUP


# --- LOOKUP state ---

class TestLookupState:
    def test_routes_to_safety_after_lookup(self, sm, session):
        session.state = State.LOOKUP
        action = sm.process(session, "")
        assert action.call_tool == "lookup_caller"

    def test_populates_session_from_lookup_result(self, sm, session):
        session.state = State.LOOKUP
        sm.handle_tool_result(session, "lookup_caller", {
            "found": True,
            "customerName": "Jonas",
            "zipCode": "78745",
        })
        assert session.caller_known is True
        assert session.customer_name == "Jonas"
        assert session.zip_code == "78745"
        assert session.state == State.SAFETY

    def test_unknown_caller_still_routes_to_safety(self, sm, session):
        session.state = State.LOOKUP
        sm.handle_tool_result(session, "lookup_caller", {"found": False})
        assert session.caller_known is False
        assert session.state == State.SAFETY


# --- SAFETY state ---

class TestSafetyState:
    def test_emergency_routes_to_safety_exit(self, sm, session):
        session.state = State.SAFETY
        action = sm.process(session, "yes I smell gas right now")
        assert session.state == State.SAFETY_EXIT

    def test_no_emergency_routes_to_service_area(self, sm, session):
        session.state = State.SAFETY
        action = sm.process(session, "no nothing like that")
        assert session.state == State.SERVICE_AREA

    def test_unclear_stays_in_safety(self, sm, session):
        session.state = State.SAFETY
        action = sm.process(session, "what do you mean")
        assert session.state == State.SAFETY


# --- SAFETY_EXIT state ---

class TestSafetyExitState:
    def test_ends_call(self, sm, session):
        session.state = State.SAFETY_EXIT
        action = sm.process(session, "")
        assert action.end_call is True


# --- SERVICE_AREA state ---

class TestServiceAreaState:
    def test_known_valid_zip_routes_to_discovery(self, sm, session):
        session.state = State.SERVICE_AREA
        session.zip_code = "78745"
        action = sm.process(session, "")
        assert session.state == State.DISCOVERY

    def test_caller_provides_valid_zip(self, sm, session):
        session.state = State.SERVICE_AREA
        action = sm.process(session, "my ZIP is 78701")
        assert session.zip_code == "78701"
        assert session.state == State.DISCOVERY

    def test_out_of_area_zip_routes_to_callback(self, sm, session):
        session.state = State.SERVICE_AREA
        action = sm.process(session, "my ZIP is 90210")
        assert session.state == State.CALLBACK

    def test_invalid_zip_stays_in_state(self, sm, session):
        session.state = State.SERVICE_AREA
        action = sm.process(session, "it's 787")
        assert session.state == State.SERVICE_AREA


# --- DISCOVERY state ---

class TestDiscoveryState:
    def test_all_fields_routes_to_confirm(self, sm, session):
        session.state = State.DISCOVERY
        session.customer_name = "Jonas"
        session.problem_description = "AC blowing warm air"
        session.service_address = "4210 South Lamar Blvd"
        action = sm.process(session, "")
        assert session.state == State.CONFIRM

    def test_missing_name_stays(self, sm, session):
        session.state = State.DISCOVERY
        session.problem_description = "AC broken"
        session.service_address = "123 Main St"
        action = sm.process(session, "")
        assert session.state == State.DISCOVERY

    def test_phone_number_as_name_rejected(self, sm, session):
        session.state = State.DISCOVERY
        session.customer_name = "5125551234"
        session.problem_description = "AC broken"
        session.service_address = "123 Main St"
        action = sm.process(session, "")
        assert session.customer_name == ""
        assert session.state == State.DISCOVERY


# --- CONFIRM state ---

class TestConfirmState:
    def test_yes_routes_to_booking(self, sm, session):
        session.state = State.CONFIRM
        session.caller_confirmed = True
        action = sm.process(session, "yes that sounds right, schedule me")
        assert session.state == State.BOOKING

    def test_callback_request_routes_to_callback(self, sm, session):
        session.state = State.CONFIRM
        action = sm.process(session, "just have someone call me back")
        assert session.state == State.CALLBACK

    def test_high_ticket_routes_to_callback(self, sm, session):
        session.state = State.CONFIRM
        session.lead_type = "high_ticket"
        session.caller_confirmed = True
        action = sm.process(session, "yes I want a new system")
        assert session.state == State.CALLBACK
        assert action.call_tool == "send_sales_lead_alert"


# --- BOOKING state ---

class TestBookingState:
    def test_enters_booking_calls_tool(self, sm, session):
        session.state = State.BOOKING
        action = sm.process(session, "")
        assert action.call_tool == "book_service"

    def test_booking_success_routes_to_done(self, sm, session):
        session.state = State.BOOKING
        sm.handle_tool_result(session, "book_service", {
            "booked": True,
            "booking_time": "2026-02-15T10:00:00",
        })
        assert session.booking_confirmed is True
        assert session.state == State.DONE

    def test_booking_failure_routes_to_callback(self, sm, session):
        session.state = State.BOOKING
        sm.handle_tool_result(session, "book_service", {"booked": False})
        assert session.booking_confirmed is False
        assert session.state == State.CALLBACK

    def test_booking_has_no_end_call(self, sm, session):
        """The critical structural guarantee: booking cannot end a call."""
        session.state = State.BOOKING
        action = sm.process(session, "")
        assert action.end_call is False


# --- DONE state ---

class TestDoneState:
    def test_ends_call(self, sm, session):
        session.state = State.DONE
        action = sm.process(session, "")
        assert action.end_call is True


# --- CALLBACK state ---

class TestCallbackState:
    def test_fires_callback_tool(self, sm, session):
        session.state = State.CALLBACK
        action = sm.process(session, "")
        assert action.call_tool == "create_callback"

    def test_ends_call_after_callback(self, sm, session):
        session.state = State.CALLBACK
        sm.handle_tool_result(session, "create_callback", {"success": True})
        action = sm.process(session, "")
        assert action.end_call is True


# --- Structural guarantees ---

class TestStructuralGuarantees:
    def test_no_backward_transitions(self, sm, session):
        """States can only move forward in the flow."""
        forward_order = [
            State.WELCOME, State.LOOKUP, State.SAFETY,
            State.SERVICE_AREA, State.DISCOVERY, State.CONFIRM,
            State.BOOKING, State.DONE,
        ]
        for i, state in enumerate(forward_order[:-1]):
            valid_nexts = sm.valid_transitions(state)
            for prev_state in forward_order[:i]:
                assert prev_state not in valid_nexts, \
                    f"{state.value} should not transition back to {prev_state.value}"

    def test_decision_states_have_no_tools(self, sm):
        for state in [State.WELCOME, State.SAFETY, State.DISCOVERY, State.CONFIRM]:
            assert sm.available_tools(state) == [], \
                f"Decision state {state.value} should have no tools"

    def test_booking_has_no_end_call(self, sm):
        assert "end_call" not in sm.available_tools(State.BOOKING)
```

**Step 2: Run tests to verify they fail**

Run: `cd pipecat-agent && python -m pytest tests/test_state_machine.py -v`
Expected: FAIL — module not found

**Step 3: Implement state_machine.py**

```python
# pipecat-agent/src/calllock/state_machine.py
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
            zip_match = re.search(r"\b(\d{5})\b", text)
            if zip_match:
                session.zip_code = validate_zip(zip_match.group(1))

        if session.zip_code:
            if is_service_area(session.zip_code):
                session.state = State.DISCOVERY
            else:
                session.state = State.CALLBACK
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
        # Callback created — next process() call will end the call
        pass

    def _tool_result_send_sales_lead_alert(self, session: CallSession, result: dict):
        # Alert sent — state already set to CALLBACK
        pass
```

**Step 4: Run tests**

Run: `cd pipecat-agent && python -m pytest tests/test_state_machine.py -v`
Expected: all PASS

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/state_machine.py pipecat-agent/tests/test_state_machine.py
git commit -m "feat: add deterministic state machine with full transition tests"
```

---

## Task 5: State Prompts

**Files:**
- Create: `pipecat-agent/src/calllock/prompts.py`
- Test: `pipecat-agent/tests/test_prompts.py`

**Step 1: Write failing test**

```python
# pipecat-agent/tests/test_prompts.py
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
```

**Step 2: Run tests to verify they fail**

Run: `cd pipecat-agent && python -m pytest tests/test_prompts.py -v`
Expected: FAIL

**Step 3: Implement prompts.py**

Port the persona and state prompts from `voice-agent/retell-llm-v10-simplified.json`. Each state gets a focused prompt that tells the LLM what to say — NOT what to decide. Key principle: no tool names, no state names, no transition instructions in prompts. The LLM just generates natural conversation.

```python
# pipecat-agent/src/calllock/prompts.py
from calllock.session import CallSession
from calllock.states import State

PERSONA = """You are the virtual receptionist for ACE Cooling, an HVAC service company in Austin, Texas.

VOICE: Friendly, brisk, confident. Not bubbly, not salesy.
CADENCE: ONE question at a time. Max 2 sentences before a question.
ACKNOWLEDGMENTS: Short (5 words or fewer). Often skip entirely.
TONE MATCHING: Mirror the caller's energy. Never more cheerful than the caller.
ACTIVE LISTENING: Paraphrase what the caller said professionally. Don't parrot exact words.

NEVER say 'transition', 'transitioning', 'let me move this forward', or describe your own process.
If asked if you're AI: 'I'm the virtual receptionist for ACE Cooling.'"""


def get_system_prompt(session: CallSession) -> str:
    state_prompt = STATE_PROMPTS.get(session.state, "")
    context = _build_context(session)
    return f"{PERSONA}\n\n{context}\n\n{state_prompt}"


def _build_context(session: CallSession) -> str:
    parts = []
    if session.customer_name:
        parts.append(f"Caller's name: {session.customer_name}")
    if session.problem_description:
        parts.append(f"Issue: {session.problem_description}")
    if session.service_address:
        parts.append(f"Address: {session.service_address}")
    if session.zip_code:
        parts.append(f"ZIP: {session.zip_code}")
    if session.has_appointment:
        parts.append("Caller has an existing appointment.")
    if session.preferred_time:
        parts.append(f"Preferred time: {session.preferred_time}")
    if not parts:
        return ""
    return "KNOWN INFO:\n" + "\n".join(f"- {p}" for p in parts)


STATE_PROMPTS = {
    State.WELCOME: """You just answered the phone. Say a brief, warm greeting:
"Thanks for calling ACE Cooling, how can I help you?"
Then listen. Do NOT ask diagnostic questions — just greet and listen.""",

    State.LOOKUP: """You're pulling up the caller's account. Say something brief like:
"Pulling that up now..." or "One sec, let me check on that."
Keep it to one short sentence.""",

    State.SAFETY: """Ask the safety screening question. Be direct but not alarming:
"Quick safety check — any gas smells, burning, smoke, or CO alarms going off right now?"
If they say yes to any safety concern, acknowledge it seriously.
If they say no, say something brief like "Good, just had to ask." """,

    State.SAFETY_EXIT: """This is a safety emergency. Be calm and direct:
"That sounds serious. Please hang up and call 911 right away. Don't use any electrical switches. Get everyone outside. We'll follow up once you're safe."
Keep it short and actionable.""",

    State.SERVICE_AREA: """You need the caller's ZIP code to confirm they're in the service area.
If you already know their ZIP, confirm: "Looks like you're in [ZIP] — that's in our area."
If not, ask: "What's the ZIP code where you need service?"
If out of area: "Unfortunately we only cover the Austin area right now. I can have someone call you back with a referral." """,

    State.DISCOVERY: """Collect the information needed to schedule service. You need three things:
1. Caller's name (if not already known)
2. What's wrong with their HVAC system
3. Service address

Ask for missing items one at a time. Paraphrase their problem professionally.
Do NOT ask about timing — that comes later.
Do NOT ask diagnostic follow-up questions — the tech handles that on-site.""",

    State.CONFIRM: """Read back what you've collected and get the caller's okay to proceed:
"So I have [name], [problem summary], at [address]. When works best for you?"

After they give timing preference, confirm: "Got it — [summary]. Want me to get that booked?"

If they want a callback instead, that's fine too.
If they mention wanting a new system, replacement, or quote, let them know a comfort advisor will call them back.""",

    State.BOOKING: """You're booking the appointment. Say something brief:
"Let me check what's available..." or "Checking the schedule now..."
Keep it to one short sentence while the booking processes.""",

    State.DONE: """The appointment is confirmed. Read back the details:
"You're all set for [time]. A tech will be out to [address] for [issue]. Anything else I can help with?"
Keep it brief and positive.""",

    State.CALLBACK: """You're setting up a callback. Be helpful and clear:
"I'll have someone from the team reach out to you. Is this the best number to call back?"
Or for specific types: "I'll have our [billing team / comfort advisor] give you a call."
Keep it brief, then wrap up: "Is there anything else? ... Great, have a good one." """,
}
```

**Step 4: Run tests**

Run: `cd pipecat-agent && python -m pytest tests/test_prompts.py -v`
Expected: all PASS

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/prompts.py pipecat-agent/tests/test_prompts.py
git commit -m "feat: add state-specific LLM prompts ported from v10 config"
```

---

## Task 6: V2 Backend HTTP Client (Tools)

**Files:**
- Create: `pipecat-agent/src/calllock/tools.py`
- Test: `pipecat-agent/tests/test_tools.py`

**Step 1: Write failing tests**

```python
# pipecat-agent/tests/test_tools.py
import pytest
import httpx
import respx
from calllock.tools import V2Client


@pytest.fixture
def client():
    return V2Client(base_url="https://test-server.example.com")


@respx.mock
@pytest.mark.asyncio
async def test_lookup_caller_returns_result(client):
    respx.post("https://test-server.example.com/webhook/retell/lookup_caller").mock(
        return_value=httpx.Response(200, json={
            "found": True,
            "customerName": "Jonas",
            "zipCode": "78745",
        })
    )
    result = await client.lookup_caller("+15125551234", "call_123")
    assert result["found"] is True
    assert result["customerName"] == "Jonas"


@respx.mock
@pytest.mark.asyncio
async def test_lookup_caller_handles_failure(client):
    respx.post("https://test-server.example.com/webhook/retell/lookup_caller").mock(
        return_value=httpx.Response(500)
    )
    result = await client.lookup_caller("+15125551234", "call_123")
    assert result["found"] is False


@respx.mock
@pytest.mark.asyncio
async def test_book_service_success(client):
    respx.post("https://test-server.example.com/api/retell/book-service").mock(
        return_value=httpx.Response(200, json={
            "booked": True,
            "booking_time": "2026-02-15T10:00:00",
        })
    )
    result = await client.book_service(
        customer_name="Jonas",
        problem="AC blowing warm",
        address="4210 South Lamar",
        preferred_time="morning",
        phone="+15125551234",
    )
    assert result["booked"] is True


@respx.mock
@pytest.mark.asyncio
async def test_create_callback_success(client):
    respx.post("https://test-server.example.com/webhook/retell/create_callback").mock(
        return_value=httpx.Response(200, json={"success": True})
    )
    result = await client.create_callback(
        phone="+15125551234",
        callback_type="service",
        reason="Caller wants to schedule",
    )
    assert result["success"] is True
```

**Step 2: Run tests to verify they fail**

Run: `cd pipecat-agent && python -m pytest tests/test_tools.py -v`
Expected: FAIL

**Step 3: Implement tools.py**

```python
# pipecat-agent/src/calllock/tools.py
import httpx
import logging

logger = logging.getLogger(__name__)


class V2Client:
    """HTTP client for the V2 backend tool endpoints."""

    def __init__(self, base_url: str, timeout: float = 10.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    async def lookup_caller(self, phone: str, call_id: str) -> dict:
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(
                    f"{self.base_url}/webhook/retell/lookup_caller",
                    json={
                        "call": {
                            "call_id": call_id,
                            "from_number": phone,
                            "metadata": {},
                        },
                        "args": {},
                    },
                )
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            logger.error(f"lookup_caller failed: {e}")
            return {"found": False, "message": "Lookup failed — proceeding without history."}

    async def book_service(
        self,
        customer_name: str,
        problem: str,
        address: str,
        preferred_time: str,
        phone: str,
    ) -> dict:
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(
                    f"{self.base_url}/api/retell/book-service",
                    json={
                        "customer_name": customer_name,
                        "customer_phone": phone,
                        "issue_description": problem,
                        "service_address": address,
                        "preferred_time": preferred_time,
                    },
                )
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            logger.error(f"book_service failed: {e}")
            return {"booked": False, "error": str(e)}

    async def create_callback(
        self,
        phone: str,
        callback_type: str = "service",
        reason: str = "",
    ) -> dict:
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(
                    f"{self.base_url}/webhook/retell/create_callback",
                    json={
                        "call": {"from_number": phone, "metadata": {}},
                        "args": {
                            "callback_type": callback_type,
                            "execution_message": reason,
                        },
                    },
                )
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            logger.error(f"create_callback failed: {e}")
            return {"success": False, "error": str(e)}

    async def send_sales_lead_alert(self, phone: str, reason: str = "") -> dict:
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(
                    f"{self.base_url}/webhook/retell/send_sales_lead_alert",
                    json={
                        "call": {"from_number": phone, "metadata": {}},
                        "args": {"execution_message": reason},
                    },
                )
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            logger.error(f"send_sales_lead_alert failed: {e}")
            return {"success": False, "error": str(e)}
```

**Step 4: Run tests**

Run: `cd pipecat-agent && python -m pytest tests/test_tools.py -v`
Expected: all PASS

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/tools.py pipecat-agent/tests/test_tools.py
git commit -m "feat: add V2 backend HTTP client for tool invocations"
```

---

## Task 7: Pipecat Pipeline + Twilio Bot (Week 1 Kill Test)

**Files:**
- Create: `pipecat-agent/src/calllock/bot.py`
- Create: `pipecat-agent/src/calllock/pipeline.py`

**Step 1: Create bot.py (FastAPI + Twilio WebSocket)**

```python
# pipecat-agent/src/calllock/bot.py
import os
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket
from fastapi.responses import PlainTextResponse

from calllock.pipeline import create_pipeline

load_dotenv()

app = FastAPI(title="CallLock Voice Agent")


@app.get("/health")
async def health():
    return PlainTextResponse("ok")


@app.websocket("/ws/twilio")
async def twilio_websocket(websocket: WebSocket):
    await websocket.accept()
    await create_pipeline(websocket)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8765"))
    uvicorn.run("calllock.bot:app", host="0.0.0.0", port=port, reload=True)
```

**Step 2: Create pipeline.py**

```python
# pipecat-agent/src/calllock/pipeline.py
import os
import logging
from fastapi import WebSocket

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineTask
from pipecat.transports.network.fastapi_websocket import (
    FastAPIWebsocketTransport,
    FastAPIWebsocketParams,
)
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.runner.utils import parse_telephony_websocket

from calllock.session import CallSession
from calllock.state_machine import StateMachine
from calllock.prompts import get_system_prompt
from calllock.tools import V2Client

logger = logging.getLogger(__name__)


async def create_pipeline(websocket: WebSocket):
    """Create and run the Pipecat pipeline for a Twilio call."""

    # Parse Twilio WebSocket handshake
    transport_type, call_data = await parse_telephony_websocket(websocket)
    stream_sid = call_data["stream_id"]
    call_sid = call_data["call_id"]
    caller_phone = call_data.get("body", {}).get("From", "")

    logger.info(f"Call started: {call_sid} from {caller_phone}")

    # Initialize session and state machine
    session = CallSession(phone_number=caller_phone)
    machine = StateMachine()
    tools = V2Client(base_url=os.getenv("V2_BACKEND_URL", ""))

    # Twilio transport
    serializer = TwilioFrameSerializer(
        stream_sid=stream_sid,
        call_sid=call_sid,
        account_sid=os.getenv("TWILIO_ACCOUNT_SID"),
        auth_token=os.getenv("TWILIO_AUTH_TOKEN"),
    )
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            vad_analyzer=SileroVADAnalyzer(),
            serializer=serializer,
        ),
    )

    # Services
    stt = DeepgramSTTService(api_key=os.getenv("DEEPGRAM_API_KEY"))

    llm = OpenAILLMService(
        api_key=os.getenv("OPENAI_API_KEY"),
        model="gpt-4o",
    )

    tts = ElevenLabsTTSService(
        api_key=os.getenv("ELEVENLABS_API_KEY"),
        voice_id=os.getenv("ELEVENLABS_VOICE_ID"),
    )

    # LLM context with initial system prompt
    from pipecat.services.openai.llm import OpenAILLMContext
    messages = [{"role": "system", "content": get_system_prompt(session)}]
    context = OpenAILLMContext(messages)
    context_aggregator = llm.create_context_aggregator(context)

    # Build pipeline
    pipeline = Pipeline([
        transport.input(),
        stt,
        context_aggregator.user(),
        llm,
        tts,
        transport.output(),
        context_aggregator.assistant(),
    ])

    task = PipelineTask(pipeline)

    # Send initial greeting on connect
    from pipecat.frames.frames import LLMMessagesFrame
    @transport.event_handler("on_client_connected")
    async def on_connected(transport, client):
        await task.queue_frames([LLMMessagesFrame(messages)])

    runner = PipelineRunner()
    await runner.run(task)

    logger.info(f"Call ended: {call_sid}")
```

**Step 3: Test locally**

Run: `cd pipecat-agent && python -m calllock.bot`
Expected: FastAPI server starts on port 8765, `/health` returns "ok"

Run: `curl http://localhost:8765/health`
Expected: "ok"

**Step 4: Commit**

```bash
git add pipecat-agent/src/calllock/bot.py pipecat-agent/src/calllock/pipeline.py
git commit -m "feat: add Pipecat pipeline with Twilio + Deepgram + ElevenLabs + GPT-4o"
```

---

## Task 8: Deploy Skeleton + Latency Kill Test

**Files:**
- Create: `pipecat-agent/Dockerfile`
- Create: `pipecat-agent/fly.toml`

**Step 1: Create Dockerfile**

```dockerfile
# pipecat-agent/Dockerfile
FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml .
RUN pip install --no-cache-dir .

COPY src/ src/
ENV PYTHONPATH=/app/src

CMD ["uvicorn", "calllock.bot:app", "--host", "0.0.0.0", "--port", "8765"]
```

**Step 2: Create fly.toml**

```toml
# pipecat-agent/fly.toml
app = "calllock-voice"
primary_region = "dfw"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8765"

[http_service]
  internal_port = 8765
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[[services]]
  internal_port = 8765
  protocol = "tcp"
  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
```

**Step 3: Deploy to Fly.io**

```bash
cd pipecat-agent
fly launch --no-deploy
fly secrets set OPENAI_API_KEY=... DEEPGRAM_API_KEY=... ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=... TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... V2_BACKEND_URL=https://calllock-server.onrender.com
fly deploy
```

**Step 4: Configure Twilio to point to Fly.io**

In Twilio console, set the phone number's Voice webhook to:
`wss://calllock-voice.fly.dev/ws/twilio`

Or use TwiML Bin with:
```xml
<Response>
  <Connect>
    <Stream url="wss://calllock-voice.fly.dev/ws/twilio">
      <Parameter name="caller_id" value="{{From}}" />
    </Stream>
  </Connect>
</Response>
```

**Step 5: KILL TEST — call the number**

Call the production phone number from your cell phone. Success criteria:
- [ ] Hear the greeting clearly (voice quality OK)
- [ ] Response latency <500ms (no dead air)
- [ ] No echo (agent doesn't respond to its own voice)
- [ ] Call ends cleanly

**If ANY of these fail: STOP.** The architecture doesn't work for phone calls. Maximum sunk cost: 1 week.

**Step 6: Commit**

```bash
git add pipecat-agent/Dockerfile pipecat-agent/fly.toml
git commit -m "feat: add Docker + Fly.io deployment for skeleton pipeline"
```

---

## Task 9: Wire State Machine into Pipeline

This is the critical integration — replacing Pipecat's default "LLM drives everything" with "state machine drives everything, LLM generates words."

**Files:**
- Modify: `pipecat-agent/src/calllock/pipeline.py`
- Create: `pipecat-agent/src/calllock/extraction.py`
- Test: `pipecat-agent/tests/test_extraction.py`

This task requires deeper exploration of Pipecat's processor API to build a custom processor that intercepts transcription frames, runs the state machine, and injects the appropriate system prompt before each LLM call. The exact implementation depends on Pipecat's frame types and processor base class, which should be explored from the Pipecat docs and examples.

**Key integration points:**
1. Custom processor receives `TranscriptionFrame` from STT
2. Feeds text to `StateMachine.process()`
3. If action says `call_tool`: call V2 backend via `tools.py`, feed result to `StateMachine.handle_tool_result()`
4. Update LLM system prompt via `context.messages[0]` to match current state
5. If action says `end_call`: trigger Twilio hangup
6. If action says `needs_llm`: let the pipeline continue to LLM → TTS
7. After LLM generates response, run extraction to update session fields

**Extraction service (separate LLM call for structured data):**

```python
# pipecat-agent/src/calllock/extraction.py
import json
import httpx
import os
import logging

logger = logging.getLogger(__name__)

EXTRACTION_PROMPT = """Extract structured data from this conversation. Return ONLY valid JSON.
Fields to extract: customer_name, problem_description, service_address, zip_code, preferred_time.
If a field is not mentioned, use empty string "".
Do not guess or fabricate values. Only extract what the caller explicitly said."""


async def extract_fields(conversation: list[dict]) -> dict:
    """Call GPT-4o-mini to extract structured fields from conversation."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {os.getenv('OPENAI_API_KEY')}"},
                json={
                    "model": "gpt-4o-mini",
                    "temperature": 0.1,
                    "response_format": {"type": "json_object"},
                    "messages": [
                        {"role": "system", "content": EXTRACTION_PROMPT},
                        *conversation[-10:],  # Last 10 turns for context
                    ],
                },
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
            return json.loads(content)
    except Exception as e:
        logger.error(f"extraction failed: {e}")
        return {}
```

```python
# pipecat-agent/tests/test_extraction.py
import pytest
import httpx
import respx
import json
from calllock.extraction import extract_fields


@respx.mock
@pytest.mark.asyncio
async def test_extraction_returns_structured_data(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    respx.post("https://api.openai.com/v1/chat/completions").mock(
        return_value=httpx.Response(200, json={
            "choices": [{"message": {"content": json.dumps({
                "customer_name": "Jonas",
                "problem_description": "AC blowing warm air",
                "service_address": "4210 South Lamar Blvd",
                "zip_code": "78745",
                "preferred_time": "morning",
            })}}],
        })
    )
    result = await extract_fields([
        {"role": "user", "content": "This is Jonas, my AC is blowing warm at 4210 South Lamar 78745"},
    ])
    assert result["customer_name"] == "Jonas"
    assert result["zip_code"] == "78745"


@respx.mock
@pytest.mark.asyncio
async def test_extraction_handles_api_failure(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    respx.post("https://api.openai.com/v1/chat/completions").mock(
        return_value=httpx.Response(500)
    )
    result = await extract_fields([{"role": "user", "content": "test"}])
    assert result == {}
```

**Step: Run extraction tests**

Run: `cd pipecat-agent && python -m pytest tests/test_extraction.py -v`
Expected: all PASS

**Commit:**

```bash
git add pipecat-agent/src/calllock/extraction.py pipecat-agent/tests/test_extraction.py
git commit -m "feat: add LLM extraction service with structured JSON output"
```

---

## Task 10: End-to-End Test Call

After Task 9 is wired up, run 3 scripted scenarios:

**Scenario 1: Happy path (new caller → booking)**
1. Call the number
2. Say "My AC is broken"
3. Answer safety question "No"
4. Provide ZIP "78745"
5. Provide name, problem, address
6. Confirm booking
7. Verify: appointment appears in Cal.com

**Scenario 2: Booking failure → callback**
1. Call the number
2. Go through flow but request a time with no availability
3. Verify: callback created, SMS sent to owner

**Scenario 3: Non-service caller**
1. Call the number
2. Say "I have a billing question"
3. Verify: agent routes to callback, call ends quickly

**Success criteria:** 5 consecutive happy-path calls succeed without intervention.

---

## Task 11: Polish + Demo Ready (Week 4)

- Tune VAD sensitivity per state (lower for welcome to prevent echo)
- Tune prompts for natural conversation flow
- Verify dashboard receives correct data from all 3 scenarios
- Record a clean demo call
- Update `voice-agent/AGENT-STATUS.md` with Pipecat deployment info

**Commit:**

```bash
git add -A
git commit -m "feat: CallLock voice agent fully migrated to Pipecat pipeline"
```

---

## Summary

| Task | What | Approx Time |
|---|---|---|
| 1 | Project scaffold | 15 min |
| 2 | CallSession + State enum (TDD) | 30 min |
| 3 | Deterministic validators (TDD) | 45 min |
| 4 | State machine transitions (TDD) | 1-2 hours |
| 5 | State prompts | 45 min |
| 6 | V2 backend HTTP client (TDD) | 45 min |
| 7 | Pipecat pipeline + Twilio bot | 1-2 hours |
| 8 | Deploy + latency kill test | 1-2 hours |
| 9 | Wire state machine into pipeline | 2-4 hours (hardest task) |
| 10 | End-to-end test calls | 2-3 hours |
| 11 | Polish + demo ready | 1-2 days |
