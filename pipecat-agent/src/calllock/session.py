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
