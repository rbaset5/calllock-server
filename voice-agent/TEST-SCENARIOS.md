# TEST SCENARIOS (v9-triage — 15 states)

Each scenario includes: goal (state path), sample caller lines, expected behavior.

State reference:
```
1.welcome  2.non_service  3.lookup  4.follow_up  5.manage_booking
6.safety  7.safety_emergency  8.service_area  9.discovery  10.urgency
11.urgency_callback  12.pre_confirm  13.booking  14.booking_failed  15.confirm
```

---

## 1) New Caller — Full Booking (Happy Path)
**Path:** welcome → lookup → safety → service_area → discovery → urgency → pre_confirm → booking → confirm
**Caller:** "My AC stopped cooling this morning. ZIP 78745. 123 Elm Street."
**Expected:** Lookup finds no record → safety clear → ZIP accepted → collects problem/address/name → urgency routes to booking → pre_confirm summarizes → booking succeeds → confirm with end_call.

---

## 2) Safety Emergency (Gas Smell)
**Path:** welcome → lookup → safety → safety_emergency
**Caller:** "I smell gas near my furnace."
**Expected:** Safety detects emergency → transitions to safety_emergency → instructs caller to call 911 → end_call(safety_emergency). No booking attempt.

---

## 3) Out-of-Area Caller (ZIP Rejection)
**Path:** welcome → lookup → safety → service_area → end_call
**Caller:** ZIP "78613" or "77002"
**Expected:** ZIP not in 787xx range → polite decline → end_call from service_area.

---

## 4) Booking Fails → Callback
**Path:** welcome → lookup → safety → service_area → discovery → urgency → pre_confirm → booking → booking_failed
**Caller:** Picks "tomorrow at 9 AM" but book_service returns error.
**Expected:** Booking tool fails → transitions to booking_failed → create_callback_request → end_call.

---

## 5) High-Ticket Sales Lead
**Path:** welcome → lookup → safety → service_area → discovery → urgency → urgency_callback
**Caller:** "I need a whole new AC system installed."
**Expected:** Discovery sets lead_type=high_ticket → urgency routes to urgency_callback → send_sales_lead_alert → create_callback_request(type=estimate) → end_call. No diagnostic booking.

---

## 6) Non-Service — Billing Inquiry
**Path:** welcome → non_service → end_call
**Caller:** "I have a question about my bill."
**Expected:** Welcome detects billing intent → non_service → create_callback_request(type=billing) → end_call. No safety question asked.

---

## 7) Non-Service — Vendor Call
**Path:** welcome → non_service → end_call
**Caller:** "We sell HVAC parts and wanted to talk to the owner."
**Expected:** Welcome detects vendor → non_service → polite decline → end_call.

---

## 8) Non-Service — Pricing → Schedules Service
**Path:** welcome → non_service → safety → (normal booking flow)
**Caller:** "How much does a service call cost?" then "Yes, go ahead and schedule."
**Expected:** Pricing answer ($89 diagnostic) → caller accepts → transitions to safety → continues normal booking flow.

---

## 9) Known Caller — New Issue (Fast-Track)
**Path:** welcome → lookup → safety → service_area* → discovery* → urgency → pre_confirm → booking → confirm
**Caller:** Return caller with ZIP/address on file. "My heater is making a loud noise."
**Expected:** Lookup finds existing record → name confirmed → service_area skipped (ZIP known) → discovery skips name/address (pre-filled) → normal booking flow.

---

## 10) Known Caller — Follow-Up
**Path:** welcome → lookup → follow_up
**Caller:** "You guys were supposed to call me back about a quote."
**Expected:** Lookup finds history → follow_up acknowledges prior interaction → create_callback_request(type=follow_up) → end_call.

---

## 11) Known Caller — Manage Existing Booking
**Path:** welcome → lookup → manage_booking → confirm
**Caller:** "I need to reschedule my appointment."
**Expected:** Lookup finds booking → manage_booking calls manage_appointment → reschedule succeeds → confirm with end_call.

---

## 12) Known Caller — Cancel Booking
**Path:** welcome → lookup → manage_booking → confirm
**Caller:** "I need to cancel my appointment."
**Expected:** manage_booking calls manage_appointment(cancel) → cancellation confirmed → confirm with end_call.

---

## 13) Property Manager Call
**Path:** (normal booking flow through discovery)
**Caller:** "I'm a property manager, my tenant's AC is out. I won't be at the property."
**Expected:** Discovery detects PM language → asks for site contact name/phone → captures site_contact_name and site_contact_phone → booking appends site contact to issue_description.

---

## 14) Urgent — Caller Wants Callback Only
**Path:** welcome → lookup → safety → service_area → discovery → urgency → urgency_callback
**Caller:** "My AC is broken. Just have someone call me back."
**Expected:** Urgency detects callback preference → routes to urgency_callback → create_callback_request(type=service) → end_call. No booking attempt.

---

## 15) Wrong Number
**Path:** welcome → non_service → end_call
**Caller:** "Sorry, wrong number."
**Expected:** Welcome detects wrong number → non_service → polite close → end_call.

---

## 16) Regression — Returning Caller + Existing Appointment + Slot Substitution (v10-simplified)
**Reference:** Mirrors failure pattern from `call_c80d24d2f11780aee2c1290d665` on **February 26, 2026**
**Path (v10 simplified):** welcome → lookup → safety → service_area → discovery → confirm → booking → done
**Caller:** Returning caller. "I need HVAC service tomorrow at 4:30 PM."
**Backend setup:** `lookup_caller` returns an existing upcoming appointment (for example, Thursday, February 26, 2026 at 2:00 PM). `book_service` returns a different slot (for example, Friday, February 27, 2026 at 3:45 PM).
**Expected (UX):**
- Agent acknowledges existing appointment from lookup before booking a new one (or explicitly offers reschedule/cancel path).
- Agent gets one clear booking approval (no duplicate "ready to proceed?" after an explicit yes).
- If `book_service` returns a different slot than requested, agent says the exact booked slot and asks for caller acceptance before final confirmation.
- Agent does not present alternate slot as already accepted.
**Expected (Engineering / State):**
- `urgency_tier` remains consistent from confirm/transition into `book_service` (no silent `routine` → `urgent` drift).
- Booking success handling works with either `{"booked": true}` or `{"booking_confirmed": true}`.
- Post-call/dashboard payload includes booking audit signals:
  - `slot_changed`
  - `urgency_mismatch`
  - `booking_requested_time`
  - `booking_booked_slot`
  - `booking_urgency_transition`
- Dashboard summary text includes a review note when slot/urgency drift occurs.

---

## Validation Checklist

For each test call, verify:
- [ ] State transitions follow expected path (no backward transitions)
- [ ] No "transitioning" language spoken aloud
- [ ] No fabricated bookings (confirm only after successful book_service)
- [ ] Safety question asked for all service callers
- [ ] end_call only available in terminal states (safety_emergency, urgency_callback, booking_failed, confirm, non_service, follow_up, manage_booking, welcome)
- [ ] Urgency state has NO tools (edges only)
- [ ] Safety state has NO tools (edges only)
- [ ] Customer data (name, address, ZIP) flows through transitions without re-asking
- [ ] If backend books a different slot than requested, agent asks for acceptance before final confirmation
- [ ] No duplicate booking approval question after caller has already approved (for example, no extra "ready to proceed?")
- [ ] Dashboard payload includes booking audit flags/details when booking trace exists (`slot_changed`, `urgency_mismatch`, `booking_requested_time`, `booking_booked_slot`, `booking_urgency_transition`)
- [ ] Dashboard card/summary includes a booking review note when slot or urgency drift occurs
