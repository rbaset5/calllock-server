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
from calllock.state_machine import StateMachine, Action, TERMINAL_SCRIPTS, TERMINAL_SCOPED_PROMPT, BOOKING_LANGUAGE
from calllock.prompts import get_system_prompt
from calllock.extraction import extract_fields
from calllock.validation import validate_name, validate_zip, match_any_keyword
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

    BUFFER_DEBOUNCE_S = 1.5
    BUFFER_MAX_S = 5.0

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
        self._buffer_mode = False
        self._buffer_texts: list[str] = []
        self._buffer_timer: asyncio.Task | None = None
        self._buffer_frame: TranscriptionFrame | None = None
        self._buffer_start_time: float = 0.0

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

        NOTE: Canned TTSSpeakFrame messages (e.g. "One moment" during tool calls,
        turn-limit escalation messages) bypass the LLM and don't appear in context,
        so they don't set agent_has_responded. This is correct because canned speaks
        are either terminal (call ending) or followed by an LLM response (force_llm
        after tool-induced state transitions).
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
                self.session.agent_has_responded = True
            self._context_capture_idx += 1

    def flush_transcript(self):
        """Capture any remaining agent responses. Call before post-call processing."""
        self._capture_agent_responses()

    def _start_buffer(self, text: str, frame: TranscriptionFrame):
        """Enter buffer mode after a tool transition."""
        self._buffer_mode = True
        self._buffer_texts = [text]
        self._buffer_frame = frame
        self._buffer_start_time = time.time()
        self._reset_buffer_timer()

    def _reset_buffer_timer(self):
        """Reset the debounce timer."""
        if self._buffer_timer and not self._buffer_timer.done():
            self._buffer_timer.cancel()
        self._buffer_timer = asyncio.create_task(self._buffer_debounce_wait())

    async def _buffer_debounce_wait(self):
        """Wait for debounce period, then flush."""
        await asyncio.sleep(self.BUFFER_DEBOUNCE_S)
        await self._flush_buffer()

    async def _flush_buffer(self):
        """Push accumulated fragments to LLM as one concatenated message."""
        if not self._buffer_mode:
            return
        self._buffer_mode = False
        combined_text = " ".join(self._buffer_texts)

        # Run state machine on concatenated text (skipped during buffer mode)
        action = self.machine.process(self.session, combined_text)

        # Update system prompt for current state
        self.context.messages[0]["content"] = get_system_prompt(self.session)

        # Run extraction if applicable
        if self.session.state.value in ("service_area", "discovery", "urgency", "pre_confirm"):
            asyncio.create_task(self._safe_extraction())

        combined_frame = TranscriptionFrame(
            text=combined_text,
            user_id=self._buffer_frame.user_id if self._buffer_frame else "",
            timestamp=self._buffer_frame.timestamp if self._buffer_frame else "",
        )
        text_display = f"'{combined_text[:80]}...'" if len(combined_text) > 80 else f"'{combined_text}'"
        logger.info(f"[{self.session.state.value}] Buffer flush: {len(self._buffer_texts)} fragments → {text_display}")
        self._buffer_texts = []
        self._buffer_frame = None
        if self._buffer_timer and not self._buffer_timer.done():
            self._buffer_timer.cancel()
        self._buffer_timer = None

        # Handle end_call from flushed text (e.g., safety emergency)
        if action.end_call:
            if action.needs_llm:
                await self.push_frame(combined_frame, FrameDirection.DOWNSTREAM)
                asyncio.create_task(self._delayed_end_call(delay=3.0))
            else:
                await self.push_frame(EndFrame(), FrameDirection.DOWNSTREAM)
            return

        await self.push_frame(combined_frame, FrameDirection.DOWNSTREAM)

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

        # Buffer mode: skip state machine, just accumulate text
        if self._buffer_mode:
            self._buffer_texts.append(text)
            self._buffer_frame = frame
            if time.time() - self._buffer_start_time >= self.BUFFER_MAX_S:
                logger.info(f"[{self.session.state.value}] Buffer max time reached, flushing")
                await self._flush_buffer()
            else:
                self._reset_buffer_timer()
            return

        # Run state machine
        action = self.machine.process(self.session, text)

        # Speak canned message immediately
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

        # Run extraction in background
        if self.session.state.value in ("service_area", "discovery", "urgency", "pre_confirm"):
            asyncio.create_task(self._safe_extraction())

        # Terminal state routing: use canned responses instead of LLM
        if self.session.state.is_terminal and TERMINAL_SCRIPTS.get(self.session.state):
            await self._handle_terminal_response(frame, action)
            return

        # End the call if needed
        if action.end_call:
            if action.needs_llm or force_llm:
                await self.push_frame(frame, FrameDirection.DOWNSTREAM)
                asyncio.create_task(self._delayed_end_call(delay=3.0))
            else:
                await self.push_frame(EndFrame(), FrameDirection.DOWNSTREAM)
            return

        # Post-tool debounce: buffer fragments so caller finishes their thought
        if force_llm:
            self._start_buffer(text, frame)
            return

        # Normal path: pass transcription downstream if LLM should generate response
        if action.needs_llm:
            t_push = time.time()
            logger.info(
                f"[{self.session.state.value}] Processing: {(t_push - t_start)*1000:.0f}ms "
                f"(transcription→LLM push, force_llm={force_llm})"
            )
            await self.push_frame(frame, FrameDirection.DOWNSTREAM)
        else:
            # Preserve user text in LLM context even when LLM won't respond.
            self.context.messages.append({"role": "user", "content": text})

    async def _delayed_end_call(self, delay: float = 3.0):
        """Push EndFrame after a delay to allow TTS to finish speaking."""
        await asyncio.sleep(delay)
        await self.push_frame(EndFrame(), FrameDirection.DOWNSTREAM)

    async def _handle_terminal_response(self, frame, action):
        """Handle responses in terminal states with canned scripts + one scoped LLM reply.

        Layer 1: Canned scripts for known terminal states
        Layer 2: One scoped LLM reply (first off-script utterance only)
        Layer 3: Booking language filter on the LLM reply
        """
        state = self.session.state
        canned = TERMINAL_SCRIPTS.get(state)

        # First utterance: allow one scoped LLM reply before the canned close
        if not self.session.terminal_reply_used and canned:
            self.session.terminal_reply_used = True
            scoped_messages = [
                {"role": "system", "content": TERMINAL_SCOPED_PROMPT},
                {"role": "user", "content": frame.text.strip()},
            ]
            try:
                reply = await self._generate_scoped_reply(scoped_messages)
                if reply and not match_any_keyword(reply, BOOKING_LANGUAGE):
                    await self.push_frame(
                        TTSSpeakFrame(text=reply), FrameDirection.DOWNSTREAM
                    )
                    await asyncio.sleep(1.5)
            except Exception as e:
                logger.warning(f"Scoped reply failed: {e}")

        # Serve canned script
        if canned:
            await self.push_frame(
                TTSSpeakFrame(text=canned), FrameDirection.DOWNSTREAM
            )
        else:
            # Dynamic terminal states (CONFIRM, URGENCY_CALLBACK) use LLM
            await self.push_frame(frame, FrameDirection.DOWNSTREAM)

        if action.end_call:
            asyncio.create_task(self._delayed_end_call(delay=4.0))

    async def _generate_scoped_reply(self, messages: list[dict]) -> str:
        """Generate a single LLM response using a scoped prompt."""
        import httpx
        import os
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={"Authorization": f"Bearer {os.getenv('OPENAI_API_KEY', '')}"},
                    json={
                        "model": "gpt-4o-mini",
                        "temperature": 0.3,
                        "max_tokens": 50,
                        "messages": messages,
                    },
                )
                resp.raise_for_status()
                return resp.json()["choices"][0]["message"]["content"].strip()
        except Exception as e:
            logger.warning(f"Scoped LLM reply failed: {e}")
            return ""

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
        """Extract structured fields from conversation using LLM.

        EXTRACTION FIREWALL: Only extraction-owned fields are set here.
        Handler-owned fields (zip_code, service_address, customer_name) are
        NEVER set by extraction — they have deterministic paths in the state
        machine handlers and lookup_caller tool result.
        """
        if len(self.session.conversation_history) < 2:
            return

        extracted = await extract_fields(self.session.conversation_history)
        if not extracted:
            return

        # Extraction-owned fields only
        if not self.session.problem_description:
            prob = extracted.get("problem_description", "")
            if prob:
                self.session.problem_description = prob

        if not self.session.preferred_time:
            ptime = extracted.get("preferred_time", "")
            if ptime:
                self.session.preferred_time = ptime

        if not self.session.equipment_type:
            equip = extracted.get("equipment_type", "")
            if equip:
                self.session.equipment_type = equip

        if not self.session.problem_duration:
            dur = extracted.get("problem_duration", "")
            if dur:
                self.session.problem_duration = dur
