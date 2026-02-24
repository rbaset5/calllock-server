# Pipecat Post-Call Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add post-call processing to the Pipecat voice agent so calls sync to the CallLock dashboard — making Pipecat a full Retell replacement.

**Architecture:** After `runner.run(task)` returns in `pipeline.py`, a post-call handler serializes the transcript, classifies the call (tags, priority, revenue), builds a dashboard payload, and sends it to 3 webhook endpoints. CallSession is the single source of truth — no extraction needed.

**Tech Stack:** Python 3.12, httpx, pytest, respx (all already installed)

**Design Doc:** `docs/plans/2026-02-16-pipecat-post-call-design.md`

---

## Task 1: Add Post-Call Fields to CallSession

**Files:**
- Modify: `pipecat-agent/src/calllock/session.py`
- Modify: `pipecat-agent/tests/test_session.py`

**Step 1: Write failing tests**

```python
# Add to pipecat-agent/tests/test_session.py

def test_session_has_call_metadata_fields():
    s = CallSession(phone_number="+15125551234")
    assert s.call_sid == ""
    assert s.start_time == 0.0
    assert s.transcript_log == []


def test_session_transcript_log_accumulates():
    s = CallSession(phone_number="+15125551234")
    s.transcript_log.append({"role": "agent", "content": "Hello", "timestamp": 1000.0})
    s.transcript_log.append({"role": "user", "content": "Hi", "timestamp": 1001.0})
    assert len(s.transcript_log) == 2
    assert s.transcript_log[0]["role"] == "agent"
```

**Step 2: Run tests to verify they fail**

Run: `cd pipecat-agent && .venv/bin/python -m pytest tests/test_session.py::test_session_has_call_metadata_fields tests/test_session.py::test_session_transcript_log_accumulates -v`
Expected: FAIL — `CallSession` has no `call_sid`, `start_time`, or `transcript_log`

**Step 3: Add fields to session.py**

Add these fields to the `CallSession` dataclass in `pipecat-agent/src/calllock/session.py`, in a new "# Call metadata" section after the existing "# Metadata" section:

```python
    # Call metadata (set at pipeline start, used in post-call)
    call_sid: str = ""
    start_time: float = 0.0
    transcript_log: list = field(default_factory=list)
```

**Step 4: Run tests to verify they pass**

Run: `cd pipecat-agent && .venv/bin/python -m pytest tests/test_session.py -v`
Expected: all PASS

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/session.py pipecat-agent/tests/test_session.py
git commit -m "feat: add call_sid, start_time, transcript_log to CallSession"
```

---

## Task 2: Transcript Serialization (TDD)

**Files:**
- Create: `pipecat-agent/src/calllock/transcript.py`
- Create: `pipecat-agent/tests/test_transcript.py`

**Step 1: Write failing tests**

```python
# pipecat-agent/tests/test_transcript.py
from calllock.transcript import to_plain_text, to_json_array


class TestToPlainText:
    def test_basic_conversation(self):
        log = [
            {"role": "agent", "content": "Thanks for calling ACE Cooling.", "timestamp": 1000.0},
            {"role": "user", "content": "My AC is broken.", "timestamp": 1002.0},
            {"role": "agent", "content": "Let me look into that.", "timestamp": 1004.0},
        ]
        result = to_plain_text(log)
        assert result == (
            "Agent: Thanks for calling ACE Cooling.\n"
            "Caller: My AC is broken.\n"
            "Agent: Let me look into that."
        )

    def test_includes_tool_invocations(self):
        log = [
            {"role": "agent", "content": "Pulling that up now.", "timestamp": 1000.0},
            {"role": "tool", "name": "lookup_caller", "result": {"found": True}, "timestamp": 1001.0},
            {"role": "agent", "content": "I found your account.", "timestamp": 1002.0},
        ]
        result = to_plain_text(log)
        assert "[Tool: lookup_caller]" in result

    def test_empty_log(self):
        assert to_plain_text([]) == ""


class TestToJsonArray:
    def test_basic_conversation(self):
        log = [
            {"role": "agent", "content": "Hello.", "timestamp": 1000.0},
            {"role": "user", "content": "Hi.", "timestamp": 1001.0},
        ]
        result = to_json_array(log)
        assert len(result) == 2
        assert result[0]["role"] == "agent"
        assert result[0]["content"] == "Hello."
        assert result[1]["role"] == "user"
        assert result[1]["content"] == "Hi."

    def test_tool_entries_included(self):
        log = [
            {"role": "tool", "name": "book_service", "result": {"booked": True}, "timestamp": 1000.0},
        ]
        result = to_json_array(log)
        assert len(result) == 1
        assert result[0]["role"] == "tool"
        assert result[0]["name"] == "book_service"

    def test_empty_log(self):
        assert to_json_array([]) == []
```

**Step 2: Run tests to verify they fail**

Run: `cd pipecat-agent && .venv/bin/python -m pytest tests/test_transcript.py -v`
Expected: FAIL — module not found

**Step 3: Implement transcript.py**

```python
# pipecat-agent/src/calllock/transcript.py


def to_plain_text(log: list[dict]) -> str:
    """Convert transcript log to plain text format.

    Agent lines prefixed with "Agent:", user lines with "Caller:",
    tool invocations shown as "[Tool: name]".
    """
    if not log:
        return ""

    lines = []
    for entry in log:
        role = entry.get("role", "")
        if role == "agent":
            lines.append(f"Agent: {entry['content']}")
        elif role == "user":
            lines.append(f"Caller: {entry['content']}")
        elif role == "tool":
            lines.append(f"[Tool: {entry['name']}]")
    return "\n".join(lines)


def to_json_array(log: list[dict]) -> list[dict]:
    """Convert transcript log to structured JSON array for dashboard.

    Returns list of {role, content} dicts. Tool entries include name and result.
    """
    if not log:
        return []

    result = []
    for entry in log:
        role = entry.get("role", "")
        if role in ("agent", "user"):
            result.append({"role": role, "content": entry["content"]})
        elif role == "tool":
            result.append({
                "role": "tool",
                "name": entry["name"],
                "result": entry.get("result", {}),
            })
    return result
```

**Step 4: Run tests to verify they pass**

Run: `cd pipecat-agent && .venv/bin/python -m pytest tests/test_transcript.py -v`
Expected: all PASS

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/transcript.py pipecat-agent/tests/test_transcript.py
git commit -m "feat: add transcript serialization (plain text + JSON array)"
```

---

## Task 3: Classification — Taxonomy Tags (TDD)

**Files:**
- Create: `pipecat-agent/src/calllock/classification.py`
- Create: `pipecat-agent/tests/test_classification.py`

**Step 1: Write failing tests for taxonomy tags**

```python
# pipecat-agent/tests/test_classification.py
from calllock.classification import classify_tags, detect_priority, estimate_revenue_tier
from calllock.session import CallSession
from calllock.states import State


class TestClassifyTags:
    def test_safety_exit_produces_hazard_tag(self):
        session = CallSession(phone_number="+15125551234")
        session.state = State.SAFETY_EXIT
        transcript_text = "I smell gas in my house"
        tags = classify_tags(session, transcript_text)
        assert "GAS_LEAK" in tags["HAZARD"]

    def test_co_detector_produces_co_tag(self):
        session = CallSession(phone_number="+15125551234")
        session.state = State.SAFETY_EXIT
        transcript_text = "my CO detector is going off"
        tags = classify_tags(session, transcript_text)
        assert "CO_EVENT" in tags["HAZARD"]

    def test_emergency_urgency_tag(self):
        session = CallSession(phone_number="+15125551234")
        session.urgency_tier = "emergency"
        tags = classify_tags(session, "")
        assert "EMERGENCY_SAMEDAY" in tags["URGENCY"]

    def test_standard_urgency_default(self):
        session = CallSession(phone_number="+15125551234")
        session.urgency_tier = "routine"
        tags = classify_tags(session, "")
        assert "STANDARD" in tags["URGENCY"]

    def test_high_ticket_produces_revenue_tag(self):
        session = CallSession(phone_number="+15125551234")
        session.problem_description = "I want a new AC system"
        tags = classify_tags(session, "")
        assert "HOT_LEAD" in tags["REVENUE"]

    def test_new_customer_tag(self):
        session = CallSession(phone_number="+15125551234")
        session.caller_known = False
        tags = classify_tags(session, "")
        assert "NEW_CUSTOMER" in tags["CUSTOMER"]

    def test_existing_customer_tag(self):
        session = CallSession(phone_number="+15125551234")
        session.caller_known = True
        tags = classify_tags(session, "")
        assert "EXISTING_CUSTOMER" in tags["CUSTOMER"]

    def test_non_service_vendor_tag(self):
        session = CallSession(phone_number="+15125551234")
        session.state = State.CALLBACK
        transcript_text = "I'm a parts supplier"
        tags = classify_tags(session, transcript_text)
        assert len(tags["NON_CUSTOMER"]) > 0

    def test_repair_ac_service_type(self):
        session = CallSession(phone_number="+15125551234")
        session.problem_description = "my AC is broken and not cooling"
        tags = classify_tags(session, "")
        assert "REPAIR_AC" in tags["SERVICE_TYPE"]

    def test_all_nine_categories_present(self):
        session = CallSession(phone_number="+15125551234")
        tags = classify_tags(session, "")
        expected_categories = {
            "HAZARD", "URGENCY", "SERVICE_TYPE", "REVENUE",
            "RECOVERY", "LOGISTICS", "CUSTOMER", "NON_CUSTOMER", "CONTEXT",
        }
        assert set(tags.keys()) == expected_categories

    def test_booking_confirmed_produces_service_type(self):
        session = CallSession(phone_number="+15125551234")
        session.state = State.DONE
        session.booking_confirmed = True
        session.problem_description = "heating not working"
        tags = classify_tags(session, "")
        assert "REPAIR_HEATING" in tags["SERVICE_TYPE"]
```

**Step 2: Run tests to verify they fail**

Run: `cd pipecat-agent && .venv/bin/python -m pytest tests/test_classification.py::TestClassifyTags -v`
Expected: FAIL — module not found

**Step 3: Implement classify_tags in classification.py**

```python
# pipecat-agent/src/calllock/classification.py
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
        # Default to GAS_LEAK if safety_exit but no specific match
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
```

**Step 4: Run tests to verify they pass**

Run: `cd pipecat-agent && .venv/bin/python -m pytest tests/test_classification.py::TestClassifyTags -v`
Expected: all PASS

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/classification.py pipecat-agent/tests/test_classification.py
git commit -m "feat: add HVAC taxonomy tag classification (9 categories)"
```

---

## Task 4: Classification — Priority + Revenue Tier (TDD)

**Files:**
- Modify: `pipecat-agent/src/calllock/classification.py`
- Modify: `pipecat-agent/tests/test_classification.py`

**Step 1: Write failing tests**

```python
# Add to pipecat-agent/tests/test_classification.py


class TestDetectPriority:
    def test_hazard_tags_produce_red(self):
        tags = {"HAZARD": ["GAS_LEAK"], "RECOVERY": [], "REVENUE": [], "NON_CUSTOMER": []}
        result = detect_priority(tags, "attempted_failed")
        assert result["color"] == "red"

    def test_recovery_tags_produce_red(self):
        tags = {"HAZARD": [], "RECOVERY": ["COMPLAINT_NOFIX"], "REVENUE": [], "NON_CUSTOMER": []}
        result = detect_priority(tags, "confirmed")
        assert result["color"] == "red"

    def test_commercial_produces_green(self):
        tags = {"HAZARD": [], "RECOVERY": [], "REVENUE": ["HOT_LEAD"], "NON_CUSTOMER": []}
        result = detect_priority(tags, "confirmed")
        assert result["color"] == "green"

    def test_vendor_produces_gray(self):
        tags = {"HAZARD": [], "RECOVERY": [], "REVENUE": [], "NON_CUSTOMER": ["VENDOR_SALES"]}
        result = detect_priority(tags, "not_requested")
        assert result["color"] == "gray"

    def test_standard_call_produces_blue(self):
        tags = {"HAZARD": [], "RECOVERY": [], "REVENUE": [], "NON_CUSTOMER": []}
        result = detect_priority(tags, "confirmed")
        assert result["color"] == "blue"

    def test_result_has_reason(self):
        tags = {"HAZARD": ["GAS_LEAK"], "RECOVERY": [], "REVENUE": [], "NON_CUSTOMER": []}
        result = detect_priority(tags, "confirmed")
        assert isinstance(result["reason"], str)
        assert len(result["reason"]) > 0


class TestEstimateRevenueTier:
    def test_replacement_keywords(self):
        result = estimate_revenue_tier("I want a new AC system installed", [])
        assert result["tier"] == "replacement"
        assert result["tier_label"] == "$$$$"

    def test_major_repair_keywords(self):
        result = estimate_revenue_tier("compressor is dead", [])
        assert result["tier"] == "major_repair"
        assert result["tier_label"] == "$$$"

    def test_standard_repair_default(self):
        result = estimate_revenue_tier("AC is broken not cooling", [])
        assert result["tier"] == "standard_repair"
        assert result["tier_label"] == "$$"

    def test_minor_keywords(self):
        result = estimate_revenue_tier("thermostat is not responding", [])
        assert result["tier"] == "minor"
        assert result["tier_label"] == "$"

    def test_diagnostic_fallback(self):
        result = estimate_revenue_tier("", [])
        assert result["tier"] == "diagnostic"
        assert result["tier_label"] == "$$?"

    def test_r22_signals_replacement(self):
        result = estimate_revenue_tier("needs freon recharge", ["R22_RETROFIT"])
        assert result["tier"] == "replacement"

    def test_result_has_signals(self):
        result = estimate_revenue_tier("compressor failed", [])
        assert isinstance(result["signals"], list)
        assert len(result["signals"]) > 0

    def test_result_has_confidence(self):
        result = estimate_revenue_tier("new system replacement", [])
        assert result["confidence"] in ("low", "medium", "high")
```

**Step 2: Run tests to verify they fail**

Run: `cd pipecat-agent && .venv/bin/python -m pytest tests/test_classification.py::TestDetectPriority tests/test_classification.py::TestEstimateRevenueTier -v`
Expected: FAIL — functions not defined

**Step 3: Add detect_priority and estimate_revenue_tier to classification.py**

Append to `pipecat-agent/src/calllock/classification.py`:

```python
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
```

**Step 4: Run tests to verify they pass**

Run: `cd pipecat-agent && .venv/bin/python -m pytest tests/test_classification.py -v`
Expected: all PASS

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/classification.py pipecat-agent/tests/test_classification.py
git commit -m "feat: add priority detection and revenue tier estimation"
```

---

## Task 5: Dashboard Sync Client (TDD)

**Files:**
- Create: `pipecat-agent/src/calllock/dashboard_sync.py`
- Create: `pipecat-agent/tests/test_dashboard_sync.py`

**Important context:** The dashboard uses a simple secret string comparison for auth (NOT HMAC). The header is `X-Webhook-Secret` and the value is `DASHBOARD_WEBHOOK_SECRET` sent as-is.

**Step 1: Write failing tests**

```python
# pipecat-agent/tests/test_dashboard_sync.py
import pytest
import httpx
import respx
from calllock.dashboard_sync import DashboardClient


@pytest.fixture
def dashboard():
    return DashboardClient(
        webhook_url="https://app.example.com/api/webhook/jobs",
        webhook_secret="test-secret-123",
    )


class TestDashboardClient:
    def test_derives_calls_url(self, dashboard):
        assert dashboard.calls_url == "https://app.example.com/api/webhook/calls"

    def test_derives_alerts_url(self, dashboard):
        assert dashboard.alerts_url == "https://app.example.com/api/webhook/emergency-alerts"


class TestSendJob:
    @respx.mock
    @pytest.mark.asyncio
    async def test_sends_job_payload(self, dashboard):
        route = respx.post("https://app.example.com/api/webhook/jobs").mock(
            return_value=httpx.Response(200, json={"success": True, "job_id": "j_123"})
        )
        result = await dashboard.send_job({"customer_name": "Jonas", "call_id": "call_1"})
        assert result["success"] is True
        # Verify secret header was sent
        assert route.calls[0].request.headers["X-Webhook-Secret"] == "test-secret-123"

    @respx.mock
    @pytest.mark.asyncio
    async def test_handles_failure(self, dashboard):
        respx.post("https://app.example.com/api/webhook/jobs").mock(
            return_value=httpx.Response(500)
        )
        result = await dashboard.send_job({"customer_name": "Jonas"})
        assert result["success"] is False


class TestSendCall:
    @respx.mock
    @pytest.mark.asyncio
    async def test_sends_call_record(self, dashboard):
        route = respx.post("https://app.example.com/api/webhook/calls").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        result = await dashboard.send_call({"call_id": "call_1", "phone_number": "+15125551234"})
        assert result["success"] is True
        assert route.calls[0].request.headers["X-Webhook-Secret"] == "test-secret-123"

    @respx.mock
    @pytest.mark.asyncio
    async def test_handles_failure(self, dashboard):
        respx.post("https://app.example.com/api/webhook/calls").mock(
            return_value=httpx.Response(500)
        )
        result = await dashboard.send_call({"call_id": "call_1"})
        assert result["success"] is False


class TestSendEmergencyAlert:
    @respx.mock
    @pytest.mark.asyncio
    async def test_sends_alert(self, dashboard):
        route = respx.post("https://app.example.com/api/webhook/emergency-alerts").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        result = await dashboard.send_emergency_alert({
            "phone_number": "+15125551234",
            "problem_description": "Gas leak",
        })
        assert result["success"] is True
        assert route.calls[0].request.headers["X-Webhook-Secret"] == "test-secret-123"

    @respx.mock
    @pytest.mark.asyncio
    async def test_handles_failure(self, dashboard):
        respx.post("https://app.example.com/api/webhook/emergency-alerts").mock(
            return_value=httpx.Response(500)
        )
        result = await dashboard.send_emergency_alert({"phone_number": "+15125551234"})
        assert result["success"] is False
```

**Step 2: Run tests to verify they fail**

Run: `cd pipecat-agent && .venv/bin/python -m pytest tests/test_dashboard_sync.py -v`
Expected: FAIL — module not found

**Step 3: Implement dashboard_sync.py**

```python
# pipecat-agent/src/calllock/dashboard_sync.py
import httpx
import logging

logger = logging.getLogger(__name__)


class DashboardClient:
    """HTTP client for sending post-call data to the CallLock dashboard."""

    def __init__(self, webhook_url: str, webhook_secret: str, timeout: float = 15.0):
        self.jobs_url = webhook_url
        self.calls_url = webhook_url.replace("/api/webhook/jobs", "/api/webhook/calls")
        self.alerts_url = webhook_url.replace("/api/webhook/jobs", "/api/webhook/emergency-alerts")
        self.secret = webhook_secret
        self.timeout = timeout

    def _headers(self) -> dict:
        return {
            "Content-Type": "application/json",
            "X-Webhook-Secret": self.secret,
        }

    async def send_job(self, payload: dict) -> dict:
        """Send job/lead data to dashboard. Returns {"success": bool, ...}."""
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(self.jobs_url, json=payload, headers=self._headers())
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            logger.error(f"Dashboard job sync failed: {e}")
            return {"success": False, "error": str(e)}

    async def send_call(self, payload: dict) -> dict:
        """Send call record to dashboard. Fire-and-forget with error logging."""
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(self.calls_url, json=payload, headers=self._headers())
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            logger.error(f"Dashboard call sync failed: {e}")
            return {"success": False, "error": str(e)}

    async def send_emergency_alert(self, payload: dict) -> dict:
        """Send emergency alert to dashboard."""
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(self.alerts_url, json=payload, headers=self._headers())
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            logger.error(f"Dashboard emergency alert failed: {e}")
            return {"success": False, "error": str(e)}
```

**Step 4: Run tests to verify they pass**

Run: `cd pipecat-agent && .venv/bin/python -m pytest tests/test_dashboard_sync.py -v`
Expected: all PASS

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/dashboard_sync.py pipecat-agent/tests/test_dashboard_sync.py
git commit -m "feat: add dashboard webhook client (jobs, calls, emergency alerts)"
```

---

## Task 6: Post-Call Orchestrator (TDD)

**Files:**
- Create: `pipecat-agent/src/calllock/post_call.py`
- Create: `pipecat-agent/tests/test_post_call.py`

**Step 1: Write failing tests**

```python
# pipecat-agent/tests/test_post_call.py
import pytest
import httpx
import respx
import time
from calllock.post_call import handle_call_ended, build_job_payload, build_call_payload
from calllock.session import CallSession
from calllock.states import State


@pytest.fixture
def completed_session():
    """A session that went through a full happy-path call."""
    s = CallSession(phone_number="+15125551234")
    s.call_sid = "CA_test_123"
    s.start_time = 1000.0
    s.state = State.DONE
    s.caller_known = True
    s.customer_name = "Jonas"
    s.zip_code = "78745"
    s.service_address = "4210 South Lamar Blvd"
    s.problem_description = "AC blowing warm air"
    s.preferred_time = "morning"
    s.booking_confirmed = True
    s.booked_time = "2026-02-20T10:00:00"
    s.urgency_tier = "routine"
    s.transcript_log = [
        {"role": "agent", "content": "Thanks for calling ACE Cooling.", "timestamp": 1000.0},
        {"role": "user", "content": "My AC is blowing warm air.", "timestamp": 1002.0},
        {"role": "tool", "name": "book_service", "result": {"booked": True}, "timestamp": 1010.0},
        {"role": "agent", "content": "You're all set for tomorrow morning.", "timestamp": 1012.0},
    ]
    return s


@pytest.fixture
def safety_session():
    """A session that hit safety exit."""
    s = CallSession(phone_number="+15125559876")
    s.call_sid = "CA_test_456"
    s.start_time = 2000.0
    s.state = State.SAFETY_EXIT
    s.customer_name = "Maria"
    s.transcript_log = [
        {"role": "agent", "content": "Any safety concerns?", "timestamp": 2000.0},
        {"role": "user", "content": "I smell gas in my house", "timestamp": 2002.0},
        {"role": "agent", "content": "Please call 911 immediately.", "timestamp": 2003.0},
    ]
    return s


class TestBuildJobPayload:
    def test_has_required_fields(self, completed_session):
        payload = build_job_payload(completed_session, end_time=1015.0, user_email="owner@test.com")
        assert payload["customer_name"] == "Jonas"
        assert payload["customer_phone"] == "+15125551234"
        assert payload["customer_address"] == "4210 South Lamar Blvd"
        assert payload["service_type"] == "hvac"
        assert payload["call_id"] == "CA_test_123"
        assert payload["user_email"] == "owner@test.com"

    def test_booking_confirmed_has_scheduled_at(self, completed_session):
        payload = build_job_payload(completed_session, end_time=1015.0, user_email="owner@test.com")
        assert payload["scheduled_at"] == "2026-02-20T10:00:00"
        assert payload["booking_status"] == "confirmed"

    def test_callback_session_no_scheduled_at(self):
        s = CallSession(phone_number="+15125551234")
        s.call_sid = "CA_test_789"
        s.start_time = 1000.0
        s.state = State.CALLBACK
        payload = build_job_payload(s, end_time=1015.0, user_email="owner@test.com")
        assert payload.get("scheduled_at") is None
        assert payload["booking_status"] == "not_requested"

    def test_includes_transcript(self, completed_session):
        payload = build_job_payload(completed_session, end_time=1015.0, user_email="owner@test.com")
        assert "Agent:" in payload["call_transcript"]
        assert isinstance(payload["transcript_object"], list)

    def test_includes_classification(self, completed_session):
        payload = build_job_payload(completed_session, end_time=1015.0, user_email="owner@test.com")
        assert isinstance(payload["tags"], dict)
        assert "HAZARD" in payload["tags"]
        assert isinstance(payload["priority_color"], str)
        assert isinstance(payload["revenue_tier"], str)


class TestBuildCallPayload:
    def test_has_required_fields(self, completed_session):
        payload = build_call_payload(completed_session, end_time=1015.0, user_email="owner@test.com")
        assert payload["call_id"] == "CA_test_123"
        assert payload["phone_number"] == "+15125551234"
        assert payload["user_email"] == "owner@test.com"
        assert payload["duration_seconds"] == 15

    def test_has_transcript_object(self, completed_session):
        payload = build_call_payload(completed_session, end_time=1015.0, user_email="owner@test.com")
        assert isinstance(payload["transcript_object"], list)


class TestHandleCallEnded:
    @respx.mock
    @pytest.mark.asyncio
    async def test_sends_job_and_call(self, completed_session, monkeypatch):
        monkeypatch.setenv("DASHBOARD_WEBHOOK_URL", "https://app.example.com/api/webhook/jobs")
        monkeypatch.setenv("DASHBOARD_WEBHOOK_SECRET", "test-secret")
        monkeypatch.setenv("DASHBOARD_USER_EMAIL", "owner@test.com")

        job_route = respx.post("https://app.example.com/api/webhook/jobs").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        call_route = respx.post("https://app.example.com/api/webhook/calls").mock(
            return_value=httpx.Response(200, json={"success": True})
        )

        await handle_call_ended(completed_session)

        assert job_route.called
        assert call_route.called

    @respx.mock
    @pytest.mark.asyncio
    async def test_safety_exit_sends_emergency_alert(self, safety_session, monkeypatch):
        monkeypatch.setenv("DASHBOARD_WEBHOOK_URL", "https://app.example.com/api/webhook/jobs")
        monkeypatch.setenv("DASHBOARD_WEBHOOK_SECRET", "test-secret")
        monkeypatch.setenv("DASHBOARD_USER_EMAIL", "owner@test.com")

        respx.post("https://app.example.com/api/webhook/jobs").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        respx.post("https://app.example.com/api/webhook/calls").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        alert_route = respx.post("https://app.example.com/api/webhook/emergency-alerts").mock(
            return_value=httpx.Response(200, json={"success": True})
        )

        await handle_call_ended(safety_session)

        assert alert_route.called

    @respx.mock
    @pytest.mark.asyncio
    async def test_non_safety_does_not_send_alert(self, completed_session, monkeypatch):
        monkeypatch.setenv("DASHBOARD_WEBHOOK_URL", "https://app.example.com/api/webhook/jobs")
        monkeypatch.setenv("DASHBOARD_WEBHOOK_SECRET", "test-secret")
        monkeypatch.setenv("DASHBOARD_USER_EMAIL", "owner@test.com")

        respx.post("https://app.example.com/api/webhook/jobs").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        respx.post("https://app.example.com/api/webhook/calls").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        alert_route = respx.post("https://app.example.com/api/webhook/emergency-alerts").mock(
            return_value=httpx.Response(200, json={"success": True})
        )

        await handle_call_ended(completed_session)

        assert not alert_route.called

    @respx.mock
    @pytest.mark.asyncio
    async def test_survives_webhook_failure(self, completed_session, monkeypatch):
        monkeypatch.setenv("DASHBOARD_WEBHOOK_URL", "https://app.example.com/api/webhook/jobs")
        monkeypatch.setenv("DASHBOARD_WEBHOOK_SECRET", "test-secret")
        monkeypatch.setenv("DASHBOARD_USER_EMAIL", "owner@test.com")

        respx.post("https://app.example.com/api/webhook/jobs").mock(
            return_value=httpx.Response(500)
        )
        respx.post("https://app.example.com/api/webhook/calls").mock(
            return_value=httpx.Response(500)
        )

        # Should not raise
        await handle_call_ended(completed_session)
```

**Step 2: Run tests to verify they fail**

Run: `cd pipecat-agent && .venv/bin/python -m pytest tests/test_post_call.py -v`
Expected: FAIL — module not found

**Step 3: Implement post_call.py**

```python
# pipecat-agent/src/calllock/post_call.py
import os
import time
import logging
from datetime import datetime, timezone

from calllock.session import CallSession
from calllock.states import State
from calllock.transcript import to_plain_text, to_json_array
from calllock.classification import classify_tags, detect_priority, estimate_revenue_tier
from calllock.dashboard_sync import DashboardClient

logger = logging.getLogger(__name__)


def _derive_end_call_reason(session: CallSession) -> str:
    """Map final session state to an end_call_reason string."""
    if session.state == State.SAFETY_EXIT:
        return "safety_emergency"
    if session.state == State.DONE and session.booking_confirmed:
        return "completed"
    if session.state == State.CALLBACK:
        if session.lead_type == "high_ticket":
            return "sales_lead"
        return "callback_later"
    return "customer_hangup"


def _derive_booking_status(session: CallSession) -> str:
    """Derive booking_status from session state."""
    if session.booking_confirmed:
        return "confirmed"
    if session.state == State.CALLBACK and session.caller_confirmed:
        return "attempted_failed"
    return "not_requested"


def build_job_payload(session: CallSession, end_time: float, user_email: str) -> dict:
    """Build the full dashboard job/lead payload from session + classification."""
    transcript_text = to_plain_text(session.transcript_log)
    transcript_obj = to_json_array(session.transcript_log)

    tags = classify_tags(session, transcript_text)
    priority = detect_priority(tags, _derive_booking_status(session))
    revenue = estimate_revenue_tier(session.problem_description, tags.get("REVENUE", []))

    duration = int(end_time - session.start_time) if session.start_time > 0 else 0

    payload = {
        # Required
        "customer_name": session.customer_name or "Unknown Caller",
        "customer_phone": session.phone_number,
        "customer_address": session.service_address,
        "service_type": "hvac",
        "urgency": session.urgency_tier,
        "user_email": user_email,

        # Call tracking
        "call_id": session.call_sid,

        # Transcript
        "call_transcript": transcript_text,
        "transcript_object": transcript_obj,

        # Booking
        "booking_status": _derive_booking_status(session),
        "end_call_reason": _derive_end_call_reason(session),
        "issue_description": session.problem_description,

        # Classification
        "tags": tags,
        "priority_color": priority["color"],
        "priority_reason": priority["reason"],
        "revenue_tier": revenue["tier"],
        "revenue_tier_label": revenue["tier_label"],
        "revenue_tier_signals": revenue["signals"],
        "revenue_confidence": revenue["confidence"],

        # Derived fields
        "caller_type": "residential",
        "primary_intent": "booking_request" if session.booking_confirmed else "new_lead",
        "work_type": "service",
    }

    # Conditional fields
    if session.booking_confirmed and session.booked_time:
        payload["scheduled_at"] = session.booked_time

    return payload


def build_call_payload(session: CallSession, end_time: float, user_email: str) -> dict:
    """Build the call record payload."""
    start_dt = datetime.fromtimestamp(session.start_time, tz=timezone.utc).isoformat() if session.start_time > 0 else ""
    end_dt = datetime.fromtimestamp(end_time, tz=timezone.utc).isoformat() if end_time > 0 else ""
    duration = int(end_time - session.start_time) if session.start_time > 0 else 0

    return {
        "call_id": session.call_sid,
        "phone_number": session.phone_number,
        "customer_name": session.customer_name,
        "user_email": user_email,
        "started_at": start_dt,
        "ended_at": end_dt,
        "duration_seconds": duration,
        "direction": "inbound",
        "outcome": _derive_end_call_reason(session),
        "urgency_tier": session.urgency_tier,
        "problem_description": session.problem_description,
        "booking_status": _derive_booking_status(session),
        "transcript_object": to_json_array(session.transcript_log),
    }


async def handle_call_ended(session: CallSession):
    """Post-call orchestrator. Called after the pipeline finishes."""
    webhook_url = os.getenv("DASHBOARD_WEBHOOK_URL", "")
    webhook_secret = os.getenv("DASHBOARD_WEBHOOK_SECRET", "")
    user_email = os.getenv("DASHBOARD_USER_EMAIL", "")

    if not webhook_url or not webhook_secret:
        logger.warning("Dashboard webhook not configured, skipping post-call sync")
        return

    end_time = time.time()
    dashboard = DashboardClient(webhook_url=webhook_url, webhook_secret=webhook_secret)

    # 1. Send job/lead
    job_payload = build_job_payload(session, end_time, user_email)
    job_result = await dashboard.send_job(job_payload)
    logger.info(f"Dashboard job sync: {job_result}")

    # 2. Send call record
    call_payload = build_call_payload(session, end_time, user_email)
    call_result = await dashboard.send_call(call_payload)
    logger.info(f"Dashboard call sync: {call_result}")

    # 3. Send emergency alert if safety exit
    if session.state == State.SAFETY_EXIT:
        alert_payload = {
            "call_id": session.call_sid,
            "phone_number": session.phone_number,
            "customer_name": session.customer_name,
            "customer_address": session.service_address,
            "problem_description": session.problem_description or "Safety emergency detected",
            "user_email": user_email,
            "sms_sent_at": datetime.now(timezone.utc).isoformat(),
            "callback_promised_minutes": 30,
        }
        alert_result = await dashboard.send_emergency_alert(alert_payload)
        logger.info(f"Dashboard emergency alert: {alert_result}")

    logger.info(f"Post-call complete for {session.call_sid}: state={session.state.value}, booking={session.booking_confirmed}")
```

**Step 4: Run tests to verify they pass**

Run: `cd pipecat-agent && .venv/bin/python -m pytest tests/test_post_call.py -v`
Expected: all PASS

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/post_call.py pipecat-agent/tests/test_post_call.py
git commit -m "feat: add post-call orchestrator with dashboard job/call/alert sync"
```

---

## Task 7: Wire Transcript Logging into Processor

**Files:**
- Modify: `pipecat-agent/src/calllock/processor.py`

The `StateMachineProcessor` already appends to `session.conversation_history` for user messages (line 64). We need to also log agent responses and tool invocations to `session.transcript_log`.

**Step 1: Modify processor.py**

Add transcript logging in three places:

1. **User transcriptions** — in `_handle_transcription`, after the existing `conversation_history.append`:

```python
        # Add to transcript log with timestamp
        import time
        self.session.transcript_log.append({
            "role": "user",
            "content": text,
            "timestamp": time.time(),
        })
```

2. **Tool invocations** — in `_execute_tool`, after the tool result is received:

```python
        self.session.transcript_log.append({
            "role": "tool",
            "name": tool,
            "result": result,
            "timestamp": time.time(),
        })
```

3. **Agent responses** — intercept `TextFrame` flowing upstream (assistant → context aggregator). Add to `process_frame`:

```python
        if isinstance(frame, TextFrame) and direction == FrameDirection.UPSTREAM:
            # Agent response flowing back — log it
            self.session.transcript_log.append({
                "role": "agent",
                "content": frame.text,
                "timestamp": time.time(),
            })
```

**Step 2: Add TextFrame import if not already present**

In the imports at top of `processor.py`, `TextFrame` is already imported (line 8).

**Step 3: Run existing tests to ensure nothing breaks**

Run: `cd pipecat-agent && .venv/bin/python -m pytest tests/ -v`
Expected: all existing tests PASS

**Step 4: Commit**

```bash
git add pipecat-agent/src/calllock/processor.py
git commit -m "feat: log user/agent/tool turns to session.transcript_log"
```

---

## Task 8: Wire Post-Call Handler into Pipeline

**Files:**
- Modify: `pipecat-agent/src/calllock/pipeline.py`
- Modify: `pipecat-agent/.env.example`

**Step 1: Modify pipeline.py**

Add three things:

1. **Import** `post_call` and `time`:

```python
import time
from calllock.post_call import handle_call_ended
```

2. **Set call metadata** on session after parsing Twilio handshake (after line 42):

```python
    session.call_sid = call_sid
    session.start_time = time.time()
```

3. **Call post-call handler** after `runner.run(task)` returns (replace line 122):

```python
    runner = PipelineRunner()
    await runner.run(task)

    # Post-call: classify and sync to dashboard
    try:
        await handle_call_ended(session)
    except Exception as e:
        logger.error(f"Post-call handler failed: {e}")

    logger.info(f"Call ended: {call_sid}")
```

**Step 2: Update .env.example**

Add to `pipecat-agent/.env.example`:

```bash
DASHBOARD_WEBHOOK_URL=https://app.calllock.co/api/webhook/jobs
DASHBOARD_WEBHOOK_SECRET=<shared-secret-from-V2>
DASHBOARD_USER_EMAIL=<business-owner-email>
```

**Step 3: Run all tests**

Run: `cd pipecat-agent && .venv/bin/python -m pytest tests/ -v`
Expected: all PASS

**Step 4: Commit**

```bash
git add pipecat-agent/src/calllock/pipeline.py pipecat-agent/.env.example
git commit -m "feat: wire post-call handler into pipeline after call ends"
```

---

## Task 9: Deploy and Set Secrets

**Step 1: Set new Fly.io secrets**

Get the values from the V2 Render environment (they use the same webhook secret):

```bash
cd pipecat-agent
fly secrets set \
  DASHBOARD_WEBHOOK_URL=https://app.calllock.co/api/webhook/jobs \
  DASHBOARD_WEBHOOK_SECRET=<value-from-V2-render> \
  DASHBOARD_USER_EMAIL=<business-owner-email> \
  --app calllock-voice
```

**Step 2: Deploy**

```bash
cd pipecat-agent && fly deploy --remote-only
```

**Step 3: Verify health**

```bash
curl https://calllock-voice.fly.dev/health
```
Expected: `ok`

**Step 4: Verify logs show post-call handler**

After making a test call, check logs:

```bash
fly logs --app calllock-voice --no-tail | grep "Post-call\|Dashboard"
```

Expected: lines showing "Dashboard job sync: {success: True}" and "Post-call complete"

**Step 5: Verify dashboard received the call**

Open `https://app.calllock.co` and check that:
- The call appears in the Calls tab
- A lead/job record appears in the ACTION or BOOKED tab
- Customer name, phone, and transcript are populated

**Step 6: Commit fly.toml if changed**

```bash
git add pipecat-agent/fly.toml
git commit -m "chore: deploy post-call pipeline to production"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Add call metadata fields to CallSession | session.py |
| 2 | Transcript serialization (TDD) | transcript.py |
| 3 | Taxonomy tag classification (TDD) | classification.py |
| 4 | Priority + revenue tier (TDD) | classification.py |
| 5 | Dashboard webhook client (TDD) | dashboard_sync.py |
| 6 | Post-call orchestrator (TDD) | post_call.py |
| 7 | Wire transcript logging into processor | processor.py |
| 8 | Wire post-call handler into pipeline | pipeline.py |
| 9 | Deploy + verify | fly.toml, .env |
