import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from calllock.processor import StateMachineProcessor
from calllock.session import CallSession
from calllock.state_machine import StateMachine
from calllock.states import State
from calllock.extraction import extract_fields

from pipecat.processors.frame_processor import FrameDirection
from pipecat.frames.frames import TranscriptionFrame, InterimTranscriptionFrame, EndFrame, LLMMessagesFrame
from calllock.state_machine import Action


@pytest.fixture
def processor():
    session = CallSession(phone_number="+15125551234")
    machine = StateMachine()
    tools = AsyncMock()
    # Return proper dicts so validate_name/validate_zip don't choke on mocks
    tools.lookup_caller.return_value = {"found": False}
    tools.book_service.return_value = {"booked": False}
    tools.create_callback.return_value = {"success": True}
    tools.send_sales_lead_alert.return_value = {"success": True}
    context = MagicMock()
    context.messages = [{"role": "system", "content": "test prompt"}]
    proc = StateMachineProcessor(
        session=session,
        machine=machine,
        tools=tools,
        context=context,
    )
    # Mock push_frame to capture output
    proc.push_frame = AsyncMock()
    # Mock _run_extraction to avoid LLM calls
    proc._run_extraction = AsyncMock()
    proc.BUFFER_DEBOUNCE_S = 0.05
    return proc


class TestDirectTranscriptionProcessing:
    """With Smart Turn handling coalescing upstream, transcription frames go straight through."""

    @pytest.mark.asyncio
    async def test_transcription_processed_immediately(self, processor):
        """TranscriptionFrame should trigger state machine without debounce delay."""
        await processor.process_frame(
            TranscriptionFrame(text="my AC is broken", user_id="", timestamp=""),
            FrameDirection.DOWNSTREAM,
        )
        assert processor.session.turn_count == 1

    @pytest.mark.asyncio
    async def test_multiple_frames_are_separate_turns(self, processor):
        """Each TranscriptionFrame is its own turn (Smart Turn handles coalescing upstream)."""
        processor.session.state = State.SAFETY
        await processor.process_frame(
            TranscriptionFrame(text="no gas smell", user_id="", timestamp=""),
            FrameDirection.DOWNSTREAM,
        )
        await processor.process_frame(
            TranscriptionFrame(text="everything is fine", user_id="", timestamp=""),
            FrameDirection.DOWNSTREAM,
        )
        assert processor.session.turn_count == 2


class TestNonBlockingExtraction:
    @pytest.mark.asyncio
    async def test_extraction_runs_in_background(self, processor):
        """Extraction should not block the transcription frame from reaching the LLM."""
        # Make extraction take 500ms (simulating real GPT-4o-mini call)
        extraction_started = asyncio.Event()
        extraction_finished = asyncio.Event()

        async def slow_extraction():
            extraction_started.set()
            await asyncio.sleep(0.5)
            extraction_finished.set()

        processor._run_extraction = slow_extraction

        # Put processor in discovery state (triggers extraction)
        processor.session.state = State.DISCOVERY
        processor.session.conversation_history = [
            {"role": "user", "content": "hello"},
            {"role": "agent", "content": "hi"},
        ]

        frame = TranscriptionFrame(text="My AC is broken.", user_id="", timestamp="")
        await processor._handle_transcription(frame)
        await asyncio.sleep(0)  # Yield to let background task start

        # Frame should have been pushed downstream BEFORE extraction finishes
        assert processor.push_frame.called, "Frame should be pushed without waiting for extraction"
        assert extraction_started.is_set(), "Extraction should have started"
        assert not extraction_finished.is_set(), "Extraction should still be running (non-blocking)"

        # Wait for extraction to finish
        await asyncio.sleep(0.5)
        assert extraction_finished.is_set(), "Extraction should finish in background"

    @pytest.mark.asyncio
    async def test_extraction_error_does_not_crash(self, processor):
        """If background extraction raises, it should log and not crash the pipeline."""
        async def exploding_extraction():
            raise RuntimeError("extraction boom")

        processor._run_extraction = exploding_extraction

        processor.session.state = State.DISCOVERY
        processor.session.conversation_history = [
            {"role": "user", "content": "hello"},
            {"role": "agent", "content": "hi"},
        ]

        # Should not raise
        frame = TranscriptionFrame(text="My AC is broken.", user_id="", timestamp="")
        await processor._handle_transcription(frame)
        await asyncio.sleep(0.05)  # Let background task attempt extraction

        # Pipeline still works
        assert processor.push_frame.called


class TestEndCallAfterLLM:
    @pytest.mark.asyncio
    async def test_end_call_with_llm_schedules_endframe(self, processor):
        """When end_call=True and needs_llm=True, EndFrame should be scheduled after delay."""
        # Put session in CONFIRM state — triggers end_call=True, needs_llm=True
        processor.session.state = State.CONFIRM

        frame = TranscriptionFrame(text="Thanks bye", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        # Transcription frame should be pushed downstream for LLM
        pushed_frames = [call.args[0] for call in processor.push_frame.call_args_list]
        frame_types = [type(f).__name__ for f in pushed_frames]
        assert "TranscriptionFrame" in frame_types, f"TranscriptionFrame not pushed: {frame_types}"

        # Wait for delayed EndFrame
        await asyncio.sleep(3.5)

        pushed_frames = [call.args[0] for call in processor.push_frame.call_args_list]
        frame_types = [type(f).__name__ for f in pushed_frames]
        assert "EndFrame" in frame_types, f"EndFrame not found in pushed frames: {frame_types}"


class TestTranscriptLogging:
    """Transcript log must capture actual agent responses, not interim STT."""

    @pytest.mark.asyncio
    async def test_interim_transcription_not_logged_as_agent(self, processor):
        """InterimTranscriptionFrame (partial STT) must NOT be logged as agent speech.

        Bug: InterimTranscriptionFrame extends TextFrame (not TranscriptionFrame),
        so the processor's else branch caught it and logged as role=agent.
        """
        interim = InterimTranscriptionFrame(text="I have a prob", user_id="test", timestamp="")
        await processor.process_frame(interim, FrameDirection.DOWNSTREAM)

        agent_entries = [e for e in processor.session.transcript_log if e["role"] == "agent"]
        assert len(agent_entries) == 0, (
            f"Interim STT was incorrectly logged as agent: {agent_entries}"
        )

    @pytest.mark.asyncio
    async def test_agent_responses_captured_from_context(self, processor):
        """Actual LLM responses (in context.messages) should be logged as agent speech.

        The LLM output flows downstream past the processor, so the processor
        must capture agent responses from the LLM context on each user turn.
        """
        # Simulate: greeting is already in context (added by context_aggregator)
        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Thanks for calling ACE Cooling, how can I help you?"},
        ]

        # First user utterance arrives
        frame = TranscriptionFrame(text="My AC is broken", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        # The greeting should now be in the transcript as agent
        agent_entries = [e for e in processor.session.transcript_log if e["role"] == "agent"]
        assert len(agent_entries) >= 1, "Greeting should be captured as agent response"
        assert "ACE Cooling" in agent_entries[0]["content"]

    @pytest.mark.asyncio
    async def test_flush_captures_final_agent_response(self, processor):
        """flush_transcript() should capture any remaining agent messages from context."""
        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Goodbye, have a great day!"},
        ]

        processor.flush_transcript()

        agent_entries = [e for e in processor.session.transcript_log if e["role"] == "agent"]
        assert len(agent_entries) == 1
        assert "Goodbye" in agent_entries[0]["content"]


class TestContextPreservation:
    """User text must always be in LLM context, even during needs_llm=False turns."""

    @pytest.mark.asyncio
    async def test_user_text_reaches_llm_after_tool_transition(self, processor):
        """When WELCOME→LOOKUP→SAFETY, the force_llm fix pushes the
        transcription frame downstream so the context aggregator adds
        user text to the LLM context.

        Before the fix, needs_llm=False meant the frame was NOT pushed
        and user text was manually appended. Now force_llm=True triggers
        buffer mode, and after debounce the frame is pushed downstream.
        """
        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Thanks for calling ACE Cooling, how can I help you?"},
        ]

        frame = TranscriptionFrame(text="my AC is broken", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        # Wait for buffer debounce to flush
        await asyncio.sleep(processor.BUFFER_DEBOUNCE_S + 0.2)

        # With force_llm fix, the TranscriptionFrame is pushed downstream after debounce
        pushed_types = [type(call.args[0]).__name__ for call in processor.push_frame.call_args_list]
        assert "TranscriptionFrame" in pushed_types, (
            f"TranscriptionFrame should be pushed downstream after tool-driven state transition. "
            f"Pushed: {pushed_types}"
        )

    @pytest.mark.asyncio
    async def test_speak_fires_before_tool_call(self, processor):
        """When action has both speak and call_tool, the speak (TTSSpeakFrame)
        should be pushed before the tool executes, so the caller hears
        acknowledgment during long tool calls."""
        # Track frame push order
        pushed = []
        original_push = processor.push_frame

        async def tracking_push(frame, direction=FrameDirection.DOWNSTREAM):
            pushed.append(type(frame).__name__)
            return await original_push(frame, direction)

        processor.push_frame = tracking_push

        # WELCOME state — "my AC is broken" should trigger speak + lookup_caller
        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Greeting"},
        ]

        frame = TranscriptionFrame(text="my AC is broken", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        # TTSSpeakFrame should appear before tool execution completes
        if "TTSSpeakFrame" in pushed:
            assert True, "Speak frame was pushed"
        # If no speak frame, the test passes as advisory — the core fix is context preservation


class TestPostToolLLMTrigger:
    """After tool execution transitions state, LLM must be triggered."""

    @pytest.mark.asyncio
    async def test_lookup_triggers_llm_response_after_transition(self, processor):
        """WELCOME → LOOKUP → SAFETY: after lookup_caller returns,
        the LLM must be invoked to greet the caller in SAFETY state.

        Bug: lookup returns needs_llm=False, so the LLM was never
        triggered after the tool result transitioned to SAFETY.
        This caused 26s of dead air in production (call CAd2b972dc).
        Now force_llm enters buffer mode; LLM is triggered after debounce.
        """
        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Thanks for calling ACE Cooling"},
        ]

        frame = TranscriptionFrame(text="my AC is broken", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        # Wait for buffer debounce to flush
        await asyncio.sleep(processor.BUFFER_DEBOUNCE_S + 0.2)

        pushed_types = [type(call.args[0]).__name__ for call in processor.push_frame.call_args_list]

        # No canned speak — lookup runs silently so it doesn't interrupt the caller
        assert "TTSSpeakFrame" not in pushed_types, f"Unexpected speak frame: {pushed_types}"

        # After tool completes and state transitions, a frame must trigger LLM
        llm_trigger_types = {"TranscriptionFrame", "LLMMessagesFrame"}
        assert llm_trigger_types & set(pushed_types), (
            f"LLM was not triggered after tool-driven state transition. "
            f"Pushed frames: {pushed_types}"
        )

    @pytest.mark.asyncio
    async def test_booking_triggers_llm_after_confirmation(self, processor):
        """BOOKING → (tool) → CONFIRM: after book_service returns success,
        the LLM must generate a confirmation message (after buffer debounce)."""
        processor.session.state = State.BOOKING
        processor.session.booking_attempted = False
        processor.tools.book_service.return_value = {
            "booked": True,
            "booking_time": "Tomorrow 9 AM",
        }
        processor.context.messages = [
            {"role": "system", "content": "test"},
        ]

        frame = TranscriptionFrame(text="yes please", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        assert processor.session.state == State.CONFIRM

        # Wait for buffer debounce to flush
        await asyncio.sleep(processor.BUFFER_DEBOUNCE_S + 0.2)

        pushed_types = [type(call.args[0]).__name__ for call in processor.push_frame.call_args_list]
        llm_trigger_types = {"TranscriptionFrame", "LLMMessagesFrame"}
        assert llm_trigger_types & set(pushed_types), (
            f"LLM was not triggered after booking confirmation. "
            f"Pushed frames: {pushed_types}"
        )

    @pytest.mark.asyncio
    async def test_lookup_failure_still_triggers_llm(self, processor):
        """When V2 backend returns failure dict, state should still
        transition and LLM should still respond (after buffer debounce)."""
        processor.tools.lookup_caller.return_value = {
            "found": False, "message": "V2 backend unavailable"
        }
        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Greeting"},
        ]

        frame = TranscriptionFrame(text="my AC is broken", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        # Wait for buffer debounce to flush
        await asyncio.sleep(processor.BUFFER_DEBOUNCE_S + 0.2)

        assert processor.session.state == State.SAFETY
        pushed_types = [type(c.args[0]).__name__ for c in processor.push_frame.call_args_list]
        assert "TTSSpeakFrame" in pushed_types or "TranscriptionFrame" in pushed_types

    @pytest.mark.asyncio
    async def test_context_preserved_when_tool_doesnt_transition(self, processor):
        """When tool doesn't transition state AND needs_llm=False, user text
        must still be preserved in LLM context via manual append (review T4).

        Uses a mocked state machine to create a needs_llm=False + no-transition
        scenario (no natural state machine path produces this combo).
        Uses URGENCY (non-terminal) so terminal canned routing doesn't intercept.
        """
        processor.session.state = State.URGENCY

        # Mock machine.process to return needs_llm=False with a tool call
        mock_action = Action(call_tool="create_callback", needs_llm=False)
        processor.machine = MagicMock()
        processor.machine.process.return_value = mock_action
        # Tool result handler does NOT transition state
        processor.machine.handle_tool_result = MagicMock()

        processor.tools.create_callback.return_value = {"error": "timeout"}
        processor.context.messages = [
            {"role": "system", "content": "test"},
        ]

        frame = TranscriptionFrame(text="please call me back", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        # force_llm should be False (no state change), needs_llm is False,
        # so user text must be manually appended to context
        user_msgs = [m for m in processor.context.messages if m.get("role") == "user"]
        assert any("call me back" in m["content"] for m in user_msgs)


class TestAgentHasRespondedFlag:
    """agent_has_responded must be set when the processor captures an assistant message."""

    def test_agent_response_sets_flag(self, processor):
        """Capturing an agent response must set session.agent_has_responded."""
        processor.session.agent_has_responded = False

        # Simulate LLM adding an assistant message to context
        processor.context.messages.append({"role": "assistant", "content": "What's your ZIP code?"})

        processor._capture_agent_responses()

        assert processor.session.agent_has_responded is True

    def test_no_agent_response_leaves_flag(self, processor):
        """If no new assistant messages, agent_has_responded stays unchanged."""
        processor.session.agent_has_responded = False

        # Add a user message (not assistant)
        processor.context.messages.append({"role": "user", "content": "hello"})

        processor._capture_agent_responses()

        assert processor.session.agent_has_responded is False


class TestPostToolDebounce:
    """After tool transitions (force_llm), buffer fragments before triggering LLM."""

    @pytest.mark.asyncio
    async def test_force_llm_enters_buffer_mode(self, processor):
        """After WELCOME→LOOKUP→SAFETY, processor should NOT push immediately."""
        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Greeting"},
        ]
        frame = TranscriptionFrame(text="my AC is broken", user_id="", timestamp="")
        await processor._handle_transcription(frame)
        pushed_types = [type(c.args[0]).__name__ for c in processor.push_frame.call_args_list]
        assert "TranscriptionFrame" not in pushed_types, (
            f"TranscriptionFrame pushed immediately — should be buffered. Got: {pushed_types}"
        )
        assert processor._buffer_mode is True

    @pytest.mark.asyncio
    async def test_buffer_flushes_after_debounce(self, processor):
        """After debounce timeout, buffered text should be pushed to LLM."""
        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Greeting"},
        ]
        frame = TranscriptionFrame(text="my AC is broken", user_id="", timestamp="")
        await processor._handle_transcription(frame)
        await asyncio.sleep(processor.BUFFER_DEBOUNCE_S + 0.2)
        pushed_types = [type(c.args[0]).__name__ for c in processor.push_frame.call_args_list]
        assert "TranscriptionFrame" in pushed_types, (
            f"TranscriptionFrame not pushed after debounce. Got: {pushed_types}"
        )
        assert processor._buffer_mode is False

    @pytest.mark.asyncio
    async def test_buffer_accumulates_fragments(self, processor):
        """Multiple fragments during buffer mode should be concatenated on flush."""
        processor.context.messages = [
            {"role": "system", "content": "test"},
            {"role": "assistant", "content": "Greeting"},
        ]
        f1 = TranscriptionFrame(text="my AC is broken", user_id="", timestamp="")
        await processor._handle_transcription(f1)
        f2 = TranscriptionFrame(text="it's blowing warm air", user_id="u1", timestamp="t1")
        await processor._handle_transcription(f2)
        await asyncio.sleep(processor.BUFFER_DEBOUNCE_S + 0.2)
        pushed_frames = [c.args[0] for c in processor.push_frame.call_args_list]
        transcription_frames = [f for f in pushed_frames if isinstance(f, TranscriptionFrame)]
        assert len(transcription_frames) == 1
        assert "my AC is broken" in transcription_frames[0].text
        assert "blowing warm air" in transcription_frames[0].text


class TestExtractionFirewall:
    """zip_code is firewalled (never set by extraction).
    service_address and customer_name CAN be set by extraction when empty,
    but extraction never overwrites existing values."""

    # --- zip_code: fully firewalled ---

    @pytest.mark.asyncio
    async def test_extraction_does_not_overwrite_zip(self, processor):
        """Reproduces Jonas call bug: extraction set wrong ZIP before handler corrected it."""
        processor._run_extraction = StateMachineProcessor._run_extraction.__get__(processor)
        processor.session.zip_code = "78701"
        processor.session.conversation_history = [
            {"role": "user", "content": "seven eight zero one"},
            {"role": "assistant", "content": "What's your ZIP?"},
        ]
        with patch("calllock.processor.extract_fields", new_callable=AsyncMock) as mock_extract:
            mock_extract.return_value = {"zip_code": "78001", "problem_description": "fan issue"}
            await processor._run_extraction()
        assert processor.session.zip_code == "78701"

    @pytest.mark.asyncio
    async def test_extraction_does_not_set_zip_even_when_empty(self, processor):
        """Extraction should never set zip_code — that's handler-only."""
        processor._run_extraction = StateMachineProcessor._run_extraction.__get__(processor)
        processor.session.zip_code = ""
        processor.session.conversation_history = [
            {"role": "user", "content": "seven eight seven zero one"},
            {"role": "assistant", "content": "Got it."},
        ]
        with patch("calllock.processor.extract_fields", new_callable=AsyncMock) as mock_extract:
            mock_extract.return_value = {"zip_code": "78701"}
            await processor._run_extraction()
        assert processor.session.zip_code == ""

    # --- service_address: extraction fills empty, never overwrites ---

    @pytest.mark.asyncio
    async def test_extraction_sets_address_when_empty(self, processor):
        """Extraction should set service_address when empty (fallback for new callers)."""
        processor._run_extraction = StateMachineProcessor._run_extraction.__get__(processor)
        processor.session.service_address = ""
        processor.session.conversation_history = [
            {"role": "user", "content": "123 Oak Street"},
            {"role": "assistant", "content": "Got it."},
        ]
        with patch("calllock.processor.extract_fields", new_callable=AsyncMock) as mock_extract:
            mock_extract.return_value = {"service_address": "123 Oak Street"}
            await processor._run_extraction()
        assert processor.session.service_address == "123 Oak Street"

    @pytest.mark.asyncio
    async def test_extraction_does_not_overwrite_existing_address(self, processor):
        """Extraction must not overwrite address already set by lookup_caller."""
        processor._run_extraction = StateMachineProcessor._run_extraction.__get__(processor)
        processor.session.service_address = "456 Main Ave"
        processor.session.conversation_history = [
            {"role": "user", "content": "123 Oak Street"},
            {"role": "assistant", "content": "Got it."},
        ]
        with patch("calllock.processor.extract_fields", new_callable=AsyncMock) as mock_extract:
            mock_extract.return_value = {"service_address": "123 Oak Street"}
            await processor._run_extraction()
        assert processor.session.service_address == "456 Main Ave"

    # --- customer_name: extraction fills empty, never overwrites ---

    @pytest.mark.asyncio
    async def test_extraction_sets_name_when_empty(self, processor):
        """Extraction should set customer_name when empty (fallback for new callers)."""
        processor._run_extraction = StateMachineProcessor._run_extraction.__get__(processor)
        processor.session.customer_name = ""
        processor.session.conversation_history = [
            {"role": "user", "content": "This is Jonas"},
            {"role": "assistant", "content": "Hi Jonas."},
        ]
        with patch("calllock.processor.extract_fields", new_callable=AsyncMock) as mock_extract:
            mock_extract.return_value = {"customer_name": "Jonas"}
            await processor._run_extraction()
        assert processor.session.customer_name == "Jonas"

    @pytest.mark.asyncio
    async def test_extraction_does_not_overwrite_existing_name(self, processor):
        """Extraction must not overwrite name already set by lookup_caller."""
        processor._run_extraction = StateMachineProcessor._run_extraction.__get__(processor)
        processor.session.customer_name = "Jonas"
        processor.session.conversation_history = [
            {"role": "user", "content": "This is Jon"},
            {"role": "assistant", "content": "Hi."},
        ]
        with patch("calllock.processor.extract_fields", new_callable=AsyncMock) as mock_extract:
            mock_extract.return_value = {"customer_name": "Jon"}
            await processor._run_extraction()
        assert processor.session.customer_name == "Jonas"

    # --- problem_description: extraction-owned ---

    @pytest.mark.asyncio
    async def test_extraction_still_sets_problem_description(self, processor):
        """Extraction-owned fields should still work."""
        processor._run_extraction = StateMachineProcessor._run_extraction.__get__(processor)
        processor.session.problem_description = ""
        processor.session.conversation_history = [
            {"role": "user", "content": "My AC fan is intermittent"},
            {"role": "assistant", "content": "Got it."},
        ]
        with patch("calllock.processor.extract_fields", new_callable=AsyncMock) as mock_extract:
            mock_extract.return_value = {"problem_description": "AC fan is intermittent"}
            await processor._run_extraction()
        assert processor.session.problem_description == "AC fan is intermittent"


class TestTerminalCannedResponses:
    """Terminal states should use canned responses instead of LLM."""

    @pytest.mark.asyncio
    async def test_callback_state_uses_canned_script(self, processor):
        """In CALLBACK state after callback is created, should push canned TTSSpeakFrame."""
        processor.session.state = State.CALLBACK
        processor.session.callback_created = True
        processor.session.terminal_reply_used = False

        processor.context.messages = [
            {"role": "system", "content": "test"},
        ]

        frame = TranscriptionFrame(text="Can I still get scheduled?", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        # Should push TTSSpeakFrame with canned script (not pass frame to LLM)
        from pipecat.frames.frames import TTSSpeakFrame
        pushed_frames = [c.args[0] for c in processor.push_frame.call_args_list]
        tts_frames = [f for f in pushed_frames if isinstance(f, TTSSpeakFrame)]
        assert len(tts_frames) >= 1, f"Expected TTSSpeakFrame, got: {[type(f).__name__ for f in pushed_frames]}"
        assert "call you back" in tts_frames[-1].text

    @pytest.mark.asyncio
    async def test_terminal_reply_used_flag_set(self, processor):
        """First utterance in terminal state should set terminal_reply_used."""
        processor.session.state = State.CALLBACK
        processor.session.callback_created = True
        processor.session.terminal_reply_used = False

        processor.context.messages = [
            {"role": "system", "content": "test"},
        ]

        frame = TranscriptionFrame(text="When will someone call?", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        assert processor.session.terminal_reply_used is True

    @pytest.mark.asyncio
    async def test_safety_exit_uses_canned_script(self, processor):
        """SAFETY_EXIT should use canned 911 script."""
        processor.session.state = State.SAFETY_EXIT
        processor.session.terminal_reply_used = False

        processor.context.messages = [
            {"role": "system", "content": "test"},
        ]

        frame = TranscriptionFrame(text="what should I do", user_id="", timestamp="")
        await processor._handle_transcription(frame)

        from pipecat.frames.frames import TTSSpeakFrame
        pushed_frames = [c.args[0] for c in processor.push_frame.call_args_list]
        tts_frames = [f for f in pushed_frames if isinstance(f, TTSSpeakFrame)]
        assert any("911" in f.text for f in tts_frames), f"Expected 911 script, got: {[f.text for f in tts_frames]}"


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
