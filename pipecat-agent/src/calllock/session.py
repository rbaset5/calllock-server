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

    # From callback
    callback_created: bool = False

    # Call metadata (set at pipeline start, used in post-call)
    call_sid: str = ""
    start_time: float = 0.0
    transcript_log: list = field(default_factory=list)

    # Metadata
    turn_count: int = 0
    state_turn_count: int = 0
    conversation_history: list = field(default_factory=list)
