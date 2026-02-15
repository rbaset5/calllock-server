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
