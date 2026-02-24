# Call Audit Fix Design: ZIP Race Condition + 4 Related Bugs

**Date:** 2026-02-23
**Trigger:** Call audit of Jonas call CA1fd951b84d358e00b0fe7cc9464430ba
**Branch:** `rbaset5/urgency-state-fixes`

## Problem Summary

Jonas called with a valid AC service request in ZIP 78701 (Austin service area). The call routed to CALLBACK without ever reaching DISCOVERY, URGENCY, PRE_CONFIRM, or BOOKING. Root cause: background LLM extraction set `session.zip_code` to "78001" (wrong) from fragmented speech before the caller clarified "78701". The handler's `if not session.zip_code:` guard prevented the correct ZIP from being extracted.

Five bugs identified:

1. **CRITICAL** — ZIP extraction race condition (extraction overwrites handler-owned field)
2. **CRITICAL** — LLM ignores CALLBACK system prompt (generates booking language in terminal state)
3. **MODERATE** — Safety `"no"` substring match (`"no" in "not"` evaluates True)
4. **MODERATE** — `validate_address` accepts "7801" (pure digits, not a real address)
5. **MODERATE** — Call record not linked to lead (lead_id missing from call payload)

## Approach: Surgical Fixes + Extraction Firewall

Fix each bug at its location. Additionally, partition session fields into handler-owned (deterministic) vs extraction-owned (soft) to prevent the race condition class.

---

## Fix 1: Extraction Firewall

### Rationale

Background LLM extraction runs asynchronously and can set session fields that conflict with deterministic handler logic. The design philosophy is "code controls flow, LLM generates words." ZIP parsing is a deterministic problem — there's no reason to let GPT-4o-mini guess at it.

### Field Partitioning

| Category | Fields | Set By |
|----------|--------|--------|
| **Handler-owned** | `zip_code`, `service_address`, `customer_name` | State machine handlers + `_tool_result_lookup_caller` |
| **Extraction-owned** | `problem_description`, `equipment_type`, `problem_duration`, `preferred_time` | Background LLM extraction |

### Changes

**`processor.py:_run_extraction()`** — Remove the `zip_code`, `service_address`, and `customer_name` update blocks. Keep `problem_description`, `equipment_type`, `problem_duration`, `preferred_time`.

**Why remove `customer_name`:** lookup_caller already returns it for known callers. For unknown callers, DISCOVERY collects it explicitly. Extraction is redundant and has a documented bug class (extracting names from agent speech).

---

## Fix 2: Terminal State Canned Responses

### Rationale

In terminal states, the LLM can ignore its system prompt and generate responses that contradict the call flow. The conversation context overwhelms the system prompt instruction.

### Three-Layer Defense

**Layer 1 — Canned scripts:**

```
CALLBACK: "I'll have someone from the team call you back within the hour.
           Is this the best number to reach you?"
BOOKING_FAILED: "I wasn't able to lock in that time.
                 Let me have someone call you back to get you scheduled."
SAFETY_EXIT: "This is a safety emergency. Leave the house right now
              and call 911 from outside."
CONFIRM: (dynamic — includes booked_time)
URGENCY_CALLBACK: (dynamic — varies by lead_type)
```

**Layer 2 — One scoped LLM reply:**

New session field: `terminal_reply_used: bool = False`

Flow:
1. First user utterance in terminal state: if `not terminal_reply_used`, generate ONE LLM response using a scoped prompt
2. Set `terminal_reply_used = True`
3. Every subsequent utterance: deliver canned script + `end_call=True`

Scoped prompt (not the full agent persona):
```
You are briefly answering a question during a call wrap-up for ACE Cooling.
Answer in one sentence maximum.
NEVER mention scheduling, appointments, availability, booking, or next steps.
NEVER offer to help with their service issue.
```

**Layer 3 — Post-generation booking filter:**

Before delivering the LLM reply, check for booking language:
```python
BOOKING_LANGUAGE = {"appointment", "schedule", "book", "tech out",
                    "available", "slot", "open"}
```
If any match (word-boundary), discard and serve canned script.

### Changes

- `session.py`: Add `terminal_reply_used: bool = False`
- `processor.py`: New `_handle_terminal_response()` method
- `state_machine.py`: Add `TERMINAL_SCRIPTS` dict

---

## Fix 3: Word-Boundary Keyword Matching

### Rationale

`keyword in lower` does substring matching. `"no"` matches inside `"not"`, `"noticed"`, `"know"`. This is a latent bug across all handlers.

### Changes

**`validation.py`** — Add shared helper:
```python
def match_any_keyword(text: str, keywords: set[str]) -> bool:
    lower = text.lower()
    return any(re.search(rf'\b{re.escape(kw)}\b', lower) for kw in keywords)
```

**Apply to all keyword checks:**
- `_handle_safety` no_signals
- `_handle_non_service` schedule_signals
- `_handle_follow_up` new_issue_signals, schedule_signals
- `_handle_manage_booking` new_issue_signals
- `_handle_urgency` urgent_signals, routine_signals, time_patterns
- `_handle_pre_confirm` yes_signals
- `detect_callback_request`, `detect_safety_emergency`, `detect_high_ticket`, `detect_property_manager`

---

## Fix 4: Address Validation

### Rationale

`validate_address("7801")` returns "7801" (truthy). This is a backstop — the extraction firewall (Fix 1) is the primary defense against ZIP fragments landing in the address field.

### Changes

**`validation.py:validate_address()`** — Add two checks:
- Must contain at least one letter character (rejects "7801", "78001")
- Must be at least 5 characters (rejects "Oak", "Elm")

---

## Fix 5: Call-Lead Linking

### Rationale

Post-call sync creates the lead (gets back `lead_id`), then creates the call record separately without linking them.

### Changes

**`post_call.py:handle_call_ended()`:**
1. After `dashboard.send_job()` returns, extract `lead_id` from response
2. Pass `lead_id` into `build_call_payload()` as new optional parameter
3. Include `lead_id` in the call payload sent to dashboard

---

## Testing Strategy

Each fix requires:
1. A failing test that reproduces the exact bug
2. The fix
3. The test passing

Additional regression tests:
- ZIP extraction race: simulate extraction setting wrong ZIP before handler processes correct ZIP
- Terminal canned response: verify LLM is never called for second+ utterances in terminal states
- Word boundary: "It's not working" should NOT match "no" signal; "no" alone should match
- Address validation: "7801" rejected, "123 Main St" accepted, "Oak" rejected
- Call-lead linking: verify lead_id present in call payload after job sync
