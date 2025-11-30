# CallLock Voice AI - Retell AI Migration Guide

**Original Platform:** Vapi.ai
**Target Platform:** Retell AI
**Use Case:** Outbound callback voice AI for service appointment booking (HVAC/Plumbing/Electrical)

---

## Quick Start: Two Integration Modes

Retell AI offers two integration modes. We recommend **Built-in LLM** for production:

| Mode | Latency | Complexity | Use Case |
|------|---------|------------|----------|
| **Built-in LLM** (Recommended) | ~300-800ms | Simple | Production - lowest latency |
| Custom LLM WebSocket | ~2-4s | Complex | Full control over LLM behavior |

### Current Production Setup

**Agent ID:** `agent_5fc7f25aee27c8242e8236f868`
**LLM ID:** `llm_c03ae02a9a67e733cc158e200d43`
**Model:** Claude 3.5 Haiku
**Voice:** 11labs-Myra

---

## 1. Key Concept Mapping: Vapi → Retell AI

| Vapi Concept | Retell AI Equivalent | Key Difference |
|--------------|---------------------|----------------|
| Assistant | Agent | Configuration entity for voice AI |
| System Prompt | LLM WebSocket Server | Your server handles ALL conversation logic |
| Functions | Custom Functions / Tools | Retell POSTs to your endpoint OR you handle internally |
| Server URL | `llm_websocket_url` | WebSocket connection instead of HTTP webhooks |
| End of Call Report | Post-Call Webhook | Similar concept, different payload structure |
| First Message | Initial response on WebSocket connect | Your server sends first message |
| Response Delay | `responsiveness` setting (0-1) | Lower = slower response |

### Architecture Difference

**Vapi Approach:**
```
Vapi manages conversation → Calls your webhook for functions → Returns to Vapi
```

**Retell AI LLM WebSocket Approach:**
```
Retell handles voice/transcription → Sends transcript to YOUR server →
Your server runs LLM + logic → Sends response back to Retell
```

**Key Insight:** With LLM WebSocket mode, YOU control the entire conversation logic. Retell handles:
- Speech-to-text (transcription)
- Text-to-speech (voice synthesis)
- Telephony (calls, transfers)
- Turn-taking and interruptions

You handle:
- LLM inference (Claude, GPT-4, etc.)
- Conversation flow logic
- Function/tool execution
- State management

---

## 2. Built-in LLM Approach (Recommended)

This is the simpler, lower-latency approach where Retell handles the LLM calls directly.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  TRIGGER: Customer calls business, call goes to voicemail   │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  n8n waits 1 minute, then calls Retell AI Create Call API   │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  RETELL AI HANDLES EVERYTHING:                               │
│  - Speech-to-text transcription                              │
│  - LLM inference (Claude 3.5 Haiku)                         │
│  - Text-to-speech (11labs)                                   │
│  - Function calling (end_call, etc.)                         │
└─────────────────────────────────────────────────────────────┘
```

### Step 1: Create Retell LLM

```bash
curl -X POST "https://api.retellai.com/create-retell-llm" \
  -H "Authorization: Bearer $RETELL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3.5-haiku",
    "general_prompt": "You are a friendly AI assistant for ACE Cooling, an HVAC/Plumbing/Electrical service company in Austin.\n\nCONTEXT: You are calling the customer BACK within 1 minute of their missed call.\n\nFLOW:\n1. Verify they called us\n2. If NO - apologize, end call\n3. If YES - ask what service they need\n4. Assess urgency\n5. Get address\n6. Offer appointment times\n7. Confirm and end call\n\nRULES:\n- Never quote prices\n- Keep responses under 2 sentences\n- Ask ONE question at a time",
    "general_tools": [
      {
        "type": "end_call",
        "name": "end_call",
        "description": "End the call when complete or for wrong number"
      }
    ],
    "begin_message": "Hi, this is the CallLock assistant calling from ACE Cooling. I am calling you back because you tried to reach us just a moment ago. Is this a good time?",
    "start_speaker": "agent"
  }'
```

### Step 2: Create Agent with Built-in LLM

```bash
curl -X POST "https://api.retellai.com/create-agent" \
  -H "Authorization: Bearer $RETELL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_name": "CallLock Built-in LLM Agent",
    "response_engine": {
      "type": "retell-llm",
      "llm_id": "YOUR_LLM_ID"
    },
    "voice_id": "11labs-Myra",
    "language": "en-US",
    "responsiveness": 1.0,
    "interruption_sensitivity": 0.8,
    "enable_backchannel": true
  }'
```

### Step 3: Test with Web Call

Open `test-call.html` in your browser. The agent ID is pre-configured.

### Available Models

| Model | Latency | Cost | Use Case |
|-------|---------|------|----------|
| `claude-3.5-haiku` | Fastest | Low | Production (recommended) |
| `claude-4.5-sonnet` | Medium | Higher | Complex reasoning |
| `gpt-4.1-mini` | Fast | Low | Alternative to Claude |
| `gpt-4.1` | Slower | Higher | Complex tasks |

---

## 3. Custom LLM WebSocket Approach (Advanced)

Use this approach when you need full control over the LLM behavior, custom tool execution, or integration with your own backend.

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  TRIGGER: Customer calls business, call goes to voicemail   │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  Twilio detects missed call, triggers n8n webhook           │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  n8n waits 1 minute, then calls Retell AI Create Call API   │
│  POST https://api.retellai.com/v2/create-phone-call         │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  RETELL AI CONNECTS TO YOUR LLM WEBSOCKET SERVER            │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Your Server (Node.js/Python):                         │ │
│  │ 1. Receives call_details event                        │ │
│  │ 2. Sends initial greeting (outbound context)          │ │
│  │ 3. Receives transcripts via response_required events  │ │
│  │ 4. Calls Claude/GPT-4 with system prompt + history    │ │
│  │ 5. Executes functions (calendar, booking) internally  │ │
│  │ 6. Sends response events back to Retell               │ │
│  │ 7. Handles end_call when conversation completes       │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  Retell Post-Call Webhook to n8n:                           │
│  - Log to Google Sheets                                     │
│  - Send SMS to owner                                        │
│  - Send email summary                                       │
└─────────────────────────────────────────────────────────────┘
```

---

### Step-by-Step Migration (Custom LLM)

### Step 1: Set Up Retell AI Account & Phone Number

1. Go to [retellai.com](https://www.retellai.com) and create account
2. Navigate to **Phone Numbers** → **Buy Number** (or import existing)
3. Note: For outbound-only, you can leave `inbound_agent_id` unset

### Step 2: Create Your LLM WebSocket Server

You need a server that:
- Accepts WebSocket connections from Retell
- Processes transcripts and generates responses using Claude/GPT-4
- Handles function calls (calendar, booking) internally
- Returns responses in Retell's expected format

**Option A: Use Retell's Node.js Demo as Base**
```bash
git clone https://github.com/RetellAI/retell-custom-llm-node-demo
cd retell-custom-llm-node-demo
npm install
```

**Option B: Use Retell's Python Demo as Base**
```bash
git clone https://github.com/RetellAI/retell-custom-llm-python-demo
cd retell-custom-llm-python-demo
pip install -r requirements.txt
```

### Step 3: Configure Environment Variables

Create `.env` file:
```env
# Retell AI
RETELL_API_KEY=key_2d22013d18c09d647b1904f78f35

# LLM Provider (choose one)
ANTHROPIC_API_KEY=your_anthropic_key
# OR
OPENAI_API_KEY=your_openai_key

# n8n Webhooks (for calendar/booking)
N8N_WEBHOOK_BASE_URL=https://your-n8n-domain.com/webhook

# Business Configuration
BUSINESS_NAME=ACE Cooling
SERVICE_TYPES=HVAC,Plumbing,Electrical
SERVICE_AREA=Austin and surrounding areas
```

### Step 4: Implement WebSocket Handler

Here's the core WebSocket protocol you need to implement:

#### Events FROM Retell (handle these):

```typescript
// 1. ping_pong - Keep connection alive
{
  "interaction_type": "ping_pong",
  "timestamp": 1703302407333
}

// 2. call_details - Sent on connection (if enabled)
{
  "interaction_type": "call_details",
  "call": { /* call object with metadata */ }
}

// 3. response_required - User said something, respond!
{
  "interaction_type": "response_required",
  "response_id": 1,
  "transcript": [
    {"role": "agent", "content": "Hi, this is..."},
    {"role": "user", "content": "Yes, my AC is broken!"}
  ]
}

// 4. update_only - Transcript update, no response needed
{
  "interaction_type": "update_only",
  "transcript": [...]
}

// 5. reminder_required - User is silent, send reminder
{
  "interaction_type": "reminder_required",
  "response_id": 2
}
```

#### Events TO Retell (send these):

```typescript
// 1. config - Send immediately on connection
{
  "response_type": "config",
  "config": {
    "auto_reconnect": true,
    "call_details": true
  }
}

// 2. response - Your agent's reply (can stream)
{
  "response_type": "response",
  "response_id": 1,  // Match the request
  "content": "I understand your AC is broken. Let me help...",
  "content_complete": true,
  "end_call": false
}

// 3. response with end_call - Terminate after speaking
{
  "response_type": "response",
  "response_id": 5,
  "content": "Thank you for choosing ACE Cooling. Goodbye!",
  "content_complete": true,
  "end_call": true  // Hangs up after speaking
}
```

### Step 5: Implement CallLock Conversation Logic

Your server needs to:

1. **Send Initial Greeting** (on WebSocket connect):
```typescript
// First message after connection established
const initialGreeting = {
  response_type: "response",
  response_id: 0,
  content: "Hi, this is the CallLock assistant calling from ACE Cooling. I'm calling you back because you tried to reach us just a moment ago. Is this a good time?",
  content_complete: true,
  end_call: false
};
ws.send(JSON.stringify(initialGreeting));
```

2. **Process Transcripts with Claude**:
```typescript
async function generateResponse(transcript: Message[], responseId: number) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    system: CALLLOCK_SYSTEM_PROMPT,  // Same prompt from Vapi guide
    messages: transcript.map(t => ({
      role: t.role === "agent" ? "assistant" : "user",
      content: t.content
    }))
  });

  return {
    response_type: "response",
    response_id: responseId,
    content: response.content[0].text,
    content_complete: true,
    end_call: shouldEndCall(response)  // Check for end conditions
  };
}
```

3. **Handle Function Calls Internally**:

Unlike Vapi where functions are called via webhooks, with LLM WebSocket mode you handle functions in your server:

```typescript
// When Claude returns a tool_use block
if (response.stop_reason === "tool_use") {
  const toolUse = response.content.find(c => c.type === "tool_use");

  // Execute function
  let result;
  switch (toolUse.name) {
    case "checkCalendarAvailability":
      result = await checkCalendar(toolUse.input);
      break;
    case "bookAppointment":
      result = await bookAppointment(toolUse.input);
      break;
    case "endCall":
      // Set end_call: true in next response
      break;
  }

  // Continue conversation with function result
  const followUp = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    system: CALLLOCK_SYSTEM_PROMPT,
    messages: [
      ...transcript,
      { role: "assistant", content: response.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(result) }] }
    ]
  });
}
```

### Step 6: Create Retell AI Agent

**Via Dashboard:**
1. Go to Retell Dashboard → **Agents** → **Create Agent**
2. Select **Custom LLM** option
3. Enter your WebSocket URL: `wss://your-server.com/llm-websocket`
4. Configure voice settings (11Labs recommended)

**Via API:**
```bash
curl -X POST https://api.retellai.com/v2/create-agent \
  -H "Authorization: Bearer $RETELL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_name": "CallLock Service Appointment Agent",
    "llm_websocket_url": "wss://your-server.com/llm-websocket",
    "voice_id": "eleven_labs_voice_id",
    "voice_model": "eleven_turbo_v2",
    "responsiveness": 0.7,
    "interruption_sensitivity": 0.5,
    "enable_backchannel": true,
    "language": "en-US"
  }'
```

### Step 7: Assign Agent to Phone Number

```bash
curl -X PATCH https://api.retellai.com/v2/update-phone-number/{phone_number_id} \
  -H "Authorization: Bearer $RETELL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "outbound_agent_id": "your_agent_id"
  }'
```

### Step 8: Update n8n Workflow for Retell AI

**Change 1: Trigger Outbound Call (was Vapi, now Retell)**

Old Vapi call:
```json
POST https://api.vapi.ai/call
{
  "assistantId": "YOUR_ASSISTANT_ID",
  "phoneNumber": "+15125551234"
}
```

New Retell call:
```json
POST https://api.retellai.com/v2/create-phone-call
{
  "from_number": "+1YOUR_RETELL_NUMBER",
  "to_number": "+15125551234",
  "agent_id": "YOUR_AGENT_ID",
  "metadata": {
    "missed_call_time": "2025-11-26T10:30:00Z",
    "source": "missed_call_callback"
  }
}
```

**Change 2: Post-Call Webhook**

Retell sends different payload structure. Update your n8n webhook to handle:

```json
{
  "event": "call_ended",
  "call": {
    "call_id": "call_abc123",
    "agent_id": "agent_xyz",
    "call_status": "ended",
    "start_timestamp": 1703302407000,
    "end_timestamp": 1703302650000,
    "transcript": "Full conversation transcript...",
    "recording_url": "https://...",
    "call_analysis": {
      "call_summary": "Customer called about AC repair...",
      "user_sentiment": "positive"
    },
    "metadata": {
      "missed_call_time": "2025-11-26T10:30:00Z"
    }
  }
}
```

---

### Function Implementation (Internal to Your Server)

Since you control the LLM, implement functions directly in your server:

### checkCalendarAvailability

```typescript
async function checkCalendarAvailability(params: {
  urgency: "Emergency" | "Urgent" | "Routine" | "Estimate";
  preferredDate?: string;
}) {
  // Option A: Call n8n webhook
  const response = await fetch(`${N8N_WEBHOOK_BASE_URL}/calendar/availability`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params)
  });
  return response.json();

  // Option B: Call Google Calendar API directly
  // const calendar = google.calendar({ version: 'v3', auth });
  // ...
}
```

### bookAppointment

```typescript
async function bookAppointment(params: {
  dateTime: string;
  customerName: string;
  customerPhone: string;
  serviceAddress: string;
  serviceType: string;
  urgency: string;
  problemDescription: string;
}) {
  // Call n8n webhook to create calendar event + log to sheets
  const response = await fetch(`${N8N_WEBHOOK_BASE_URL}/appointments/book`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params)
  });
  return response.json();
}
```

### Tool Definitions for Claude

```typescript
const tools = [
  {
    name: "checkCalendarAvailability",
    description: "Check available appointment slots based on urgency level",
    input_schema: {
      type: "object",
      properties: {
        urgency: {
          type: "string",
          enum: ["Emergency", "Urgent", "Routine", "Estimate"],
          description: "Urgency level of the service request"
        },
        preferredDate: {
          type: "string",
          description: "Customer's preferred date (YYYY-MM-DD)"
        }
      },
      required: ["urgency"]
    }
  },
  {
    name: "bookAppointment",
    description: "Book a confirmed service appointment",
    input_schema: {
      type: "object",
      properties: {
        dateTime: { type: "string" },
        customerName: { type: "string" },
        customerPhone: { type: "string" },
        serviceAddress: { type: "string" },
        serviceType: { type: "string", enum: ["HVAC", "Plumbing", "Electrical"] },
        urgency: { type: "string" },
        problemDescription: { type: "string" }
      },
      required: ["dateTime", "customerPhone", "serviceAddress", "serviceType", "problemDescription"]
    }
  },
  {
    name: "endCall",
    description: "End the call (wrong number, safety emergency, or completed)",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          enum: ["wrong_number", "callback_later", "safety_emergency", "completed"]
        }
      },
      required: ["reason"]
    }
  }
];
```

---

## 4. System Prompt

The system prompt from the original guide works with Claude in your WebSocket server. Copy the entire prompt from Section 5 of `retell-implementation-guide.md`.

Key customizations:
- Replace `[BUSINESS_NAME]` with actual business name
- Replace `[SERVICE_TYPE]` with services offered
- Replace `[SERVICE_AREA]` with coverage area

---

## 5. n8n Webhook Updates Summary

| Webhook | Old (Vapi) | New (Retell) |
|---------|------------|--------------|
| Function calls during call | `POST /webhook/vapi/functions` | **Handled in your WebSocket server** |
| Post-call data | `POST /webhook/vapi/call-completed` | `POST /webhook/retell/call-ended` |
| Trigger outbound call | `POST api.vapi.ai/call` | `POST api.retellai.com/v2/create-phone-call` |

### Updated n8n Workflow: "Missed Call → Outbound Callback"

```
[Twilio Webhook: Missed Call]
  ↓
[Wait 1 Minute]
  ↓
[HTTP Request: Retell Create Phone Call]
  - Method: POST
  - URL: https://api.retellai.com/v2/create-phone-call
  - Headers:
      Authorization: Bearer YOUR_RETELL_API_KEY
      Content-Type: application/json
  - Body:
    {
      "from_number": "+1YOUR_RETELL_NUMBER",
      "to_number": "{{$json.From}}",
      "agent_id": "YOUR_AGENT_ID",
      "metadata": {
        "missed_call_time": "{{$json.timestamp}}",
        "original_call_sid": "{{$json.CallSid}}"
      }
    }
```

### Updated n8n Workflow: "Retell Post-Call Handler"

```
[Webhook Trigger: /webhook/retell/call-ended]
  ↓
[Parse Retell Payload]
  - Extract: call.transcript, call.call_analysis.call_summary, call.metadata
  ↓
[Parallel Processing]
  ├─ [Google Sheets: Log Call]
  ├─ [Twilio SMS: Notify Owner]
  └─ [Gmail: Send Email Summary]
```

---

## 6. Deployment Options

### Option A: Railway (Recommended for Quick Start)
```bash
# Deploy Node.js server
railway login
railway init
railway up
# Note the URL: your-app.railway.app
# WebSocket URL: wss://your-app.railway.app/llm-websocket
```

### Option B: Render
```bash
# Create Web Service on render.com
# Point to your repo
# WebSocket URL: wss://your-service.onrender.com/llm-websocket
```

### Option C: AWS/GCP/Azure
- Use EC2/Compute Engine/VM
- Ensure WebSocket support (not all load balancers support it)
- Use Application Load Balancer with WebSocket sticky sessions

### Development with ngrok
```bash
# For local testing
ngrok http 8080
# WebSocket URL: wss://abc123.ngrok.io/llm-websocket
```

---

## 7. Cost Comparison

| Component | Vapi | Retell AI (Custom LLM) |
|-----------|------|------------------------|
| Base platform | $0.05/min | $0.07-0.09/min |
| Voice (11Labs) | +$0.03/min | Included in base |
| LLM (Claude) | +$0.02-0.04/min | **You pay directly** |
| Transcription | +$0.01/min | Included in base |
| **Total** | ~$0.11-0.13/min | ~$0.09-0.11/min |

**Note:** With Custom LLM mode, you pay Anthropic/OpenAI directly for LLM usage, which can be cheaper at scale.

---

## 8. Testing Checklist

- [ ] WebSocket server connects successfully
- [ ] Initial greeting plays on call connect
- [ ] Transcripts are received and processed
- [ ] Claude generates appropriate responses
- [ ] Function calls work (calendar check, booking)
- [ ] Call ends properly with `end_call: true`
- [ ] Post-call webhook fires to n8n
- [ ] Google Sheets logs call data
- [ ] Owner receives SMS notification
- [ ] Owner receives email summary

### Test Scenarios (Same as Vapi Guide)

1. **Emergency HVAC** - Verify emergency flow, skips intake questions
2. **Routine Plumbing** - Full flow with all intake questions
3. **Safety Escalation** - Provides safety instructions, ends immediately
4. **Wrong Number** - Apologizes and ends call

---

## 9. Quick Reference: API Endpoints

### Retell AI API

| Action | Endpoint |
|--------|----------|
| Create phone call | `POST https://api.retellai.com/v2/create-phone-call` |
| Create agent | `POST https://api.retellai.com/v2/create-agent` |
| Update agent | `PATCH https://api.retellai.com/v2/update-agent/{agent_id}` |
| Get call details | `GET https://api.retellai.com/v2/get-call/{call_id}` |
| List calls | `GET https://api.retellai.com/v2/list-calls` |

### Your WebSocket Server

| Route | Purpose |
|-------|---------|
| `wss://your-server/llm-websocket` | Retell connects here for LLM |
| `POST /health` | Health check endpoint |

### n8n Webhooks

| Route | Purpose |
|-------|---------|
| `POST /webhook/retell/call-ended` | Post-call processing |
| `POST /webhook/calendar/availability` | Check calendar (called by your server) |
| `POST /webhook/appointments/book` | Book appointment (called by your server) |

---

## 10. Troubleshooting

### WebSocket Connection Fails
- Verify URL format: `wss://` not `https://`
- Check server is publicly accessible
- Verify no firewall blocking WebSocket connections
- Check Retell dashboard for connection errors

### No Response from Agent
- Check your server logs for incoming events
- Verify you're sending `response_type: "response"` with matching `response_id`
- Ensure `content_complete: true` is set

### Call Doesn't End
- Verify `end_call: true` is set in final response
- Check Claude is calling the `endCall` function appropriately

### High Latency
- Optimize LLM call (use streaming if possible)
- Check server location (closer to Retell = better)
- Monitor with `auto_reconnect` ping/pong latency tracking

---

## Sources

- [Retell AI Custom LLM Overview](https://docs.retellai.com/integrate-llm/overview)
- [Retell AI LLM WebSocket API Reference](https://docs.retellai.com/api-references/llm-websocket)
- [Retell Custom LLM Node.js Demo](https://github.com/RetellAI/retell-custom-llm-node-demo)
- [Retell Custom LLM Python Demo](https://github.com/RetellAI/retell-custom-llm-python-demo)
- [Retell AI Create Phone Call API](https://docs.retellai.com/api-references/create-phone-call)
- [Retell AI Custom Functions](https://docs.retellai.com/build/single-multi-prompt/custom-function)
- [n8n Retell Voice Agent Template](https://n8n.io/workflows/3805-connect-retell-voice-agents-to-custom-functions/)
