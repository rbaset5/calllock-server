# Pipecat Brain Transfer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transfer Retell v9-triage behavioral knowledge to Pipecat agent (2.5/10 to 6-7/10)

**Architecture:** Keep deterministic state machine. Port 15 Retell state prompts adapted for Pipecat. Add 5 missing states. Fix tool integration. Strengthen validation.

**Tech Stack:** Python 3.12+, Pipecat framework, OpenAI GPT-4o, Deepgram STT, Inworld/Deepgram TTS, httpx, FastAPI

**Pipecat source:** `/Users/rashidbaset/conductor/workspaces/retellai-calllock/pattaya/pipecat-agent/`
**Retell config:** `/Users/rashidbaset/conductor/workspaces/retellai-calllock/caracas/voice-agent/retell-llm-v9-triage.json`

---

## Task 1: Expand State Enum (10 to 15 states)

**Files:**
- Modify: `src/calllock/states.py`

**Step 1: Update states.py with 15 states**

Replace the entire file:

```python
from enum import Enum

DECISION_STATES = {
    "welcome", "safety", "service_area", "discovery",
    "urgency", "pre_confirm",
}
ACTION_STATES = {"lookup", "booking"}
TERMINAL_STATES = {
    "safety_exit", "confirm", "callback",
    "booking_failed", "urgency_callback",
}


class State(Enum):
    WELCOME = "welcome"
    NON_SERVICE = "non_service"
    LOOKUP = "lookup"
    FOLLOW_UP = "follow_up"
    MANAGE_BOOKING = "manage_booking"
    SAFETY = "safety"
    SAFETY_EXIT = "safety_exit"
    SERVICE_AREA = "service_area"
    DISCOVERY = "discovery"
    URGENCY = "urgency"
    URGENCY_CALLBACK = "urgency_callback"
    PRE_CONFIRM = "pre_confirm"
    BOOKING = "booking"
    BOOKING_FAILED = "booking_failed"
    CONFIRM = "confirm"
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

**Step 2: Run existing tests to verify nothing breaks**

Run: `cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/pattaya/pipecat-agent && python -m pytest tests/ -v 2>&1 | head -50`

If no tests exist yet, skip and proceed.

**Step 3: Commit**

```bash
git add src/calllock/states.py
git commit -m "feat: expand state enum from 10 to 15 states"
```

---

## Task 2: Expand CallSession with new fields

**Files:**
- Modify: `src/calllock/session.py`

**Step 1: Add fields for new states and tool results**

Replace the entire file:

```python
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
    appointment_date: str = ""
    appointment_time: str = ""
    appointment_uid: str = ""
    callback_promise: str = ""
    caller_intent: str = ""  # hvac_issue, schedule_service, follow_up, manage_appointment, unclear

    # From discovery
    problem_description: str = ""
    equipment_type: str = ""
    problem_duration: str = ""
    is_third_party: bool = False
    site_contact_name: str = ""
    site_contact_phone: str = ""

    # From urgency
    preferred_time: str = ""
    urgency_tier: str = "routine"  # urgent or routine
    lead_type: str = ""  # high_ticket or empty

    # From pre_confirm
    caller_confirmed: bool = False

    # From booking
    booking_confirmed: bool = False
    booking_attempted: bool = False
    booked_time: str = ""
    appointment_id: str = ""

    # From callback
    callback_created: bool = False
    callback_attempts: int = 0
    callback_type: str = "service"  # billing, warranty, estimate, service, follow_up, general

    # Call metadata
    call_sid: str = ""
    start_time: float = 0.0
    transcript_log: list = field(default_factory=list)
    turn_count: int = 0
    state_turn_count: int = 0
    conversation_history: list = field(default_factory=list)
```

**Step 2: Commit**

```bash
git add src/calllock/session.py
git commit -m "feat: expand CallSession with urgency, booking, third-party fields"
```

---

## Task 3: Strengthen validation.py

**Files:**
- Modify: `src/calllock/validation.py`

**Step 1: Add negative high-ticket keywords, safety retraction, intent subtypes**

Replace the entire file:

```python
import re

SENTINEL_VALUES = {
    "not provided", "n/a", "na", "unknown", "none", "tbd",
    "{{customer_name}}", "{{zip_code}}", "{{service_address}}",
    "auto", "customer_name", "service_address",
}

SERVICE_KEYWORDS = {
    "ac", "heat", "furnace", "cooling", "heating", "broken", "noise",
    "leak", "thermostat", "unit", "system", "not working", "appointment",
    "booking", "schedule", "service", "someone to come out", "repair",
    "maintenance", "hvac", "air conditioning", "compressor", "duct",
    "not cooling", "not heating", "won't turn on", "stopped working",
}

NON_SERVICE_KEYWORDS = {
    "billing", "bill", "charge", "payment", "warranty", "invoice",
    "vendor", "supplier", "selling", "partnership", "parts supplier",
    "hiring", "job", "apply", "position", "employment",
    "wrong number",
}

FOLLOW_UP_KEYWORDS = {
    "following up", "called before", "waiting for callback",
    "checking on", "any update", "called earlier", "still waiting",
}

MANAGE_BOOKING_KEYWORDS = {
    "my appointment", "reschedule", "cancel my", "cancel the",
    "change my appointment", "move my appointment",
}

SAFETY_KEYWORDS = {"gas", "burning", "smoke", "co detector", "carbon monoxide", "sparks", "fire"}

SAFETY_RETRACTION_KEYWORDS = {
    "never mind", "but don't worry", "actually no", "not the issue",
    "forget i said", "i'm fine", "we're okay", "no emergency",
    "that's not it", "not really",
}

HIGH_TICKET_POSITIVE = {
    "new system", "new unit", "new ac", "new furnace",
    "replacement", "replace", "quote", "estimate",
    "how much for a new", "cost of a new",
    "upgrade", "whole new", "brand new", "installing a new",
}

HIGH_TICKET_NEGATIVE = {
    "broken", "not working", "stopped working", "won't turn on",
    "cover", "part", "piece", "component",
    "noise", "leak", "smell", "drip",
    "tune-up", "check", "maintenance", "filter",
}

CALLBACK_REQUEST_KEYWORDS = {
    "call me back", "callback", "just call", "have someone call",
    "have the owner call", "don't want to schedule",
}

PROPERTY_MANAGER_KEYWORDS = {
    "property manager", "landlord", "i manage", "managing properties",
    "rental property", "tenant", "property management",
    "calling on behalf", "the unit is at",
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
    # Reject phone numbers used as names
    if re.match(r"^[\d+\-() ]{7,}$", cleaned):
        return ""
    # Reject template variables
    if "{{" in cleaned or "}}" in cleaned:
        return ""
    return cleaned


def validate_address(value: str | None) -> str:
    if not value:
        return ""
    cleaned = value.strip()
    if cleaned.lower() in SENTINEL_VALUES:
        return ""
    # Reject garbled addresses containing "or" (ambiguous alternatives)
    if re.search(r"\bor\b", cleaned, re.IGNORECASE):
        return ""
    return cleaned


def is_service_area(zip_code: str) -> bool:
    validated = validate_zip(zip_code)
    if not validated:
        return False
    return validated.startswith("787")


def classify_intent(text: str) -> str:
    """Classify caller intent from first utterance.

    Returns: service, non_service, follow_up, manage_booking
    """
    lower = text.lower()
    for keyword in MANAGE_BOOKING_KEYWORDS:
        if keyword in lower:
            return "manage_booking"
    for keyword in FOLLOW_UP_KEYWORDS:
        if keyword in lower:
            return "follow_up"
    for keyword in NON_SERVICE_KEYWORDS:
        if keyword in lower:
            return "non_service"
    return "service"


def detect_safety_emergency(text: str) -> bool:
    lower = text.lower()
    has_safety = any(keyword in lower for keyword in SAFETY_KEYWORDS)
    if not has_safety:
        return False
    # Check for retraction in the same utterance
    has_retraction = any(keyword in lower for keyword in SAFETY_RETRACTION_KEYWORDS)
    return not has_retraction


def detect_high_ticket(text: str) -> bool:
    lower = text.lower()
    has_positive = any(keyword in lower for keyword in HIGH_TICKET_POSITIVE)
    if not has_positive:
        return False
    # If negative keywords also present, it's a repair, not high-ticket
    has_negative = any(keyword in lower for keyword in HIGH_TICKET_NEGATIVE)
    return not has_negative


def detect_callback_request(text: str) -> bool:
    lower = text.lower()
    return any(keyword in lower for keyword in CALLBACK_REQUEST_KEYWORDS)


def detect_property_manager(text: str) -> bool:
    lower = text.lower()
    return any(keyword in lower for keyword in PROPERTY_MANAGER_KEYWORDS)
```

**Step 2: Commit**

```bash
git add src/calllock/validation.py
git commit -m "feat: strengthen validation with retraction detection, negative keywords, address filter"
```

---

## Task 4: Port all 15 state prompts + general prompt

**Files:**
- Modify: `src/calllock/prompts.py`

**Step 1: Replace prompts.py with full Retell-derived prompts**

This is the largest change. Replace the entire file with prompts ported from `retell-llm-v9-triage.json`, adapted for the deterministic state machine (strip transition/edge/tool instructions, keep behavioral rules):

```python
from calllock.session import CallSession
from calllock.states import State

PERSONA = """You are the virtual receptionist for ACE Cooling, an HVAC service company in Austin, Texas.

VOICE & PERSONA (Calm HVAC Dispatcher)
- Tone: friendly, brisk, confident (not bubbly, not salesy).
- Cadence: ONE question at a time. Max 1 sentence for acknowledgments, max 2 sentences total.
- Acknowledgments: 5 words or fewer: "Got it." / "Noted." / "Okay."
  Often skip the acknowledgment entirely and move straight to your next question.
- NEVER repeat yourself.
- Tone matching: Mirror the caller's energy.
  Frustrated caller: professional, empathetic, direct.
  Calm caller: match their pace, keep it efficient.
- Active listening: Paraphrase into professional description, don't parrot.
  "It's blowing warm air" -> "Sounds like the cooling isn't kicking in."
  "Making a grinding noise" -> "Could be a motor or fan issue."
  "Water's leaking everywhere" -> "Let's get a tech out to stop that leak."

WORDS TO AVOID
- NEVER say "transition", "transitioning", "let me move this forward", "let me handle this", "let me process this".
- NEVER use filler about YOUR process. Say what matters to the CALLER.

BOOKING FIREWALL
- NEVER say "booked", "scheduled", "confirmed", "all set", "locked in", or "finalized" unless you are told the booking succeeded.
- NEVER fabricate a confirmation.

TRUST STANCE
- If asked if you're AI: "I'm the virtual receptionist for ACE Cooling."

BUSINESS INFO
- Service area: Austin, TX (ZIP codes starting with 787 ONLY)
- Diagnostic: $89, credited if customer proceeds with repair.
- Available for scheduling 7 days a week.

RULES
1. NEVER re-ask something already known.
2. NEVER confirm a booking without being told it succeeded.
3. Accept flexible time: "ASAP", "soonest", "whenever" are valid.
4. If you can't understand, ask to repeat. Do NOT end the call.
5. Known callers: greet by name as a STATEMENT, not a question."""


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
        appt = f"Caller has an existing appointment"
        if session.appointment_date:
            appt += f" on {session.appointment_date}"
        if session.appointment_time:
            appt += f" at {session.appointment_time}"
        parts.append(appt)
    if session.preferred_time:
        parts.append(f"Preferred time: {session.preferred_time}")
    if session.urgency_tier and session.urgency_tier != "routine":
        parts.append(f"Urgency: {session.urgency_tier}")
    if session.caller_known:
        parts.append("Returning caller (known customer)")
    if session.callback_promise:
        parts.append(f"We owe this caller a callback: {session.callback_promise}")
    if session.lead_type == "high_ticket":
        parts.append("HIGH-TICKET LEAD: Caller wants replacement/new system")
    if session.is_third_party:
        parts.append(f"Third-party caller (property manager). Site contact: {session.site_contact_name} at {session.site_contact_phone}")
    if not parts:
        return ""
    return "KNOWN INFO:\n" + "\n".join(f"- {p}" for p in parts)


STATE_PROMPTS = {
    State.WELCOME: """## WELCOME
Detect the caller's intent from their first response, then respond briefly.

INTENTS:
- HVAC issue, scheduling, broken system -> service intent
- Billing, vendor, job applicant, pricing -> non-service intent

RESPONSES:
- Service intent: "Let me pull up your account." (one sentence)
- Non-service: respond to their specific need (see NON_SERVICE rules)
- Wrong number: "No problem, have a good one."
- Silent (3-4 seconds): "Hey, you still there?"

Do NOT ask diagnostic questions. Do NOT stay in welcome after detecting intent.""",

    State.NON_SERVICE: """## NON_SERVICE
Handle callers NOT calling about HVAC service. Keep it SHORT.

BILLING/WARRANTY:
"I'll have someone from our office call you about that."

VENDOR/SUPPLIER:
"We don't take vendor calls on this line. Thanks though."

JOB APPLICANT:
"Thanks for your interest! Best way is to email us."

PRICING INQUIRY:
"Our diagnostic is $89 — and if you go ahead with the repair we knock that off."
Then: "Want to go ahead and schedule a visit?"

Do NOT ask the safety question for non-service callers.
Do NOT ask for ZIP or address.""",

    State.LOOKUP: """## LOOKUP
Say briefly: "Pulling that up now."
One short sentence only. Do NOT ask questions or collect info.""",

    State.FOLLOW_UP: """## FOLLOW_UP
Handle callers following up on previous calls or waiting on a callback.

If callback promise exists:
"I see your call about [issue]. Looks like we still owe you a callback — sorry about the wait."

If repeat caller (3+ times today):
"I see you've been trying to reach us — I'm really sorry about that. What are you calling about?"

If they want a callback: acknowledge and confirm.
If they mention a NEW issue: "Got it, let's get that taken care of."
Be empathetic about unfulfilled callbacks. Don't make excuses.""",

    State.MANAGE_BOOKING: """## MANAGE_BOOKING
Handle reschedule, cancel, or status check on existing appointment.

Confirm: "I see your appointment — [date] at [time]. What do you need?"
If they didn't specify: "Are you looking to reschedule, cancel, or just checking on it?"

RESCHEDULE: "Sure — when works better?" Wait for time.
CANCEL: Confirm if today/tomorrow, then proceed.
STATUS: Read appointment details, "Anything else?"
NEW ISSUE: "Want me to schedule someone for that too?"

Keep it brief — they know what they want.""",

    State.SAFETY: """## SAFETY
Ask ONE safety question before proceeding.

If they described their issue: "Quick safety check — any gas smell, burning smell, or smoke right now?"
If they haven't: "I'll get you taken care of. Quick safety check first — any gas smell, burning smell, or smoke right now?"

CLEAR YES (confirmed danger, no retraction): acknowledge seriously.
RETRACTED YES ("yes but never mind", "actually no"): treat as NO. "Okay, just double-checking — no active gas smell or alarms right now?"
CLEAR NO: "Okay, just had to check."
AMBIGUOUS: ONE follow-up: "Just to be safe — right this second, are you smelling gas or burning?"

"Gas heater" + "water leak" = NOT emergency.
"Gas heater" + "smells like gas" = YES emergency.
Only their answer about RIGHT NOW determines safety.""",

    State.SAFETY_EXIT: """## SAFETY EMERGENCY
Say EXACTLY: "Okay — this is a safety emergency. I need you to leave the house right now and call 911 from outside. Don't flip any light switches on the way out. Stay safe."
Do NOT ask follow-up questions.""",

    State.SERVICE_AREA: """## SERVICE_AREA
Verify caller is in service area. ZIP must start with 787 and be exactly 5 digits.

If ZIP already known and valid: proceed without asking.
If not: "What's your ZIP code?"

Valid 787 ZIP: "Got it."
Invalid ZIP: "We're only servicing Austin 787 ZIP codes right now."

That is your ONLY job. Do NOT ask about problem, timing, or address.
MAX 2 exchanges in this state.""",

    State.DISCOVERY: """## DISCOVERY
Collect three things: name, problem, address. Ask ONE missing item at a time.

1. NAME (if missing): "What name should I put on the work order?"
2. PROBLEM (if missing): "What's going on with the system?"
3. ADDRESS (if missing): "What's the street address for the service call?"

Paraphrase their problem professionally. No diagnostic questions — the tech handles that on-site.

If caller mentions equipment type or how long the problem has been going on, note it, but do NOT ask separately.

BLOCKING: Do NOT proceed without a real street address.
Do NOT ask about timing — that's handled next.
Do NOT read back a summary — that's handled next.""",

    State.URGENCY: """## URGENCY
Determine scheduling priority.

If timing is ALREADY CLEAR from what they said:
"ASAP" / "today" / "right away" -> urgent
"whenever" / "this week" / "no rush" / specific day -> routine

If timing is UNCLEAR:
"How urgent is this — more of a 'need someone today' situation, or 'sometime in the next few days' works?"

Do NOT say the time "works" or is "available" — you haven't checked the calendar yet.""",

    State.URGENCY_CALLBACK: """## URGENCY CALLBACK
Handle callback requests and high-ticket sales lead routing.

HIGH-TICKET (replacement/new system):
"For a system replacement, our comfort advisor would want to come out and give you a proper quote — not just an $89 diagnostic. Let me have them reach out to you today."

STANDARD CALLBACK (caller requested):
"Sure — let me set that up."

If caller pushes back on high-ticket: "I totally get it — but for a replacement quote, you really want our comfort advisor there. They'll reach out today." """,

    State.PRE_CONFIRM: """## PRE_CONFIRM
Read back collected info and get explicit approval before booking.

VERIFY FIRST: If name, problem, or address is missing or looks wrong, ask before reading back.

READ BACK: "Alright, let me make sure I have everything right. [Name], you've got a [problem] at [address], and you're looking for [timing]. Sound right?"

YES: "Perfect — let me check what we've got open."
CORRECTION: "Got it — so that's [corrected detail]. Everything else look good?"
DECLINED: "No problem. Want me to have someone call you back instead?"

NEVER proceed to booking without explicit approval.""",

    State.BOOKING: """## BOOKING
Say: "Let me check what we've got open..."
One sentence only. Do NOT include specific times — the actual slot may differ.

NEVER say "you're booked" or "confirmed" — wait for the result.""",

    State.BOOKING_FAILED: """## BOOKING FAILED
Booking didn't work. Offer callback.

"I'm sorry — I wasn't able to lock in that time. Let me have someone from the team call you back to get you scheduled. Sound good?"

YES: confirm callback.
NO: "No problem — you can call us back anytime." """,

    State.CONFIRM: """## CONFIRM
Wrap up after successful booking.

Read the booking details, then add: "The tech will call about 30 minutes before heading over."

Price question: "It's an $89 diagnostic, and if you go ahead with the repair we knock that off."
"What should I do until then?" — give practical advice (close blinds, grab a fan, put a bucket).

Close: "Anything else? ... Alright, thanks for calling ACE Cooling — stay cool out there." """,

    State.CALLBACK: """## CALLBACK
Fallback state. Create callback and wrap up.

"I'll have someone from the team call you back. Is this the best number?"
Then: "Anything else? Great, have a good one."

If caller has existing appointment, mention it: "I also see you have an appointment on file." """,
}
```

**Step 2: Commit**

```bash
git add src/calllock/prompts.py
git commit -m "feat: port all 15 Retell state prompts with behavioral rules"
```

---

## Task 5: Rewrite state_machine.py with 15 states + new transitions

**Files:**
- Modify: `src/calllock/state_machine.py`

**Step 1: Replace state_machine.py with full 15-state machine**

```python
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


class StateMachine:
    def valid_transitions(self, state: State) -> set[State]:
        return TRANSITIONS.get(state, set())

    def available_tools(self, state: State) -> list[str]:
        return STATE_TOOLS.get(state, [])

    def process(self, session: CallSession, user_text: str) -> Action:
        session.turn_count += 1
        session.state_turn_count += 1

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
            _transition(session, State.BOOKING)
            return Action(needs_llm=True)

        # Stay for corrections or re-confirmation
        return Action(needs_llm=True)

    def _handle_booking(self, session: CallSession, text: str) -> Action:
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
```

**Step 2: Commit**

```bash
git add src/calllock/state_machine.py
git commit -m "feat: rewrite state machine with 15 states, new transitions, tool handlers"
```

---

## Task 6: Add manage_appointment to V2Client

**Files:**
- Modify: `src/calllock/tools.py`

**Step 1: Add manage_appointment method and fix create_callback args**

Add the following method to the `V2Client` class after `send_sales_lead_alert`:

```python
    async def manage_appointment(
        self,
        action: str,
        phone: str,
        call_id: str = "pipecat_call",
        booking_uid: str = "",
        reason: str = "",
        new_time: str = "",
    ) -> dict:
        if not self._circuit.should_try():
            logger.warning("V2 circuit breaker open — returning appointment failure")
            return {"success": False, "error": "V2 backend unavailable"}
        try:
            args = {"action": action}
            if booking_uid:
                args["booking_uid"] = booking_uid
            if reason:
                args["reason"] = reason
            if new_time:
                args["new_date_time"] = new_time

            async with httpx.AsyncClient(timeout=self.timeout, headers=self._headers()) as client:
                resp = await client.post(
                    f"{self.base_url}/webhook/retell/manage_appointment",
                    json={
                        "call": {
                            "call_id": call_id,
                            "from_number": phone,
                            "metadata": {},
                        },
                        "args": args,
                    },
                )
                resp.raise_for_status()
                self._circuit.record_success()
                return resp.json()
        except Exception as e:
            self._circuit.record_failure()
            logger.error("manage_appointment failed: %s", e)
            return {"success": False, "error": str(e)}
```

Also update `create_callback` to accept and pass `callback_type` and `reason` as proper `args` fields:

```python
    async def create_callback(
        self,
        phone: str,
        call_id: str = "pipecat_call",
        callback_type: str = "service",
        reason: str = "",
        customer_name: str = "",
        urgency: str = "normal",
    ) -> dict:
        if not self._circuit.should_try():
            logger.warning("V2 circuit breaker open — returning callback failure")
            return {"success": False, "error": "V2 backend unavailable"}
        try:
            async with httpx.AsyncClient(timeout=self.timeout, headers=self._headers()) as client:
                resp = await client.post(
                    f"{self.base_url}/webhook/retell/create_callback",
                    json={
                        "call": {
                            "call_id": call_id,
                            "from_number": phone,
                            "metadata": {},
                        },
                        "args": {
                            "reason": reason or "Callback requested",
                            "callback_type": callback_type,
                            "customer_name": customer_name,
                            "urgency": urgency,
                        },
                    },
                )
                resp.raise_for_status()
                self._circuit.record_success()
                return resp.json()
        except Exception as e:
            self._circuit.record_failure()
            logger.error("create_callback failed: %s", e)
            return {"success": False, "error": str(e)}
```

**Step 2: Commit**

```bash
git add src/calllock/tools.py
git commit -m "feat: add manage_appointment tool, fix create_callback args"
```

---

## Task 7: Update processor.py for new states and tools

**Files:**
- Modify: `src/calllock/processor.py`

**Step 1: Add manage_appointment to tool execution and update extraction states**

In the `_execute_tool` method, add the `manage_appointment` case:

```python
        elif tool == "manage_appointment":
            result = await self.tools.manage_appointment(
                action=action.tool_args.get("action", "status"),
                phone=self.session.phone_number,
                booking_uid=self.session.appointment_uid,
                reason=action.tool_args.get("reason", ""),
                new_time=action.tool_args.get("new_time", ""),
            )
```

Update the `create_callback` case to pass more fields:

```python
        elif tool == "create_callback":
            result = await self.tools.create_callback(
                phone=self.session.phone_number,
                callback_type=self.session.callback_type or self.session.lead_type or "service",
                reason=self.session.problem_description or "Callback requested",
                customer_name=self.session.customer_name,
                urgency="urgent" if self.session.urgency_tier == "urgent" else "normal",
            )
```

Update the extraction trigger states to include the new states:

```python
        if self.session.state.value in ("service_area", "discovery", "urgency", "pre_confirm"):
```

**Step 2: Commit**

```bash
git add src/calllock/processor.py
git commit -m "feat: wire manage_appointment tool, update extraction states"
```

---

## Task 8: Improve extraction.py with agent utterance filtering

**Files:**
- Modify: `src/calllock/extraction.py`

**Step 1: Filter agent utterances and add duration categorization**

Replace the entire file:

```python
import json
import httpx
import os
import logging

logger = logging.getLogger(__name__)

EXTRACTION_PROMPT = """Extract structured data from this conversation between a caller and a receptionist.
Return ONLY valid JSON. Only extract what the CALLER explicitly said — ignore what the receptionist said.

Fields:
- customer_name: The caller's name only. Must be a real human name. Not a phone number, not an address. Only extract from CALLER utterances.
- problem_description: What HVAC service issue the caller described.
- service_address: Street address for service. Do NOT include the customer name. Format: "123 Street Name".
- zip_code: 5-digit ZIP code.
- preferred_time: When the caller wants service (e.g., "ASAP", "tomorrow morning", "this week").
- problem_duration: How long the problem has been going on (e.g., "2 days", "since yesterday", "a few weeks").
- equipment_type: Type of HVAC equipment mentioned (AC, furnace, heat pump, thermostat, etc.).

If a field is not mentioned by the CALLER, use empty string "".
Do not guess or fabricate values. Only extract what the caller explicitly said.
NEVER mix customer_name into service_address or vice versa."""


def categorize_duration(duration: str) -> str:
    """Map problem duration to category: acute (<24h), recent (1-7d), ongoing (>7d)."""
    if not duration:
        return ""
    lower = duration.lower()
    acute_signals = ["today", "this morning", "tonight", "just", "hour", "few hours", "started"]
    recent_signals = ["yesterday", "couple days", "few days", "2 days", "3 days", "since"]
    ongoing_signals = ["week", "weeks", "month", "months", "long time", "a while"]

    if any(s in lower for s in acute_signals):
        return "acute"
    if any(s in lower for s in ongoing_signals):
        return "ongoing"
    if any(s in lower for s in recent_signals):
        return "recent"
    return ""


async def extract_fields(conversation: list[dict]) -> dict:
    """Call GPT-4o-mini to extract structured fields from conversation."""
    # Filter to only caller utterances for extraction context
    caller_turns = [msg for msg in conversation[-10:] if msg.get("role") == "user"]
    if not caller_turns:
        return {}

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
                        *conversation[-10:],
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

**Step 2: Update processor.py extraction handler to use new fields**

In `_run_extraction` in `processor.py`, add after the existing field updates:

```python
        if not self.session.equipment_type:
            equip = extracted.get("equipment_type", "")
            if equip:
                self.session.equipment_type = equip

        if not self.session.problem_duration:
            dur = extracted.get("problem_duration", "")
            if dur:
                self.session.problem_duration = dur
```

**Step 3: Commit**

```bash
git add src/calllock/extraction.py src/calllock/processor.py
git commit -m "feat: improve extraction with agent filtering, duration categorization"
```

---

## Task 9: Integration verification

**Step 1: Verify all imports resolve**

Run: `cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/pattaya/pipecat-agent && python -c "from calllock.states import State; from calllock.state_machine import StateMachine; from calllock.prompts import get_system_prompt; from calllock.session import CallSession; from calllock.tools import V2Client; from calllock.validation import classify_intent, detect_safety_emergency, detect_high_ticket, detect_callback_request, validate_address; from calllock.extraction import extract_fields, categorize_duration; print('All imports OK')"`

Expected: `All imports OK`

**Step 2: Verify state machine transitions are consistent**

Run: `python -c "
from calllock.states import State
from calllock.state_machine import TRANSITIONS, STATE_TOOLS
# Every state in enum should have a transition entry
for s in State:
    assert s in TRANSITIONS, f'{s} missing from TRANSITIONS'
    assert s in STATE_TOOLS, f'{s} missing from STATE_TOOLS'
print(f'All {len(State.__members__)} states have transitions and tools')
"`

Expected: `All 16 states have transitions and tools`

**Step 3: Verify state machine handles all states**

Run: `python -c "
from calllock.state_machine import StateMachine
from calllock.states import State
sm = StateMachine()
for s in State:
    handler = getattr(sm, f'_handle_{s.value}', None)
    assert handler is not None, f'Missing handler for {s.value}'
print(f'All {len(State.__members__)} state handlers exist')
"`

Expected: `All 16 states have handlers`

**Step 4: Fix any import or handler errors found**

**Step 5: Commit**

```bash
git commit --allow-empty -m "chore: verify all 15-state integration passes"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Expand State enum (10→15+CALLBACK) | states.py |
| 2 | Expand CallSession fields | session.py |
| 3 | Strengthen validation | validation.py |
| 4 | Port 15 Retell prompts | prompts.py |
| 5 | Rewrite state machine | state_machine.py |
| 6 | Add manage_appointment tool | tools.py |
| 7 | Update processor for new states | processor.py |
| 8 | Improve extraction | extraction.py, processor.py |
| 9 | Integration verification | all files |

Total: 9 tasks, ~8 files modified. Each task is independently committable.
