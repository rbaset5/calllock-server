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
