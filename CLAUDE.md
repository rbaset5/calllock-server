# CallLock - AI Voice Receptionist Platform

## What It Does

CallLock is a missed call recovery service for trades businesses (HVAC, plumbing, electrical). When a customer calls and the business misses it, the call redirects to CallLock's AI receptionist, which handles the conversation, collects information, and books appointments — without human intervention.

## Why Pipecat (The Migration Story)

CallLock originally ran on Retell AI. After 18 reactive patches in 5 days, a pattern emerged:

- **Prompt-based guards: 0% success rate** — telling the LLM "don't do X" never worked under context pressure
- **Structural fixes (removing tools): 100% success rate** — if the LLM can't call a tool, it can't misuse it

The v10 design principle — "states that decide have no tools, states that take actions have specific tools" — was a workaround for Retell's architecture where the LLM always drives state transitions. The workaround had limits: the LLM still controlled conversation flow, could fabricate data, and could stall in states.

**The core insight:** LLMs are excellent at generating natural language. They are unreliable at controlling program flow. Mixing the two is the root cause of every bug in the optimization log.

**The solution:** Migrate to Pipecat (open-source Python framework) with a deterministic state machine. Code controls all flow. The LLM generates conversational text only — it never triggers tools, transitions states, or ends calls.

> **Full rationale:** `docs/plans/2026-02-14-pipecat-migration-design.md`
> **Patch history that proves the pattern:** `voice-agent/OPTIMIZATION-LOG.md`

## Design Philosophy

These principles — validated by CallLock's own patch history and articulated in MostlyLucid's "Ten Commandments of LLM Use" and "Building Voice Forms with Blazor and Local LLMs" — guide every architectural decision:

1. **LLM as translator, not controller.** The LLM converts structured intent into natural speech. It never decides what happens next.
2. **Deterministic state machine owns flow.** States, transitions, and tool invocations are defined in code. No probabilistic routing.
3. **Separate extraction from generation.** The LLM generates a conversational response; a separate step extracts structured data; deterministic code validates it.
4. **Validation gates every side-effect.** No tool call, state transition, or data write happens without code-level validation first.
5. **Loud failures over silent defaults.** Missing env vars crash at startup. Circuit breakers log and degrade visibly. Turn limits escalate to callback rather than looping.
6. **Build boring machinery first.** State machine, validators, circuit breakers, retry logic — the reliable infrastructure that the LLM operates within.

## Core Architectural Principle

**Code controls flow. LLM generates words. Validation gates every side-effect.**

Three state types enforce this:

| Type | LLM Does | Code Does |
|------|----------|-----------|
| **Decision** (welcome, safety, service_area, discovery, confirm) | Generates conversational response | Extracts data, validates, transitions |
| **Action** (lookup, booking) | Narrates result to caller | Calls tools via HTTP, transitions on result |
| **Terminal** (safety_exit, done, callback) | Says goodbye | Fires final tools, ends call |

## Architecture

```
  Customer Call  →  Twilio  →  Pipecat Agent (Fly.io)  →  V2 Backend (Render)
  (Missed Call)     SIP         Python state machine        Express/Node.js
                                Deepgram STT                Cal.com booking
                                GPT-4o (text only)          Supabase persistence
                                Inworld TTS (+ Deepgram     Dashboard webhook sync
                                  Aura-2 fallback)
                                                               ↓
                                                   Dashboard (Vercel)
                                                   ACTION | BOOKED | Calls | Settings
```

## Repository Structure

| Directory | Description | Deployment |
|-----------|-------------|------------|
| `pipecat-agent/` | **Voice agent — Python/FastAPI, deterministic state machine** | Fly.io: `calllock-voice` |
| `V2/` | Backend webhook server (Express/Node.js) — tools, booking, sync | Render: `calllock-server.onrender.com` |
| `V3/` | V3 backend with triage engine (experimental) | - |
| `calllock-dashboard/` | **Symlink** to `/Users/rashidbaset/calllock-dashboard` (separate repo) | Vercel: `callseal-app` |
| `voice-agent/` | Legacy Retell AI configs + optimization log (historical reference) | Archived |
| `docs/` | Design documents, migration plans | - |

> **Dashboard** is a separate git repo at `https://github.com/rbaset5/calllock-dashboard`.
> Canonical location: `/Users/rashidbaset/calllock-dashboard`

## Data Flow

1. Customer calls business phone → call forwards to Twilio
2. Twilio connects WebSocket to Pipecat agent on Fly.io
3. Pipecat pipeline: Deepgram STT → State Machine → GPT-4o → Inworld TTS → audio back to caller
4. State machine calls V2 backend tools via HTTP (lookup_caller, book_service, create_callback)
5. Call ends → Pipecat post-call handler syncs to Dashboard:
   - `POST DASHBOARD_JOBS_URL` → Creates/updates leads/jobs
   - `POST DASHBOARD_CALLS_URL` → Syncs call records
   - `POST DASHBOARD_ALERTS_URL` → Creates emergency alerts

## Services

| Service | URL | Purpose |
|---------|-----|---------|
| Pipecat Agent | `https://calllock-voice.fly.dev` | Voice agent (Fly.io) |
| V2 Backend | `https://calllock-server.onrender.com` | Tool execution, booking, classification |
| Dashboard | `https://app.calllock.co` | Business owner UI (Vercel) |
| Supabase | `https://xboybmqtwsxmdokgzclk.supabase.co` | Database |

---

## Pipecat Agent (`pipecat-agent/`)

### Key Files

| File | Purpose |
|------|---------|
| `src/calllock/bot.py` | FastAPI app, TwiML endpoints, WebSocket handler, startup validation |
| `src/calllock/pipeline.py` | Pipeline assembly: STT → StateMachine → LLM → TTS → transport |
| `src/calllock/state_machine.py` | 10-state flow with turn limits — all transitions are deterministic |
| `src/calllock/states.py` | `State` enum with `is_decision`, `is_action`, `is_terminal` properties |
| `src/calllock/processor.py` | `StateMachineProcessor` — bridges state machine with Pipecat frames |
| `src/calllock/session.py` | `CallSession` dataclass — all call state lives here, external to LLM |
| `src/calllock/tools.py` | `V2Client` — HTTP calls to V2 backend with circuit breaker |
| `src/calllock/validation.py` | Deterministic validators (ZIP, name, intent, safety, high-ticket) |
| `src/calllock/extraction.py` | Structured data extraction from conversation |
| `src/calllock/prompts.py` | Per-state LLM system prompts |
| `src/calllock/tts_fallback.py` | `FallbackTTSService` — Inworld primary, Deepgram Aura-2 fallback |
| `src/calllock/circuit_breaker.py` | Shared `CircuitBreaker` (used by TTS + V2Client) |
| `src/calllock/config.py` | Startup env var validation — crashes on missing required keys |
| `src/calllock/dashboard_sync.py` | `DashboardClient` — POST with retry to dashboard webhooks |
| `src/calllock/post_call.py` | Post-call orchestrator — builds payloads, syncs to dashboard |

### Call Flow (10 States)

```
WELCOME → LOOKUP → SAFETY → SERVICE_AREA → DISCOVERY → CONFIRM → BOOKING → DONE
                      ↓                                    ↓         ↓
                  SAFETY_EXIT                           CALLBACK  CALLBACK
```

Each state has an explicit set of allowed tools and reachable next states defined in `state_machine.py`. The LLM cannot invoke tools or transition states — only code can.

### Development

```bash
cd pipecat-agent
pip install -e . --break-system-packages  # editable install (macOS managed Python)
pip install respx pytest-asyncio          # test deps not in pyproject.toml
pytest tests/ -v                          # 166 tests
```

### Deployment

```bash
cd pipecat-agent
fly deploy -a calllock-voice
fly secrets set KEY=value -a calllock-voice
fly logs -a calllock-voice
curl -s https://calllock-voice.fly.dev/health  # verify
```

### Environment Variables

**Required** (startup crashes if missing):
- `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `INWORLD_API_KEY`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
- `V2_BACKEND_URL`

**Dashboard sync** (separate URLs, not string-derived):
- `DASHBOARD_JOBS_URL`, `DASHBOARD_CALLS_URL`, `DASHBOARD_ALERTS_URL`
- `DASHBOARD_WEBHOOK_SECRET`, `DASHBOARD_USER_EMAIL`

**Optional:** `LOG_LEVEL`, `INWORLD_VOICE_ID`, `DEEPGRAM_TTS_VOICE`

### Gotchas

- `pip install -e .` requires `--break-system-packages` on macOS managed Python
- `respx` and `pytest-asyncio` are test deps not in `pyproject.toml`
- Silero VAD takes ~10s to load — `min_machines_running = 1` in fly.toml prevents cold-start timeouts
- Inworld TTS requires `setup()` propagation for clock init — handled by `FallbackTTSService.setup()`
- `TTSSpeakFrame` "StartFrame not received" errors in logs are non-fatal cosmetic noise
- Old `DASHBOARD_WEBHOOK_URL` is deprecated — use the three separate URL vars

---

## V2 Backend (`V2/`)

Express/Node.js server that the Pipecat agent calls for business logic:
- `lookup_caller` — checks Supabase for existing customer
- `book_service` — books via Cal.com
- `create_callback` — creates callback request
- `send_sales_lead_alert` — alerts for high-ticket leads
- Post-call classification (urgency, tags, revenue estimation)

See `V2/CLAUDE.md` for full backend docs.

## Dashboard (`calllock-dashboard/`)

Next.js app on Vercel. Receives webhook data from Pipecat agent's post-call handler.

```bash
cd /Users/rashidbaset/calllock-dashboard
npm install && npm run dev  # http://localhost:3000
```

Requires `.env.local` with Supabase credentials. See `calllock-dashboard/CLAUDE.md`.

---

## Architectural Decisions

- **Dashboard URLs:** Use separate env vars (`DASHBOARD_JOBS_URL`, `DASHBOARD_CALLS_URL`, `DASHBOARD_ALERTS_URL`). Never derive URLs via string replacement.
- **Webhook secrets:** Use `DASHBOARD_WEBHOOK_SECRET` everywhere.
- **State persistence:** Use upsert (not insert) for `call_sessions`. `Prefer: resolution=merge-duplicates` header required.
- **Urgency field:** `session.urgency` is the source of truth. Map to `urgencyTier` for dashboard consumption.
- **Customer name extraction:** Filter agent utterances before applying name regex.
- **Turn limits:** Per-state (5) and per-call (30) limits prevent infinite loops. Exceeding either escalates to CALLBACK.
- **Circuit breaker:** Shared pattern across V2Client and TTS — 3 failures opens circuit for 60s cooldown.

## HVAC Smart Tag Taxonomy

117-tag taxonomy for call classification. V2 backend classifies, dashboard displays.

> **Full reference:** `V2/HVAC_SMART_TAG_TAXONOMY.md`

## Hard Rules

1. **No merging without passing tests.** `pytest tests/ -v` must pass.
2. **One branch per issue.** Never reuse a branch for multiple PRs.
3. **No batch deploys.** Deploy one PR at a time. Verify before merging the next.
4. **Bug fixes require a failing test first.**
5. **LLM never controls flow.** All state transitions happen in `state_machine.py`. All tool calls happen in code. If you're tempted to add a tool the LLM can invoke, stop — that's the bug class we migrated away from.
