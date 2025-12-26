# CallLock HVAC - Retell Webhook Server

## Project Overview
**CallLock** is a multi-tenant voice AI platform for HVAC businesses using Retell AI.
- **Role:** This repo is the **Webhook Server**. It executes tools (booking, checking availability) triggered by the Retell LLM.
- **Architecture:** `Retell LLM (Voice)` -> `Webhook Server (This Repo)` -> `Supabase` -> `Dashboard`
- **Tenancy:** Logic is multi-tenant. Business identity is derived from Retell call metadata (agent ID/phone number).

## Key Tech Stack
- **Runtime:** Node.js / TypeScript
- **Server:** Express
- **DB:** Supabase
- **Integrations:** Retell AI, Twilio (SMS), Cal.com (Booking)

## Domain Logic & Business Rules

### Emergency Tiers (Critical)
| Tier | Criteria | System Action |
|------|----------|---------------|
| **Tier 1 (Safety)** | Gas/burning smell, CO alarm, smoke | Instruct to call 911 -> `end_call(safety_emergency)` |
| **Tier 2 (Urgent)** | No heat <40°F, No AC >100°F, Water leak | Check same-day slots OR offer callback -> SMS Dispatcher |
| **Tier 3 (Routine)** | Standard maintenance, noise, etc. | Normal booking flow |

### Revenue Estimation
Logic location: `src/services/revenue-estimation.ts`
- **$$$$ (Replacement):** Signals: "R-22", "Freon", "15+ years old".
- **$$$ (Major Repair):** Signals: "Compressor", "Heat exchanger".
- **Diagnostic Fee:** $89 (hardcoded for now).

## Tool Definition (API Surface)
*Note: These correspond to Retell Dashboard Functions. See `src/types/retell.ts` for exact interfaces.*

| Function Name | Description | Key Args |
|---------------|-------------|----------|
| `validate_service_area` | Checks ZIP against allowed list. | `zip_code` |
| `check_calendar_availability` | Fetches Cal.com slots. | `urgency`, `preferred_date` |
| `book_appointment` | Creates Cal.com booking. | `date_time` (ISO), `customer_phone`, `address`, `problem` |
| `lookup_booking` | Finds booking by caller ID. | `phone` (optional) |
| `cancel_booking` | Cancels existing booking. | `booking_uid`, `reason` |
| `reschedule_booking` | Moves booking. | `booking_uid`, `new_date_time` |
| `send_emergency_alert` | SMS to dispatcher (Tier 2). | `urgency_description`, `caller_phone` |
| `send_sales_lead_alert` | SMS to owner (Replacement signal). | `equipment_age`, `notes` |
| `get_customer_status` | Returns history/status summary. | `phone` |

## Data Flow & Storage

1.  **Incoming Call:** Retell hits `POST /webhook/retell/*`
2.  **State:** Conversation state is transient. Final outcomes are saved to Supabase via `end_call`.
3.  **Post-Call:** Retell hits `POST /webhook/retell/call-ended` with transcript/recording -> Syncs to Supabase.
4.  **Dashboard Sync:** Backend sends data to dashboard via webhooks (see Dashboard Integration below).

## Dashboard Integration

The backend syncs call data to the CallLock Dashboard via webhooks. This is configured via environment variables.

### Required Environment Variables (Render)

| Variable | Description | Example |
|----------|-------------|---------|
| `DASHBOARD_WEBHOOK_URL` | Dashboard jobs webhook endpoint | `https://calllock-dashboard-2.vercel.app/api/webhook/jobs` |
| `DASHBOARD_WEBHOOK_SECRET` | Shared secret for webhook auth | `9d04de2c8cdbdfe...` (generate with `openssl rand -hex 32`) |
| `DASHBOARD_USER_EMAIL` | Email of dashboard user to sync data to | `user@example.com` |

### Webhook Endpoints

The backend sends data to these dashboard endpoints:

| Function | Endpoint | Data |
|----------|----------|------|
| `sendJobToDashboard()` | `/api/webhook/jobs` | Leads (non-bookings) and Jobs (bookings) |
| `sendCallToDashboard()` | `/api/webhook/calls` | Call records with transcripts |
| `sendEmergencyAlertToDashboard()` | `/api/webhook/emergency-alerts` | Tier 2 urgent alerts |

### Data Flow Diagram

```
Retell AI Voice Agent
    ↓ (call ends - POST to Agent Level Webhook URL)
V2 Backend (Render) - calllock-server.onrender.com/webhook/retell/call-ended
    ↓ sendJobToDashboard()      → POST /api/webhook/jobs
    ↓ sendCallToDashboard()     → POST /api/webhook/calls
    ↓ sendEmergencyAlertToDashboard() → POST /api/webhook/emergency-alerts
Dashboard (Vercel) - calllock-dashboard-2.vercel.app
    ↓ validates X-Webhook-Secret header
    ↓ finds user by email
    ↓ deduplicates by call_id (prevents duplicate leads on retry)
    ↓ inserts new OR updates existing record
UI displays data
```

### Webhook Retry & Deduplication

The backend uses `fetchWithRetry` with 3 retry attempts for webhook calls. The dashboard implements **idempotent webhook handling**:

- **First call**: Creates new lead/job, returns `action: "created"`
- **Retry (same call_id)**: Updates existing record, returns `action: "updated"`

This ensures no duplicate leads are created when webhooks are retried due to network issues.

### Required Retell Configuration

**CRITICAL**: The Retell agent must have the **Agent Level Webhook URL** configured:

1. Go to Retell Dashboard → Agent Settings → Webhook Settings
2. Set **Agent Level Webhook URL** to:
   ```
   https://calllock-server.onrender.com/webhook/retell/call-ended
   ```

Without this, Retell never notifies the V2 backend when calls end, and bookings/leads won't sync to the dashboard.

### Payload Fields

Key fields sent to dashboard:

- `customer_name`, `customer_phone`, `customer_address`
- `call_id`, `started_at`, `ended_at`, `duration_seconds`
- `outcome` / `end_call_reason` - Determines lead vs job creation
- `transcript_object` - Speaker-labeled transcript `[{role, content}]`
- `revenue_tier_label`, `revenue_tier_signals` - Revenue classification
- `priority_color`, `priority_reason` - V4 priority system
- `caller_type`, `primary_intent`, `is_callback_complaint` - V3 triage fields
- `sentiment_score`, `work_type` - V5 velocity enhancements
- `tags` - V6 HVAC Smart Tag Taxonomy (see below)

### V6 HVAC Smart Tag Taxonomy

The backend classifies calls using a 117-tag taxonomy across 9 categories. Dashboard uses these tags for:
- **Archetype determination**: HAZARD > RECOVERY > REVENUE > LOGISTICS
- **Display tags**: Up to 4 prioritized tags shown on velocity cards
- **Priority scoring**: Tag presence affects velocity queue order

**Tag Categories:**

| Category | Tags | Purpose |
|----------|------|---------|
| HAZARD | 7 | Safety-critical (gas leak, CO, electrical) |
| URGENCY | 8 | Time-sensitivity (emergency, same-day, standard) |
| SERVICE_TYPE | 23 | What the call is about (repair, maintenance, install) |
| REVENUE | 9 | Sales opportunities (hot lead, financing, commercial) |
| RECOVERY | 10 | Customer retention (callback risk, complaints) |
| LOGISTICS | 20 | Access/authorization (gate code, landlord auth) |
| CUSTOMER | 15 | Caller relationship (new, existing, commercial) |
| NON_CUSTOMER | 12 | Non-customers (vendor, spam, wrong number) |
| CONTEXT | 13 | Situational (seasonal, medical, post-storm) |

**Webhook Payload Example:**

```json
{
  "call_id": "call_xxx",
  "customer_name": "John Smith",
  "tags": {
    "HAZARD": ["GAS_LEAK"],
    "URGENCY": ["CRITICAL_EVACUATE"],
    "SERVICE_TYPE": ["REPAIR_HEATING"],
    "REVENUE": [],
    "RECOVERY": [],
    "LOGISTICS": ["GATE_CODE"],
    "CUSTOMER": ["EXISTING_CUSTOMER"],
    "NON_CUSTOMER": [],
    "CONTEXT": ["PEAK_WINTER"]
  }
}
```

**Implementation Files:**
- Full taxonomy reference: `V2/HVAC_SMART_TAG_TAXONOMY.md`
- Implementation example: `V2/HVAC_TAXONOMY_IMPLEMENTATION_EXAMPLE.md`
- Dashboard testing guide: `calllock-dashboard/HVAC_TAXONOMY_TESTING_GUIDE.md`

### Service Location

Dashboard sync logic: `src/services/dashboard.ts`

## Developer Notes

**Prompt Management:**
The System Prompt is the source of truth for the AI's personality and flow.
- Located at: `src/constants/prompt.ts` (or wherever you keep it)
- **Do not hardcode prompts in this README.** Update the source file.

**SMS / Notifications:**
- Service: `src/services/alerts.ts`
- Uses Twilio. Fallback to console logs if env vars missing.

**Project Structure:**
- `src/server.ts`: Entry point.
- `src/controllers/retell.ts`: Handles the webhook routing.
- `src/functions/*`: Individual tool logic (booking, calendar, etc).