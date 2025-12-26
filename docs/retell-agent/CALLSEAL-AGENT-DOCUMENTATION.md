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
| **Customer Status URL** | `https://calllock-dashboard-2.vercel.app/api/retell/customer-status` |
| **Book Service URL** | `https://calllock-dashboard-2.vercel.app/api/retell/book-service` |
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
To book appointments:
1. Gather customer info (name, phone, address, issue)
2. Ask when they'd like to come in
3. Call book_service with their info and preferred time - it checks availability AND books in one step
4. Confirm the booking using the date/time from the tool response

NEVER say "you're booked" until book_service returns booked: true.
The send_emergency_sms tool is ONLY for life safety emergencies.

## CRITICAL: State Machine Discipline
You MUST follow the state machine flow. Do NOT call tools from other states.

State-specific tool access:
- State 4 (Service Area): NO tools - only confirm ZIP, then transition to [discovery] or [calendar]
- State 5 (Discovery): NO tools - gather problem details, then transition to [calendar]
- State 6 (Calendar): ONLY book_service - checks availability AND books in one step
- State 7 (Booking): Recovery state - retry book_service if needed
- State 10 (Existing Customer): ONLY get_customer_status - lookup appointments

NEVER skip states. NEVER call a tool assigned to a different state.
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

> **⚠️ CRITICAL FIX (Dec 19, 2025):** Added "fast path" edge for customers who want to book immediately without going through discovery. Also added explicit tool restrictions since Retell gives LLM access to ALL tools regardless of state. Agent was calling `check_availability_cal` directly from State 4, bypassing the entire state flow.

**Prompt:**
```markdown
## Your Task
Verify they're in our service area AND get property type.

## Step 1: Ask for ZIP
"What's your ZIP code?"

## Step 2: If In Service Area, Ask Property Type
- If ZIP starts with 787: "Perfect, y'all are in our area. Is this a house, condo, or commercial property?"

## After Property Type Response
Store: property_type: 'house' | 'condo' | 'apartment' | 'commercial'

Then transition:
- "Got it. So tell me what's going on with the system." → [discovery]

## If Outside Austin
"Ah shoot, we just do Austin and the surrounding area - sorry we can't help ya out there!"
→ Transition to [end_call_state]

## Rules
- Keep it quick
- Don't repeat info back verbatim
- Commercial properties should get GREEN priority (high value)

## Fast Path - Customer Already Knows What They Want
If customer says they want to book right away (e.g., "quick booking", "soonest available", "just need an appointment"):
After confirming ZIP AND property type, say "Perfect, let me check what we've got open..."
→ Transition to [calendar] IMMEDIATELY (skip discovery)

## ⚠️ TOOL RESTRICTIONS - CRITICAL
You are in the SERVICE AREA state. The ONLY thing you can do here is verify ZIP code and property type.

Do NOT call any tools in this state:
- Do NOT call check_availability_cal (that's for State 6 - calendar)
- Do NOT call book_appointment_cal (that's for State 7 - booking)
- Do NOT call get_customer_status (that's for State 10)

After verifying ZIP code, you MUST transition:
- Normal flow: → [discovery] to ask diagnostic questions
- Fast path (customer wants to book now): → [calendar] to check availability

NEVER call calendar/booking tools without transitioning first.
```

**Edges:**
| Condition | Destination | Speak During Transition |
|-----------|-------------|-------------------------|
| ZIP starts with 787 AND customer wants to describe problem | `state_5_discovery` | **true** |
| ZIP starts with 787 AND customer wants quick booking | `state_6_calendar` | **true** |
| ZIP outside service area | `state_12_end_call_state` | false |

---

### State 5: Discovery
**Name:** `state_5_discovery`
**Interruption Sensitivity:** 0.8 (HIGH - be responsive to early info volunteering)
**Tools:** None

> **⚠️ CRITICAL FIX (Dec 19, 2025):** Added "fast path" edge for customers who want to skip discovery questions. Also added explicit tool restrictions since Retell gives LLM access to ALL tools.

**Prompt:**
```markdown
## Your Task
Get the details for the tech. Ask ONE question at a time. These questions help the owner-operator decide whether to take the job and what to expect.

## Questions (vary your phrasing)
1. "What's it doing?" or "Tell me what's happening"
2. "Is the system completely off, or is it still running but not working right?"
3. "How long's it been going on?"
4. "Anything happen right before - storm, power outage, anything like that?"
5. "Roughly how old is the system - under 10 years, 10 to 15, or older than 15?"

## What You're Collecting (for dispatch decisions)
- system_status: 'completely_down' | 'partially_working' | 'running_but_ineffective'
- equipment_age_bracket: 'under_10' | '10_to_15' | 'over_15' | 'unknown'

## Acknowledgments (vary these between questions)
- "I'll get that on the ticket"
- "Making a note of that"
- "Gotcha, let me jot that down"
- "Right on"
- "Noting that for the tech"

## Active Listening
Instead of just saying "Okay," repeat the key detail with a downward inflection.
- User: "It's making a grinding noise."
- Agent: "Grinding noise... yikes. Okay."
- User: "It's completely dead."
- Agent: "Completely dead... got it. Okay."

## If They Volunteer Info Early
If customer gives you details before you finish asking, just roll with it:
- "Oh gotcha, so it's been a few days - making a note of that."
Don't re-ask questions they've already answered.

## After 4-5 Questions
"Alright, I've got what I need for the tech. Let me check what we've got open..."
Transition to [calendar]

## Fast Path - Customer Wants to Skip Discovery
If customer says they just want to book or don't want to answer questions:
"No problem! Let me check what we've got open..."
→ Transition to [calendar] IMMEDIATELY

## ⚠️ TOOL RESTRICTIONS - CRITICAL
You are in the DISCOVERY state. The ONLY thing you can do here is ask questions.

Do NOT call any tools in this state:
- Do NOT call check_availability_cal (that's for State 6)
- Do NOT call book_appointment_cal (that's for State 7)
- Do NOT call get_customer_status (that's for State 10)

If customer wants to schedule, you MUST transition to [calendar] first.
NEVER skip the state transition.

## Rules
- ONE question at a time
- Don't diagnose or promise anything
- Show you're actively taking notes, not just listening
```

**Edges:**
| Condition | Destination | Speak During Transition |
|-----------|-------------|-------------------------|
| Gathered sufficient diagnostic details (2-3 questions) | `state_6_calendar` | **true** (agent offers appointment times) |
| Customer wants to skip discovery ("just book me", "skip questions") | `state_6_calendar` | **true** (agent says "No problem! Let me check what we've got open...") |

---

### State 6: Calendar
**Name:** `state_6_calendar`
**Interruption Sensitivity:** 0.8 (HIGH - be responsive to customer input)
**Tools:** `book_service` (combined availability check + booking)

> **⚠️ CRITICAL UPDATE (Dec 19, 2025):** Replaced separate `check_availability_cal` and `book_appointment_cal` tools with single `book_service` tool. This prevents the agent from "checking" availability without actually creating a booking.

**Prompt:**
```markdown
## Your Task
Book the customer's appointment in ONE step. Before booking, confirm they can authorize the work.

## Step 1: Gather Quick Info
If you don't already have it, ask:
- "What name should I put this under?"
- "And what's the service address?"
- "When works best for you? We've got mornings and afternoons most days."

## Step 1.5: Decision-Maker Confirmation (CRITICAL)
Right before calling book_service, ask:
"And you're the homeowner who can approve the work, right?"

**If YES:** Great, proceed to Step 2.
Store: is_decision_maker: true

**If NO (tenant/property manager):**
"No problem - who should we contact to authorize the repair if needed? What's their name and number?"
Store: is_decision_maker: false
Store: decision_maker_contact: "[name] [phone]"
Then proceed to Step 2 (still book the appointment, but flag it).

## Step 2: Call book_service
Once you have name, phone, address, preferred time, and issue description, IMMEDIATELY call book_service.

Say: "Perfect, lemme check what we've got and lock you in..."

Then call book_service with ALL the info.

## Step 3: Handle Response

**If booked: true**
Say exactly what the tool returns in the message field, then:
"Tech'll give you a call about 30 minutes before they head over."
→ Transition to [confirmation]

**If booked: false with alternatives**
Offer the alternatives: "That slot's taken, but I've got [alternatives]. Any of those work?"
When they pick one, call book_service again with the new preferred_time.

**If booked: false with no alternatives**
"I'm not finding any openings right now. Let me have someone call you back."
→ Transition to [callback]

## Rules
- ALWAYS call book_service before confirming - verbal confirmation is NOT a booking
- Use the exact date/time from the tool response
- Don't say "you're booked" unless booked: true
- Always ask about decision-maker status before booking
```

**Edges:**
| Condition | Destination | Speak During Transition |
|-----------|-------------|-------------------------|
| `book_service` returned booked: true | `state_8_confirmation` | false |
| Booking failed or no availability - callback preferred | `state_9_callback` | **true** |

---

### State 7: Booking (Recovery State)
**Name:** `state_7_booking`
**Interruption Sensitivity:** 0.7
**Tools:** `book_service` (same as State 6)

> **⚠️ UPDATE (Dec 19, 2025):** State 7 is now a recovery/fallback state. Booking normally happens in State 6 using the combined `book_service` tool. State 7 is only reached if booking didn't complete in State 6.

**Prompt:**
```markdown
## Recovery State
You're in this state if booking didn't complete in the calendar state.

If you have all the info, try calling book_service again:
- customer_name
- customer_phone
- service_address
- preferred_time
- issue_description

If it still fails, say:
"Hmm, the system's being a little finicky. Let me have someone call you back to get you scheduled."
→ Transition to [callback]

If it succeeds (booked: true):
→ Transition to [confirmation]
```

**Edges:**
| Condition | Destination | Speak During Transition |
|-----------|-------------|-------------------------|
| `book_service` returned booked: true | `state_8_confirmation` | false |
| Booking still failed | `state_9_callback` | **true** (agent offers callback) |

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

### 2. Book Service (Combined Check + Book)
**Type:** Custom webhook
**Assigned to:** State 6 (Calendar), State 7 (Booking - recovery)

> **⚠️ NEW (Dec 19, 2025):** Replaced separate `check_availability_cal` and `book_appointment_cal` with single combined `book_service` tool. This prevents the agent from "checking" without actually booking.

| Field | Value |
|-------|-------|
| Name | `book_service` |
| Description | Check availability and book appointment in one step. Returns confirmation or alternatives. |
| Method | `POST` |
| URL | `https://calllock-dashboard-2.vercel.app/api/retell/book-service` |
| Timeout | `15000` ms |
| Speak During Execution | ✅ Enabled |

**Parameters JSON:**
```json
{
  "type": "object",
  "properties": {
    "customer_name": { "type": "string", "description": "Customer's name" },
    "customer_phone": { "type": "string", "description": "Customer's phone number from caller ID or conversation" },
    "service_address": { "type": "string", "description": "Address for service call. Use 'TBD' if not provided." },
    "preferred_time": { "type": "string", "description": "When customer wants appointment: 'Monday at 9am', 'tomorrow morning', 'soonest available'" },
    "issue_description": { "type": "string", "description": "Brief description of the HVAC problem from discovery" }
  },
  "required": ["customer_name", "customer_phone", "preferred_time", "issue_description"]
}
```

**Response Format:**
```json
{
  "success": true,
  "booked": true,
  "appointment_date": "Monday, December 22nd",
  "appointment_time": "9:00 AM",
  "message": "You're all set for Monday, December 22nd at 9:00 AM. Our tech will give you a call about 30 minutes before they head over."
}
```

Or if slot not available:
```json
{
  "success": true,
  "booked": false,
  "available_slots": ["Monday, December 22nd at 2:00 PM", "Tuesday, December 23rd at 9:00 AM"],
  "message": "That time's not available, but I've got Monday, December 22nd at 2:00 PM or Tuesday, December 23rd at 9:00 AM. Would either of those work?"
}
```

**Natural Language Time Parsing:**
The `preferred_time` parameter accepts natural language:
- "soonest available" → First available slot in next 7 days
- "tomorrow morning" → Tomorrow 6am-12pm
- "Monday at 9" → Monday 9am slot
- "next week" → Monday-Friday of next week

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

## Custom Webhook Endpoints

### 1. Book Service (Combined Availability + Booking)

#### File Location
`calllock-dashboard/src/app/api/retell/book-service/route.ts`

#### Endpoint
`POST https://calllock-dashboard-2.vercel.app/api/retell/book-service`

#### Request Format (from Retell)
```json
{
  "call": {
    "call_id": "string",
    "agent_id": "string",
    "from_number": "string"
  },
  "args": {
    "customer_name": "John Smith",
    "customer_phone": "512-555-1234",
    "service_address": "123 Main St, Austin TX",
    "preferred_time": "Monday morning",
    "issue_description": "AC not cooling"
  }
}
```

#### Response Format (Success)
```json
{
  "success": true,
  "booked": true,
  "appointment_date": "Monday, December 22nd",
  "appointment_time": "9:00 AM",
  "message": "You're all set for Monday, December 22nd at 9:00 AM. Our tech will give you a call about 30 minutes before they head over."
}
```

#### Response Format (Alternatives Available)
```json
{
  "success": true,
  "booked": false,
  "available_slots": ["Monday, December 22nd at 2:00 PM", "Tuesday, December 23rd at 9:00 AM"],
  "message": "That time's not available, but I've got Monday, December 22nd at 2:00 PM or Tuesday, December 23rd at 9:00 AM. Would either of those work?"
}
```

#### Implementation
- Parses natural language time preferences ("Monday 9am", "tomorrow morning", "soonest")
- Calls Cal.com API to check availability
- Books first available slot matching preference
- Returns confirmation or alternatives for agent to offer

---

### 2. Customer Status (Appointment Lookup)

#### File Location
`calllock-dashboard/src/app/api/retell/customer-status/route.ts`

#### Endpoint
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
- **Root cause**: Retell multi-state agents give the LLM access to ALL tools across the entire agent, not just tools assigned to the current state.
- **IMPORTANT**: Prompt-based restrictions ("Do NOT call X") DO NOT WORK reliably. The LLM ignores them.
- **Solution**: **ARCHITECTURAL FIX** - Move tools out of `general_tools` into state-specific `tools` arrays:

  **Before (broken):**
  ```json
  "general_tools": [
    { "name": "end_call" },
    { "name": "send_emergency_sms" },
    { "name": "get_customer_status" }  // ← Available in ALL states!
  ]
  ```

  **After (fixed):**
  ```json
  "general_tools": [
    { "name": "end_call" },
    { "name": "send_emergency_sms" }
  ]
  // get_customer_status moved to State 10's tools array
  ```

- **Key Learning**: `general_tools` are available in ALL states. To restrict a tool to specific states, it MUST be in that state's `tools` array, NOT in `general_tools`.
- **Why prompt restrictions fail**: The LLM optimizes for user experience over state machine discipline. If calling a tool helps the user faster, it will ignore "Do NOT call" instructions.

### Customer Name Shows "Unknown Caller"
- **Root cause**: Customer info collected verbally but not stored in state
- **Solution**: State 7 prompt now explicitly collects name, phone, and address before calling booking tool
- The booking tool parameters include `attendee_name`, `attendee_phone`, etc.

### Early-Exit Calls Not Creating Leads
- **Symptom**: Call ends early (audio issues, customer says bye, agent misinterprets) and no lead/job appears in dashboard
- **Root cause**: Agent called `end_call` without explicit reason, and dashboard webhook returned `null` for undefined `end_call_reason`, preventing lead creation
- **Solution**: Dashboard webhook now treats undefined `end_call_reason` as `'abandoned'` status, ensuring early-exit calls become hot leads
- **Location**: `calllock-dashboard/src/app/api/webhook/jobs/route.ts` - `mapEndCallReasonToLeadStatus()` function
- **Result**: All calls that end without booking now appear as leads with "CALLBACK RISK" badge

### Retell API Rejects Config: "Duplicate Destination State"
- **Symptom**: API returns error `"Destination states must be unique for a particular state"`
- **Root cause**: A state has multiple edges with the same `destination_state_name`
- **Example**: State 5 had two edges both going to `state_6_calendar`
- **Solution**: Merge conditions into a single edge with combined description
- **Before (broken)**:
  ```json
  "edges": [
    { "description": "Gathered details", "destination_state_name": "state_6_calendar" },
    { "description": "Customer wants to skip", "destination_state_name": "state_6_calendar" }
  ]
  ```
- **After (fixed)**:
  ```json
  "edges": [
    { "description": "Ready to book - either gathered details OR customer wants to skip", "destination_state_name": "state_6_calendar" }
  ]
  ```

### Agent Checks Availability But Never Books
- **Symptom**: Agent says "I've got Monday at 9 AM" but never creates actual booking - customer thinks they're booked but no Cal.com appointment exists
- **Root cause**: Separate `check_availability_cal` and `book_appointment_cal` tools allowed agent to check without booking
- **Solution** (Dec 19, 2025): Replaced with single `book_service` tool that checks AND books in one step
- **How it works**: Agent calls `book_service` with customer info + preferred time. Tool returns either `booked: true` with confirmation details, or `booked: false` with alternatives
- **Verification**: Check call logs for `book_service` tool invocation and `booked: true` in response

### Agent Config Updated But Live Calls Use Old Behavior
- **Symptom**: You updated the LLM config via API, verified the new config is there, but live calls still use old tools/prompts
- **Root cause 1**: Retell has a **publish/draft system**. Updating the LLM creates a new draft version, but live calls use the **last published version**
- **Root cause 2**: Phone numbers can be **pinned to a specific version** and won't use newer versions even after publishing
- **Verification**: Call logs show agent version (e.g., "Version: 3") while API shows higher version (e.g., "version": 5)
- **Check published status**:
  ```bash
  curl -s -X GET "https://api.retellai.com/get-agent/{agent_id}" \
    -H "Authorization: Bearer {api_key}" | jq '{version, is_published}'
  ```
  - `is_published: false` means current version is a draft
  - The published version = current version - 1 (or the last version that was published)
- **Solution Step 1**: Publish the agent to make current config active:
  ```bash
  curl -X POST "https://api.retellai.com/publish-agent/{agent_id}" \
    -H "Authorization: Bearer {api_key}" \
    -H "Content-Type: application/json"
  ```
- **Solution Step 2**: Check if phone number is pinned to old version:
  ```bash
  curl -s "https://api.retellai.com/list-phone-numbers" \
    -H "Authorization: Bearer {api_key}" | jq '.[] | {phone_number, inbound_agent_version}'
  ```
- **Solution Step 3**: Update phone number to use new version:
  ```bash
  curl -X PATCH "https://api.retellai.com/update-phone-number/{phone_number}" \
    -H "Authorization: Bearer {api_key}" \
    -H "Content-Type: application/json" \
    -d '{"inbound_agent_version": 4}'
  ```
- **After publishing**: Version increments by 1, previous version becomes the published/live version
- **IMPORTANT**: After publishing AND updating phone number version, verify with a test call that logs show correct version

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

**Publish Agent (REQUIRED for live calls to use new config):**
```bash
curl -X POST "https://api.retellai.com/publish-agent/agent_94ae0e7fdc51f791172e31b5f9" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json"
```
> **Note:** After updating LLM config, you MUST publish the agent for changes to take effect on live calls. Without publishing, calls use the last published version.

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
| 2025-12-19 | **DISCOVERY**: Prompt-based tool restrictions don't work - LLM ignores "Do NOT call" instructions and calls tools anyway |
| 2025-12-19 | **ARCHITECTURAL FIX**: Moved `get_customer_status` from `general_tools` to State 10's `tools` array - enforces tool scope at Retell level, not just prompt level |
| 2025-12-19 | **LEARNING**: `general_tools` are available in ALL states. To restrict a tool to specific states, it MUST be in that state's `tools` array, not `general_tools` |
| 2025-12-19 | **FIX**: Merged duplicate State 5 edges to `state_6_calendar` - Retell requires unique destination states per edge |
| 2025-12-19 | **FIX**: Dashboard webhook now creates leads for calls without explicit `end_call_reason` - treats as 'abandoned' to capture early-exit calls (audio issues, customer says bye early) |
| 2025-12-19 | **LEARNING**: Calls ending without explicit reason (agent_hangup without booking) previously created neither lead nor job - they vanished from the system |
| 2025-12-19 | **ARCHITECTURAL FIX**: Replaced separate `check_availability_cal` + `book_appointment_cal` tools with single combined `book_service` tool |
| 2025-12-19 | **WHY**: Agent was calling availability check but never booking tool - verbally confirming bookings that didn't exist |
| 2025-12-19 | **NEW ENDPOINT**: Created `/api/retell/book-service` - accepts natural language time ("Monday 9am", "soonest"), checks Cal.com availability, and books in one step |
| 2025-12-19 | **STATE CHANGES**: State 6 now handles booking directly. State 7 is now a recovery/fallback state for retrying failed bookings |
| 2025-12-19 | **CRITICAL FIX**: Agent was not published - live calls were using old Version 3 config with `check_availability_cal` instead of new `book_service` tool |
| 2025-12-19 | **LEARNING**: Retell uses the **last published version** for live calls. Updating LLM config creates a draft - must explicitly publish via `POST /publish-agent/{agent_id}` |
| 2025-12-19 | Published agent Version 4 → Version 5 (new draft), making `book_service` active for live calls |
| 2025-12-19 | **CRITICAL FIX**: Phone number `+13126463816` was pinned to Version 3 (`inbound_agent_version: 3`) - calls still used old config even after publishing |
| 2025-12-19 | **LEARNING**: Retell phone numbers have `inbound_agent_version` field that OVERRIDES the default published version. Must update via `PATCH /update-phone-number/{number}` |
| 2025-12-19 | Updated phone number to use Version 4: `{"inbound_agent_version": 4}` - now live calls will use `book_service` tool |
| 2025-12-19 | **VERIFIED**: Test Call 12 (`call_b3c3c2305b9a4a0d9cc69a47812`) confirmed fix - agent used Version 4, called `book_service` tool, and created real Cal.com booking |
| 2025-12-19 | **SUCCESS**: Agent correctly offered alternative when Monday 6 AM unavailable → booked Sunday 9 AM instead, confirmed with actual date/time from tool response |
| 2025-12-19 | **SUMMARY**: Two-step version update required: (1) Publish agent to create new version, (2) Update phone number `inbound_agent_version` to route calls to new version |
| 2025-12-19 | **BUG**: Cal.com bookings created by `book_service` were not appearing in dashboard BOOKED tab - job was never inserted into Supabase |
| 2025-12-19 | **ROOT CAUSE**: `book_service` endpoint created Cal.com booking but didn't insert Job into Supabase. Old flow relied on V2 backend setting `state.appointmentDateTime` and sending to dashboard webhook |
| 2025-12-19 | **FIX**: Updated `book_service` to insert Job directly into Supabase after successful Cal.com booking. Uses `DASHBOARD_USER_EMAIL` env var to find user, includes deduplication via `original_call_id` |
| 2025-12-19 | **DATA FLOW NOW**: Agent → `book_service` → (1) Creates Cal.com booking (2) Inserts Job into Supabase → Job appears in BOOKED tab |
