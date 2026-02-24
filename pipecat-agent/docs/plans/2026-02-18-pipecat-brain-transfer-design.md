# Pipecat Brain Transfer — Design Doc

**Date:** 2026-02-18
**Goal:** Transfer Retell v9-triage behavioral knowledge to Pipecat agent (2.5/10 → 6-7/10)
**Approach:** Prompt translation + tool fixes + validation alignment (Approach C)

---

## Problem

The Pipecat voice agent has solid infrastructure (deterministic state machine, circuit breakers, TTS fallback) but thin prompts (~50 lines total vs. Retell's ~930 lines across 18 patches). Result: agent fabricates bookings, gives wrong info, repeats questions, and tools fail.

## Scope

**In scope:**
- Align state machine from 10 → 15 states
- Port all Retell behavioral prompts (adapted for deterministic control)
- Fix tool integration (endpoint alignment, response parsing, missing tools)
- Strengthen validation (ZIP, name, address, high-ticket, safety retraction)
- Improve post-call data reconciliation

**Out of scope:**
- Voice UX (TTS tuning, latency, interruption sensitivity, backchannel)
- New features beyond Retell parity
- Dashboard changes
- Retell deprecation

---

## Section 1: State Machine Alignment

Add 5 states, rename 2, enrich all existing prompts.

| Retell State | Pipecat State | Action |
|-------------|---------------|--------|
| welcome | WELCOME | Enrich prompt |
| non_service | NON_SERVICE | **Add** |
| lookup | LOOKUP | Enrich prompt |
| follow_up | FOLLOW_UP | **Add** |
| manage_booking | MANAGE_BOOKING | **Add** |
| safety | SAFETY | Enrich prompt |
| safety_emergency | SAFETY_EXIT | Enrich prompt |
| service_area | SERVICE_AREA | Enrich prompt |
| discovery | DISCOVERY | Enrich prompt |
| urgency | URGENCY | **Add** (split from discovery) |
| urgency_callback | URGENCY_CALLBACK | **Add** |
| pre_confirm | PRE_CONFIRM | Rename from CONFIRM, enrich prompt |
| booking | BOOKING | Enrich prompt |
| booking_failed | BOOKING_FAILED | Split from CALLBACK |
| confirm | CONFIRM | Rename from DONE, enrich prompt |

### New Transition Map

```
WELCOME → {LOOKUP, NON_SERVICE, CALLBACK}
NON_SERVICE → {SAFETY, CALLBACK}
LOOKUP → {SAFETY, FOLLOW_UP, MANAGE_BOOKING}
FOLLOW_UP → {SAFETY, CALLBACK}
MANAGE_BOOKING → {CONFIRM, SAFETY, CALLBACK}
SAFETY → {SERVICE_AREA, SAFETY_EXIT}
SAFETY_EXIT → (terminal)
SERVICE_AREA → {DISCOVERY, CALLBACK}
DISCOVERY → {URGENCY}
URGENCY → {PRE_CONFIRM, URGENCY_CALLBACK}
URGENCY_CALLBACK → (terminal)
PRE_CONFIRM → {BOOKING, CALLBACK}
BOOKING → {CONFIRM, BOOKING_FAILED}
BOOKING_FAILED → (terminal)
CONFIRM → (terminal)
CALLBACK → (terminal, fallback from any state via turn limits)
```

---

## Section 2: Prompt Translation

### General Prompt (~250 words, injected on every LLM call)

Port from Retell's `general_prompt`:
- Persona: calm HVAC dispatcher, friendly/brisk/confident
- Cadence: ONE question at a time, max 2 sentences before a question
- Acknowledgments: 5 words or fewer, often skip entirely
- Tone matching: mirror caller's energy
- Active listening: paraphrase, don't parrot
- Words to avoid: "transition", process-narrating phrases
- Trust stance: "I'm the virtual receptionist for ACE Cooling"
- Booking firewall: never say booked/confirmed/scheduled without tool success
- Business info: $89 diagnostic (credited on repair), 787 ZIP, 7-day scheduling

### Per-State Prompts (~60-250 words each)

Each state prompt contains:
1. **Job** — 1-2 sentences: what this state does
2. **How to respond** — specific phrasing for each scenario
3. **Rules** — 3-5 critical behavioral rules

Strip from Retell prompts:
- Transition instructions (state machine handles)
- Tool availability rules (state machine handles)
- Edge parameter specs (CallSession handles)
- Loop detection (MAX_TURNS_PER_STATE handles)

### Context Window (injected dynamically)

```
Caller's name: {session.customer_name}
Issue: {session.problem_description}
Address: {session.service_address}
ZIP: {session.zip_code}
Appointment status: {session.has_appointment}
Preferred time: {session.preferred_time}
Lead type: {session.lead_type}
Caller known: {session.caller_known}
```

---

## Section 3: Tool Integration Fixes

### Endpoint Audit

| Tool | Current Pipecat URL | Correct URL | Fix |
|------|-------------------|-------------|-----|
| lookup_caller | `/webhook/retell/lookup_caller` | `/webhook/retell/lookup_caller` | Verify response field parsing |
| book_service | `/webhook/retell/book_appointment` | **TBD — audit dashboard vs V2 endpoint** | Align with Retell's target |
| create_callback | `/webhook/retell/create_callback` | `/webhook/retell/create_callback` | Add callback_type param |
| send_sales_lead_alert | `/webhook/retell/send_sales_lead_alert` | `/webhook/retell/send_sales_lead_alert` | Wire to URGENCY_CALLBACK state |
| manage_appointment | **Missing** | `/webhook/retell/manage_appointment` | **Add to V2Client** |

### Tool Result → CallSession Mapping

```
lookup_caller:
  found → caller_known
  customerName → customer_name
  zipCode → zip_code
  address → service_address
  upcoming_appointment → has_appointment + appointment details
  callbackPromise → callback_promise

book_service:
  booking_confirmed → booking_confirmed
  appointment_time → booked_time
  appointmentId → appointment_id
  available_slots → offer alternatives (state machine handles retry)
  existing_appointment → route to MANAGE_BOOKING or force_book

create_callback:
  success → callback_created

manage_appointment:
  success + action_taken → update session per action type
```

### Authentication

Pipecat uses `X-API-Key` header. Retell webhook routes accept both `X-Retell-Signature` and `X-API-Key` (combined auth middleware). Pipecat's approach works — no change needed.

---

## Section 4: Validation & Extraction

### Validation Strengthening

| Check | Current | Target |
|-------|---------|--------|
| ZIP | Regex 787xx | Exactly 5 digits, starts with 787. "787" alone is invalid |
| Name | Basic | Reject: phone numbers, {{...}}, TBD, N/A, Not provided, unknown, empty |
| Address | Basic | Reject: TBD, empty, Not provided, contains word "or" (garbled) |
| High-ticket | Positive keywords only | Add negative list: broken, not working, cover, noise, leak, stopped, won't turn on |
| Safety | Keyword match | Add retraction detection: "yes but never mind" = NOT emergency |
| Problem desc | Pass-through | If < 30 chars, prefer post-call summary |

### Post-Call Data Reconciliation (3-Source Priority)

1. CallSession fields (from during-call tools) — highest priority
2. Background extraction (GPT-4o-mini) — fill gaps only
3. Transcript regex — last resort

### Extraction Improvements

- Filter agent utterances before name regex ("my name is" from greeting shouldn't match)
- Duration categorization: <24h=acute, 1-7d=recent, >7d=ongoing
- Only update empty fields (already implemented)

---

## Section 5: Scope Boundaries

### Not Doing

- TTS voice selection/tuning
- Latency optimization
- Per-state interruption sensitivity
- Backchannel implementation
- Speak-during-execution
- V3 backend
- New features beyond Retell parity
- Dashboard changes
- Retell deprecation

### Success Criteria

A Pipecat call should:
1. Complete all 6 flows (new caller, non-service, high-ticket, follow-up, manage booking, safety emergency)
2. Collect name + problem + address without re-asking known data
3. Book appointments when caller approves
4. Never fabricate booking confirmations
5. Create callbacks on booking failure or caller request
6. Send correct dashboard payloads (job + call webhooks)
7. Handle returning callers with pre-filled data

### Verification

Run 21 test scenarios from `voice-agent/TEST-SCENARIOS.md` against Pipecat agent.

---

## Implementation Order

1. **State machine** — Add 5 states, rename 2, update transition map
2. **Prompts** — Port general prompt + all 15 state prompts
3. **Tools** — Add manage_appointment, fix book_service endpoint, add callback_type
4. **Validation** — Strengthen all 6 validators
5. **Extraction** — Agent utterance filter, duration categorization, 3-source reconciliation
6. **Testing** — Run 21 scenarios, fix regressions

Estimated effort: 2-3 days.
