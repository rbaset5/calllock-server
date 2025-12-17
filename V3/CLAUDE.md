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

### Triage Classification (AI Required)

When calling `end_call`, the AI must include these classification fields:

| Field | Values | Purpose |
|-------|--------|---------|
| `caller_type` | residential, commercial, vendor, recruiting, unknown | Caller classification |
| `primary_intent` | new_lead, active_job_issue, booking_request, admin_billing, solicitation | Call purpose classification |
| `booking_status` | confirmed, attempted_failed, not_requested | Track booking outcome |
| `is_callback_complaint` | true/false | Flag for service complaints |

**Notes:**
- `booking_status` is auto-set to `confirmed` by `book_appointment` handler on success
- AI should classify `caller_type` and `primary_intent` during conversation based on caller statements
- `is_callback_complaint` should be true when caller is complaining about previous service

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