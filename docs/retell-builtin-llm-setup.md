# Retell Built-in LLM Setup Guide

This guide explains how to switch from the Custom LLM (WebSocket) to Retell's Built-in LLM for faster response times.

## Why Switch?

| Aspect | Custom LLM | Retell Built-in LLM |
|--------|------------|---------------------|
| Latency | ~2-3 seconds | ~500ms |
| Control | Full control over prompts & tools | Retell manages LLM calls |
| Infrastructure | Your server + Claude/OpenAI | Retell's optimized infrastructure |
| Tool Execution | Server-side | Webhook-based |

## Setup Steps

### Step 1: Create Tool Webhook Endpoint

Your server needs to handle tool calls via webhooks. The endpoint is already implemented at:
```
POST /webhook/retell/tool-call
```

### Step 2: Configure Agent in Retell Dashboard

1. Go to **Retell Dashboard** → **Agents**
2. Select your agent (or create a new one)
3. Under **LLM Configuration**:
   - Change from **Custom LLM** to **Retell LLM**
   - Select model: **GPT-4o** or **Claude 3.5 Sonnet**

### Step 3: Set the System Prompt

Copy this prompt into the **System Prompt** field:

```
You are a friendly AI assistant for {{business_name}}, an HVAC service company in {{service_area}}.

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

### Step 4: Configure Tools

Add these tools in the **Functions** section:

#### Tool 1: validate_service_area
```json
{
  "name": "validate_service_area",
  "description": "Check if a ZIP code is within the service area. Always call this before checking calendar availability.",
  "parameters": {
    "type": "object",
    "properties": {
      "zip_code": {
        "type": "string",
        "description": "5-digit ZIP code to validate"
      }
    },
    "required": ["zip_code"]
  }
}
```

#### Tool 2: check_calendar_availability
```json
{
  "name": "check_calendar_availability",
  "description": "Check available appointment slots. Call after validating service area.",
  "parameters": {
    "type": "object",
    "properties": {
      "urgency": {
        "type": "string",
        "enum": ["Emergency", "Urgent", "Routine", "Estimate"],
        "description": "Urgency level of the service request"
      },
      "preferred_date": {
        "type": "string",
        "description": "Customer's preferred date in YYYY-MM-DD format (optional)"
      }
    },
    "required": ["urgency"]
  }
}
```

#### Tool 3: book_appointment
```json
{
  "name": "book_appointment",
  "description": "Book a confirmed appointment after customer selects a time slot.",
  "parameters": {
    "type": "object",
    "properties": {
      "date_time": {
        "type": "string",
        "description": "Use the exact isoDateTime from the selected calendar slot"
      },
      "customer_name": {
        "type": "string",
        "description": "Customer's full name (if provided)"
      },
      "customer_phone": {
        "type": "string",
        "description": "Customer's phone number"
      },
      "service_address": {
        "type": "string",
        "description": "Full service address including street, city, state, zip"
      },
      "urgency": {
        "type": "string",
        "enum": ["Emergency", "Urgent", "Routine", "Estimate"],
        "description": "Urgency level"
      },
      "problem_description": {
        "type": "string",
        "description": "Brief description of the HVAC problem"
      }
    },
    "required": ["date_time", "customer_phone", "service_address", "problem_description"]
  }
}
```

#### Tool 4: send_emergency_alert
```json
{
  "name": "send_emergency_alert",
  "description": "Send urgent SMS alert to dispatcher for urgent situations.",
  "parameters": {
    "type": "object",
    "properties": {
      "urgency_description": {
        "type": "string",
        "description": "Brief description of the urgent situation"
      },
      "caller_phone": {
        "type": "string",
        "description": "Customer's callback phone number"
      },
      "address": {
        "type": "string",
        "description": "Service address"
      }
    },
    "required": ["urgency_description", "caller_phone", "address"]
  }
}
```

#### Tool 5: end_call
```json
{
  "name": "end_call",
  "description": "End the call. MUST be called to end every conversation. Pass any customer info collected.",
  "parameters": {
    "type": "object",
    "properties": {
      "reason": {
        "type": "string",
        "enum": ["wrong_number", "callback_later", "safety_emergency", "urgent_escalation", "out_of_area", "waitlist_added", "completed"],
        "description": "Reason for ending the call"
      },
      "customer_name": {
        "type": "string",
        "description": "Customer's name if collected during the call"
      },
      "customer_phone": {
        "type": "string",
        "description": "Customer's phone if different from caller ID"
      },
      "customer_address": {
        "type": "string",
        "description": "Service address if collected"
      },
      "problem_description": {
        "type": "string",
        "description": "Brief description of their HVAC issue"
      },
      "urgency": {
        "type": "string",
        "enum": ["Emergency", "Urgent", "Routine", "Estimate"],
        "description": "Urgency level if determined"
      }
    },
    "required": ["reason"]
  }
}
```

### Step 5: Configure API Endpoints for Each Tool

Each function needs its own API endpoint URL:

| Function | API Endpoint |
|----------|-------------|
| validate_service_area | `https://calllock-server.onrender.com/webhook/retell/validate_service_area` |
| check_calendar_availability | `https://calllock-server.onrender.com/webhook/retell/check_calendar_availability` |
| book_appointment | `https://calllock-server.onrender.com/webhook/retell/book_appointment` |
| send_emergency_alert | `https://calllock-server.onrender.com/webhook/retell/send_emergency_alert` |
| end_call | `https://calllock-server.onrender.com/webhook/retell/end_call` |

### Step 5b: Configure Post-Call Webhook (IMPORTANT!)

**This is required for the CallLock Dashboard to receive call data.**

1. Go to **Retell Dashboard** → **Agent Settings** → **Webhooks**
2. Find **Post-Call Webhook URL** and set it to:
   ```
   https://calllock-server.onrender.com/webhook/retell/call-ended
   ```
3. This webhook fires after each call ends with the full transcript and call analysis

Without this configuration, calls will be tracked in Supabase but will NOT sync to the CallLock Dashboard.

### Step 6: Set Greeting Message

Under **General Settings** → **Begin Message**:
```
Thanks for calling ACE Cooling! What's going on with your AC or heating?
```

### Step 7: Configure Caller ID Phone Skip (Optional)

To automatically skip asking for phone number when caller ID is available:

1. In **Agent Settings** → **General** → **Dynamic Variables**, add:
   - Variable name: `customer_phone`
   - Value: `{{call.from_number}}` (for inbound calls)

2. Update the system prompt to include this line after the FLOW section:
```
CALLER ID: Customer phone from caller ID: {{customer_phone}}. If this has a value (not empty), do NOT ask for their phone number—skip directly to checking calendar availability.
```

This prevents the AI from asking "What's the best number to reach you?" when the phone is already captured from caller ID.

## Environment Variables

Make sure these are set on your Render server:

| Variable | Description | Example |
|----------|-------------|---------|
| `BUSINESS_NAME` | Company name | ACE Cooling |
| `SERVICE_AREA` | Service area description | Austin and surrounding areas |
| `SERVICE_AREA_ZIPS` | Comma-separated ZIP codes | 78701,78702,78703 |
| `DIAGNOSTIC_FEE` | Diagnostic fee in dollars | 89 |
| `EMERGENCY_SMS_NUMBER` | Phone for urgent alerts | +15125559999 |
| `CAL_COM_API_KEY` | Cal.com API key | cal_live_xxx |

## Testing

1. Use Retell's **Test Call** feature in the dashboard
2. Test scenarios:
   - Routine booking flow
   - Out of service area
   - Urgent call with same-day booking
   - Background noise handling

## Rollback

To switch back to Custom LLM:
1. Go to Agent Settings
2. Change LLM type back to **Custom LLM**
3. Set WebSocket URL: `wss://calllock-server.onrender.com/llm-websocket`
