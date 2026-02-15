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
