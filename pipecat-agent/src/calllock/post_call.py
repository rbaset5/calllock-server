import json
import os
import time
import logging
from datetime import datetime, timezone

from calllock.session import CallSession
from calllock.states import State
from calllock.transcript import to_plain_text, to_json_array, to_timestamped_dump
from calllock.classification import classify_tags, detect_priority, estimate_revenue_tier
from calllock.dashboard_sync import DashboardClient

logger = logging.getLogger(__name__)

# Dashboard expects: low | medium | high | emergency
# Pipecat internal: routine | low | medium | high | emergency
_URGENCY_MAP = {
    "routine": "low",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "urgent": "high",
    "emergency": "emergency",
}


def _map_urgency(internal: str) -> str:
    """Map Pipecat internal urgency to dashboard enum."""
    return _URGENCY_MAP.get(internal, "low")


def _derive_end_call_reason(session: CallSession) -> str:
    """Map final session state to an end_call_reason string."""
    if session.state == State.SAFETY_EXIT:
        return "safety_emergency"
    if session.state == State.CONFIRM and session.booking_confirmed:
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
    if session.booking_attempted:
        return "attempted_failed"
    return "not_requested"


def build_job_payload(session: CallSession, end_time: float, user_email: str) -> dict:
    """Build the full dashboard job/lead payload from session + classification."""
    transcript_text = to_plain_text(session.transcript_log)
    transcript_obj = to_json_array(session.transcript_log)

    tags = classify_tags(session, transcript_text)
    priority = detect_priority(tags, _derive_booking_status(session))
    revenue = estimate_revenue_tier(session.problem_description, tags.get("REVENUE", []))

    payload = {
        # Required
        "customer_name": session.customer_name or "Unknown Caller",
        "customer_phone": session.phone_number or "unknown",
        "customer_address": session.service_address,
        "service_type": "hvac",
        "urgency": _map_urgency(session.urgency_tier),
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


def build_call_payload(session: CallSession, end_time: float, user_email: str, lead_id: str | None = None, job_id: str | None = None) -> dict:
    """Build the call record payload."""
    now_dt = datetime.now(timezone.utc).isoformat()
    start_dt = datetime.fromtimestamp(session.start_time, tz=timezone.utc).isoformat() if session.start_time > 0 else now_dt
    end_dt = datetime.fromtimestamp(end_time, tz=timezone.utc).isoformat() if end_time > 0 else now_dt
    duration = int(end_time - session.start_time) if session.start_time > 0 else 0

    payload = {
        "call_id": session.call_sid,
        "phone_number": session.phone_number or "unknown",
        "customer_name": session.customer_name,
        "user_email": user_email,
        "started_at": start_dt,
        "ended_at": end_dt,
        "duration_seconds": duration,
        "direction": "inbound",
        "outcome": _derive_end_call_reason(session),
        "urgency_tier": _map_urgency(session.urgency_tier),
        "problem_description": session.problem_description,
        "booking_status": _derive_booking_status(session),
        "transcript_object": [
            e for e in to_json_array(session.transcript_log)
            if e.get("role") in ("agent", "user")
        ],
    }
    if lead_id:
        payload["lead_id"] = lead_id
    if job_id:
        payload["job_id"] = job_id
    return payload


def chunk_transcript_dump(dump: dict, max_bytes: int = 3500) -> list[str]:
    """Split a transcript dump into chunks that fit within log line limits.

    Each chunk is a string: TRANSCRIPT_DUMP|N/M|{json}
    The first chunk contains header fields + as many entries as fit.
    Subsequent chunks contain only entries.
    """
    header = {k: v for k, v in dump.items() if k != "entries"}
    entries = dump.get("entries", [])

    if not entries:
        payload = json.dumps({**header, "entries": []})
        return [f"TRANSCRIPT_DUMP|1/1|{payload}"]

    chunks_entries: list[list[dict]] = []
    current_chunk: list[dict] = []
    # Reserve space for header in first chunk
    current_size = len(json.dumps({**header, "entries": []}).encode("utf-8"))
    is_first = True

    for entry in entries:
        entry_json = json.dumps(entry)
        entry_size = len(entry_json.encode("utf-8")) + 2  # comma + bracket overhead

        if current_chunk and (current_size + entry_size) > max_bytes:
            chunks_entries.append(current_chunk)
            current_chunk = []
            current_size = len(json.dumps({"entries": []}).encode("utf-8"))
            is_first = False

        current_chunk.append(entry)
        current_size += entry_size

    if current_chunk:
        chunks_entries.append(current_chunk)

    total = len(chunks_entries)
    result = []
    for i, chunk_entries in enumerate(chunks_entries):
        if i == 0:
            payload = json.dumps({**header, "entries": chunk_entries})
        else:
            payload = json.dumps({"entries": chunk_entries})
        result.append(f"TRANSCRIPT_DUMP|{i + 1}/{total}|{payload}")

    return result


async def handle_call_ended(session: CallSession):
    """Post-call orchestrator. Called after the pipeline finishes."""
    jobs_url = os.getenv("DASHBOARD_JOBS_URL", "")
    calls_url = os.getenv("DASHBOARD_CALLS_URL", "")
    alerts_url = os.getenv("DASHBOARD_ALERTS_URL", "")
    webhook_secret = os.getenv("DASHBOARD_WEBHOOK_SECRET", "")
    user_email = os.getenv("DASHBOARD_USER_EMAIL", "")

    if not jobs_url or not webhook_secret:
        logger.warning("Dashboard webhook not configured, skipping post-call sync")
        return

    end_time = time.time()
    dashboard = DashboardClient(
        jobs_url=jobs_url,
        calls_url=calls_url,
        alerts_url=alerts_url,
        webhook_secret=webhook_secret,
    )

    # 1. Send job/lead
    job_payload = build_job_payload(session, end_time, user_email)
    job_result = await dashboard.send_job(job_payload)
    logger.info(f"Dashboard job sync: {job_result}")

    # Extract lead_id and job_id for call linking
    lead_id = job_result.get("lead_id") if isinstance(job_result, dict) else None
    job_id = job_result.get("job_id") if isinstance(job_result, dict) else None

    # 2. Send call record (linked to lead and job)
    call_payload = build_call_payload(session, end_time, user_email, lead_id=lead_id, job_id=job_id)
    call_result = await dashboard.send_call(call_payload)
    logger.info(f"Dashboard call sync: {call_result}")

    # 3. Send emergency alert if safety exit
    if session.state == State.SAFETY_EXIT:
        alert_payload = {
            "call_id": session.call_sid,
            "phone_number": session.phone_number or "unknown",
            "customer_name": session.customer_name,
            "customer_address": session.service_address,
            "problem_description": session.problem_description or "Safety emergency detected",
            "user_email": user_email,
            "sms_sent_at": datetime.now(timezone.utc).isoformat(),
            "callback_promised_minutes": 30,
        }
        alert_result = await dashboard.send_emergency_alert(alert_payload)
        logger.info(f"Dashboard emergency alert: {alert_result}")

    # 4. Emit structured transcript dump for CLI retrieval
    end_duration = round(end_time - session.start_time, 1) if session.start_time > 0 else 0
    dump = to_timestamped_dump(
        session.transcript_log,
        start_time=session.start_time,
        call_sid=session.call_sid,
        phone=session.phone_number,
        final_state=session.state.value,
    )
    dump["duration_s"] = end_duration
    for line in chunk_transcript_dump(dump):
        logger.info(line)

    logger.info(f"Post-call complete for {session.call_sid}: state={session.state.value}, booking={session.booking_confirmed}")
