# CallLock - AI Voice Receptionist Platform

---

## ⚠️ Current System State

| Component | Status | Notes |
|-----------|--------|-------|
| **Voice Agent** | 🟢 LIVE | Retell AI v10-simplified — 8 states, LLM-driven transitions |
| **V2 Backend** | 🟢 LIVE | Express/Node.js on Render |
| **Dashboard** | 🟢 LIVE | Next.js on Vercel |

> **Pipecat reference in this repo is deprecated.** The Pipecat agent design was explored but will not be implemented.

---

## What It Does

CallLock is a missed call recovery service for trades businesses (HVAC, plumbing, electrical). When a customer calls and the business misses it, the call redirects to CallLock's AI receptionist, which handles the conversation, collects information, and books appointments — without human intervention.

---

## Architecture (LIVE — Retell AI)

```
Customer Call  →  Twilio  →  Retell AI Voice Agent  →  V2 Backend (Render)
(Missed Call)     SIP         GPT-4o + 8-state flow      Express/Node.js
                              LLM-driven transitions      Cal.com booking
                                                          Supabase persistence
                                                          Dashboard webhook sync
                                                               ↓
                                                   Dashboard (Vercel)
                                                   ACTION | BOOKED | Calls | Settings
```

### Live Voice Agent: Retell v10-simplified (8 States)

Config file: `voice-agent/retell-llm-v10-simplified.json`

```
welcome → lookup → safety → service_area → discovery → confirm → booking → done
         ↓              ↓
      callback     safety_exit
```

| State | Tools Available | Purpose |
|-------|----------------|---------|
| `welcome` | None | Intent detection (service vs non-service) |
| `lookup` | `lookup_caller` | Caller ID lookup → customer history |
| `safety` | None | Safety question (gas/burning/smoke/CO) |
| `safety_exit` | `end_call` only | Emergency 911 instructions |
| `service_area` | `end_call` (out-of-area only) | ZIP validation (787 prefix) |
| `discovery` | None | Collect name, problem, address |
| `confirm` | None | Summarize, get approval, set urgency |
| `booking` | `book_service` | Book via Cal.com |
| `done` | `end_call` | Wrap up successful booking |
| `callback` | `create_callback_request`, `send_sales_lead_alert`, `end_call` | Universal exit |

**How transitions work:** LLM-driven via Retell's `edges` mechanism. The LLM decides which edge to take. Structural guarantees are enforced by tool availability per state — if a state doesn't have `end_call`, the LLM cannot end the call from that state.

---

## Repository Structure

| Directory | Status | Description | Deployment |
|-----------|--------|-------------|------------|
| `voice-agent/` | 🟢 **LIVE** | Retell AI v10-simplified config (8 states) + optimization log | Retell Dashboard |
| `V2/` | 🟢 **LIVE** | Backend webhook server (Express/Node.js) — tools, booking, sync | Render: `calllock-server.onrender.com` |
| `calllock-dashboard/` | 🟢 **LIVE** | Symlink to `/Users/rashidbaset/calllock-dashboard` (separate repo) | Vercel: `callseal-app` |
| `pipecat-agent/` | ⚫ **DEPRECATED** | Deprecated Pipecat design — do not use | - |
| `V3/` | 🟡 **EXPERIMENTAL** | V3 backend with triage engine | - |
| `docs/` | — | Design documents | - |

> **Dashboard** is a separate git repo at `https://github.com/rbaset5/calllock-dashboard`.
> Canonical location: `/Users/rashidbaset/calllock-dashboard`

---

## Data Flow

1. Customer calls business phone → call forwards to Twilio
2. Twilio connects to Retell voice agent
3. Retell: GPT-4o LLM processes audio, drives state transitions via edges
4. LLM invokes tools via HTTP calls to V2 backend:
   - `lookup_caller` → `/webhook/retell/lookup_caller`
   - `book_service` → `/api/retell/book-service`
   - `create_callback_request` → `/webhook/retell/create_callback`
   - `send_sales_lead_alert` → `/webhook/retell/send_sales_lead_alert`
5. Call ends → Retell fires `call_analyzed` webhook to V2 (`/webhook/retell/call-ended`)
6. V2 extracts conversation state, classifies with 117-tag HVAC taxonomy
7. V2 syncs to Dashboard:
   - `POST DASHBOARD_JOBS_URL` → Creates/updates leads/jobs
   - `POST DASHBOARD_CALLS_URL` → Syncs call records
   - `POST DASHBOARD_ALERTS_URL` → Creates emergency alerts

---

## Services

| Service | Status | URL | Purpose |
|---------|--------|-----|---------|
| Retell Voice Agent | 🟢 LIVE | Managed by Retell Dashboard | 8-state LLM-driven voice agent |
| V2 Backend | 🟢 LIVE | `https://calllock-server.onrender.com` | Tool execution, booking, classification |
| Dashboard | 🟢 LIVE | `https://app.calllock.co` | Business owner UI (Vercel) |
| Supabase | 🟢 LIVE | `https://xboybmqtwsxmdokgzclk.supabase.co` | Database |

---

## Voice Agent (`voice-agent/`) — LIVE

### Key Files

| File | Purpose |
|------|---------|
| `retell-llm-v10-simplified.json` | **Live config** — 8-state Retell LLM definition |
| `OPTIMIZATION-LOG.md` | 19 reactive patches applied to fix LLM behavior in production |
| `AGENT-STATUS.md` | Current agent status and version tracking |
| `TEST-SCENARIOS.md` | Test scenarios for voice agent QA |

### The 19 Patches (Proof of Live Iteration)

The optimization log documents fixes for LLM misbehavior in production calls:

| Issue | Fix Type | Lesson |
|-------|----------|--------|
| LLM called `end_call` from safety state (3 occurrences) | **Structural** — removed tool from state | Prompt guards don't work; remove the tool |
| LLM said "Transitioning now" 4 times | **Structural** — purged "transition" word from all prompts | Partial purges leave the same vulnerability |
| LLM omitted required edge parameters / fabricated ZIP "787" | **Structural** — made params required | LLM silently omits optional params |
| Return caller data lost between states | **Structural** — added required params to edges | Data must be explicitly passed at every edge |
| Time mismatch (booked 8AM, confirmed 7:30AM) | **Code** — added time comparison check | Cal.com snaps to nearest slot; agent must flag discrepancy |

> **Key insight:** Prompt-based tool restrictions have 0% success rate with GPT-4o. Structural fixes (removing tools, making params required) have 100% success rate.

---

## V2 Backend (`V2/`) — LIVE

Express/Node.js server that Retell calls for business logic:

- `lookup_caller` — checks Supabase for existing customer
- `book_service` — books via Cal.com
- `create_callback` — creates callback request + sends SMS
- `send_sales_lead_alert` — alerts for high-ticket leads
- Post-call classification (urgency, tags, revenue estimation)

See `V2/CLAUDE.md` for full backend docs.

---

## Dashboard (`calllock-dashboard/`) — LIVE

Next.js app on Vercel. Receives webhook data from V2 backend's post-call handler.

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
- **Structural over prompt-based guards:** Remove tools from states that shouldn't use them. Never rely on prompt instructions to prevent tool misuse.

---

## HVAC Smart Tag Taxonomy

117-tag taxonomy for call classification. V2 backend classifies, dashboard displays.

> **Full reference:** `V2/HVAC_SMART_TAG_TAXONOMY.md`

---

## Hard Rules

1. **No merging without passing tests.** `npm test` (V2) must pass.
2. **One branch per issue.** Never reuse a branch for multiple PRs.
3. **No batch deploys.** Deploy one PR at a time. Verify before merging the next.
4. **Bug fixes require a failing test first.**
5. **Structural over prompt-based fixes.** If the LLM is misusing a tool, remove the tool from that state. Do not add prompt instructions — they don't work.

---

## Design Philosophy

1. **LLM as conversational interface.** The LLM handles natural language. Tool calls and state transitions are driven by the LLM's interpretation.
2. **Structural guards over prompt guards.** Remove tools from states that shouldn't use them. Prompt instructions don't work reliably.
3. **Validation gates side-effects.** No tool call or data write happens without code-level validation.
4. **Loud failures over silent defaults.** Missing env vars crash at startup. Circuit breakers log and degrade visibly.
5. **Post-call extraction.** The LLM generates conversation; deterministic code extracts structured data afterward.

---

*Last updated: 2026-02-28 — Removed deprecated Pipecat references*
