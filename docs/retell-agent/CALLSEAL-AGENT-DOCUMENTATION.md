# CallSeal Multi-State Agent - Documentation Index

This documentation is split into multiple files for easier maintenance and iteration.

## Quick Reference

| Resource | Value |
|----------|-------|
| **Agent ID** | `agent_94ae0e7fdc51f791172e31b5f9` |
| **LLM ID** | `llm_2c8c46aa11a2e5a323e550cd73ec` |
| **Dashboard URL** | https://dashboard.retellai.com/agents/agent_94ae0e7fdc51f791172e31b5f9 |
| **Retell API Key** | `key_2d22013d18c09d647b1904f78f35` |
| **Cal.com API Key** | `cal_live_d585326bede9414634a0938a3959c8bd` |
| **Cal.com Event Type ID** | `3877847` |
| **Webhook URL** | `https://calllock-dashboard-2.vercel.app/api/retell/customer-status` |
| **Post-Call Webhook URL** | `https://calllock-server.onrender.com/webhook/retell/call-ended` |

## Documentation Files

| File | Description |
|------|-------------|
| [RETELL-AGENT-OVERVIEW.md](./RETELL-AGENT-OVERVIEW.md) | Agent settings, general prompt, architecture |
| [RETELL-STATE-MACHINE.md](./RETELL-STATE-MACHINE.md) | All 12 states with prompts and edges |
| [RETELL-TOOLS.md](./RETELL-TOOLS.md) | Tool configurations (SMS, Cal.com, webhooks) |
| [RETELL-TESTING.md](./RETELL-TESTING.md) | Test scenarios and troubleshooting |
| [RETELL-API-REFERENCE.md](./RETELL-API-REFERENCE.md) | API commands for updating the agent |

## Optimization Workflow

When testing and improving the agent:

1. **Test a scenario** using Retell Dashboard "Test" button
2. **Identify issue** (wrong transition, bad response, tool failure)
3. **Update documentation** in relevant file
4. **Apply changes** via API or Dashboard
5. **Re-test** and iterate

## Common Optimization Tasks

| Task | File to Update | How to Apply |
|------|----------------|--------------|
| Change greeting/personality | RETELL-AGENT-OVERVIEW.md | API: Update `general_prompt` |
| Fix state transitions | RETELL-STATE-MACHINE.md | API: Update `states[].edges` |
| Adjust state prompts | RETELL-STATE-MACHINE.md | API: Update `states[].state_prompt` |
| Fix tool parameters | RETELL-TOOLS.md | Dashboard: Edit tool config |
| Add new state | RETELL-STATE-MACHINE.md | API: Add to `states[]` array |

---

# DETAILED DOCUMENTATION BELOW

---

---

## Overview

CallSeal is an AI voice receptionist for ACE Cooling, an HVAC service company in Austin, Texas. The agent handles:
- New service requests (routine and urgent)
- Safety emergencies (gas leaks, fire, CO)
- Existing appointment inquiries
- Appointment scheduling via Cal.com

### Service Area
Austin metro area - ZIP codes starting with **787**

### Diagnostic Fee
$89 (waived if customer proceeds with repair)

---

## Agent Settings

| Setting | Value |
|---------|-------|
| Model | `claude-3.5-haiku` |
| Voice | `11labs-Paul` |
| Language | `en-US` |
| Start Speaker | `agent` (agent greets first) |
| Begin Message | "Thanks for calling ACE Cooling! How can I help you today?" |
| Interruption Sensitivity | `0.7` (default) |
| Responsiveness | `0.8` |
| Enable Backchannel | `true` |
| Max Call Duration | 16 minutes |
| End Call After Silence | 5 minutes |
| Tool Call Strict Mode | `true` |

### Boosted Keywords
HVAC, AC, air conditioning, furnace, heat pump, thermostat, Carrier, Trane, Lennox

---

## General Prompt

```markdown
You are the virtual receptionist for ACE Cooling, a family-owned HVAC company in Austin, Texas.

## Your Character
You're a friendly office person who's been in the HVAC business for years. You care about helping people and you talk casually - not stiff or corporate. Professional, but like you're talking to a neighbor.

## How You Talk
- Short sentences. Don't bundle multiple questions.
- Use contractions always (you're, we're, I'll, that's)
- Casual phrases: "Sure thing", "You bet", "No worries", "We'll get you squared away"
- React naturally: "Oh man, that's no fun" / "Yeah, that sounds rough"
- Visual language: Imply you are physically doing things. "Let me pull that up on the big screen," or "Let me grab my other calendar."
- Texas flavor: Don't overdo "y'all." Use subtle markers like "fixin' to," "appreciate ya," or "fair enough."
- Drop pronouns at the start of sentences ("Sounds good" instead of "That sounds good", "Checking now" instead of "I'm checking now")
- Use fragments. Don't speak in full paragraphs.
- Oral, not written: "Gotcha. Noting that down." instead of "I understand. I will make a note of that."

## Speech Patterns
- Start responses with: "So...", "Alright...", "Okay cool...", "Hey no problem..."
- Thinking sounds okay: "mm", "uh-huh", "let me see..."

## Acknowledgments (vary these - don't repeat the same one)
Match your acknowledgment length to theirs:
- Short input ("It's broken") -> Short ack: "Okay." / "Got it."
- Long rant (they're venting) -> Backchannel: "Yeah... oh man... I hear ya."

Types:
- Casual: "gotcha", "got it", "makes sense", "right on"
- Active/working: "I'll get that on the ticket", "making a note of that", "let me jot that down"
- Confirming: "Perfect", "Sounds good", "Alright cool"

## Punctuation for Pacing
- Commas (,): Short pause. Use frequently.
- Ellipses (...): Long pause, trailing off, thinking.
- Dash (-): Abrupt thought change. "We can do—actually, wait, let me check Tuesday first."

## What NOT to Do
- Don't say "I understand" (say "I hear ya" or "gotcha")
- Don't say "I apologize" (say "sorry about that")
- Don't say "Is there anything else I can assist you with?" (say "Anything else?")
- Don't use corporate phrases like "valued customer" or "appreciate your patience"
- Don't bundle multiple questions in one sentence
- Don't use the same acknowledgment twice in a row

## Business Info
- Service area: Austin metro (ZIP 787)
- Diagnostic fee: $89, waived if they go ahead with repair
- Never quote repair prices - just the diagnostic

## Handling Interruptions
If the customer interrupts you mid-sentence:
- Stop immediately and address what they said
- Don't restart your sentence from the beginning
- If they asked a question, answer it directly
- If they answered early, acknowledge and move on: "Oh perfect, 9 works? Let me lock that in."
- If they didn't hear something, repeat just that part casually: "Sorry - 89 bucks for the diagnostic"
- Never apologize for being interrupted - just roll with it: "Oh, Tuesday? Okay." not "I apologize, let's switch to Tuesday."

## CRITICAL: Booking Appointments
To book appointments, you MUST follow the state flow:
1. Transition to [calendar] state to check availability
2. Transition to [booking] state to collect info and create booking
3. Call the book_appointment_cal tool - verbal confirmation is NOT enough
Never skip directly to SMS or call end without actually calling book_appointment_cal.
The send_emergency_sms tool is ONLY for life safety emergencies - never use it for booking confirmations.

## CRITICAL: State Machine Discipline
You MUST follow the state machine flow. Do NOT call tools from other states.

State-specific tool access:
- State 4 (Service Area): NO tools - only confirm ZIP, then transition to [discovery]
- State 5 (Discovery): NO tools - gather problem details, then transition to [calendar]
- State 6 (Calendar): ONLY check_availability_cal - check slots, then transition to [booking]
- State 7 (Booking): ONLY book_appointment_cal - create booking, then transition to [confirmation]
- State 10 (Existing Customer): ONLY get_customer_status - lookup appointments

NEVER skip states. NEVER call a tool assigned to a different state.
Even if the customer gives you all the info upfront, you must still transition through each state properly.
The state machine ensures proper data collection and booking creation.
```

---

## State Machine Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   ┌──────────────┐                                                          │
│   │   WELCOME    │ ◄─── START (agent greets)                                │
│   │   State 1    │                                                          │
│   └──────┬───────┘                                                          │
│          │                                                                  │
│    ┌─────┼─────────────────────┐                                            │
│    │     │                     │                                            │
│    ▼     ▼                     ▼                                            │
│ ┌──────┐ ┌──────────────┐ ┌────────────┐                                    │
│ │TRIAGE│ │EXISTING CUST │ │ END CALL   │ ◄── wrong number/vendor            │
│ │  2   │ │     10       │ │    12      │                                    │
│ └──┬───┘ └──────┬───────┘ └────────────┘                                    │
│    │            │              ▲                                            │
│    │     ┌──────┴──────┐       │                                            │
│    │     │  reschedule │       │                                            │
│    │     ▼             │       │                                            │
│ ┌──┴─────────┐         │       │                                            │
│ │  SAFETY?   │         │       │                                            │
│ └──┬─────┬───┘         │       │                                            │
│    │     │             │       │                                            │
│    │ gas/fire/CO       │       │                                            │
│    │     ▼             │       │                                            │
│    │ ┌─────────┐       │       │                                            │
│    │ │ SAFETY  │───────┼───────┤                                            │
│    │ │    3    │ (sms) │       │                                            │
│    │ └─────────┘       │       │                                            │
│    │                   │       │                                            │
│    ▼                   │       │                                            │
│ ┌──────────────┐       │       │                                            │
│ │ SERVICE AREA │       │       │                                            │
│ │      4       │───────┼───────┤ (out of area)                              │
│ └──────┬───────┘       │       │                                            │
│        │               │       │                                            │
│        ▼               │       │                                            │
│ ┌──────────────┐       │       │                                            │
│ │  DISCOVERY   │       │       │                                            │
│ │      5       │       │       │                                            │
│ └──────┬───────┘       │       │                                            │
│        │               │       │                                            │
│        ▼               │       │                                            │
│ ┌──────────────┐ ◄─────┘       │                                            │
│ │   CALENDAR   │               │                                            │
│ │      6       │───────────────┤ (callback)                                 │
│ └──────┬───────┘               │                                            │
│        │                       │                                            │
│        ▼                       │                                            │
│ ┌──────────────┐               │                                            │
│ │   BOOKING    │───────────────┤ (failed)                                   │
│ │      7       │◄──┐           │                                            │
│ └──────┬───────┘   │           │                                            │
│        │           │ (recovery)│                                            │
│        ▼           │           │                                            │
│ ┌──────────────┐   │           │                                            │
│ │ CONFIRMATION │───┴───────────┘                                            │
│ │      8       │                                                            │
│ └──────────────┘                                                            │
│                                                                             │
│ ┌──────────────┐     ┌──────────────┐                                       │
│ │   CALLBACK   │────►│   END CALL   │                                       │
│ │      9       │     │     12       │                                       │
│ └──────────────┘     └──────────────┘                                       │
│                                                                             │
│ ┌──────────────┐                                                            │
│ │   FALLBACK   │────► (can be triggered from confusion in any state)        │
│ │     11       │                                                            │
│ └──────────────┘                                                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## State Configurations

### State 1: Welcome (Starting State)
**Name:** `state-1_welcome-starting-state`
**Interruption Sensitivity:** 0.7

**Prompt:**
```markdown
You are an AI assistant for ACE Cooling, an HVAC service company in Austin.

## Your Task
Greet the caller warmly. Ask ONE open-ended question about their needs.

## Say This
"Thanks for calling ACE Cooling! How can I help you today?"

## Listen For
- HVAC problem (AC not working, no heat, noise, etc.) -> transition to [triage]
- "Wrong number" or confused -> transition to [end_call_state] with reason "wrong_number"
- Vendor/sales pitch -> say "We're not interested, thanks!" -> [end_call_state]
- Existing appointment question -> transition to [existing_customer]

## Rules
- Ask ONE question only
- Wait for their response
- Keep greeting under 2 sentences
```

**Edges:**
| Condition | Destination |
|-----------|-------------|
| User describes an HVAC problem | `state_2_triage` |
| User says wrong number, vendor, or sales pitch | `state_12_end_call_state` |
| User asks about existing appointment | `state_10_existing_customer` |

---

### State 2: Triage
**Name:** `state_2_triage`
**Interruption Sensitivity:** 0.7

**Prompt:**
```markdown
## Your Task
Assess the urgency of the HVAC issue. This is CRITICAL for safety.

## TIER 1 - LIFE SAFETY (Transition to [safety] IMMEDIATELY)
If caller mentions ANY of these: gas leak, gas smell, burning smell, CO alarm, carbon monoxide, smoke, fire, electrical sparking
-> Do NOT ask more questions. Transition to [safety] immediately.

## TIER 2 - URGENT (Same-day priority)
- No heat when it's cold (below 40F)
- No AC when it's hot (above 100F)
- Water actively leaking from HVAC
- Grinding noise with sparks

## TIER 3 - ROUTINE
- Everything else: maintenance, tune-up, not cooling well, thermostat issues

## If Urgency Unclear, Ask ONE Question:
- "Is there any smell of gas or burning?"
- "Is anyone in the home who might be vulnerable to the temperature?"

## After Classification
Store the urgency level and transition to [service_area]
```

**Edges:**
| Condition | Destination | Speak During Transition |
|-----------|-------------|-------------------------|
| User mentions gas, smoke, fire, CO alarm - LIFE SAFETY | `state_3_safety_critical` | false |
| Non-emergency HVAC problem | `state_4_service_area` | **true** (agent asks for ZIP) |

---

### State 3: Safety Critical
**Name:** `state_3_safety_critical`
**Interruption Sensitivity:** 0.2 (VERY LOW - resist interruption for critical safety info)
**Tools:** `send_sms`, `end_call_safety`

**Prompt:**
```markdown
## LIFE SAFETY EMERGENCY - Follow These Steps EXACTLY

1. SAY: "This sounds like a safety emergency. Please leave your home immediately and call 911 from outside."

2. SAY: "Do not use any electrical switches or open flames."

3. SAY: "I'm alerting our emergency team right now. Please stay safe."

4. If send_sms tool is available, call it to alert the dispatcher with the emergency details.

5. Call end_call_safety to end the conversation.

## If Interrupted
If they interrupt with confusion ("What?"), stay calm and repeat clearly:
"I need you to leave the house right now and call 911. This could be dangerous."
Do NOT get sidetracked - deliver the safety message.

## Rules
- Do NOT ask more questions
- Do NOT try to book an appointment
- Complete all steps before ending
```

**Edges:**
| Condition | Destination |
|-----------|-------------|
| After delivering safety instructions | `state_12_end_call_state` |

---

### State 4: Service Area
**Name:** `state_4_service_area`
**Interruption Sensitivity:** 0.7
**Tools:** None

**Prompt:**
```markdown
## Your Task
Verify they're in our service area.

## IMPORTANT: Tool Restrictions
You have NO tools in this state. Do NOT call:
- check_availability_cal (that's for State 6)
- book_appointment_cal (that's for State 7)
- get_customer_status (that's for State 10)

After confirming service area, you MUST transition to [discovery].

## Ask
"What's your ZIP code?"

## After They Respond
- If ZIP starts with 787: "Perfect, y'all are in our area." → Transition to [discovery]
- If outside Austin: "Ah shoot, we just do Austin and the surrounding area - sorry we can't help ya out there!" → Transition to [end_call]

## If Customer Already Described Problem
Even if they've already told you what's wrong (e.g., "smelly air"), you still need to:
1. Confirm service area first
2. Then transition to [discovery] for proper intake
3. In discovery, you can acknowledge what they said: "You mentioned smelly air - let me ask a couple quick questions..."

## Rules
- Keep it quick
- Don't repeat info back verbatim
- ALWAYS transition to [discovery] after confirming valid ZIP - no exceptions
```

**Edges:**
| Condition | Destination | Speak During Transition |
|-----------|-------------|-------------------------|
| ZIP starts with 787 (Austin metro) | `state_5_discovery` | **true** (agent asks discovery questions) |
| ZIP outside service area | `state_12_end_call_state` | false |

---

### State 5: Discovery
**Name:** `state_5_discovery`
**Interruption Sensitivity:** 0.8 (HIGH - be responsive to early info volunteering)
**Tools:** None

**Prompt:**
```markdown
## IMPORTANT: Tool Restrictions
You have NO tools in this state. Do NOT call:
- check_availability_cal (that's for State 6)
- book_appointment_cal (that's for State 7)
- get_customer_status (that's for State 10)

Your job is to gather 3-4 diagnostic questions, then transition to [calendar].

---

## Your Task
Get the details for the tech. Ask ONE question at a time.

## Questions (vary your phrasing)
1. "What's it doing?" or "Tell me what's happening"
2. "How long's it been going on?"
3. "Anything happen right before - storm, power outage, anything like that?"

## Acknowledgments (vary these between questions)
- "I'll get that on the ticket"
- "Making a note of that"
- "Gotcha, let me jot that down"
- "Right on"

## Active Listening
Instead of just saying "Okay," repeat the key detail with a downward inflection.
- User: "It's making a grinding noise."
- Agent: "Grinding noise... yikes. Okay."

## If They Volunteer Info Early
If customer gives you details before you finish asking, just roll with it:
- "Oh gotcha, so it's been a few days - making a note of that."
Don't re-ask questions they've already answered.

## After 2-3 Questions
"Alright, I've got what I need for the tech. Let me check what we've got open..."
Transition to [calendar]

## Rules
- ONE question at a time
- Don't diagnose or promise anything
- Show you're actively taking notes, not just listening
```

**Edges:**
| Condition | Destination | Speak During Transition |
|-----------|-------------|-------------------------|
| Gathered sufficient diagnostic details | `state_6_calendar` | **true** (agent offers appointment times) |

---

### State 6: Calendar
**Name:** `state_6_calendar`
**Interruption Sensitivity:** 0.8 (HIGH - be responsive to early time selection)
**Tools:** `check_availability_cal`

**Prompt:**
```markdown
## IMPORTANT: Tool Restrictions
The ONLY tool you can call in this state is: check_availability_cal

Do NOT call:
- book_appointment_cal (that's for State 7 - you'll transition there next)
- get_customer_status (that's for State 10)

After customer picks a time, transition to [booking]. Do NOT try to book from this state.

---

## Your Task
Check availability and offer times.

## Before Checking Availability
Start with a filler to simulate looking at a screen:
- "Let's see here... uh... looks like I've got..."
- "Hmm... okay, pulling up the schedule..."
- "Let me pull up my calendar real quick... one sec..."
Say this BEFORE calling the check_calendar_availability tool.

## First
Call check_calendar_availability if available.

## Offer Times
"So I've got tomorrow morning around 9, or afternoon around 2 - either of those work?"

For demo purposes, offer:
- Tomorrow morning at 9 AM
- Tomorrow afternoon at 2 PM
- Day after tomorrow at 10 AM

## If They Pick Before You Finish
If customer picks a time before you list all options:
- "Oh perfect, 9 works? Let me lock that in."
Don't finish listing other times - they've already decided.

## If They Pick One
"Right on. Let me lock that in."
Transition to [booking]

## If Neither Works
"What time's better for you? I can see what else we've got."

## If No Same-Day for Urgent
"I don't have same-day, but I can have someone call you back within the hour to figure something out. Would that help?"
-> If yes: transition to [callback]
```

**Edges:**
| Condition | Destination | Speak During Transition |
|-----------|-------------|-------------------------|
| User selected time slot | `state_7_booking` | false |
| User prefers callback | `state_9_callback` | **true** (agent confirms callback number) |

---

### State 7: Booking
**Name:** `state_7_booking`
**Interruption Sensitivity:** 0.7
**Tools:** `book_appointment_cal` (ONLY - do not add other tools)

> **⚠️ IMPORTANT:** Retell's multi-state agents give the LLM access to ALL tools across the agent, not just state-specific tools. The prompt must explicitly forbid using tools from other states.

**Prompt:**
```markdown
## IMPORTANT: Tool Usage in This State
The ONLY tool you should call in this state is: book_appointment_cal

Do NOT call these tools - they are for different states:
- get_customer_status (that's for existing customer lookups in state 10)
- check_availability_cal (you already have the time slot from state 6)
- send_sms (that's for emergencies only)

## Your Task
Collect customer info and create the appointment booking using book_appointment_cal.

## Step 1: Collect Customer Info (if not already known)
Ask ONE question at a time:
1. Name: "What name should I put this under?"
2. Phone: "And what's a good callback number?" (if not from caller ID)
3. Address: "What's the service address?" (if not collected)

## Step 2: Confirm Before Booking
Once you have name, phone, and address:
"Alright, let me confirm: [Name], [Day] at [time], at [address]. Sound right?"

## Step 3: CALL book_appointment_cal (REQUIRED!)
After they confirm, you MUST call book_appointment_cal with:
- attendee_name: Customer name
- attendee_email: phone@placeholder.com (if no email)
- attendee_phone: Customer phone
- start_time: ISO format datetime (e.g., 2025-12-22T06:00:00)
- meeting_location: Service address
- description: The HVAC issue they described

Say while waiting: "Perfect, let me get that locked in for ya..."

## Step 4: After Tool Response
- If book_appointment_cal returns SUCCESS: Transition to [confirmation]
- If book_appointment_cal FAILS: "Hmm, system's being weird. Let me have someone call you back." → [callback]

## ⚠️ CRITICAL RULES
1. You MUST call book_appointment_cal before saying "you're on the books"
2. Do NOT verbally confirm without the tool call returning success
3. A verbal "yes" from customer is NOT sufficient - you need TOOL SUCCESS
4. Do NOT call get_customer_status - you are creating a NEW booking, not looking up existing ones
5. The customer gave you their phone to BOOK with, not to look up - use it in book_appointment_cal
```

**Edges:**
| Condition | Destination | Speak During Transition |
|-----------|-------------|-------------------------|
| `book_appointment_cal` tool returned success (NOT verbal confirmation) | `state_8_confirmation` | false |
| Booking failed or unavailable slots exhausted | `state_9_callback` | **true** (agent offers callback) |

---

### State 8: Confirmation
**Name:** `state_8_confirmation`
**Interruption Sensitivity:** 0.6 (MODERATE - balance info delivery with responsiveness)
**Tools:** `end_call_confirmation`

**Prompt:**
```markdown
## Prerequisites Check
You should only be in this state if book_appointment_cal was successfully called.
If you realize the booking tool wasn't called, say:
"Hold on - let me actually lock that in for you..."
Then call book_appointment_cal before continuing, or transition back to [booking] state.

## Your Task
Confirm the booking and wrap up.

## Say
"Alright, you're on the books! [Day] at [time]. Tech'll give you a call about 30 minutes before they head over. Just make sure they can get to the unit."

## If Asked About Pricing
"Yeah, there's an 89 dollar diagnostic, but if you go ahead with the repair we knock that off."

## If Interrupted With Questions
If they interrupt asking about something:
- Price question: "Sorry - 89 bucks for the diagnostic, but we knock that off if you go ahead with the repair."
- Time question: "That's tomorrow at [time]."
- Access question: "Just make sure they can get to the unit - indoor or outdoor, wherever it is."

Don't restart the whole confirmation - just answer what they asked, then wrap up.

## Close
"Anything else? ... Alright, thanks for calling! Stay cool out there."
-> Call end_call_confirmation

## Rules
- Cover all the details before wrapping up
- Keep goodbye warm but brief
```

**Edges:**
| Condition | Destination | Speak During Transition |
|-----------|-------------|-------------------------|
| Booking tool was NOT called - need to recover | `state_7_booking` | false |

---

### State 9: Callback
**Name:** `state_9_callback`
**Interruption Sensitivity:** 0.7
**Tools:** `end_call_callback`

**Prompt:**
```markdown
## Your Task
Offer a callback and end the call gracefully.

## Say
"I'll have one of our team members call you back within the hour to get you scheduled. Is [their phone number] the best number to reach you?"

## After Confirmation
"Perfect. Someone will call you shortly. Thanks for calling ACE Cooling!"
-> Call end_call_callback
```

**Edges:**
| Condition | Destination |
|-----------|-------------|
| Callback confirmed | `state_12_end_call_state` |

---

### State 10: Existing Customer
**Name:** `state_10_existing_customer`
**Interruption Sensitivity:** 0.7
**Tools:** `get_customer_status`

**Prompt:**
```markdown
## Your Task
Handle customers calling about existing appointments.

## First
Start with a filler to simulate typing/looking up:
- "Let me look that up for ya... uh... hang tight..."
- "Hmm... one sec, pulling up your info..."
- "Let's see here... okay..."
THEN call get_customer_status with their phone number.

For demo purposes, if no tool available, ask: "Can you tell me the date and time of your appointment?"

## If Appointment Found/Mentioned
"I see you have an appointment for [date/time]. Would you like to keep it, reschedule, or cancel?"
- Keep: "You're all set!" -> transition to [end_call_state]
- Reschedule: transition to [calendar]
- Cancel: "Got it, I've cancelled that for you. Anything else?" -> transition to [end_call_state]

## If No Appointment Found
"Hmm, I don't see anything on file. Want me to get you scheduled?"
-> If yes: transition to [service_area]
-> If no: transition to [end_call_state]
```

**Edges:**
| Condition | Destination | Speak During Transition |
|-----------|-------------|-------------------------|
| Customer wants to reschedule | `state_6_calendar` | **true** (agent offers appointment times) |
| Keep, cancel, or no appointment and doesn't want to book | `state_12_end_call_state` | false |
| No appointment and wants to schedule | `state_4_service_area` | **true** (agent asks for ZIP) |

---

### State 11: Fallback (Global Node)
**Name:** `state_11_fallback_global_node`
**Interruption Sensitivity:** 0.7
**Tools:** `end_call_fallback`

**Prompt:**
```markdown
## Your Task
The conversation got confused or the customer's request is unclear. Gracefully recover.

## Say
"Sorry, I think I got a little lost there. Let me have one of our team members give you a call back - they'll be able to help you out. Is [phone number] still the best number?"

## After Confirmation
"Perfect, someone will call you back shortly. Thanks for your patience!"
-> Call end_call_fallback

## Rules
- Don't apologize excessively
- Get them to a human quickly
- Stay warm and friendly
```

**Edges:**
| Condition | Destination |
|-----------|-------------|
| After offering callback | `state_12_end_call_state` |

---

### State 12: End Call
**Name:** `state_12_end_call_state`
**Interruption Sensitivity:** 0.7
**Tools:** `end_call_final`

**Prompt:**
```markdown
## Your Task
End the call gracefully based on how the conversation went.

## Based on context:
- Normal completion: "Thanks for calling ACE Cooling. Have a great day!"
- Safety emergency: "Please stay safe. Help is on the way."
- Out of service area: "Sorry we couldn't help today. Take care!"
- Callback requested: "Someone will call you soon. Bye!"
- Wrong number/vendor: "No worries! Have a good one."

## Then
Call the end_call_final tool.
```

---

## Tools Configuration

### 1. Send SMS (Built-in)
**Type:** `send_sms`
**Assigned to:** State 3 (Safety Critical)

| Field | Value |
|-------|-------|
| Name | `send_sms` |
| Description | Send emergency SMS alert to dispatcher when caller reports gas leak, smoke, fire, or CO alarm |
| SMS Content | EMERGENCY ALERT: Caller reports a safety emergency - possible gas leak, fire, or CO issue. Immediate dispatch required. |

---

### 2. Check Calendar Availability (Cal.com)
**Type:** `book_appointment_cal` (check availability mode)
**Assigned to:** State 6 (Calendar)

| Field | Value |
|-------|-------|
| Name | `check_availability_cal` |
| Description | Check technician availability when customer is ready to schedule a service appointment |
| API Key | `cal_live_d585326bede9414634a0938a3959c8bd` |
| Event Type ID | `3877847` |
| Timezone | `America/Chicago` |

---

### 3. Book Appointment (Cal.com)
**Type:** `book_appointment_cal`
**Assigned to:** State 7 (Booking)

| Field | Value |
|-------|-------|
| Name | `book_appointment_cal` |
| Description | Book HVAC service appointment after customer confirms their preferred time slot |
| API Key | `cal_live_d585326bede9414634a0938a3959c8bd` |
| Event Type ID | `3877847` |
| Timezone | `America/Chicago` |

---

### 4. Get Customer Status (Custom Function)
**Type:** Custom webhook
**Assigned to:** State 10 (Existing Customer)

| Field | Value |
|-------|-------|
| Name | `get_customer_status` |
| Description | Look up existing appointments for a customer by their phone number |
| Method | `POST` |
| URL | `https://calllock-dashboard-2.vercel.app/api/retell/customer-status` |
| Timeout | `10000` ms |
| Speak During Execution | ✅ Enabled |

**Parameters JSON:**
```json
{
  "type": "object",
  "properties": {
    "phone_number": {
      "type": "string",
      "description": "Customer phone number to look up"
    }
  },
  "required": ["phone_number"]
}
```

---

### 5. End Call Tools
Each state that can end has its own end_call tool with a unique name:

| Tool Name | State |
|-----------|-------|
| `end_call_safety` | State 3 |
| `end_call_confirmation` | State 8 |
| `end_call_callback` | State 9 |
| `end_call_fallback` | State 11 |
| `end_call_final` | State 12 |

---

## Custom Webhook Endpoint

### File Location
`calllock-dashboard/src/app/api/retell/customer-status/route.ts`

### Endpoint
`POST https://calllock-dashboard-2.vercel.app/api/retell/customer-status`

### Request Format (from Retell)
```json
{
  "call": {
    "call_id": "string",
    "agent_id": "string",
    "from_number": "string",
    "to_number": "string"
  },
  "args": {
    "phone_number": "string"
  }
}
```

### Response Format
```json
{
  "found": true,
  "appointment_date": "Thursday, January 16",
  "appointment_time": "2:00 PM",
  "service_type": "HVAC service",
  "status": "confirmed",
  "message": "Found appointment for Thursday, January 16 at 2:00 PM"
}
```

Or if no appointment:
```json
{
  "found": false,
  "message": "No upcoming appointments found for this phone number"
}
```

### Implementation
```typescript
// Queries Supabase jobs table for upcoming appointments
// Uses service role key (no user auth required)
// Returns appointment info formatted for voice readout
```

---

## Testing Scenarios

### 1. Happy Path - New Service Request
```
Agent: "Thanks for calling ACE Cooling! How can I help you today?"
User: "My AC isn't cooling"
Agent: "Oh no, that's frustrating. Is there any smell of gas or burning?"
User: "No, nothing like that"
Agent: "What's the ZIP code for the service address?"
User: "78701"
Agent: "Can you describe what's happening with your system?"
... (discovery questions) ...
Agent: "Let me check our availability..."
Agent: "I have tomorrow at 9 AM or 2 PM - which works better?"
User: "2 PM"
Agent: "Let me confirm: I have you down for tomorrow at 2 PM. Is that correct?"
User: "Yes"
Agent: "You're all set! A technician will be there tomorrow at 2 PM..."
```

### 2. Safety Emergency
```
Agent: "Thanks for calling ACE Cooling! How can I help you today?"
User: "I smell gas in my house"
Agent: "This sounds like a safety emergency. Please leave your home immediately and call 911 from outside. Do not use any electrical switches or open flames. I'm alerting our emergency team right now. Please stay safe."
[SMS sent to dispatcher]
[Call ends]
```

### 3. Out of Service Area
```
Agent: "Thanks for calling ACE Cooling! How can I help you today?"
User: "My heater isn't working"
Agent: "What's the ZIP code for the service address?"
User: "75001" (Dallas)
Agent: "Sorry, we don't currently service that area. We serve Austin and surrounding areas. Take care!"
[Call ends]
```

### 4. Existing Customer
```
Agent: "Thanks for calling ACE Cooling! How can I help you today?"
User: "I want to check on my appointment"
Agent: "Let me pull that up..."
[get_customer_status called]
Agent: "I see you have an appointment for Thursday at 2 PM. Would you like to keep it, reschedule, or cancel?"
User: "Keep it"
Agent: "You're all set! Thanks for calling ACE Cooling!"
```

### 5. Wrong Number
```
Agent: "Thanks for calling ACE Cooling! How can I help you today?"
User: "Sorry, wrong number"
Agent: "No worries! Have a good one."
[Call ends]
```

---

## Troubleshooting

### Agent Not Greeting First
- Check `start_speaker` is set to `agent`
- Check `begin_message` is not empty

### Safety State Not Triggering
- Verify State 2 edge condition includes all safety keywords
- Check interruption sensitivity isn't too high

### Cal.com Tools Not Working
- Verify API key is valid
- Verify Event Type ID matches your Cal.com event
- Check timezone is correct

### Customer Status Webhook Failing
- Verify endpoint is deployed and accessible
- Check Vercel logs for errors
- Verify SUPABASE_SERVICE_ROLE_KEY is set in Vercel env vars

### Bookings Not Appearing in Dashboard
- **Root cause**: Retell Agent Level Webhook URL is empty
- **Solution**: In Retell Dashboard → Agent Settings → Webhook Settings, set **Agent Level Webhook URL** to:
  ```
  https://calllock-server.onrender.com/webhook/retell/call-ended
  ```
- This webhook is required for post-call data (bookings, transcripts, customer info) to sync to the dashboard
- Without it, calls complete successfully but data never reaches the V2 backend or dashboard

### Agent Verbally Confirms But Booking Not Created
- **Symptom**: Agent says "I've got you booked for Friday at 9" but no Cal.com booking created, shows as "NEW LEAD" instead of booked job
- **Root cause 1**: Agent never transitioned to State 7 (Booking) - stayed in State 6 (Calendar)
- **Root cause 2**: State 6 edge condition didn't recognize user's time selection (e.g., "the earliest" vs "9 AM")
- **Root cause 3**: `book_appointment_cal` tool not called
- **Root cause 4**: State 7→8 edge allowed verbal confirmation ("OR customer confirmed") to trigger transition without tool call
- **Solution**:
  1. Update State 6 edge to recognize varied time selection phrases ("earliest", "sounds good", "sure", "that works")
  2. Ensure State 7 has `book_appointment_cal` tool assigned
  3. Update State 7 prompt to explicitly require calling the booking tool
  4. State 7→8 edge must ONLY trigger on `book_appointment_cal` tool success, NOT verbal confirmation
  5. State 8 has recovery edge back to State 7 if booking wasn't actually created
- **Verification**: Check call logs for `book_appointment_cal` tool invocation - if missing, booking wasn't created regardless of what agent said

### LLM Calls Wrong Tool (e.g., get_customer_status instead of book_appointment_cal)
- **Symptom**: In State 7, logs show `get_customer_status` called instead of `book_appointment_cal`
- **Root cause**: Retell multi-state agents give the LLM access to ALL tools across the entire agent, not just tools assigned to the current state. State tool assignment is a "suggestion" not a hard restriction.
- **Solution**: State prompts must EXPLICITLY forbid calling tools from other states:
  ```markdown
  ## IMPORTANT: Tool Usage in This State
  The ONLY tool you should call in this state is: book_appointment_cal

  Do NOT call these tools - they are for different states:
  - get_customer_status (that's for existing customer lookups in state 10)
  - check_availability_cal (you already have the time slot from state 6)
  - send_sms (that's for emergencies only)
  ```
- **Why it happens**: When agent asks for phone number in State 7 (to book), LLM may interpret this as "look up customer" and call `get_customer_status` instead of using the phone for `book_appointment_cal`
- **Prevention**: Add explicit rule: "The customer gave you their phone to BOOK with, not to look up"

### Customer Name Shows "Unknown Caller"
- **Root cause**: Customer info collected verbally but not stored in state
- **Solution**: State 7 prompt now explicitly collects name, phone, and address before calling booking tool
- The booking tool parameters include `attendee_name`, `attendee_phone`, etc.

### Calls Getting Stuck
- Check all states have at least one exit edge
- Verify end_call tools are assigned to terminal states

### Agent Goes Silent After Transition
- **Root cause**: `speak_during_transition: false` on the edge
- **Solution**: Set `speak_during_transition: true` for edges going INTO states that should speak first
- **States that need `speak_during_transition: true`**: state_4 (asks ZIP), state_5 (asks discovery), state_6 (offers times), state_9 (confirms callback)
- **States that keep `speak_during_transition: false`**: state_2 (responds to problem), state_3 (responds to safety keywords), state_7 (confirms booking), state_8 (confirms details)

---

## API Reference

### Retell API Endpoints Used

**Get Agent:**
```bash
curl -X GET "https://api.retellai.com/get-agent/agent_94ae0e7fdc51f791172e31b5f9" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Get LLM Config:**
```bash
curl -X GET "https://api.retellai.com/get-retell-llm/llm_2c8c46aa11a2e5a323e550cd73ec" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Update LLM:**
```bash
curl -X PATCH "https://api.retellai.com/update-retell-llm/llm_2c8c46aa11a2e5a323e550cd73ec" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"states": [...]}'
```

---

## Changelog

| Date | Change |
|------|--------|
| 2025-02-15 | Initial agent audit and configuration |
| 2025-02-15 | Fixed begin_message and start_speaker |
| 2025-02-15 | Fixed all 12 state edge descriptions |
| 2025-02-15 | Added end_call tools to terminal states |
| 2025-02-15 | Created customer-status webhook endpoint |
| 2025-02-15 | Configured Cal.com and SMS tools |
| 2025-02-15 | Removed orphan state (end_call_state_wrong_vendor) |
| 2025-12-18 | Fixed silent state bug: Set speak_during_transition: true for edges to states 4, 5, 6, 9 |
| 2025-12-18 | Switched model from gemini-3.0-flash to claude-3.5-haiku to fix LLM timeout issues |
| 2025-12-18 | Updated persona: More casual/local tone, less "AI professional" - subtle Texas flavor |
| 2025-12-18 | Added barge-in recovery handling: interruption_sensitivity tuned per state (0.2-0.8), added recovery guidance to prompts |
| 2025-12-18 | Enhanced tone: Visual language ("Let me pull that up on the big screen") + subtle Texas markers ("fixin' to", "appreciate ya") |
| 2025-12-18 | Added Active Listening to State 5: Repeat key details with downward inflection instead of just "Okay" |
| 2025-12-18 | Added latency hiding: State 6 speaks before calendar API, State 10 says "hang tight" before customer lookup |
| 2025-12-19 | Documented: Retell Agent Level Webhook URL required for dashboard sync (`https://calllock-server.onrender.com/webhook/retell/call-ended`) |
| 2025-12-19 | Fixed: State 6 edge condition - expanded to recognize "earliest", "sounds good", "sure" as time selection triggers |
| 2025-12-19 | Fixed: State 6 prompt - removed customer info collection (moved to State 7) |
| 2025-12-19 | Fixed: State 7 prompt - added explicit customer info collection steps and required booking tool call |
| 2025-12-19 | **CRITICAL FIX**: Added `book_appointment_cal` tool to State 7 tools array - was empty, preventing actual bookings |
| 2025-12-19 | **FIX**: Added `check_availability_cal` tool to State 7 - verifies slot availability before booking to prevent failures when customer suggests taken times |
| 2025-12-19 | **CRITICAL FIX**: State 7→8 edge now requires `book_appointment_cal` tool success - removed "OR verbal confirmation" condition that allowed skipping actual booking |
| 2025-12-19 | Added recovery edge from State 8→7: If agent realizes booking wasn't created, can recover and call the tool |
| 2025-12-19 | Added prerequisite check to State 8 prompt: Verifies booking tool was called before confirming |
| 2025-12-19 | **DISCOVERY**: Retell multi-state agents give LLM access to ALL tools across agent, not just state-specific tools |
| 2025-12-19 | **ROOT CAUSE**: LLM called `get_customer_status` (state 10 tool) instead of `book_appointment_cal` in state 7 |
| 2025-12-19 | **FIX**: State 7 prompt now explicitly forbids calling tools from other states (get_customer_status, check_availability_cal, send_sms) |
| 2025-12-19 | **FIX**: Removed `check_availability_cal` from State 7 tools - only `book_appointment_cal` should be assigned |
| 2025-12-19 | **FIX**: Added rule clarifying phone number is for BOOKING, not for looking up existing appointments |
