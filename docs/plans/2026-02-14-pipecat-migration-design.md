# Pipecat Migration: Own the Voice Stack

**Date:** 2026-02-14
**Status:** Approved
**Approach:** Replace Retell AI with Pipecat-based pipeline. Deterministic state machine. LLM generates words only.

---

## Architecture Decision Record

### Context

CallLock's voice agent on Retell AI has gone through 18 reactive patches in 5 days. Every bug follows the same pattern: the LLM made a decision it shouldn't have been allowed to make.

- Prompt-based guards: **0% success rate** (Patches #5, #6, #10, #13, #17)
- Structural fixes (removing tools): **100% success rate** (Patches #7, #15, #18)
- v10 design principle: "States that decide have no tools. States that take actions have specific tools."

This principle is a workaround for Retell's architecture, where the LLM always drives state transitions. The workaround has limits — the LLM still controls conversation flow, can fabricate data, and can stall in states.

Two blog posts (MostlyLucid, "Ten Commandments of LLM Use" and "Building Voice Forms with Blazor and Local LLMs") describe an emerging architecture where deterministic code controls all flow and the LLM is restricted to text generation and data extraction. CallLock's own patch history independently validates every principle in those posts.

### Decision

Migrate to a self-owned voice pipeline using Pipecat (open-source framework) with deterministic state machine control. The LLM generates conversational text only — it never triggers tools, transitions states, or ends calls.

### Rationale

1. **Reliability** — 18 patches prove prompt-based guards don't work. Deterministic code eliminates the entire bug class.
2. **Testability** — State machine logic becomes unit-testable. Current setup requires manual phone calls for every change.
3. **Platform independence** — Each component (STT, LLM, TTS, telephony) is independently swappable.
4. **Cost trajectory** — ~$0.14/min at launch (break-even with Retell), ~$0.07/min after TTS optimization (50% cheaper).
5. **Architectural alignment** — The v10 principle ("no tools in decision states") becomes the default, not a workaround.

### Consequences

- ~4 weeks engineering effort
- Must solve latency (<500ms), turn-taking, and echo cancellation (Pipecat handles these)
- Retell subscription can be cancelled after migration
- Operational knowledge from 18 patches transfers directly to new state machine

---

## Architecture Overview

### Core Principle

**Code controls flow. LLM generates words. Validation gates every side-effect.**

```
                         PIPECAT PIPELINE (Python, Fly.io)
                         +------------------------------------------+
                         |                                          |
Phone Call -> Twilio ----+-> Deepgram STT (streaming audio -> text) |
                         |       |                                  |
                         |  State Machine (deterministic Python)    |
                         |       |              ^                   |
                         |  LLM (GPT-4o)    Extraction +            |
                         |  "generate reply"  Validation            |
                         |       |                                  |
                         |  TTS (ElevenLabs, streaming WebSocket)   |
                         |       |                                  |
                         +-> Audio back to caller ------------------+
                         |
                         |  Side-effects (deterministic only):
                         |    -> lookup_caller (HTTP to V2 backend)
                         |    -> book_service (HTTP to dashboard)
                         |    -> create_callback (HTTP to V2 backend)
                         |    -> end_call (Twilio hangup)
                         +------------------------------------------+
```

### What Changes vs. Retell

| Concern | Retell (today) | Pipecat (target) |
|---|---|---|
| State transitions | LLM calls edge tools (probabilistic) | Code advances state (deterministic) |
| Tool invocations | LLM calls tools when it wants | Code calls tools when state machine says to |
| Data extraction | LLM self-reports via dynamic variables | Separate extraction call + code validation |
| Turn-taking | Retell platform | Pipecat VAD (Voice Activity Detection) |
| Call lifecycle | Retell manages | Twilio + Pipecat manage |
| Configuration | 500-line JSON blob on Retell | Python code, testable, version-controlled |

### What Stays the Same

- The 10-state flow from v10
- The conversational persona (Calm HVAC Dispatcher)
- All backend integrations (Cal.com, Supabase, SMS)
- The golden rules and business logic
- V2 backend (Node.js, Render) — called via HTTP from Pipecat

---

## Component Selection

| Layer | Provider | Why | Swap candidate |
|---|---|---|---|
| Telephony | Twilio Programmable Voice | Industry standard, WebSocket streaming | Vonage, Telnyx |
| STT | Deepgram Nova-3 | $0.008/min, streaming, lowest latency | Whisper (self-hosted) |
| LLM | GPT-4o | Already tuned for CallLock, strong instruction following | Claude Sonnet, GPT-4o-mini |
| TTS | ElevenLabs (default) | Preserves current voice quality, voice cloning option | Cartesia Sonic ($0.02/min), Deepgram Aura-2 ($0.015/min) |
| Framework | Pipecat (open source, Python) | Handles pipeline, VAD, turn-taking, audio streaming | LiveKit Agents |
| Hosting | Fly.io or Railway | Low-latency edge deployment, WebSocket support | AWS ECS |

### Cost Per Minute

| Stack | STT | LLM | TTS | Telephony | Compute | Total/min |
|---|---|---|---|---|---|---|
| Retell (current) | incl | incl | incl | incl | incl | $0.13-0.18 |
| Pipecat + ElevenLabs | $0.008 | $0.03 | $0.08-0.10 | $0.009 | $0.005 | ~$0.14 |
| Pipecat + Cartesia (future) | $0.008 | $0.03 | $0.02 | $0.009 | $0.005 | ~$0.07 |

Launch at break-even with ElevenLabs. A/B test cheaper TTS providers later.

### Why Pipecat

Pipecat solves the three hardest problems:

1. **Turn-taking / VAD** — Configurable sensitivity per state (maps to current `interruption_sensitivity`).
2. **Audio pipeline** — Streams between Twilio, STT, TTS without manual buffer management.
3. **Interruption handling** — Cancels current TTS when caller interrupts.

What Pipecat does NOT do (we build):
- State machine logic
- Business rules
- Tool integrations
- Data extraction + validation layer

### Backend Integration

Pipecat calls the existing V2 backend via HTTP. No backend rewrite needed.

```
Pipecat Pipeline (Python, Fly.io)     V2 Backend (Node.js, Render)
+----------------------------+        +----------------------------+
| State Machine              |--HTTP->| /webhook/retell/lookup     |
| Extraction + Validation    |--HTTP->| /webhook/retell/book       |
| LLM prompt management      |--HTTP->| /webhook/retell/callback   |
| Audio pipeline             |        | Post-call sync             |
+----------------------------+        +----------------------------+
```

---

## State Machine Design

### Three State Types

**Decision States** — LLM talks, code extracts data, code transitions:
1. Caller speaks, STT produces text
2. LLM generates conversational response (spoken to caller)
3. Extractor pulls structured fields from conversation history
4. Validator checks extracted fields deterministically
5. Code evaluates transition conditions
6. Code advances to next state

**Action States** — Code calls tool, LLM narrates result:
1. Code calls tool immediately (HTTP to V2 backend)
2. Tool returns result
3. LLM generates response incorporating result
4. Code transitions based on tool result

**Terminal States** — LLM says goodbye, code hangs up:
1. LLM generates closing message
2. Code triggers any final tools (create_callback, send_alert)
3. Code ends call via Twilio

### The 10 States

| State | Type | LLM Does | Code Does |
|---|---|---|---|
| welcome | Decision | Greets, listens | Classifies intent, routes |
| lookup | Action | "Pulling that up" | Calls lookup_caller, populates session |
| safety | Decision | Asks safety question | Evaluates answer, routes |
| safety_exit | Terminal | 911 instructions | Ends call |
| service_area | Decision | Confirms ZIP | Validates 5-digit + 787 prefix |
| discovery | Decision | Collects name, problem, address | Extracts + validates each field |
| confirm | Decision | Reads back summary, asks consent | Evaluates consent + urgency |
| booking | Action | "Let me check availability" | Calls book_service, evaluates result |
| done | Terminal | Confirms details | Ends call |
| callback | Terminal | Explains next steps | Calls create_callback + alert, ends call |

### Extraction + Validation Pattern

The key architectural difference from Retell. Instead of trusting LLM self-reported data, a separate extraction step pulls structured data and deterministic code validates it.

```python
# After each caller turn in DISCOVERY state:

# Step 1: LLM generates conversational response
response = await llm.generate(
    system=DISCOVERY_PROMPT,
    history=conversation_history
)
# -> "Sounds like the cooling isn't kicking in. And what's the address?"

# Step 2: Separate extraction call (cheap model)
extracted = await llm.extract(
    model="gpt-4o-mini",
    prompt="Extract: customer_name, problem_description, service_address",
    history=conversation_history,
    schema=DiscoverySchema  # JSON schema forces structured output
)
# -> {"customer_name": "Jonas", "problem_description": "AC blowing warm",
#     "service_address": "4210 South Lamar"}

# Step 3: Deterministic validation (code, not LLM)
if extracted.customer_name:
    if is_phone_number(extracted.customer_name):
        extracted.customer_name = ""
    if extracted.customer_name in SENTINEL_VALUES:
        extracted.customer_name = ""

if extracted.zip_code:
    if not re.match(r'^\d{5}$', extracted.zip_code):
        extracted.zip_code = ""
    if not extracted.zip_code.startswith('787'):
        session.state = State.CALLBACK  # Out of area

# Step 4: Deterministic transition
if all([session.customer_name, session.problem_description, session.service_address]):
    session.state = State.CONFIRM
# else: stay in DISCOVERY, LLM asks for missing field next turn
```

### Bug Classes Eliminated

| Bug (from optimization log) | Why structurally impossible |
|---|---|
| Fabricated ZIP "787" | `re.match(r'^\d{5}$')` rejects non-5-digit values |
| "Not provided" as real value | `SENTINEL_VALUES` check strips it |
| Phone number as customer name | `is_phone_number()` rejects it |
| Fabricated booking | Code calls book_service, not LLM |
| Premature hangup | Code calls end_call, only in terminal states |
| State collapse (60s in one state) | Code transitions when conditions met |
| Backward transition | Code only transitions forward |
| Skipped safety question | Code blocks advancement until validated yes/no |

### Session State

All state lives in a typed dataclass, external to the LLM. Only the extraction + validation layer can update fields.

```python
@dataclass
class CallSession:
    state: State = State.WELCOME
    phone_number: str = ""

    # From lookup (Action state)
    caller_known: bool = False
    customer_name: str = ""
    zip_code: str = ""
    service_address: str = ""
    has_appointment: bool = False

    # From discovery (Decision state, extracted + validated)
    problem_description: str = ""

    # From confirm (Decision state)
    preferred_time: str = ""
    urgency_tier: str = "routine"
    lead_type: str = ""
    caller_confirmed: bool = False

    # From booking (Action state)
    booking_confirmed: bool = False
    booked_time: str = ""

    # Metadata
    turn_count: int = 0
    state_turn_count: int = 0  # Resets on transition
```

---

## Migration Strategy

No existing customers. No callers to protect. Build directly and test yourself.

### Week 1: Skeleton Pipeline

**Goal:** Phone call comes in, caller hears a voice, call ends.

- Set up Pipecat project: Twilio + Deepgram STT + ElevenLabs TTS + GPT-4o
- Single state: welcome greeting, then end call
- Deploy to Fly.io on the production phone number
- Validate: latency <500ms, voice quality acceptable, no echo

**Done when:** You call the number, hear the greeting clearly, call ends cleanly.

### Weeks 2-3: Full State Machine + Backend

**Goal:** All 10 states working with real backend tools.

- Implement CallSession dataclass and StateMachine class
- Port all 10 state prompts from v10 config
- Implement extraction + validation layer
- Wire tool calls to V2 backend via HTTP
- Write unit tests for every state transition

**Unit tests (minimum):**
```
test_welcome_service_intent_routes_to_lookup
test_welcome_billing_intent_routes_to_callback
test_safety_emergency_yes_routes_to_safety_exit
test_safety_no_routes_to_service_area
test_service_area_invalid_zip_stays
test_service_area_out_of_area_routes_to_callback
test_discovery_all_fields_routes_to_confirm
test_discovery_phone_as_name_rejected
test_discovery_partial_zip_rejected
test_confirm_yes_routes_to_booking
test_confirm_callback_routes_to_callback
test_confirm_high_ticket_routes_to_callback_with_alert
test_booking_success_routes_to_done
test_booking_failure_routes_to_callback
test_done_ends_call
test_callback_fires_create_callback_then_ends
```

**Done when:** All unit tests pass. Full happy-path call works with real Cal.com booking.

### Week 4: Polish + Demo Ready

**Goal:** Reliable enough for investor demos and first customer calls.

- Run all 3 scripted scenarios (happy path, booking failure, non-service caller)
- Tune VAD / interruption sensitivity per state
- Tune LLM prompts for natural conversation
- Verify dashboard receives correct data
- Fix issues found in test calls

**Done when:** 5 consecutive happy-path calls succeed without manual intervention.

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Latency >500ms | Medium | High | Pipecat streams STT+TTS in parallel. ElevenLabs WebSocket with optimize_streaming_latency=3. Deepgram Nova-3 fastest STT. Fly.io edge deployment. Tested in Week 1 before investing further. |
| Turn-taking worse than Retell | Medium | Medium | Pipecat VAD configurable per state. Tune in Week 2-3. |
| V2 backend format mismatch | High | Low | Build clean Pipecat routes or add thin adapter. Fixable in hours. |
| Extraction accuracy concerns | Low | Medium | GPT-4o-mini with JSON schema is reliable. Deterministic validation catches errors. Net accuracy higher. |
| Engineering time overrun | Medium | Medium | Week 1 is the kill test. If latency fails, architecture doesn't work for phone calls. 1 week sunk cost max. |
| ElevenLabs voice difference | Low | Medium | Same API, same voice ID. Tested in Week 1. |

### Week 1 Kill Switch

If the skeleton pipeline can't hit <500ms latency or voice quality is unacceptable, stop. The architecture doesn't work for real-time phone calls and an alternative approach is needed. Maximum sunk cost: 1 week.

---

## Success Metrics

| Metric | Retell v10 (baseline) | Pipecat (target) |
|---|---|---|
| Demo booking success rate | ~60% | >95% |
| State transition bugs per week | ~2-3 | 0 (structurally impossible) |
| Unit test coverage on state logic | 0% | >90% |
| Silent failure rate | Unknown | 0% (every failure logged) |
| Cost per minute | $0.13-0.18 | $0.14 (launch), $0.07 (optimized) |
| Time to deploy a state change | ~30 min | ~5 min (edit, test, deploy) |

---

## References

- MostlyLucid, "Ten Commandments of LLM Use" — principles for deterministic + LLM cooperation
- MostlyLucid, "Building Voice Forms with Blazor and Local LLMs" — reference implementation
- CallLock v10 Simplification Design: `docs/plans/2026-02-14-state-machine-simplification-design.md`
- CallLock Optimization Log: `voice-agent/OPTIMIZATION-LOG.md` (18 patches, structural enforcement evidence)
- Pipecat Framework: https://github.com/pipecat-ai/pipecat
