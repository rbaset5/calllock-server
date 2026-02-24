# Booking Confirmation Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 3 production issues: Invalid Date in booking confirmation, CONFIRM state hallucination, and address number-word mangling.

**Architecture:** All 3 fixes live on the Pipecat agent side. Fix 1 adds datetime resolution to validation.py and rewires the tools.py payload (also fixes a second field mismatch: `issue_description` → `problem_description`). Fix 2 stores confirmation details on CallSession and renders them via the system prompt `_build_context()`. Fix 3 adds number-word normalization to the address validator.

**Tech Stack:** Python 3.13, pytest, `zoneinfo` (stdlib), `datetime` (stdlib)

**Design doc:** `docs/plans/2026-02-23-booking-confirmation-fixes-design.md`

**Review changes applied:**
- Dropped even-hour rounding from `resolve_booking_time` — just `now + 2h` truncated to hour
- Added `"same day"` and `"morning"` to ASAP keyword set
- Fixed second field mismatch (`issue_description` → `problem_description`) in Task 2
- Rewrote Task 3: confirmation via `session.confirmation_message` + `_build_context()` instead of `[System:]` injection
- Removed "One Twenty Three" test (WORD_TO_DIGIT has no "twenty")
- Removed dead hyphen-check code from `_normalize_address_number`
- Tightened all test assertions to verify exact hour

---

### Task 1: Add `resolve_booking_time()` with TDD

**Files:**
- Modify: `pipecat-agent/tests/test_validation.py` (append test class + imports)
- Modify: `pipecat-agent/src/calllock/validation.py` (add function + imports)

**Step 1: Write the failing tests**

Add these imports near the top of `pipecat-agent/tests/test_validation.py`:

```python
from calllock.validation import resolve_booking_time
from unittest.mock import patch
from datetime import datetime
from zoneinfo import ZoneInfo
```

Append this test class at the end of the file:

```python
class TestResolveBookingTime:
    """resolve_booking_time maps human text to ISO datetime strings."""

    CST = ZoneInfo("America/Chicago")

    def _freeze(self, year=2026, month=2, day=23, hour=10, minute=0):
        return datetime(year, month, day, hour, minute, tzinfo=self.CST)

    def test_asap_returns_2h_ahead_truncated(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10, minute=15)):
            result = resolve_booking_time("ASAP")
        assert "2026-02-23T12:00:00" in result

    def test_today_returns_2h_ahead_truncated(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=9, minute=30)):
            result = resolve_booking_time("today")
        assert "2026-02-23T11:00:00" in result

    def test_soonest_same_as_asap(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10, minute=15)):
            result = resolve_booking_time("soonest")
        assert "2026-02-23T12:00:00" in result

    def test_right_away_same_as_asap(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10, minute=15)):
            result = resolve_booking_time("right away")
        assert "2026-02-23T12:00:00" in result

    def test_same_day_treated_as_asap(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10, minute=15)):
            result = resolve_booking_time("same day")
        assert "2026-02-23T12:00:00" in result

    def test_morning_treated_as_asap(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=8, minute=0)):
            result = resolve_booking_time("morning")
        assert "2026-02-23T10:00:00" in result

    def test_late_evening_asap_goes_next_morning(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=19)):
            result = resolve_booking_time("ASAP")
        assert "2026-02-24T09:00:00" in result

    def test_tomorrow_returns_9am(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=15)):
            result = resolve_booking_time("tomorrow")
        assert "2026-02-24T09:00:00" in result

    def test_tomorrow_morning_returns_9am(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=15)):
            result = resolve_booking_time("tomorrow morning")
        assert "2026-02-24T09:00:00" in result

    def test_this_afternoon_before_2pm(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10)):
            result = resolve_booking_time("this afternoon")
        assert "2026-02-23T14:00:00" in result

    def test_this_afternoon_after_2pm_goes_tomorrow(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=15)):
            result = resolve_booking_time("this afternoon")
        assert "2026-02-24T14:00:00" in result

    def test_this_week_returns_next_day_9am(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10)):
            result = resolve_booking_time("this week")
        assert "2026-02-24T09:00:00" in result

    def test_whenever_returns_next_day_9am(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10)):
            result = resolve_booking_time("whenever")
        assert "2026-02-24T09:00:00" in result

    def test_empty_returns_next_day_9am(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10)):
            result = resolve_booking_time("")
        assert "2026-02-24T09:00:00" in result

    def test_unknown_text_falls_through_to_default(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10)):
            result = resolve_booking_time("next week")
        assert "2026-02-24T09:00:00" in result

    def test_result_is_valid_iso_format(self):
        with patch("calllock.validation._now_cst", return_value=self._freeze(hour=10)):
            result = resolve_booking_time("ASAP")
        datetime.fromisoformat(result)
```

**Step 2: Run tests to verify they fail**

Run: `cd pipecat-agent && python -m pytest tests/test_validation.py::TestResolveBookingTime -v`
Expected: ImportError — `resolve_booking_time` not found

**Step 3: Write the implementation**

Add these imports at top of `pipecat-agent/src/calllock/validation.py` (before `import re`):

```python
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
```

Add after `validate_address()` (after `is_service_area`) in `validation.py`:

```python
_CST = ZoneInfo("America/Chicago")
_BUSINESS_START = 9   # 9 AM
_BUSINESS_END = 18    # 6 PM

_ASAP_KEYWORDS = {
    "asap", "today", "right away", "soonest", "right now",
    "as soon as possible", "same day", "morning",
}


def _now_cst() -> datetime:
    """Get current time in CST. Extracted for test mocking."""
    return datetime.now(_CST)


def resolve_booking_time(preferred_time: str) -> str:
    """Map human preferred_time text to an ISO datetime string.

    Returns an ISO 8601 datetime in America/Chicago timezone suitable
    for Cal.com's booking API. This is a hint — Cal.com picks the actual
    available slot from its calendar.
    """
    now = _now_cst()
    text = preferred_time.strip().lower()

    # ASAP / today / right away / soonest / same day / morning → now + 2h truncated
    if text in _ASAP_KEYWORDS:
        target = (now + timedelta(hours=2)).replace(minute=0, second=0, microsecond=0)
        # If past business hours, go to next morning
        if target.hour >= _BUSINESS_END or target.hour < _BUSINESS_START:
            target = (now + timedelta(days=1)).replace(
                hour=_BUSINESS_START, minute=0, second=0, microsecond=0
            )
        return target.isoformat()

    # Tomorrow → 9 AM next day
    if "tomorrow" in text:
        target = (now + timedelta(days=1)).replace(
            hour=_BUSINESS_START, minute=0, second=0, microsecond=0
        )
        return target.isoformat()

    # This afternoon → 2 PM today (or tomorrow if past 2 PM)
    if "afternoon" in text:
        target = now.replace(hour=14, minute=0, second=0, microsecond=0)
        if now.hour >= 14:
            target += timedelta(days=1)
        return target.isoformat()

    # Default: this week / whenever / empty / unknown → 9 AM next day
    target = (now + timedelta(days=1)).replace(
        hour=_BUSINESS_START, minute=0, second=0, microsecond=0
    )
    return target.isoformat()
```

**Step 4: Run tests to verify they pass**

Run: `cd pipecat-agent && python -m pytest tests/test_validation.py::TestResolveBookingTime -v`
Expected: All PASS

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/validation.py pipecat-agent/tests/test_validation.py
git commit -m "feat: add resolve_booking_time to map human text to ISO datetime"
```

---

### Task 2: Rewire `tools.py` payload — fix both field mismatches

**Files:**
- Modify: `pipecat-agent/src/calllock/tools.py:92-97`
- Modify: `pipecat-agent/src/calllock/processor.py:325-331`

**Step 1: Update `tools.py` payload — fix both mismatches**

In `pipecat-agent/src/calllock/tools.py`, change the `args` dict (lines 92-98) from:

```python
                    "args": {
                        "customer_name": customer_name,
                        "customer_phone": phone,
                        "issue_description": problem,
                        "service_address": address,
                        "preferred_time": preferred_time,
                    },
```

to:

```python
                    "args": {
                        "customer_name": customer_name,
                        "customer_phone": phone,
                        "problem_description": problem,
                        "service_address": address,
                        "date_time": preferred_time,
                    },
```

Two changes: `"issue_description"` → `"problem_description"` (V2 reads `args.problem_description` at server.ts:798) and `"preferred_time"` → `"date_time"` (V2 reads `args.date_time` at server.ts:792).

**Step 2: Update `processor.py` to resolve before sending**

In `pipecat-agent/src/calllock/processor.py`, update the import line to add `resolve_booking_time`:

```python
from calllock.validation import validate_name, validate_zip, validate_address, match_any_keyword, resolve_booking_time
```

Then change the `book_service` call from:

```python
                preferred_time=self.session.preferred_time,
```

to:

```python
                preferred_time=resolve_booking_time(self.session.preferred_time),
```

**Step 3: Run full test suite**

Run: `cd pipecat-agent && python -m pytest tests/ -v`
Expected: All PASS

**Step 4: Commit**

```bash
git add pipecat-agent/src/calllock/tools.py pipecat-agent/src/calllock/processor.py
git commit -m "fix: send date_time and problem_description to V2 (field name mismatches)"
```

---

### Task 3: Store confirmation message on session + render in system prompt

**Files:**
- Modify: `pipecat-agent/src/calllock/session.py` (add field)
- Modify: `pipecat-agent/src/calllock/processor.py` (set field after booking)
- Modify: `pipecat-agent/src/calllock/prompts.py` (render in `_build_context`)
- Modify: `pipecat-agent/tests/test_processor.py` (test session field is set)
- Create: `pipecat-agent/tests/test_prompts.py` (test `_build_context` rendering)

**Step 1: Write the failing tests**

**Test A** — Append to `pipecat-agent/tests/test_processor.py`, after `TestExtractionFirewall`:

```python
class TestBookingConfirmationStorage:
    """After book_service returns success, confirmation_message must be stored on session."""

    @pytest.mark.asyncio
    async def test_confirmation_message_stored_on_session(self, processor):
        processor.session.state = State.BOOKING
        processor.session.booking_attempted = False
        processor.session.customer_name = "Jonas"
        processor.session.problem_description = "AC broken"
        processor.session.service_address = "5311 Izzical Road"
        processor.session.preferred_time = "ASAP"
        processor.tools.book_service.return_value = {
            "booking_confirmed": True,
            "confirmationMessage": "Appointment confirmed for Monday, February 24 at 2:00 PM",
            "appointmentId": "apt_123",
        }
        processor.context.messages = [
            {"role": "system", "content": "test"},
        ]

        frame = TranscriptionFrame(text="sounds good", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        assert processor.session.state == State.CONFIRM
        assert processor.session.confirmation_message == "Appointment confirmed for Monday, February 24 at 2:00 PM"

    @pytest.mark.asyncio
    async def test_no_confirmation_message_on_failure(self, processor):
        processor.session.state = State.BOOKING
        processor.session.booking_attempted = False
        processor.tools.book_service.return_value = {
            "booked": False,
            "error": "No slots available",
        }
        processor.context.messages = [
            {"role": "system", "content": "test"},
        ]

        frame = TranscriptionFrame(text="sounds good", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        assert processor.session.confirmation_message == ""
```

**Test B** — Create `pipecat-agent/tests/test_prompts.py`:

```python
from calllock.session import CallSession
from calllock.states import State
from calllock.prompts import _build_context


class TestBuildContextBookingDetails:
    """_build_context renders confirmation_message only in CONFIRM state."""

    def test_confirm_state_includes_booking_details(self):
        session = CallSession(phone_number="+15125551234")
        session.state = State.CONFIRM
        session.customer_name = "Jonas"
        session.confirmation_message = "Appointment confirmed for Monday, February 24 at 2:00 PM"

        context = _build_context(session)
        assert "Monday, February 24 at 2:00 PM" in context

    def test_non_confirm_state_excludes_booking_details(self):
        session = CallSession(phone_number="+15125551234")
        session.state = State.BOOKING
        session.customer_name = "Jonas"
        session.confirmation_message = "Appointment confirmed for Monday, February 24 at 2:00 PM"

        context = _build_context(session)
        assert "Monday, February 24" not in context
```

**Step 2: Run tests to verify they fail**

Run: `cd pipecat-agent && python -m pytest tests/test_processor.py::TestBookingConfirmationStorage tests/test_prompts.py::TestBuildContextBookingDetails -v`
Expected: FAIL — `confirmation_message` attribute doesn't exist on CallSession

**Step 3: Add `confirmation_message` field to CallSession**

In `pipecat-agent/src/calllock/session.py`, add this field to the `CallSession` dataclass (alongside other string fields):

```python
    confirmation_message: str = ""
```

**Step 4: Set `confirmation_message` in processor after booking**

In `pipecat-agent/src/calllock/processor.py`, in `_execute_tool()`, add after the `book_service` call (after the existing result assignment, before `elif tool == "create_callback"`):

```python
            # Store confirmation for system prompt rendering in CONFIRM state
            if result.get("booking_confirmed"):
                self.session.confirmation_message = result.get("confirmationMessage", "")
```

**Step 5: Render confirmation in `_build_context()`**

In `pipecat-agent/src/calllock/prompts.py`, in the `_build_context` function, add before the final `if not parts: return ""`:

```python
    if session.state == State.CONFIRM and session.confirmation_message:
        parts.append(f"Booking result: {session.confirmation_message}")
```

**Step 6: Run tests to verify they pass**

Run: `cd pipecat-agent && python -m pytest tests/test_processor.py::TestBookingConfirmationStorage tests/test_prompts.py::TestBuildContextBookingDetails -v`
Expected: All PASS

**Step 7: Run full test suite**

Run: `cd pipecat-agent && python -m pytest tests/ -v`
Expected: All PASS

**Step 8: Commit**

```bash
git add pipecat-agent/src/calllock/session.py pipecat-agent/src/calllock/processor.py pipecat-agent/src/calllock/prompts.py pipecat-agent/tests/test_processor.py pipecat-agent/tests/test_prompts.py
git commit -m "fix: store confirmation message on session, render in CONFIRM system prompt"
```

---

### Task 4: Move `WORD_TO_DIGIT` and `words_to_digits` to `validation.py`

**Files:**
- Modify: `pipecat-agent/src/calllock/validation.py` (add dict + function)
- Modify: `pipecat-agent/src/calllock/state_machine.py:7-18` (add to import) and `:107-122` (remove definition)

**Step 1: Add `WORD_TO_DIGIT` and `words_to_digits` to `validation.py`**

Add after the keyword sets section (after `PROPERTY_MANAGER_KEYWORDS`, before `validate_zip`) in `pipecat-agent/src/calllock/validation.py`:

```python
WORD_TO_DIGIT = {
    "zero": "0", "oh": "0", "o": "0",
    "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
}


def words_to_digits(text: str) -> str:
    """Convert number words and single digits to a digit string.

    Only handles single-digit words (one through nine, zero, oh, o).
    Used for ZIP code and address normalization.
    Example: "seven eight seven zero one" → "78701"
    """
    tokens = re.findall(r"[a-zA-Z]+|\d", text.lower())
    digits = []
    for tok in tokens:
        if tok in WORD_TO_DIGIT:
            digits.append(WORD_TO_DIGIT[tok])
        elif tok.isdigit():
            digits.append(tok)
    return "".join(digits)
```

**Step 2: Update `state_machine.py` to import instead of define**

In `pipecat-agent/src/calllock/state_machine.py`, add `WORD_TO_DIGIT` and `words_to_digits` to the existing import from `calllock.validation` (lines 7-18):

```python
from calllock.validation import (
    validate_zip,
    validate_name,
    validate_address,
    is_service_area,
    classify_intent,
    detect_safety_emergency,
    detect_high_ticket,
    detect_callback_request,
    match_any_keyword,
    MANAGE_BOOKING_KEYWORDS,
    WORD_TO_DIGIT,
    words_to_digits,
)
```

Then delete lines 107-122 (the `WORD_TO_DIGIT` dict and `words_to_digits` function definitions).

**Step 3: Run full test suite**

Run: `cd pipecat-agent && python -m pytest tests/ -v`
Expected: All PASS — behavior unchanged, just moved location

**Step 4: Commit**

```bash
git add pipecat-agent/src/calllock/validation.py pipecat-agent/src/calllock/state_machine.py
git commit -m "refactor: move WORD_TO_DIGIT and words_to_digits to validation.py"
```

---

### Task 5: Add number-word normalization to `validate_address()`

**Files:**
- Modify: `pipecat-agent/tests/test_validation.py` (append to TestValidateAddress)
- Modify: `pipecat-agent/src/calllock/validation.py` (enhance `validate_address`)

**Step 1: Write the failing tests**

Append these test methods to the `TestValidateAddress` class in `pipecat-agent/tests/test_validation.py`:

```python
    def test_normalizes_mixed_digit_word_street_number(self):
        """'53 Eleven Izzical Road' → '5311 Izzical Road'"""
        assert validate_address("53 Eleven Izzical Road") == "5311 Izzical Road"

    def test_normalizes_digit_then_word(self):
        """'4 Two Six Elm St' → '426 Elm St'"""
        assert validate_address("4 Two Six Elm St") == "426 Elm St"

    def test_leaves_already_numeric_alone(self):
        """'5311 Main St' → '5311 Main St' (no change)"""
        assert validate_address("5311 Main St") == "5311 Main St"

    def test_stops_at_non_number_word(self):
        """'Five Oak Lane' → '5 Oak Lane' (stops at 'Oak')"""
        assert validate_address("Five Oak Lane") == "5 Oak Lane"

    def test_oh_as_zero_in_address(self):
        """'5 Oh Three Main St' → '503 Main St'"""
        assert validate_address("5 Oh Three Main St") == "503 Main St"
```

Note: "One Twenty Three Main St" test removed — `WORD_TO_DIGIT` only has single-digit words, not "twenty".

**Step 2: Run tests to verify they fail**

Run: `cd pipecat-agent && python -m pytest tests/test_validation.py::TestValidateAddress::test_normalizes_mixed_digit_word_street_number -v`
Expected: FAIL — returns "53 Eleven Izzical Road" unchanged

**Step 3: Implement address number normalization**

Add `_normalize_address_number` before `validate_address` in `pipecat-agent/src/calllock/validation.py`, and update `validate_address`:

```python
def _normalize_address_number(address: str) -> str:
    """Convert leading number words in an address to digits.

    Only handles single-digit words (one through nine, zero, oh, o).
    Handles mixed sequences like '53 Eleven' → '5311'.
    Stops at the first token that is not a digit or number word.
    """
    tokens = address.split()
    if not tokens:
        return address

    digit_parts = []
    first_non_number_idx = 0

    for i, tok in enumerate(tokens):
        lower = tok.lower()
        if lower in WORD_TO_DIGIT:
            digit_parts.append(WORD_TO_DIGIT[lower])
            first_non_number_idx = i + 1
        elif tok.isdigit():
            digit_parts.append(tok)
            first_non_number_idx = i + 1
        else:
            break

    if not digit_parts or first_non_number_idx == 0:
        return address

    number_str = "".join(digit_parts)
    rest = " ".join(tokens[first_non_number_idx:])
    if rest:
        return f"{number_str} {rest}"
    return number_str


def validate_address(value: str | None) -> str:
    if not value:
        return ""
    cleaned = value.strip()
    if cleaned.lower() in SENTINEL_VALUES:
        return ""
    if re.search(r"\bor\b", cleaned, re.IGNORECASE):
        return ""

    # Normalize number words in street number before validation
    cleaned = _normalize_address_number(cleaned)

    # Must contain at least one letter (rejects "7801", "78001")
    if not re.search(r"[a-zA-Z]", cleaned):
        return ""
    # Must be at least 5 characters (rejects "Oak", "1 Rk")
    if len(cleaned) < 5:
        return ""
    return cleaned
```

**Step 4: Run tests to verify they pass**

Run: `cd pipecat-agent && python -m pytest tests/test_validation.py::TestValidateAddress -v`
Expected: All PASS

**Step 5: Run full test suite**

Run: `cd pipecat-agent && python -m pytest tests/ -v`
Expected: All PASS

**Step 6: Commit**

```bash
git add pipecat-agent/src/calllock/validation.py pipecat-agent/tests/test_validation.py
git commit -m "fix: normalize number words in street addresses (53 Eleven → 5311)"
```

---

### Task 6: Full test suite verification + deploy

**Files:** None — verification only

**Step 1: Run full test suite**

Run: `cd pipecat-agent && python -m pytest tests/ -v`
Expected: All PASS

**Step 2: Deploy to Fly.io**

Run: `cd pipecat-agent && fly deploy -a calllock-voice`
Expected: Deployment succeeds, health check passes

**Step 3: Verify health**

Run: `curl -s https://calllock-voice.fly.dev/health`
Expected: `{"status": "ok"}` or similar

**Step 4: Commit plan doc**

```bash
git add docs/plans/2026-02-23-booking-confirmation-fixes-plan.md
git commit -m "docs: implementation plan for booking confirmation fixes"
```
