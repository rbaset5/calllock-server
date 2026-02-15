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
