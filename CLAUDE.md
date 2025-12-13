# CallLock HVAC - Retell Webhook Server

## What is CallLock?

**CallLock is a multi-tenant platform** that provides AI-powered phone answering for HVAC businesses. Each HVAC business gets their own:
- Retell agent (with business-specific prompt variables)
- Knowledge base (FAQ document with their hours, services, etc.)
- Dashboard view (their calls, jobs, analytics)

**Key multi-tenant considerations:**
- Business-specific info (name, hours, service area) comes from Retell variables or knowledge base
- Never hardcode business-specific values in the server code
- The webhook server is shared - it handles calls for ALL businesses
- Business identification comes from Retell call metadata

## Overview

This is the webhook server for CallLock's HVAC voice AI system. It provides tool endpoints that Retell LLM calls during conversations.

**Architecture:**
- **Retell LLM** handles conversation logic (prompt configured in Retell Dashboard)
- **This server** executes tools (calendar, booking, alerts) via webhook endpoints
- **Dashboard** (`/Users/rashidbaset/Documents/calllock-dashboard`) displays call data

**Data Flow:**
```
Customer Call → Retell (voice + LLM) → Webhook Tools → Supabase → Dashboard
```

## Retell LLM Prompt (CRITICAL - Keep Updated)

**IMPORTANT:** This is the production system prompt that gets copied to Retell Dashboard. When adding new features, tools, or changing conversation flows, YOU MUST UPDATE THIS PROMPT. The user cannot update Retell Dashboard without the exact text from here.

**When to update this prompt:**
- Adding a new tool/webhook endpoint
- Changing conversation flow logic
- Adding new call handling scenarios (like sales leads, new tiers)
- Modifying business rules the AI needs to follow

**The prompt below is the source of truth:**

```
You are a friendly AI assistant for A & R Heating & Cooling, an HVAC service company in Austin, TX area.

CONTEXT: This is a live inbound call. The customer called for help—assume buying intent.

PERSONALITY: Warm, confident, solution-focused. Assume the customer wants to book. Ask ONE question at a time. Keep responses under 2 sentences.

EMPATHY FIRST:
- High temps (80°F+): "Oh wow, [X] degrees is rough—let's get someone out there fast."
- No heat in cold weather: "Ugh, that's miserable. Let me see what we can do right away."
- Frustrated caller: Mirror briefly ("I hear you") then pivot to solution.

FLOW:
1. Greet and ask about their AC/heating issue
2. If "wrong number" → "No problem! Have a great day!" → call end_call
3. If they describe a problem → ask ONE qualifying question:
   "Do you happen to know how old your system is?"
   (If they don't know, that's fine—move on)
4. Get their ZIP code
5. Call validate_service_area with the ZIP
6. If in service area → ask for phone number → call check_calendar_availability
7. Present slots as either/or: "[Day] at [time] or [Day] at [time]—which works?"
8. When they choose → get address → call book_appointment
9. Confirm booking → call end_call

TIER 1 EMERGENCY (gas smell, CO alarm, burning smell, smoke):
→ "Please leave the house immediately and call 911 from outside."
→ Call end_call(reason="safety_emergency") immediately

TIER 2 URGENT (no heat <40°F, no AC >100°F, grinding noise, ice, water leak):
→ "I understand this is urgent—let me see what we can do right now."
→ Check same-day availability
→ Offer choice: "I can get a tech today at [time], OR have the owner call you back. Which works?"

QUALIFYING FOR VALUE (after customer describes problem):
Ask: "Do you happen to know how old your system is?"
- If 15+ years → note this in problem_description (indicates high-value replacement opportunity)
- If they mention "Freon" or "R-22" → this is a high-value signal (obsolete refrigerant = replacement likely)
- If they say "I don't know" or "not sure" → that's fine, move on to ZIP

RECHARGE TRAP (critical for accurate job value):
If customer specifically asks for a "recharge" or "freon fill":
→ Ask: "Do you happen to know if your system uses the older R-22 refrigerant?"
→ If YES: This is a Replacement Opportunity, not a simple recharge
→ If NO or unsure: Proceed normally

Why: A 20-year-old AC needing a "recharge" is likely a $10k replacement, not a $200 service call.

REPLACEMENT/SALES (customer wants new unit, system 15+ years old, "time to replace"):
→ "I can have the owner call you back to discuss replacement options. Let me get your information."
→ Collect: name, phone, address, what equipment, how old
→ Call send_sales_lead_alert with the details
→ "Great, the owner will call you back shortly to discuss your options."
→ Call end_call(reason="sales_lead")

RESCHEDULE OR CANCEL:
If customer wants to reschedule or cancel an existing appointment:
→ "I can help with that. Let me look up your appointment."
→ Call lookup_booking (uses caller ID automatically)
→ If found: "I found your appointment for [date] at [time]."
  - For cancel: "Are you sure you want to cancel?" → call cancel_booking → end_call(reason="cancelled")
  - For reschedule: "When would you like to reschedule?" → check_calendar_availability → offer slots → call reschedule_booking → end_call(reason="rescheduled")
→ If not found: "I don't see an appointment under this number. Would you like to schedule a new one?"

STATUS INQUIRY (customer asks "what's my status?", "do I have an appointment?", "check my file", "any updates?"):
→ "Let me look that up for you."
→ Call get_customer_status (uses caller ID automatically)
→ Read the message from the response to the customer
→ If not found: "I don't see any history under this number. Would you like to schedule a service visit?"
→ After status: "Is there anything else I can help you with today?"

RULES:
- NEVER include parenthetical notes or internal reasoning—everything is spoken aloud
- Keep responses SHORT (1-2 sentences max)
- Ask ONE question at a time
- Don't repeat phone/address back—just say "Got it"
- MUST call end_call to end every conversation
- Use exact isoDateTime from calendar slots when booking

PRICE QUESTIONS:
- "$89 for the diagnostic—includes full system check, and it's waived if you do the repair."

BUSINESS QUESTIONS (hours, financing, licensing, services offered):
→ Answer from knowledge base if available
→ If unsure: "Let me connect you with someone who can help with that. Can I get your number for a callback?"
→ After answering, pivot back: "Is there anything else I can help you with today, or would you like to schedule service?"

BACKGROUND NOISE:
- Ignore TV/radio sounds, gibberish, or unrelated phrases
- If unsure: "I'm sorry, I didn't catch that. Were you saying something?"
- If caller talking to someone else: Wait patiently

VARIABLES:
- business_name: ACE Cooling
- service_area: Austin and surrounding areas
- diagnostic_fee: 89
```

## Conversation Flow

```
┌─────────────┐
│   Greeting  │ → Ask about AC/heating issue
└──────┬──────┘
       │
       ▼
┌─────────────┐    "wrong number"    ┌──────────┐
│   Problem   │ ──────────────────→  │ end_call │
└──────┬──────┘                      └──────────┘
       │ describes issue
       ▼
┌─────────────┐
│  Get ZIP    │ → validate_service_area
└──────┬──────┘
       │ in service area
       ▼
┌─────────────┐
│ Get Phone   │ → check_calendar_availability
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Offer Slots │ → "[Day] at [time] or [Day] at [time]?"
└──────┬──────┘
       │ customer chooses
       ▼
┌─────────────┐
│ Get Address │ → book_appointment
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Confirm    │ → end_call
└─────────────┘
```

## Sales/Replacement Inquiries

When customer wants a new unit or replacement (not a repair):

**Triggers:**
- "I need a new AC"
- "My system is 20 years old"
- "Want to replace my furnace"
- "Looking for a new unit"

**Flow:**
1. Acknowledge: "I can have the owner call you back to discuss replacement options."
2. Collect: name, phone, address, what equipment, how old
3. Call `send_sales_lead_alert` with details
4. Confirm: "Great, the owner will call you back shortly."
5. Call `end_call(reason="sales_lead")`

**SMS sent to owner:**
```
SALES LEAD: AC Replacement
Customer: John Smith
Phone: (512) 555-1234
Address: 1234 Oak St, Austin
Equipment: Central AC, 20 years old
Promised callback
```

## Emergency Tiers

| Tier | Triggers | Action |
|------|----------|--------|
| **Tier 1** | Gas smell, CO alarm, burning smell, smoke | "Call 911" → `end_call(reason="safety_emergency")` |
| **Tier 2** | No heat <40°F, no AC >100°F, grinding, ice, water leak | Same-day booking OR owner callback → SMS alert |
| **Tier 3** | Routine issues | Normal booking flow |

## SMS Alerts & Notifications

The system sends SMS notifications via **Twilio** for urgent situations. This is designed to scale into a full notification system.

### Current SMS Triggers

| Event | Recipient | Message Format |
|-------|-----------|----------------|
| **Tier 2 Emergency** | Dispatcher/Owner | Urgent alert with caller info |

### SMS Message Format (Tier 2 Alerts)

```
URGENT: No heat, elderly in home
Caller: (512) 555-1234
Address: 1234 Oak St, Austin
Promised callback within 15 min
```

### Twilio Configuration

```bash
TWILIO_ACCOUNT_SID=     # Twilio account SID
TWILIO_AUTH_TOKEN=      # Twilio auth token
TWILIO_FROM_NUMBER=     # Twilio phone number to send from
EMERGENCY_SMS_NUMBER=   # Dispatcher/owner phone to receive alerts
```

**Fallback:** If Twilio is not configured, alerts are logged to console (useful for development).

### Future SMS Expansion Ideas

- **Booking confirmations** to customers
- **Appointment reminders** (day before, 1 hour before)
- **Tech en-route notifications**
- **Post-service follow-up** requests
- **Missed call notifications** to owner

### SMS Service Location

`src/services/alerts.ts` - Contains `sendEmergencyAlert()` and Twilio integration

## Webhook Tool Endpoints

All endpoints receive `{ call: { call_id, from_number, to_number, direction }, args: {...} }`

### `POST /webhook/retell/validate_service_area`
Validates if customer's ZIP is in service area.
- **Args:** `{ zip_code: string }`
- **Returns:** `{ inServiceArea: boolean, message: string }`

### `POST /webhook/retell/check_calendar_availability`
Gets available appointment slots from Cal.com.
- **Args:** `{ urgency?: string, preferred_date?: string }`
- **Returns:** `{ slots: [{ isoDateTime, displayTime, displayDate }], message: string }`

### `POST /webhook/retell/book_appointment`
Books appointment in Cal.com.
- **Args:** `{ date_time, customer_name?, customer_phone, service_address, problem_description, urgency?, problem_duration?, equipment_type?, ... }`
- **Returns:** `{ success: boolean, appointmentId?, confirmationMessage }`

### `POST /webhook/retell/lookup_booking`
Finds existing booking by phone number (uses caller ID if not provided).
- **Args:** `{ phone?: string }` (optional - defaults to caller ID)
- **Returns:** `{ found: boolean, booking?: { uid, date, time, status }, message: string }`

### `POST /webhook/retell/cancel_booking`
Cancels an existing booking.
- **Args:** `{ booking_uid?: string, reason?: string }` (booking_uid from lookup_booking or previous call)
- **Returns:** `{ success: boolean, message: string }`

### `POST /webhook/retell/reschedule_booking`
Reschedules an existing booking to a new time.
- **Args:** `{ booking_uid?: string, new_date_time: string }` (use isoDateTime from calendar slots)
- **Returns:** `{ success: boolean, message: string, newDateTime?: string }`

### `POST /webhook/retell/send_emergency_alert`
Sends SMS alert for Tier 2 urgent calls via Twilio.
- **Args:** `{ urgency_description, caller_phone, address }`
- **Returns:** `{ success: boolean, alertId?, message: string }`
- **Side Effect:** Sends SMS to `EMERGENCY_SMS_NUMBER`

### `POST /webhook/retell/send_sales_lead_alert`
Sends SMS alert for replacement/sales inquiries.
- **Args:** `{ customer_name?, customer_phone, address?, current_equipment?, equipment_age?, notes? }`
- **Returns:** `{ success: boolean, alertId?, message: string }`
- **Side Effect:** Sends SMS to owner with lead details

### `POST /webhook/retell/get_customer_status`
Looks up customer's account history and status.
- **Args:** `{ phone?: string }` (optional - defaults to caller ID)
- **Returns:** `{ found: boolean, customerName?, upcomingAppointment?, recentCalls: [], pastAppointments: [], urgentAlert?, message: string }`
- **Note:** The `message` field contains a human-readable summary for the AI to speak

### `POST /webhook/retell/end_call`
Saves conversation state to Supabase before call ends.
- **Args:** `{ reason, customer_name?, customer_phone?, customer_address?, problem_description?, urgency?, ... }`
- **Returns:** `{ success: boolean, reason }`

### `POST /webhook/retell/call-ended`
Post-call webhook (called by Retell after call ends). Syncs data to dashboard.
- **Body:** Retell post-call payload with transcript, analysis, etc.
- **Returns:** `{ success: boolean, job_id? }`

## Retell Dashboard Function Setup

When adding new tools, configure them in **Retell Dashboard → Agent → Functions → + Add**.

**Base URL:** `https://calllock-server.onrender.com`

---

### validate_service_area
- **Name:** `validate_service_area`
- **Description:** Check if customer's ZIP code is in our service area
- **API Endpoint:** `POST` `https://calllock-server.onrender.com/webhook/retell/validate_service_area`
- **Parameters (JSON Schema):**
```json
{
  "type": "object",
  "properties": {
    "zip_code": {
      "type": "string",
      "description": "Customer's ZIP code"
    }
  },
  "required": ["zip_code"]
}
```

---

### check_calendar_availability
- **Name:** `check_calendar_availability`
- **Description:** Get available appointment slots from the calendar
- **API Endpoint:** `POST` `https://calllock-server.onrender.com/webhook/retell/check_calendar_availability`
- **Parameters (JSON Schema):**
```json
{
  "type": "object",
  "properties": {
    "urgency": {
      "type": "string",
      "description": "Urgency level: Emergency, Urgent, Routine, or Estimate"
    },
    "preferred_date": {
      "type": "string",
      "description": "Customer's preferred date"
    }
  },
  "required": []
}
```

---

### book_appointment
- **Name:** `book_appointment`
- **Description:** Book an appointment for the customer
- **API Endpoint:** `POST` `https://calllock-server.onrender.com/webhook/retell/book_appointment`
- **Parameters (JSON Schema):**
```json
{
  "type": "object",
  "properties": {
    "date_time": {
      "type": "string",
      "description": "ISO datetime from calendar slots (use exact isoDateTime value)"
    },
    "customer_phone": {
      "type": "string",
      "description": "Customer phone number"
    },
    "service_address": {
      "type": "string",
      "description": "Service address"
    },
    "problem_description": {
      "type": "string",
      "description": "Description of the HVAC issue"
    },
    "customer_name": {
      "type": "string",
      "description": "Customer name"
    },
    "urgency": {
      "type": "string",
      "description": "Urgency level"
    }
  },
  "required": ["date_time", "customer_phone", "service_address", "problem_description"]
}
```

---

### lookup_booking
- **Name:** `lookup_booking`
- **Description:** Find an existing booking by phone number (uses caller ID if not provided)
- **API Endpoint:** `POST` `https://calllock-server.onrender.com/webhook/retell/lookup_booking`
- **Parameters (JSON Schema):**
```json
{
  "type": "object",
  "properties": {
    "phone": {
      "type": "string",
      "description": "Phone number to look up (defaults to caller ID)"
    }
  },
  "required": []
}
```

---

### cancel_booking
- **Name:** `cancel_booking`
- **Description:** Cancel an existing booking
- **API Endpoint:** `POST` `https://calllock-server.onrender.com/webhook/retell/cancel_booking`
- **Parameters (JSON Schema):**
```json
{
  "type": "object",
  "properties": {
    "booking_uid": {
      "type": "string",
      "description": "Booking UID from lookup_booking result"
    },
    "reason": {
      "type": "string",
      "description": "Reason for cancellation"
    }
  },
  "required": []
}
```

---

### reschedule_booking
- **Name:** `reschedule_booking`
- **Description:** Reschedule an existing booking to a new time
- **API Endpoint:** `POST` `https://calllock-server.onrender.com/webhook/retell/reschedule_booking`
- **Parameters (JSON Schema):**
```json
{
  "type": "object",
  "properties": {
    "booking_uid": {
      "type": "string",
      "description": "Booking UID from lookup_booking result"
    },
    "new_date_time": {
      "type": "string",
      "description": "New ISO datetime from calendar slots"
    }
  },
  "required": ["new_date_time"]
}
```

---

### get_customer_status
- **Name:** `get_customer_status`
- **Description:** Look up customer's account history and status (appointments, recent calls, alerts)
- **API Endpoint:** `POST` `https://calllock-server.onrender.com/webhook/retell/get_customer_status`
- **Parameters (JSON Schema):**
```json
{
  "type": "object",
  "properties": {
    "phone": {
      "type": "string",
      "description": "Phone number to look up (defaults to caller ID)"
    }
  },
  "required": []
}
```

---

### send_emergency_alert
- **Name:** `send_emergency_alert`
- **Description:** Send SMS alert to dispatcher for Tier 2 urgent situations
- **API Endpoint:** `POST` `https://calllock-server.onrender.com/webhook/retell/send_emergency_alert`
- **Parameters (JSON Schema):**
```json
{
  "type": "object",
  "properties": {
    "urgency_description": {
      "type": "string",
      "description": "What makes this urgent (e.g., 'No heat, elderly in home')"
    },
    "caller_phone": {
      "type": "string",
      "description": "Customer phone number"
    },
    "address": {
      "type": "string",
      "description": "Service address"
    }
  },
  "required": ["urgency_description", "caller_phone", "address"]
}
```

---

### send_sales_lead_alert
- **Name:** `send_sales_lead_alert`
- **Description:** Send SMS alert for replacement/sales inquiries
- **API Endpoint:** `POST` `https://calllock-server.onrender.com/webhook/retell/send_sales_lead_alert`
- **Parameters (JSON Schema):**
```json
{
  "type": "object",
  "properties": {
    "customer_phone": {
      "type": "string",
      "description": "Customer phone number"
    },
    "customer_name": {
      "type": "string",
      "description": "Customer name"
    },
    "address": {
      "type": "string",
      "description": "Service address"
    },
    "current_equipment": {
      "type": "string",
      "description": "What equipment they want to replace (AC, furnace, etc.)"
    },
    "equipment_age": {
      "type": "string",
      "description": "How old is the equipment"
    },
    "notes": {
      "type": "string",
      "description": "Additional context from the call"
    }
  },
  "required": ["customer_phone"]
}
```

---

### end_call
- **Name:** `end_call`
- **Description:** End the call and save conversation data
- **API Endpoint:** `POST` `https://calllock-server.onrender.com/webhook/retell/end_call`
- **Parameters (JSON Schema):**
```json
{
  "type": "object",
  "properties": {
    "reason": {
      "type": "string",
      "description": "Call outcome reason",
      "enum": ["completed", "wrong_number", "callback_later", "safety_emergency", "urgent_escalation", "out_of_area", "waitlist_added", "customer_hangup", "sales_lead", "cancelled", "rescheduled"]
    }
  },
  "required": ["reason"]
}
```

## Business Rules

- **Diagnostic Fee:** $89 (waived if repair is done)
- **Service Area:** Austin and surrounding areas
- **Service Area ZIPs:** 78701, 78702, 78703, 78704, 78705, 78721, 78722, 78723, 78724, 78725
- **Emergency Heat Threshold:** <40°F
- **Emergency Cool Threshold:** >100°F
- **Emergency Callback Promise:** 15 minutes

## Revenue Tier Classification

Jobs are classified into revenue tiers based on high-signal keywords rather than exact dollar estimates. This is more reliable because dispatchers care about "Repair vs Replacement", not "$450 vs $475".

| Tier | Label | Color | Range | Signals |
|------|-------|-------|-------|---------|
| **$$$$** | Replacement | 🔴 Red | $5,000-$15,000+ | R-22/Freon, 15+ years, "need new system" |
| **$$$** | Major Repair | 🟠 Orange | $800-$3,000 | Compressor, heat exchanger, coil |
| **$$** | Standard Repair | 🔵 Blue | $200-$800 | Motor, capacitor, leak, ductwork |
| **$** | Maintenance | 🟢 Green | $75-$250 | Tune-up, filter, cleaning |
| **$$?** | Diagnostic | ⚪ Gray | $99 | Unknown scope, needs inspection |

**Priority Cascade:** The system checks for replacement signals FIRST. If customer says "making noise" ($) AND "20 years old" ($$$$), it correctly classifies as $$$$.

**Dashboard Payload Fields:**
- `revenue_tier`: "replacement" | "major_repair" | "standard_repair" | "minor" | "diagnostic"
- `revenue_tier_label`: "$$$$", "$$$", "$$", "$", "$$?"
- `revenue_tier_description`: "Potential Replacement", "Major Repair", etc.
- `revenue_tier_range`: "$5,000-$15,000+"
- `revenue_tier_signals`: ["R-22 system", "20+ years old"]

**Key Files:**
- `src/services/revenue-estimation.ts` - Tier classification logic
- `src/types/retell.ts` - `RevenueTier` type definition

## Development

```bash
npm run dev      # Development server with hot reload
npm run build    # TypeScript compilation
npm start        # Production server
```

## Git Workflow

**Always commit changes** so edits can be tracked and rolled back if needed.

- Commit after completing a feature or fix
- Use clear commit messages describing what changed
- Don't batch unrelated changes into one commit

## Related Projects

- **Dashboard:** `/Users/rashidbaset/Documents/calllock-dashboard`
  - Next.js app displaying call history, jobs, analytics
  - Receives data via `POST /webhook/retell/call-ended` → Supabase → Dashboard

## Key Files

| File | Purpose |
|------|---------|
| `src/server.ts` | Express server, webhook endpoints |
| `src/services/alerts.ts` | SMS alerts via Twilio |
| `src/services/dashboard.ts` | Dashboard webhook integration |
| `src/services/supabase.ts` | Call session persistence |
| `src/services/calcom.ts` | Cal.com booking API |
| `src/functions/calendar.ts` | Calendar availability logic |
| `src/functions/booking.ts` | Appointment booking logic |
| `src/functions/service-area.ts` | ZIP code validation |
