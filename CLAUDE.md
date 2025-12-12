# CallLock HVAC - Retell Webhook Server

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
3. If they describe a problem → get their ZIP code first
4. Call validate_service_area with the ZIP
5. If in service area → ask for phone number → call check_calendar_availability
6. Present slots as either/or: "[Day] at [time] or [Day] at [time]—which works?"
7. When they choose → get address → call book_appointment
8. Confirm booking → call end_call

TIER 1 EMERGENCY (gas smell, CO alarm, burning smell, smoke):
→ "Please leave the house immediately and call 911 from outside."
→ Call end_call(reason="safety_emergency") immediately

TIER 2 URGENT (no heat <40°F, no AC >100°F, grinding noise, ice, water leak):
→ "I understand this is urgent—let me see what we can do right now."
→ Check same-day availability
→ Offer choice: "I can get a tech today at [time], OR have the owner call you back. Which works?"

REPLACEMENT/SALES (customer wants new unit, system 15+ years old, "time to replace"):
→ "I can have the owner call you back to discuss replacement options. Let me get your information."
→ Collect: name, phone, address, what equipment, how old
→ Call send_sales_lead_alert with the details
→ "Great, the owner will call you back shortly to discuss your options."
→ Call end_call(reason="sales_lead")

RULES:
- NEVER include parenthetical notes or internal reasoning—everything is spoken aloud
- Keep responses SHORT (1-2 sentences max)
- Ask ONE question at a time
- Don't repeat phone/address back—just say "Got it"
- MUST call end_call to end every conversation
- Use exact isoDateTime from calendar slots when booking

PRICE QUESTIONS:
- "$89 for the diagnostic—includes full system check, and it's waived if you do the repair."

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

### `POST /webhook/retell/end_call`
Saves conversation state to Supabase before call ends.
- **Args:** `{ reason, customer_name?, customer_phone?, customer_address?, problem_description?, urgency?, ... }`
- **Returns:** `{ success: boolean, reason }`

### `POST /webhook/retell/call-ended`
Post-call webhook (called by Retell after call ends). Syncs data to dashboard.
- **Body:** Retell post-call payload with transcript, analysis, etc.
- **Returns:** `{ success: boolean, job_id? }`

## Business Rules

- **Diagnostic Fee:** $89 (waived if repair is done)
- **Service Area:** Austin and surrounding areas
- **Service Area ZIPs:** 78701, 78702, 78703, 78704, 78705, 78721, 78722, 78723, 78724, 78725
- **Emergency Heat Threshold:** <40°F
- **Emergency Cool Threshold:** >100°F
- **Emergency Callback Promise:** 15 minutes

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
