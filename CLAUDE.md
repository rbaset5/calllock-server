# CallLock - AI Voice Receptionist Platform

## Overview

CallLock is a Done-For-You missed call recovery service for trades businesses (HVAC, plumbing, electrical). When a customer calls and the business misses the call, it redirects to CallLock's AI receptionist.

## Architecture

```
  Customer Call  →  Retell AI Voice  →  V2 Backend
  (Missed Call)      Receptionist        (Render)
                                            ↓
                     Dashboard (Vercel)
                     ACTION | BOOKED | Calls | Settings
```

## Repository Structure

| Directory | Description | Deployment |
|-----------|-------------|------------|
| `V2/` | Backend webhook server (Express/Node.js) | Render: calllock-server.onrender.com |
| `V3/` | V3 backend with triage engine (experimental) | - |
| `calllock-dashboard/` | **Symlink** → `/Users/rashidbaset/calllock-dashboard` (separate git repo) | Vercel: callseal-app (workbridge-ai) |
| `voice-agent/` | **Voice AI agent configs, optimization logs, tests** | Retell AI |
| `docs/` | Documentation and agent configurations | - |

> **Note:** The dashboard is a **separate git repository** at `https://github.com/rbaset5/calllock-dashboard`.
> - **Canonical Location:** `/Users/rashidbaset/calllock-dashboard` (THE single source of truth)
> - **Symlink:** `calllock-dashboard/` in this directory points to it
> - **If missing:** See "First-Time Setup" below to clone and configure it
> - **Requires:** `.env.local` with Supabase credentials (not committed to git)
> - **⚠️ DO NOT use** `/Users/rashidbaset/calllockv2/dashboard` - that is an archived old copy

---

## Voice Agent Workflow (IMPORTANT)

When working on the voice agent (Retell AI), follow this systematic approach:

### Before Making Changes
1. **Read `voice-agent/AGENT-STATUS.md`** - Current deployment state
2. **Read `voice-agent/OPTIMIZATION-LOG.md`** - What's been tried before
3. **Check Retell API** - Verify actual deployed state matches docs

### When Making Changes
1. Create new config version (e.g., `retell-llm-lite-v5.json`)
2. Deploy via Retell API and publish
3. Run tests from `voice-agent/TEST-SCENARIOS.md`
4. Pull call transcripts to verify

### After Making Changes
1. Update `AGENT-STATUS.md` with new version info
2. Add entry to `OPTIMIZATION-LOG.md` with problem/change/result
3. Update testing status table

### Key Files
| File | Purpose |
|------|---------|
| `voice-agent/AGENT-STATUS.md` | Current deployment, testing status, golden rules |
| `voice-agent/OPTIMIZATION-LOG.md` | History of all changes and learnings |
| `voice-agent/TEST-SCENARIOS.md` | Standard test protocol (8 scenarios) |
| `voice-agent/retell-llm-lite-v4.json` | Current deployed config |

### API Quick Reference
```bash
# Check agent version
curl -s "https://api.retellai.com/get-agent/agent_4fb753a447e714064e71fadc6d" \
  -H "Authorization: Bearer key_2d22013d18c09d647b1904f78f35" | jq '.version'

# List recent calls
curl -s -X POST "https://api.retellai.com/v2/list-calls" \
  -H "Authorization: Bearer key_2d22013d18c09d647b1904f78f35" \
  -H "Content-Type: application/json" \
  -d '{"limit": 5, "sort_order": "descending"}' | jq '.[].call_id'

# Get call transcript
curl -s "https://api.retellai.com/v2/get-call/CALL_ID" \
  -H "Authorization: Bearer key_2d22013d18c09d647b1904f78f35" | jq '.transcript'
```

---

## Data Flow

1. Customer calls business phone
2. Call forwards to Retell AI agent
3. Retell LLM invokes tool webhooks → V2 Backend
4. V2 Backend executes tools (booking, calendar, alerts)
5. Call ends → Retell sends post-call webhook
6. V2 Backend syncs to Dashboard via webhooks:
   - POST /api/webhook/jobs → Creates/updates leads/jobs (deduplicated by call_id)
   - POST /api/webhook/calls → Syncs call records
   - POST /api/webhook/emergency-alerts → Creates alerts
7. Dashboard displays in UI

**Note:** Retell chat simulations do NOT trigger dashboard sync. Only real phone calls fire the `call-ended` webhook that initiates the data flow.

## Key Services

| Service | URL | Purpose |
|---------|-----|---------|
| V2 Backend | https://calllock-server.onrender.com | Retell webhooks, tool execution |
| Dashboard | https://app.calllock.co (Vercel: callseal-app) | Business owner UI |
| Supabase | https://xboybmqtwsxmdokgzclk.supabase.co | Database |
| Retell AI | Dashboard at retellai.com | Voice AI configuration |

## Environment Configuration

### Backend (Render) - V2/

Required for dashboard sync:
```
DASHBOARD_WEBHOOK_URL=https://app.calllock.co/api/webhook/jobs
DASHBOARD_WEBHOOK_SECRET=<shared-secret>
DASHBOARD_USER_EMAIL=user@example.com
```

### Dashboard (Vercel) - calllock-dashboard/

Required for webhook auth:
```
WEBHOOK_SECRET=<same-shared-secret>
SUPABASE_SERVICE_ROLE_KEY=<supabase-service-key>
```

## Quick Start

### First-Time Setup (Dashboard)

The dashboard is a **separate git repository**. Clone to the canonical location:

```bash
# Clone dashboard to canonical location
cd /Users/rashidbaset
git clone https://github.com/rbaset5/calllock-dashboard

# Create symlink from nashville directory
cd /Users/rashidbaset/conductor/workspaces/retellai-calllock/nashville
ln -s /Users/rashidbaset/calllock-dashboard calllock-dashboard
```

**⚠️ IMPORTANT:** Always use `/Users/rashidbaset/calllock-dashboard` - do NOT use any other paths.

**Required: Create `.env.local`** in the dashboard directory:

```bash
# calllock-dashboard/.env.local
NEXT_PUBLIC_SUPABASE_URL=https://xboybmqtwsxmdokgzclk.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<get from Supabase dashboard: Settings > API > anon public>
SUPABASE_SERVICE_ROLE_KEY=<get from Supabase dashboard: Settings > API > service_role>
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Get Supabase keys from: https://supabase.com/dashboard/project/xboybmqtwsxmdokgzclk/settings/api-keys

### Local Development

```bash
# Dashboard
cd calllock-dashboard
npm install
npm run dev
# Open http://localhost:3000

# Backend
cd V2
npm install
npm run dev
# Server runs on http://localhost:3000
```

### Database Migrations

```bash
cd calllock-dashboard
# Apply migrations to Supabase
supabase db push
```

Or run SQL manually in Supabase Dashboard SQL Editor.

## Documentation

- **`voice-agent/AGENT-STATUS.md`** - **Voice agent current deployment status** (single source of truth)
- `V2/CLAUDE.md` - Backend architecture, tool definitions, dashboard integration
- `calllock-dashboard/CLAUDE.md` - Dashboard architecture, webhook handlers, UI components
- `docs/retell-agent/` - Voice agent configuration and prompts (outdated - see voice-agent/)

## V6: HVAC Smart Tag Taxonomy

The system now supports a comprehensive 117-tag HVAC taxonomy for intelligent call classification.

### How It Works

1. **V2 Backend** classifies calls using transcript analysis
2. **Sends `tags` field** in webhook payload to dashboard
3. **Dashboard** uses tags for:
   - Velocity archetype determination (HAZARD > RECOVERY > REVENUE > LOGISTICS)
   - Display tags on velocity cards (up to 4 per card)
   - Priority queue sorting

### Tag Categories

| Category | Count | Purpose |
|----------|-------|---------|
| HAZARD | 7 | Safety-critical (gas leak, CO, electrical) |
| URGENCY | 8 | Time-sensitivity (emergency, same-day) |
| SERVICE_TYPE | 23 | Repair, maintenance, install, diagnostic |
| REVENUE | 9 | Sales opportunities (hot lead, financing) |
| RECOVERY | 10 | Customer retention (callback risk, complaints) |
| LOGISTICS | 20 | Access/authorization (gate code, landlord) |
| CUSTOMER | 15 | Caller relationship (new, existing, commercial) |
| NON_CUSTOMER | 12 | Non-customers (vendor, spam) |
| CONTEXT | 13 | Situational (seasonal, medical) |

### Documentation

- **`voice-agent/AGENT-STATUS.md`** - **Voice agent current deployment status** (single source of truth)
- **Full taxonomy reference:** `V2/HVAC_SMART_TAG_TAXONOMY.md`
- **Backend implementation:** `V2/HVAC_TAXONOMY_IMPLEMENTATION_EXAMPLE.md`
- **Dashboard testing:** `calllock-dashboard/HVAC_TAXONOMY_TESTING_GUIDE.md`

### Database Migration

Apply to enable taxonomy storage:

```bash
cd calllock-dashboard
supabase db push
```

Or run SQL in Supabase Dashboard (migration 0023).

---

## Development Discipline (Effective 2026-02-13)

> **Read `docs/plans/2026-02-13-mvp-stabilization-design.md` before starting ANY work.**
> This is the approved stabilization plan. Do not deviate without explicit approval.

### Hard Rules

1. **No merging without passing tests.** Every PR must have vitest passing in CI.
2. **One branch per issue.** Never reuse a branch for multiple PRs.
3. **No batch deploys.** Deploy one PR at a time. Verify it works before merging the next.
4. **No new features until stabilization is complete.** The plan has 3 phases. Features come after Phase 3.
5. **Bug fixes require a failing test first.** Write the test that reproduces the bug, then fix it.
6. **No bypassing auth.** The webhook auth middleware must block invalid signatures. Never call `next()` on auth failure.

### V2 Backend Module Structure (Target — Phase 2)

After Phase 2, `server.ts` is decomposed into:

```
V2/src/
  server.ts                    # Express setup, middleware, health checks (~200 lines)
  webhooks/retell-handler.ts   # Route registration, request/response
  state/conversation-state.ts  # State persistence, loop detection
  tools/lookup-caller.ts       # lookup_caller webhook logic
  tools/book-appointment.ts    # book_appointment webhook logic
  tools/create-callback.ts     # create_callback webhook logic
  extraction/post-call.ts      # Post-call data extraction
  extraction/urgency.ts        # Urgency inference
  classification/tags.ts       # 117-tag taxonomy
  classification/call-type.ts  # Call type + urgency tier mapping
  classification/revenue.ts    # Revenue estimation
  sync/job-sync.ts             # Dashboard job webhook
  sync/call-sync.ts            # Dashboard call webhook
  sync/alert-sync.ts           # Emergency alert webhook
  transformation/payload.ts    # Dashboard payload construction
```

### Known Architectural Decisions

- **Urgency field:** Use `state.urgency` (UrgencyLevel) as the source of truth. Map it to `urgencyTier` in `classification/call-type.ts` for dashboard consumption. Never read `state.urgencyTier` directly.
- **Webhook secrets:** Use `DASHBOARD_WEBHOOK_SECRET` everywhere. The `WEBHOOK_SECRET` variable in `alerts.ts` is a bug (tracked in stabilization plan).
- **Dashboard URLs:** Use separate environment variables for each webhook URL (`DASHBOARD_JOBS_URL`, `DASHBOARD_CALLS_URL`, `DASHBOARD_ALERTS_URL`). Do not derive URLs via string replacement.
- **State persistence:** Always use upsert (not insert) for `call_sessions`. The `Prefer: resolution=merge-duplicates` header is required.
- **Customer name extraction:** Filter agent utterances before applying name regex. The transcript contains both agent and caller speech.
