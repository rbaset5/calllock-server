import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from calllock.processor import StateMachineProcessor
from calllock.session import CallSession
from calllock.state_machine import StateMachine
from calllock.states import State

from pipecat.processors.frame_processor import FrameDirection
from pipecat.frames.frames import TranscriptionFrame


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
