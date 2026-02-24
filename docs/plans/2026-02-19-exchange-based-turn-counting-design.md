# Exchange-Based Turn Counting

**Date:** 2026-02-19
**Status:** Approved
**Branch:** `rbaset5/pipecat-post-call`

## Problem

Deepgram STT delivers each speech segment as a separate `TranscriptionFrame`. Every frame triggers `StateMachine.process()`, which increments `state_turn_count`. When a caller dictates an address in fragments (e.g., "It's" / "four three two nine" / "Franklin Street"), each fragment counts as a full turn.

With `MAX_TURNS_PER_STATE = 5`, a single address dictated across 5 STT frames exhausts the limit. The agent never gets to ask a follow-up — the caller is still answering the first question when the callback escalation fires.

**Evidence:** Call `CA4e393dabc01b60a99996103fd7cd6ef5` (2026-02-19 16:37 UTC). Caller gave address in 5 fragments in `discovery` state. Per-state turn limit exceeded. Call escalated to `CALLBACK` before reaching `urgency` or `booking`.

## Design

Redefine "state turn" to mean a conversational exchange: **agent asks, caller answers = 1 turn**. Multiple caller utterances before the agent responds are part of the same turn.

### Changes

**`session.py`** — Add field:

```python
agent_has_responded: bool = False
```

Tracks whether the agent has spoken since the last state-turn increment.

**`state_machine.py`** — Conditional increment:

```python
def process(self, session, user_text):
    session.turn_count += 1  # per-call: raw frame count, hard ceiling

    if session.agent_has_responded:
        session.state_turn_count += 1
        session.agent_has_responded = False

    # ... rest unchanged
```

**`processor.py`** — Set flag after LLM responds:

In `_capture_agent_responses()`, after capturing an assistant message, set `session.agent_has_responded = True`.

**`state_machine.py` `_transition()`** — Reset on state change:

```python
def _transition(session, new_state):
    session.state = new_state
    session.state_turn_count = 0
    session.agent_has_responded = False
```

### Behavior

Before (5 fragments = 5 turns):

| Frame              | state_turn_count |
|--------------------|-----------------|
| "Okay. It's"      | 1               |
| "seven eight"      | 2               |
| "four three two nine" | 3           |
| "Franklin Street," | 4               |
| "Franklin."        | 5 → CALLBACK    |

After (5 fragments = 1 turn):

| Frame              | state_turn_count | agent_has_responded |
|--------------------|-----------------|---------------------|
| "Okay. It's"      | 1               | was True → now False |
| "seven eight"      | 1               | False (no increment) |
| "four three two nine" | 1           | False                |
| "Franklin Street," | 1               | False                |
| "Franklin."        | 1               | False                |
| Agent responds     | 1               | → True               |
| Next caller frame  | 2               | was True → now False |

### Safety

- Per-call `turn_count` unchanged: increments on every raw frame, hard ceiling at 30.
- Per-state limit still enforced: 5 exchanges means the agent asked 5 questions and got 5 answers with no state progress.
- Canned `action.speak` messages (turn-limit escalation) don't set `agent_has_responded` — correct since they aren't conversational exchanges.

### Scope

- Global: applies to all states, not just discovery.
- No constant changes: `MAX_TURNS_PER_STATE` stays at 5, `MAX_TURNS_PER_CALL` stays at 30.

### Testing

- Existing tests pass (counting is more lenient, not more strict).
- New test: 6 consecutive user frames without agent response → `state_turn_count` stays at 1.
- New test: agent response + user frame → `state_turn_count` increments to 2.
- New test: state transition resets both `state_turn_count` and `agent_has_responded`.

### Files Modified

| File | Change |
|------|--------|
| `src/calllock/session.py` | Add `agent_has_responded: bool = False` |
| `src/calllock/state_machine.py` | Conditional increment in `process()`, reset in `_transition()` |
| `src/calllock/processor.py` | Set `agent_has_responded = True` in `_capture_agent_responses()` |
| `tests/` | New exchange-based turn counting tests |
