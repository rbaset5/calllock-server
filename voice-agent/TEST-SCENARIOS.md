# TEST SCENARIOS (v5-dispatcher)

Each scenario includes: goal, sample caller lines, expected path.

---

## 1) Normal Direct Booking (Happy Path)
**Goal:** 1 → 2 → 4 → 5 → 6 → 7 → 8 → 12
**Caller:** "Schedule service. No AC — blowing warm since yesterday. ZIP 78745."
**Expected:** Safety passes → ZIP accepted → discovery (2 Qs) → slots → booking success → confirm.

---

## 2) Urgent, No Same-Day → Callback
**Goal:** 5 → 6 (no same-day) → 9 → 12
**Caller:** "No AC and it's 105. I need today."
**Expected:** Calendar offers callback within hour when no same-day.

---

## 3) Booking Tool Fails → Callback
**Goal:** 6 → 7 (tool failure) → 9 → 12
**Caller:** Picks "tomorrow at 9."
**Expected:** Booking attempts tool; on failure: "not able to finalize…" then callback.

---

## 4) Confirmation Catches Missed Booking → Back-transition
**Goal:** 8 detects tool not called → back to 7
**Caller:** "Wait—are we actually confirmed?"
**Expected:** Agent returns to booking state and locks it in before confirming.

---

## 5) Safety Emergency (Gas Smell)
**Goal:** 2 → 3
**Caller:** "I smell gas by the furnace."
**Expected:** Immediate safety line; no further questions.

---

## 6) Out-of-Area Caller (ZIP Rejection)
**Goal:** 4 → 12
**Caller:** ZIP "78613" or "77002"
**Expected:** Honest testing language: "only servicing Austin 787 ZIP codes while we test."

---

## 7) Wrong Number / Vendor
**Goal:** 1 → 12
**Caller A:** "Wrong number."
**Caller B:** "We sell SEO/leads."
**Expected:** Polite wrong-number close; firm vendor rejection.

---

## 8) Existing Appointment Inquiry
**Goal:** 1 → 10
**Caller:** "I have an appointment tomorrow — what time?"
**Expected:** Routes to existing_customer flow; cleaner "Let me pull up your info."
