# Exchange-Based Turn Counting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redefine "state turn" as a conversational exchange (agent asks → caller answers = 1 turn) so STT fragments don't burn through the per-state turn limit.

**Architecture:** Add `agent_has_responded` boolean to `CallSession`. Only increment `state_turn_count` when the agent has spoken since the last increment. Per-call `turn_count` stays unchanged as the hard safety ceiling.

**Tech Stack:** Python, pytest, pipecat (TranscriptionFrame processing)

---

### Task 1: Add `agent_has_responded` field to CallSession

**Files:**
- Modify: `pipecat-agent/src/calllock/session.py:53-54`
- Test: `pipecat-agent/tests/test_session.py`

**Step 1: Write the failing test**

Add to `pipecat-agent/tests/test_session.py`:

```python
def test_agent_has_responded_defaults_false():
    session = CallSession(phone_number="+15125551234")
    assert session.agent_has_responded is False
```

**Step 2: Run test to verify it fails**

Run: `pytest pipecat-agent/tests/test_session.py::test_agent_has_responded_defaults_false -v`
Expected: FAIL with `AttributeError: 'CallSession' has no attribute 'agent_has_responded'`

**Step 3: Write minimal implementation**

In `pipecat-agent/src/calllock/session.py`, add after line 54 (`state_turn_count: int = 0`):

```python
    agent_has_responded: bool = False
```

**Step 4: Run test to verify it passes**

Run: `pytest pipecat-agent/tests/test_session.py::test_agent_has_responded_defaults_false -v`
Expected: PASS

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/session.py pipecat-agent/tests/test_session.py
git commit -m "feat: add agent_has_responded field to CallSession"
```

---

### Task 2: Exchange-based increment in StateMachine.process()

**Files:**
- Modify: `pipecat-agent/src/calllock/state_machine.py:103-105` (process method)
- Modify: `pipecat-agent/src/calllock/state_machine.py:90-93` (_transition helper)
- Test: `pipecat-agent/tests/test_state_machine.py`

**Step 1: Write failing tests for the new counting behavior**

Add a new test class to `pipecat-agent/tests/test_state_machine.py`:

```python
class TestExchangeBasedTurnCounting:
    """state_turn_count increments on exchanges, not raw STT frames."""

    def test_consecutive_fragments_count_as_one_turn(self, sm, session):
        """6 consecutive user frames without agent response = 1 state turn."""
        session.state = State.DISCOVERY
        session.agent_has_responded = True  # agent asked a question

        sm.process(session, "Okay it's")
        sm.process(session, "four three two nine")
        sm.process(session, "Franklin Street")
        sm.process(session, "Franklin")
        sm.process(session, "Austin")
        sm.process(session, "Texas")

        assert session.state_turn_count == 1  # all one exchange

    def test_turn_increments_after_agent_responds(self, sm, session):
        """Agent response + next user frame = new exchange."""
        session.state = State.SAFETY
        session.agent_has_responded = True  # agent asked a question

        sm.process(session, "no emergency")
        assert session.state_turn_count == 1

        # Simulate agent responding
        session.agent_has_responded = True

        sm.process(session, "my ac is broken")
        assert session.state_turn_count == 2

    def test_first_utterance_without_agent_response_no_increment(self, sm, session):
        """If agent hasn't responded yet, don't increment state turn."""
        session.state = State.DISCOVERY
        session.agent_has_responded = False

        sm.process(session, "hello")
        assert session.state_turn_count == 0

    def test_transition_resets_agent_has_responded(self, sm, session):
        """State transition must reset agent_has_responded to False."""
        session.state = State.SAFETY
        session.agent_has_responded = True
        sm.process(session, "no")  # triggers transition to SERVICE_AREA
        assert session.state == State.SERVICE_AREA
        assert session.agent_has_responded is False

    def test_per_call_turn_count_always_increments(self, sm, session):
        """Per-call turn_count increments on every frame regardless."""
        session.state = State.DISCOVERY
        session.agent_has_responded = False

        sm.process(session, "fragment one")
        sm.process(session, "fragment two")
        sm.process(session, "fragment three")

        assert session.turn_count == 3  # always increments
        assert session.state_turn_count == 0  # no agent response, no state-turn increment

    def test_discovery_address_fragments_dont_trigger_callback(self, sm, session):
        """Regression: call CA4e393da — address fragments exhausted turn limit.

        Real call had caller dictate address in 5 STT fragments in discovery,
        burning through MAX_TURNS_PER_STATE and escalating to CALLBACK before
        the agent could ask a follow-up question.
        """
        session.state = State.DISCOVERY
        session.customer_name = "Jonas"
        session.problem_description = "AC not cooling"
        session.agent_has_responded = True  # agent asked for address

        # Caller dictates address in 5 fragments (real Deepgram STT behavior)
        sm.process(session, "Okay it's")
        sm.process(session, "four three two nine")
        sm.process(session, "Franklin Street")
        sm.process(session, "Franklin")
        sm.process(session, "Austin Texas")

        # Should still be in DISCOVERY, NOT escalated to CALLBACK
        assert session.state == State.DISCOVERY
        assert session.state_turn_count == 1

        # Now set address and verify progression to URGENCY
        session.service_address = "4329 Franklin Street"
        session.agent_has_responded = True
        sm.process(session, "yeah that's right")
        assert session.state == State.URGENCY
```

**Step 2: Run tests to verify they fail**

Run: `pytest pipecat-agent/tests/test_state_machine.py::TestExchangeBasedTurnCounting -v`
Expected: FAIL — `state_turn_count` will be too high because current code always increments.

**Step 3: Implement the conditional increment**

In `pipecat-agent/src/calllock/state_machine.py`, change `process()` (lines 103-105):

**Before:**
```python
    def process(self, session: CallSession, user_text: str) -> Action:
        session.turn_count += 1
        session.state_turn_count += 1
```

**After:**
```python
    def process(self, session: CallSession, user_text: str) -> Action:
        session.turn_count += 1

        # Only count a new state turn when the agent has responded since last increment.
        # Consecutive user frames (STT fragments) are part of the same exchange.
        if session.agent_has_responded:
            session.state_turn_count += 1
            session.agent_has_responded = False
```

In `_transition()` (line 90-93), add reset:

**Before:**
```python
def _transition(session: CallSession, new_state: State):
    """Helper to transition state and reset turn counter."""
    session.state = new_state
    session.state_turn_count = 0
```

**After:**
```python
def _transition(session: CallSession, new_state: State):
    """Helper to transition state and reset turn counter."""
    session.state = new_state
    session.state_turn_count = 0
    session.agent_has_responded = False
```

**Step 4: Run the new tests to verify they pass**

Run: `pytest pipecat-agent/tests/test_state_machine.py::TestExchangeBasedTurnCounting -v`
Expected: PASS

**Step 5: Fix existing test `test_turn_limit_still_fires_within_state`**

This test (line 596) currently calls `process()` 6 times consecutively and expects the 6th to trigger CALLBACK. With exchange-based counting, those 6 calls are 0-1 state turns. The test must simulate actual exchanges.

**Before:**
```python
    def test_turn_limit_still_fires_within_state(self, sm, session):
        """Turn limit must still work when turns accumulate in a single state."""
        session.state = State.SAFETY
        session.state_turn_count = 0

        # 6 turns in SAFETY (exceeds MAX_TURNS_PER_STATE=5)
        for _ in range(5):
            sm.process(session, "what do you mean?")
        assert session.state == State.SAFETY

        sm.process(session, "what?")
        assert session.state == State.CALLBACK  # turn limit fires
```

**After:**
```python
    def test_turn_limit_still_fires_within_state(self, sm, session):
        """Turn limit must still work when exchanges accumulate in a single state."""
        session.state = State.SAFETY
        session.state_turn_count = 0

        # 6 exchanges in SAFETY (exceeds MAX_TURNS_PER_STATE=5)
        for _ in range(5):
            session.agent_has_responded = True  # simulate agent asking a question
            sm.process(session, "what do you mean?")
        assert session.state == State.SAFETY

        session.agent_has_responded = True
        sm.process(session, "what?")
        assert session.state == State.CALLBACK  # turn limit fires
```

**Step 6: Run full state machine test suite**

Run: `pytest pipecat-agent/tests/test_state_machine.py -v`
Expected: ALL PASS. Only `test_turn_limit_still_fires_within_state` (fixed in Step 5) needed updating. All other existing tests pass without modification because they either (a) test transition resets (which still reset to 0) or (b) don't assert on `state_turn_count` values.

**Step 7: Commit**

```bash
git add pipecat-agent/src/calllock/state_machine.py pipecat-agent/tests/test_state_machine.py
git commit -m "feat: exchange-based state turn counting

Only increment state_turn_count when agent has responded since the
last increment. Consecutive STT fragments count as one exchange.
Per-call turn_count unchanged as hard safety ceiling."
```

---

### Task 3: Set `agent_has_responded` flag in processor

**Files:**
- Modify: `pipecat-agent/src/calllock/processor.py:69-85` (_capture_agent_responses method)
- Test: `pipecat-agent/tests/test_processor.py`

**Step 1: Write the failing test**

Check existing processor test patterns first. The processor tests likely use mocks for the pipeline context. Add a test that verifies `agent_has_responded` gets set after an agent message is captured.

Add to `pipecat-agent/tests/test_processor.py`:

```python
def test_agent_response_sets_flag(processor):
    """Capturing an agent response must set session.agent_has_responded."""
    processor.session.agent_has_responded = False

    # Simulate LLM adding an assistant message to context
    processor.context.messages.append({"role": "assistant", "content": "What's your ZIP code?"})

    processor._capture_agent_responses()

    assert processor.session.agent_has_responded is True


def test_no_agent_response_leaves_flag(processor):
    """If no new assistant messages, agent_has_responded stays unchanged."""
    processor.session.agent_has_responded = False

    # Add a user message (not assistant)
    processor.context.messages.append({"role": "user", "content": "hello"})

    processor._capture_agent_responses()

    assert processor.session.agent_has_responded is False
```

**Note:** The existing `processor` fixture (test_processor.py:14-36) creates a real `StateMachineProcessor` with `MagicMock` context and `AsyncMock` tools. `processor.context.messages` is a regular list and `processor._capture_agent_responses()` is directly callable. These tests fit the existing fixture without modification.

**Step 2: Run test to verify it fails**

Run: `pytest pipecat-agent/tests/test_processor.py::test_agent_response_sets_flag -v`
Expected: FAIL — `agent_has_responded` stays False.

**Step 3: Implement the flag-setting**

In `pipecat-agent/src/calllock/processor.py`, modify `_capture_agent_responses()` (line 69):

**Before:**
```python
    def _capture_agent_responses(self):
        while self._context_capture_idx < len(self.context.messages):
            msg = self.context.messages[self._context_capture_idx]
            if msg.get("role") == "assistant" and msg.get("content"):
                self.session.transcript_log.append({
                    "role": "agent",
                    "content": msg["content"],
                    "timestamp": _time.time(),
                    "state": self.session.state.value,
                })
            self._context_capture_idx += 1
```

**After:**
```python
    def _capture_agent_responses(self):
        while self._context_capture_idx < len(self.context.messages):
            msg = self.context.messages[self._context_capture_idx]
            if msg.get("role") == "assistant" and msg.get("content"):
                self.session.transcript_log.append({
                    "role": "agent",
                    "content": msg["content"],
                    "timestamp": _time.time(),
                    "state": self.session.state.value,
                })
                self.session.agent_has_responded = True
            self._context_capture_idx += 1
```

One line added: `self.session.agent_has_responded = True` inside the `if` block.

Also add a documenting comment above the method explaining the design assumption:

```python
    def _capture_agent_responses(self):
        """Capture new assistant messages from LLM context to transcript log.

        The LLM output flows downstream (LLM → TTS → transport), bypassing
        this processor. We read agent responses from the context aggregator's
        message list instead.

        NOTE: Canned TTSSpeakFrame messages (e.g. "One moment" during tool calls,
        turn-limit escalation messages) bypass the LLM and don't appear in context,
        so they don't set agent_has_responded. This is correct because canned speaks
        are either terminal (call ending) or followed by an LLM response (force_llm
        after tool-induced state transitions).
        """
```

**Step 4: Run tests to verify they pass**

Run: `pytest pipecat-agent/tests/test_processor.py -v`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add pipecat-agent/src/calllock/processor.py pipecat-agent/tests/test_processor.py
git commit -m "feat: set agent_has_responded after LLM generates response

Completes exchange-based turn counting by marking when the agent
has spoken, so the next user frame starts a new exchange."
```

---

### Task 4: Run full test suite and verify

**Files:**
- None modified — verification only.

**Step 1: Run full test suite**

Run: `pytest pipecat-agent/tests/ -v`
Expected: ALL PASS (166+ tests). All existing tests should pass — the only test that needed updating (`test_turn_limit_still_fires_within_state`) was fixed in Task 2.

**Step 2: Verify the exact scenario from the bug**

Run: `pytest pipecat-agent/tests/test_state_machine.py::TestExchangeBasedTurnCounting::test_consecutive_fragments_count_as_one_turn -v`
Expected: PASS — confirms the address-fragment scenario no longer triggers premature callback.

**Step 3: Commit any remaining test fixes**

If any tests needed adjustment in Step 1:

```bash
git add pipecat-agent/tests/
git commit -m "test: fix existing tests for exchange-based turn counting"
```
