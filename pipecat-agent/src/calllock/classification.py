from calllock.session import CallSession
from calllock.states import State
from calllock.validation import (
    detect_safety_emergency,
    detect_high_ticket,
    classify_intent,
    NON_SERVICE_KEYWORDS,
    SAFETY_KEYWORDS,
)


# --- Keyword maps for tag detection ---

HAZARD_KEYWORDS = {
    "GAS_LEAK": {"gas", "rotten egg", "sulfur", "hissing"},
    "CO_EVENT": {"co detector", "carbon monoxide", "co alarm"},
    "ELECTRICAL_FIRE": {"burning", "smoke", "sparks", "breaker"},
    "ACTIVE_FLOODING": {"flooding", "water pouring", "burst pipe"},
    "REFRIGERANT_LEAK": {"chemical smell", "frozen coil"},
    "HEALTH_RISK": {"no heat", "no ac", "freezing"},
}

SERVICE_TYPE_KEYWORDS = {
    "REPAIR_AC": {"ac", "air conditioning", "cooling", "not cooling", "warm air"},
    "REPAIR_HEATING": {"heating", "furnace", "heat", "not heating", "no heat"},
    "REPAIR_HEATPUMP": {"heat pump", "heatpump"},
    "REPAIR_THERMOSTAT": {"thermostat"},
    "REPAIR_DUCTWORK": {"duct", "ductwork", "vent"},
    "TUNEUP_AC": {"tune-up", "tuneup", "maintenance", "checkup"},
    "INSTALL_REPLACEMENT": {"new system", "replacement", "replace", "install"},
    "DIAGNOSTIC_NOISE": {"noise", "strange sound", "rattling", "buzzing"},
    "DIAGNOSTIC_SMELL": {"smell", "odor"},
    "SECONDOPINION": {"second opinion"},
    "WARRANTY_CLAIM": {"warranty"},
}

RECOVERY_KEYWORDS = {
    "CALLBACK_RISK": {"waiting", "no one called back", "still waiting"},
    "COMPLAINT_PRICE": {"too expensive", "overcharged", "price"},
    "COMPLAINT_SERVICE": {"poor service", "rude"},
    "COMPLAINT_NOFIX": {"still broken", "didn't fix", "not fixed"},
    "ESCALATION_REQ": {"manager", "supervisor", "speak to"},
    "COMPETITOR_MENTION": {"cheaper quote", "another company"},
}

LOGISTICS_KEYWORDS = {
    "GATE_CODE": {"gate", "gated"},
    "PET_SECURE": {"dog", "cat", "pet"},
    "LANDLORD_AUTH": {"landlord", "owner permission"},
    "TENANT_COORD": {"tenant", "renter"},
}

NON_CUSTOMER_KEYWORDS = {
    "JOB_APPLICANT": {"hiring", "job", "apply", "position"},
    "VENDOR_SALES": {"vendor", "supplier", "selling", "partnership"},
    "WRONG_NUMBER": {"wrong number"},
    "SPAM_TELEMARKETING": {"telemarketing", "spam"},
    "PARTS_SUPPLIER": {"parts supplier", "supply house"},
    "REALTOR_INQUIRY": {"realtor", "real estate"},
}

CONTEXT_KEYWORDS = {
    "ELDERLY_OCCUPANT": {"elderly", "senior", "grandma", "grandmother"},
    "INFANT_NEWBORN": {"baby", "infant", "newborn"},
    "MEDICAL_NEED": {"medical", "oxygen", "health condition"},
}

URGENCY_MAP = {
    "emergency": "EMERGENCY_SAMEDAY",
    "urgent": "URGENT_24HR",
    "high": "PRIORITY_48HR",
    "routine": "STANDARD",
    "low": "FLEXIBLE",
}


def classify_tags(session: CallSession, transcript_text: str) -> dict[str, list[str]]:
    """Classify a call into the 117-tag HVAC taxonomy.

    Returns dict with 9 category keys, each containing a list of tag strings.
    """
    tags: dict[str, list[str]] = {
        "HAZARD": [],
        "URGENCY": [],
        "SERVICE_TYPE": [],
        "REVENUE": [],
        "RECOVERY": [],
        "LOGISTICS": [],
        "CUSTOMER": [],
        "NON_CUSTOMER": [],
        "CONTEXT": [],
    }

    # Combine sources for keyword matching
    text = f"{transcript_text} {session.problem_description}".lower()

    # --- HAZARD ---
    if session.state == State.SAFETY_EXIT:
        for tag, keywords in HAZARD_KEYWORDS.items():
            if any(kw in text for kw in keywords):
                tags["HAZARD"].append(tag)
        # Default to HEALTH_RISK if safety_exit but no specific match
        if not tags["HAZARD"]:
            tags["HAZARD"].append("HEALTH_RISK")

    # --- URGENCY ---
    urgency_tag = URGENCY_MAP.get(session.urgency_tier, "STANDARD")
    tags["URGENCY"].append(urgency_tag)
    # Escalate if safety exit
    if session.state == State.SAFETY_EXIT and "CRITICAL_EVACUATE" not in tags["URGENCY"]:
        tags["URGENCY"] = ["CRITICAL_EVACUATE"]

    # --- SERVICE_TYPE ---
    for tag, keywords in SERVICE_TYPE_KEYWORDS.items():
        if any(kw in text for kw in keywords):
            tags["SERVICE_TYPE"].append(tag)

    # --- REVENUE ---
    if detect_high_ticket(session.problem_description):
        tags["REVENUE"].append("HOT_LEAD")
    if "r-22" in text or "r22" in text or "freon" in text:
        tags["REVENUE"].append("R22_RETROFIT")

    # --- RECOVERY ---
    for tag, keywords in RECOVERY_KEYWORDS.items():
        if any(kw in text for kw in keywords):
            tags["RECOVERY"].append(tag)

    # --- LOGISTICS ---
    for tag, keywords in LOGISTICS_KEYWORDS.items():
        if any(kw in text for kw in keywords):
            tags["LOGISTICS"].append(tag)

    # --- CUSTOMER ---
    if session.caller_known:
        tags["CUSTOMER"].append("EXISTING_CUSTOMER")
    else:
        tags["CUSTOMER"].append("NEW_CUSTOMER")

    # --- NON_CUSTOMER ---
    for tag, keywords in NON_CUSTOMER_KEYWORDS.items():
        if any(kw in text for kw in keywords):
            tags["NON_CUSTOMER"].append(tag)

    # --- CONTEXT ---
    for tag, keywords in CONTEXT_KEYWORDS.items():
        if any(kw in text for kw in keywords):
            tags["CONTEXT"].append(tag)

    return tags
