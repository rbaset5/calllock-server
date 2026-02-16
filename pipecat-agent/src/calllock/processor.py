import logging
import time as _time
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.frames.frames import (
    Frame,
    TranscriptionFrame,
    LLMMessagesFrame,
    EndFrame,
    TextFrame,
    TTSSpeakFrame,
)

from calllock.session import CallSession
from calllock.state_machine import StateMachine, Action
from calllock.prompts import get_system_prompt
from calllock.extraction import extract_fields
from calllock.validation import validate_name, validate_zip
from calllock.tools import V2Client

logger = logging.getLogger(__name__)


class StateMachineProcessor(FrameProcessor):
    """Custom Pipecat processor that drives call flow via the state machine.

    Sits between STT and the LLM context aggregator in the pipeline:
      transport.input() -> STT -> [StateMachineProcessor] -> context_aggregator.user() -> LLM -> TTS -> ...

    On each transcription:
    1. Feed text to StateMachine.process()
    2. If action has call_tool: invoke V2 backend, then handle_tool_result()
    3. Update the LLM system prompt to match current state
    4. If action says end_call: push EndFrame
    5. If action says needs_llm: pass the transcription frame downstream
    6. After LLM generates text, run extraction to update session fields
    """

    def __init__(
        self,
        session: CallSession,
        machine: StateMachine,
        tools: V2Client,
        context,  # OpenAILLMContext
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.session = session
        self.machine = machine
        self.tools = tools
        self.context = context

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, TranscriptionFrame) and frame.text.strip():
            await self._handle_transcription(frame)
        else:
            # Log agent responses flowing through
            if isinstance(frame, TextFrame) and frame.text.strip():
                self.session.transcript_log.append({
                    "role": "agent",
                    "content": frame.text,
                    "timestamp": _time.time(),
                })
            # Pass through all other frames
            await self.push_frame(frame, direction)

    async def _handle_transcription(self, frame: TranscriptionFrame):
        text = frame.text.strip()
        logger.info(f"[{self.session.state.value}] Caller: {text}")

        # Add to conversation history
        self.session.conversation_history.append({"role": "user", "content": text})

        # Add to transcript log for post-call processing
        self.session.transcript_log.append({
            "role": "user",
            "content": text,
            "timestamp": _time.time(),
        })

        # Run state machine
        action = self.machine.process(self.session, text)

        # Handle tool calls
        if action.call_tool:
            await self._execute_tool(action)

        # Update system prompt for current state
        self.context.messages[0]["content"] = get_system_prompt(self.session)

        # Run extraction to populate session fields from conversation
        if self.session.state.value in ("service_area", "discovery", "confirm"):
            await self._run_extraction()

        # If action has a canned speak message, use it instead of LLM
        if action.speak:
            await self.push_frame(TTSSpeakFrame(text=action.speak), FrameDirection.DOWNSTREAM)
            if action.end_call:
                await self.push_frame(EndFrame(), FrameDirection.DOWNSTREAM)
            return

        # End the call if needed
        if action.end_call:
            if action.needs_llm:
                # Let LLM generate a farewell, then end
                await self.push_frame(frame, FrameDirection.DOWNSTREAM)
                # EndFrame will be pushed after TTS completes
                # We schedule it to fire after a brief delay
            else:
                await self.push_frame(EndFrame(), FrameDirection.DOWNSTREAM)
            return

        # Pass transcription downstream if LLM should generate response
        if action.needs_llm:
            await self.push_frame(frame, FrameDirection.DOWNSTREAM)

    async def _execute_tool(self, action: Action):
        tool = action.call_tool
        logger.info(f"Executing tool: {tool}")

        result = {}
        if tool == "lookup_caller":
            result = await self.tools.lookup_caller(
                self.session.phone_number, "pipecat_call"
            )
        elif tool == "book_service":
            result = await self.tools.book_service(
                customer_name=self.session.customer_name,
                problem=self.session.problem_description,
                address=self.session.service_address,
                preferred_time=self.session.preferred_time,
                phone=self.session.phone_number,
            )
        elif tool == "create_callback":
            result = await self.tools.create_callback(
                phone=self.session.phone_number,
                callback_type=self.session.lead_type or "service",
                reason=self.session.problem_description,
            )
        elif tool == "send_sales_lead_alert":
            result = await self.tools.send_sales_lead_alert(
                phone=self.session.phone_number,
                reason=self.session.problem_description,
            )

        logger.info(f"Tool result ({tool}): {result}")
        self.machine.handle_tool_result(self.session, tool, result)

        # Log tool invocation to transcript
        self.session.transcript_log.append({
            "role": "tool",
            "name": tool,
            "result": result,
            "timestamp": _time.time(),
        })

    async def _run_extraction(self):
        """Extract structured fields from conversation using LLM."""
        if len(self.session.conversation_history) < 2:
            return

        extracted = await extract_fields(self.session.conversation_history)
        if not extracted:
            return

        # Only update fields that are currently empty
        if not self.session.customer_name:
            name = validate_name(extracted.get("customer_name", ""))
            if name:
                self.session.customer_name = name

        if not self.session.problem_description:
            prob = extracted.get("problem_description", "")
            if prob:
                self.session.problem_description = prob

        if not self.session.service_address:
            addr = extracted.get("service_address", "")
            if addr:
                self.session.service_address = addr

        if not self.session.zip_code:
            zip_code = validate_zip(extracted.get("zip_code", ""))
            if zip_code:
                self.session.zip_code = zip_code

        if not self.session.preferred_time:
            time = extracted.get("preferred_time", "")
            if time:
                self.session.preferred_time = time
