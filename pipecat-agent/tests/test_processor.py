import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from calllock.processor import StateMachineProcessor
from calllock.session import CallSession
from calllock.state_machine import StateMachine
from calllock.states import State

from pipecat.processors.frame_processor import FrameDirection
from pipecat.frames.frames import TranscriptionFrame, EndFrame


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
    return proc


class TestTranscriptionDebounce:
    @pytest.mark.asyncio
    async def test_rapid_frames_coalesced(self, processor):
        """Frames arriving within 400ms should be coalesced into one turn."""
        processor._debounce_seconds = 0.05  # 50ms for fast tests

        # Send 3 rapid frames
        await processor.process_frame(TranscriptionFrame(text="Yeah.", user_id="", timestamp=""), FrameDirection.DOWNSTREAM)
        await processor.process_frame(TranscriptionFrame(text="Mhmm.", user_id="", timestamp=""), FrameDirection.DOWNSTREAM)
        await processor.process_frame(TranscriptionFrame(text="It's broken.", user_id="", timestamp=""), FrameDirection.DOWNSTREAM)

        # Wait for debounce to fire
        await asyncio.sleep(0.1)

        # State machine should have been called once, not three times
        assert processor.session.turn_count == 1

    @pytest.mark.asyncio
    async def test_slow_frames_processed_separately(self, processor):
        """Frames arriving >debounce apart should be separate turns."""
        processor._debounce_seconds = 0.05

        await processor.process_frame(TranscriptionFrame(text="Yeah.", user_id="", timestamp=""), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(0.1)  # Wait for first debounce to fire

        await processor.process_frame(TranscriptionFrame(text="No.", user_id="", timestamp=""), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(0.1)  # Wait for second debounce to fire

        assert processor.session.turn_count == 2

    @pytest.mark.asyncio
    async def test_coalesced_text_is_concatenated(self, processor):
        """Coalesced text should join fragments with space."""
        processor._debounce_seconds = 0.05

        await processor.process_frame(TranscriptionFrame(text="Yeah.", user_id="", timestamp=""), FrameDirection.DOWNSTREAM)
        await processor.process_frame(TranscriptionFrame(text="It's broken.", user_id="", timestamp=""), FrameDirection.DOWNSTREAM)

        await asyncio.sleep(0.1)

        # Check the last user entry in conversation_history
        user_entries = [e for e in processor.session.conversation_history if e["role"] == "user"]
        assert len(user_entries) == 1
        assert "Yeah." in user_entries[0]["content"]
        assert "It's broken." in user_entries[0]["content"]


class TestNonBlockingExtraction:
    @pytest.mark.asyncio
    async def test_extraction_runs_in_background(self, processor):
        """Extraction should not block the transcription frame from reaching the LLM."""
        processor._debounce_seconds = 0.05

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

        await processor.process_frame(
            TranscriptionFrame(text="My AC is broken.", user_id="", timestamp=""),
            FrameDirection.DOWNSTREAM,
        )
        await asyncio.sleep(0.1)  # Let debounce fire

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
        processor._debounce_seconds = 0.05

        async def exploding_extraction():
            raise RuntimeError("extraction boom")

        processor._run_extraction = exploding_extraction

        processor.session.state = State.DISCOVERY
        processor.session.conversation_history = [
            {"role": "user", "content": "hello"},
            {"role": "agent", "content": "hi"},
        ]

        # Should not raise
        await processor.process_frame(
            TranscriptionFrame(text="My AC is broken.", user_id="", timestamp=""),
            FrameDirection.DOWNSTREAM,
        )
        await asyncio.sleep(0.15)  # Let debounce fire + extraction attempt

        # Pipeline still works
        assert processor.push_frame.called


class TestDebounceWindow:
    def test_debounce_window_exceeds_vad_stop(self, processor):
        """Debounce window (400ms) must exceed VAD stop_secs (300ms) to prevent split utterances."""
        assert processor._debounce_seconds >= 0.4


class TestEndCallAfterLLM:
    @pytest.mark.asyncio
    async def test_end_call_with_llm_schedules_endframe(self, processor):
        """When end_call=True and needs_llm=True, EndFrame should be scheduled after delay."""
        processor._debounce_seconds = 0.05

        # Put session in DONE state — triggers end_call=True, needs_llm=True
        processor.session.state = State.DONE

        frame = TranscriptionFrame(text="Thanks bye", user_id="", timestamp="")
        await processor.process_frame(frame, FrameDirection.DOWNSTREAM)

        # Wait for debounce + delayed EndFrame (3s default, but we'll check the task exists)
        await asyncio.sleep(0.1)  # Let debounce fire

        # Transcription frame should be pushed downstream for LLM
        pushed_frames = [call.args[0] for call in processor.push_frame.call_args_list]
        frame_types = [type(f).__name__ for f in pushed_frames]
        assert "TranscriptionFrame" in frame_types, f"TranscriptionFrame not pushed: {frame_types}"

        # Wait for delayed EndFrame
        await asyncio.sleep(3.5)

        pushed_frames = [call.args[0] for call in processor.push_frame.call_args_list]
        frame_types = [type(f).__name__ for f in pushed_frames]
        assert "EndFrame" in frame_types, f"EndFrame not found in pushed frames: {frame_types}"
