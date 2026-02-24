# Pipecat Post-Call Pipeline Design

> **Goal:** Make Pipecat a full Retell replacement by adding post-call data processing and dashboard sync. After this work, turning off Retell means zero loss of dashboard functionality.

## Architecture

Today's call lifecycle ends abruptly:

```
Call starts → StateMachine drives conversation → EndFrame → logger.info("Call ended") → gone
```

The new lifecycle adds a post-call phase:

```
Call starts → StateMachine drives conversation → EndFrame → Post-Call Handler
                                                                ↓
                                                        Build transcript
                                                        Classify (tags, priority, revenue)
                                                        Build dashboard payload
                                                        POST /api/webhook/jobs
                                                        POST /api/webhook/calls
                                                        POST /api/webhook/emergency-alerts (if safety)
```

The post-call handler runs after `runner.run(task)` returns in `pipeline.py`. It receives the in-memory `CallSession` — which already has all the structured data — serializes it, classifies it, and fires the dashboard webhooks. No Supabase client needed in Pipecat; the dashboard handles persistence when it receives the webhook.

**Key insight:** CallSession is the single source of truth. V2 had to reconstruct call data from transcripts using 7 layers of extraction. Pipecat's state machine already collected the structured data during the call. No extraction needed.

## New Modules

| Module | Purpose | ~Lines |
|--------|---------|--------|
| `post_call.py` | Orchestrates post-call: transcript, classify, build payload, send | ~150 |
| `classification.py` | 117-tag taxonomy + priority detection + revenue tier | ~350 |
| `dashboard_sync.py` | HTTP client for 3 dashboard webhook endpoints with HMAC signing | ~150 |
| `transcript.py` | Serialize conversation history to string + JSON array formats | ~80 |

Plus modifications to `pipeline.py` and `processor.py` to capture transcript data during the call and trigger post-call on disconnect.

## Transcript Capture

During the call, `StateMachineProcessor` accumulates a parallel transcript log as a simple list of `{role, content, timestamp}` dicts. Every user transcription and assistant response gets appended. Tool invocations are also captured as entries (e.g., `{"role": "tool", "name": "book_service", "result": {...}}`).

At call end, `transcript.py` converts this to two formats:

1. **Plain text string** — `"Agent: Thanks for calling ACE Cooling...\nCaller: My AC is broken...\n"`
2. **JSON array** — `[{"role": "agent", "content": "...", "timestamp": "..."}, ...]`

**CallSession additions:**
- `call_sid: str` — Twilio call ID (set at pipeline start)
- `start_time: float` — `time.time()` at pipeline start
- `transcript_log: list[dict]` — accumulated during call

## Classification

Three responsibilities, all keyword-based from CallSession fields + transcript.

### Taxonomy Tags (117 tags, 9 categories)

Most tags are direct lookups from data the state machine already classified:

- `session.state == SAFETY_EXIT` → `HAZARD:gas_leak` or `HAZARD:co_detected` (based on transcript keywords)
- `session.urgency_tier == "emergency"` → `URGENCY:emergency`
- `detect_high_ticket(session.problem_description)` → `REVENUE:hot_lead`
- `session.caller_known == False` → `CUSTOMER:new_customer`
- `classify_intent() == "non_service"` → `NON_CUSTOMER:vendor_sales` or similar

Builds on existing functions in `validation.py`.

### Priority Detection

Maps state + tags → priority color:

| Priority | Condition |
|----------|-----------|
| RED | Any HAZARD tag present |
| ORANGE | RECOVERY tags (callback risk, complaint) or URGENCY:emergency |
| YELLOW | REVENUE:hot_lead or booking_status == "attempted_failed" |
| BLUE | Everything else (standard service call) |

### Revenue Tier Estimation

Derived from problem description + tags:

| Tier | Label | Signals |
|------|-------|---------|
| replacement | $$$$$ | "new system", "replacement", "install" |
| major_repair | $$$$ | "compressor", "coil", "refrigerant" |
| standard_repair | $$$ | general repair requests |
| minor | $$ | "thermostat", "filter", "noise" |
| diagnostic | $ | "diagnostic", "check", "inspection" |

## Dashboard Sync

`dashboard_sync.py` handles HTTP calls to the dashboard. Three endpoints, one client.

**HMAC Signing:** Every request includes `X-Webhook-Signature` header — HMAC-SHA256 of the JSON body using `DASHBOARD_WEBHOOK_SECRET`. Matches V2's existing scheme.

### Endpoint 1: Job Sync

`POST /api/webhook/jobs` — 40+ field payload from CallSession + classification. Deduplicated by `call_id`. Creates/updates lead record in ACTION or BOOKED tabs.

### Endpoint 2: Call Sync

`POST /api/webhook/calls` — Call history: call_id, phone, duration, transcript, timestamps, booking_status. Fire-and-forget with error logging.

### Endpoint 3: Emergency Alert

`POST /api/webhook/emergency-alerts` — Only fires when `session.state == SAFETY_EXIT`. Contains caller phone, safety keywords, transcript excerpt.

### Environment Variables

- `DASHBOARD_WEBHOOK_URL` — base URL (set on Fly.io)
- `DASHBOARD_WEBHOOK_SECRET` — shared HMAC secret (same value V2 uses)

### Error Handling

Log failures but don't retry. The call is already over. Dashboard can reconcile missing calls later.

## Post-Call Orchestrator

`post_call.py` is the single async function called when a call ends:

```python
async def handle_call_ended(session: CallSession, context: OpenAILLMContext):
    1. Build transcript (transcript.py)
    2. Classify call (classification.py) → tags, priority, revenue_tier
    3. Build dashboard job payload (merge session fields + classification + transcript)
    4. Send job to dashboard (dashboard_sync.py)
    5. Send call record to dashboard
    6. If safety_exit: send emergency alert
    7. Log summary
```

**Trigger point:** After `await runner.run(task)` returns in `pipeline.py`:

```python
runner = PipelineRunner()
await runner.run(task)
await handle_call_ended(session, context)
```

`runner.run()` blocks until the call ends. Session and context are still in scope. No event handler wiring needed.

**Payload construction** lives here — `build_job_payload()` maps CallSession + classification to the 40+ field dict. Fields the state machine didn't collect get sensible defaults (empty strings, not nulls).

## Testing Strategy

### Unit Tests (new)

| Test file | Covers |
|-----------|--------|
| `test_transcript.py` | Serialization to plain text + JSON array, tool invocations, empty history |
| `test_classification.py` | Tag assignment for 9 categories, priority color mapping, revenue tier |
| `test_dashboard_sync.py` | HMAC signature, payload schema, HTTP error handling |
| `test_post_call.py` | Orchestrator order, safety_exit triggers alert, non-safety doesn't |

All HTTP calls mocked with `respx`.

### Integration Testing

Task 10 E2E test calls from the original plan. Call the number, verify the call appears in the dashboard. The 3 scripted scenarios now also validate dashboard records.

### Out of Scope

- Dashboard webhook endpoint testing (dashboard's responsibility)
- Twilio transport behavior (Pipecat's domain)
- Classification accuracy tuning (post-launch)

~200 lines of new tests total.
