import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo


def match_any_keyword(text: str, keywords: set[str]) -> bool:
    """Check if any keyword appears in text as a whole word (not substring)."""
    lower = text.lower()
    return any(re.search(rf'\b{re.escape(kw)}\b', lower) for kw in keywords)


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

WORD_TO_DIGIT = {
    "zero": "0", "oh": "0", "o": "0",
    "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
}


def words_to_digits(text: str) -> str:
    """Convert number words and single digits to a digit string.

    Only handles single-digit words (one through nine, zero, oh, o).
    Used for ZIP code and address normalization.
    Example: "seven eight seven zero one" → "78701"
    """
    tokens = re.findall(r"[a-zA-Z]+|\d", text.lower())
    digits = []
    for tok in tokens:
        if tok in WORD_TO_DIGIT:
            digits.append(WORD_TO_DIGIT[tok])
        elif tok.isdigit():
            digits.append(tok)
    return "".join(digits)


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
    if re.search(r"\bor\b", cleaned, re.IGNORECASE):
        return ""
    # Must contain at least one letter (rejects "7801", "78001")
    if not re.search(r"[a-zA-Z]", cleaned):
        return ""
    # Must be at least 5 characters (rejects "Oak", "1 Rk")
    if len(cleaned) < 5:
        return ""
    return cleaned


def is_service_area(zip_code: str) -> bool:
    validated = validate_zip(zip_code)
    if not validated:
        return False
    return validated.startswith("787")


_CST = ZoneInfo("America/Chicago")
_BUSINESS_START = 9   # 9 AM
_BUSINESS_END = 18    # 6 PM

_ASAP_KEYWORDS = {
    "asap", "today", "right away", "soonest", "right now",
    "as soon as possible", "same day", "morning",
}


def _now_cst() -> datetime:
    """Get current time in CST. Extracted for test mocking."""
    return datetime.now(_CST)


def resolve_booking_time(preferred_time: str) -> str:
    """Map human preferred_time text to an ISO datetime string.

    Returns an ISO 8601 datetime in America/Chicago timezone suitable
    for Cal.com's booking API. This is a hint — Cal.com picks the actual
    available slot from its calendar.
    """
    now = _now_cst()
    text = preferred_time.strip().lower()

    # ASAP / today / right away / soonest / same day / morning → now + 2h truncated
    if text in _ASAP_KEYWORDS:
        target = (now + timedelta(hours=2)).replace(minute=0, second=0, microsecond=0)
        # If past business hours, go to next morning
        if target.hour >= _BUSINESS_END or target.hour < _BUSINESS_START:
            target = (now + timedelta(days=1)).replace(
                hour=_BUSINESS_START, minute=0, second=0, microsecond=0
            )
        return target.isoformat()

    # Tomorrow → 9 AM next day
    if "tomorrow" in text:
        target = (now + timedelta(days=1)).replace(
            hour=_BUSINESS_START, minute=0, second=0, microsecond=0
        )
        return target.isoformat()

    # This afternoon → 2 PM today (or tomorrow if past 2 PM)
    if "afternoon" in text:
        target = now.replace(hour=14, minute=0, second=0, microsecond=0)
        if now.hour >= 14:
            target += timedelta(days=1)
        return target.isoformat()

    # Default: this week / whenever / empty / unknown → 9 AM next day
    target = (now + timedelta(days=1)).replace(
        hour=_BUSINESS_START, minute=0, second=0, microsecond=0
    )
    return target.isoformat()


def classify_intent(text: str) -> str:
    """Classify caller intent from first utterance.

    Returns: service, non_service, follow_up, manage_booking
    """
    if match_any_keyword(text, MANAGE_BOOKING_KEYWORDS):
        return "manage_booking"
    if match_any_keyword(text, FOLLOW_UP_KEYWORDS):
        return "follow_up"
    if match_any_keyword(text, NON_SERVICE_KEYWORDS):
        return "non_service"
    return "service"


def detect_safety_emergency(text: str) -> bool:
    if not match_any_keyword(text, SAFETY_KEYWORDS):
        return False
    return not match_any_keyword(text, SAFETY_RETRACTION_KEYWORDS)


def detect_high_ticket(text: str) -> bool:
    if not match_any_keyword(text, HIGH_TICKET_POSITIVE):
        return False
    return not match_any_keyword(text, HIGH_TICKET_NEGATIVE)


def detect_callback_request(text: str) -> bool:
    return match_any_keyword(text, CALLBACK_REQUEST_KEYWORDS)


def detect_property_manager(text: str) -> bool:
    return match_any_keyword(text, PROPERTY_MANAGER_KEYWORDS)
