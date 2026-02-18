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
