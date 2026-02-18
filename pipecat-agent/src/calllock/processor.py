import asyncio
import logging
import time
import time as _time
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.frames.frames import (
    Frame,
    TranscriptionFrame,
    InterimTranscriptionFrame,
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
        self._context_capture_idx = 1  # Skip system message at index 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, TranscriptionFrame) and frame.text.strip():
            logger.debug(f"TranscriptionFrame arrived: '{frame.text.strip()}'")
            await self._handle_transcription(frame)
        elif isinstance(frame, InterimTranscriptionFrame):
            # Ignore interim STT — these are partial user speech fragments,
            # not agent responses. They extend TextFrame but not TranscriptionFrame.
            await self.push_frame(frame, direction)
        else:
            await self.push_frame(frame, direction)

    def _capture_agent_responses(self):
        """Capture new assistant messages from LLM context to transcript log.

        The LLM output flows downstream (LLM → TTS → transport), bypassing
        this processor. We read agent responses from the context aggregator's
        message list instead.
        """
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

    def flush_transcript(self):
        """Capture any remaining agent responses. Call before post-call processing."""
        self._capture_agent_responses()

    async def _handle_transcription(self, frame: TranscriptionFrame):
        t_start = time.time()

        # Capture any agent responses from previous turn
        self._capture_agent_responses()

        text = frame.text.strip()
        logger.info(f"[{self.session.state.value}] Caller: {text}")

        # Add to conversation history
        self.session.conversation_history.append({"role": "user", "content": text})

        # Add to transcript log for post-call processing
        self.session.transcript_log.append({
            "role": "user",
            "content": text,
            "timestamp": _time.time(),
            "state": self.session.state.value,
        })

        # Run state machine
        action = self.machine.process(self.session, text)

        # Speak canned message immediately (e.g., "One moment" before a slow tool call)
        if action.speak:
            await self.push_frame(TTSSpeakFrame(text=action.speak), FrameDirection.DOWNSTREAM)

        # Handle tool calls — track state change to force LLM if state transitions
        force_llm = False
        if action.call_tool:
            state_before = self.session.state
            await self._execute_tool(action)
            if self.session.state != state_before:
                force_llm = True

        # Update system prompt for current state
        self.context.messages[0]["content"] = get_system_prompt(self.session)

        # Run extraction in background — results only matter for the next turn
        if self.session.state.value in ("service_area", "discovery", "urgency", "pre_confirm"):
            asyncio.create_task(self._safe_extraction())

        # End the call if needed
        if action.end_call:
            if action.needs_llm or force_llm:
                # Let LLM generate a farewell, then end after TTS finishes
                await self.push_frame(frame, FrameDirection.DOWNSTREAM)
                asyncio.create_task(self._delayed_end_call(delay=3.0))
            else:
                await self.push_frame(EndFrame(), FrameDirection.DOWNSTREAM)
            return

        # Pass transcription downstream if LLM should generate response
        if action.needs_llm or force_llm:
            t_push = time.time()
            logger.info(
                f"[{self.session.state.value}] Processing: {(t_push - t_start)*1000:.0f}ms "
                f"(transcription→LLM push, force_llm={force_llm})"
            )
            await self.push_frame(frame, FrameDirection.DOWNSTREAM)
        else:
            # Preserve user text in LLM context even when LLM won't respond.
            # Without this, user speech during WELCOME/LOOKUP is invisible
            # to the LLM on its next turn.
            self.context.messages.append({"role": "user", "content": text})

    async def _delayed_end_call(self, delay: float = 3.0):
        """Push EndFrame after a delay to allow TTS to finish speaking."""
        await asyncio.sleep(delay)
        await self.push_frame(EndFrame(), FrameDirection.DOWNSTREAM)

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
                callback_type=self.session.callback_type or self.session.lead_type or "service",
                reason=self.session.problem_description or "Callback requested",
                customer_name=self.session.customer_name,
                urgency="urgent" if self.session.urgency_tier == "urgent" else "normal",
            )
        elif tool == "manage_appointment":
            result = await self.tools.manage_appointment(
                action=action.tool_args.get("action", "status"),
                phone=self.session.phone_number,
                booking_uid=self.session.appointment_uid,
                reason=action.tool_args.get("reason", ""),
                new_time=action.tool_args.get("new_time", ""),
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
            "state": self.session.state.value,
        })

    async def _safe_extraction(self):
        """Run extraction in background, catching errors to prevent silent crashes."""
        try:
            await self._run_extraction()
        except Exception as e:
            logger.error(f"Background extraction failed: {e}")

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

        if not self.session.equipment_type:
            equip = extracted.get("equipment_type", "")
            if equip:
                self.session.equipment_type = equip

        if not self.session.problem_duration:
            dur = extracted.get("problem_duration", "")
            if dur:
                self.session.problem_duration = dur
