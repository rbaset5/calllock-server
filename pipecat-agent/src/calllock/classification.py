import httpx
import json
import logging
import os

from calllock.session import CallSession
from calllock.states import State
from calllock.validation import (
    detect_safety_emergency,
    detect_high_ticket,
    classify_intent,
    NON_SERVICE_KEYWORDS,
    SAFETY_KEYWORDS,
)

logger = logging.getLogger(__name__)


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


# --- Priority Detection ---

REPLACEMENT_KEYWORDS = {"new system", "new unit", "new ac", "replacement", "replace", "install", "installation", "upgrade"}
MAJOR_REPAIR_KEYWORDS = {"compressor", "heat exchanger", "evaporator", "condenser", "coil"}
MINOR_KEYWORDS = {"thermostat", "filter", "noise", "strange sound", "weird noise"}
MAINTENANCE_KEYWORDS = {"tune-up", "tuneup", "maintenance", "cleaning", "checkup"}


def detect_priority(tags: dict[str, list[str]], booking_status: str) -> dict:
    """Detect priority color from tags and booking status.

    Returns {"color": str, "reason": str}.
    Colors: red (callback risk), green (high-value), gray (spam), blue (standard).
    """
    # RED: hazard or recovery (frustrated customer)
    if tags.get("HAZARD"):
        return {"color": "red", "reason": f"Safety hazard: {', '.join(tags['HAZARD'])}"}
    if tags.get("RECOVERY"):
        return {"color": "red", "reason": f"Customer concern: {', '.join(tags['RECOVERY'])}"}

    # GRAY: spam/vendor
    if tags.get("NON_CUSTOMER"):
        return {"color": "gray", "reason": f"Non-customer: {', '.join(tags['NON_CUSTOMER'])}"}

    # GREEN: high-value / commercial
    if tags.get("REVENUE"):
        return {"color": "green", "reason": f"Revenue opportunity: {', '.join(tags['REVENUE'])}"}

    # BLUE: standard
    return {"color": "blue", "reason": "Standard residential service request"}


def estimate_revenue_tier(problem_description: str, revenue_tags: list[str]) -> dict:
    """Estimate revenue tier from problem description and tags.

    Returns {"tier": str, "tier_label": str, "signals": list, "confidence": str}.
    """
    lower = problem_description.lower()
    signals = []

    # Check for R-22 (always replacement)
    if "R22_RETROFIT" in revenue_tags:
        signals.append("R-22/Freon system")
        return {
            "tier": "replacement",
            "tier_label": "$$$$",
            "signals": signals,
            "confidence": "high",
        }

    # Tier 1: Replacement
    for kw in REPLACEMENT_KEYWORDS:
        if kw in lower:
            signals.append(kw)
    if signals:
        return {
            "tier": "replacement",
            "tier_label": "$$$$",
            "signals": signals,
            "confidence": "high" if len(signals) >= 2 else "medium",
        }

    # Tier 2: Major repair
    for kw in MAJOR_REPAIR_KEYWORDS:
        if kw in lower:
            signals.append(kw)
    if signals:
        return {
            "tier": "major_repair",
            "tier_label": "$$$",
            "signals": signals,
            "confidence": "medium",
        }

    # Tier 3: Minor
    for kw in MINOR_KEYWORDS:
        if kw in lower:
            signals.append(kw)
    if signals:
        return {
            "tier": "minor",
            "tier_label": "$",
            "signals": signals,
            "confidence": "medium",
        }

    # Tier 4: Maintenance
    for kw in MAINTENANCE_KEYWORDS:
        if kw in lower:
            signals.append(kw)
    if signals:
        return {
            "tier": "minor",
            "tier_label": "$",
            "signals": signals,
            "confidence": "medium",
        }

    # If problem text has content but no specific keywords → standard repair
    if problem_description.strip():
        return {
            "tier": "standard_repair",
            "tier_label": "$$",
            "signals": ["general repair request"],
            "confidence": "low",
        }

    # No signals at all → diagnostic
    return {
        "tier": "diagnostic",
        "tier_label": "$$?",
        "signals": [],
        "confidence": "low",
    }


# --- LLM Classification Pipeline ---

CALL_TYPE_ENUM = [
    "SERVICE", "ESTIMATE", "MAINTENANCE", "EXISTING_CUSTOMER",
    "RETURNING_CONTACT", "COMPLAINT", "JOB_SEEKER", "VENDOR_SUPPLIER",
    "SPAM_JUNK", "WRONG_NUMBER", "HANGUP_NO_MESSAGE", "UNKNOWN",
]

CLASSIFY_PROMPT = """Analyze this HVAC service call transcript and return a JSON object with these fields:

- ai_summary: 2-3 sentence summary of what happened on the call (who called, what they needed, what was the outcome)
- card_headline: Punchy 5-8 word headline for a dashboard card (e.g., "AC Not Blowing Cold — Same Day")
- card_summary: 2-3 sentence dispatch summary a technician would read before heading to the job
- call_type: One of: {call_types}
- call_subtype: Specific subtype like "REPAIR_AC", "REPAIR_HEATING", "DIAGNOSTIC_NOISE", or null if not applicable
- sentiment_score: 1-5 integer (1=very negative, 3=neutral, 5=very positive) based on how the caller felt during the call

Context:
- Customer: {customer_name}
- Final state: {final_state}
- Booking: {booking_status}
- Urgency: {urgency}

Transcript:
{transcript}

Return ONLY valid JSON, no markdown fences."""


async def classify_call(session: CallSession, transcript_text: str) -> dict:
    """Single LLM call to classify the call and generate display fields.

    Returns dict with ai_summary, card_headline, card_summary, call_type,
    call_subtype, sentiment_score. Returns empty dict on failure.
    """
    api_key = os.getenv("OPENAI_API_KEY", "")
    if not api_key or not transcript_text.strip():
        return {}

    booking_status = "confirmed" if session.booking_confirmed else (
        "attempted_failed" if session.booking_attempted else "not_requested"
    )

    prompt = CLASSIFY_PROMPT.format(
        call_types=", ".join(CALL_TYPE_ENUM),
        customer_name=session.customer_name or "Unknown",
        final_state=session.state.value,
        booking_status=booking_status,
        urgency=session.urgency_tier,
        transcript=transcript_text[:3000],
    )

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json={
                    "model": "gpt-4o-mini",
                    "temperature": 0.2,
                    "max_tokens": 500,
                    "response_format": {"type": "json_object"},
                    "messages": [
                        {"role": "system", "content": "You classify HVAC service calls. Return only JSON."},
                        {"role": "user", "content": prompt},
                    ],
                },
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
            data = json.loads(content)

            # Validate and clamp
            result = {}
            if data.get("ai_summary"):
                result["ai_summary"] = str(data["ai_summary"])[:500]
            if data.get("card_headline"):
                result["card_headline"] = str(data["card_headline"])[:100]
            if data.get("card_summary"):
                result["card_summary"] = str(data["card_summary"])[:500]
            if data.get("call_type") in CALL_TYPE_ENUM:
                result["call_type"] = data["call_type"]
            if data.get("call_subtype"):
                result["call_subtype"] = str(data["call_subtype"])
            if isinstance(data.get("sentiment_score"), (int, float)):
                result["sentiment_score"] = max(1, min(5, int(data["sentiment_score"])))

            return result

    except Exception as e:
        logger.warning(f"classify_call failed: {e}")
        return {}
