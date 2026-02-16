import os
import time
import logging
from fastapi import WebSocket

import aiohttp
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketTransport,
    FastAPIWebsocketParams,
)
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.openai.llm import OpenAILLMService, OpenAILLMContext
from pipecat.services.inworld.tts import InworldHttpTTSService
from pipecat.services.deepgram.tts import DeepgramHttpTTSService
from pipecat.frames.frames import EndFrame, LLMMessagesFrame, TTSSpeakFrame
from pipecat.runner.utils import parse_telephony_websocket

from calllock.session import CallSession
from calllock.state_machine import StateMachine
from calllock.prompts import get_system_prompt
from calllock.tools import V2Client
from calllock.processor import StateMachineProcessor
from calllock.audio_resample import AudioResampleProcessor
from calllock.post_call import handle_call_ended
from calllock.tts_fallback import FallbackTTSService

logger = logging.getLogger(__name__)


async def create_pipeline(websocket: WebSocket):
    """Create and run the Pipecat pipeline for a Twilio call."""

    # Parse Twilio WebSocket handshake
    transport_type, call_data = await parse_telephony_websocket(websocket)
    logger.info(f"Twilio handshake: transport={transport_type}, keys={list(call_data.keys())}")
    logger.debug(f"Twilio call_data: {call_data}")
    stream_sid = call_data["stream_id"]
    call_sid = call_data["call_id"]
    caller_phone = call_data.get("body", {}).get("From", "")
    if not caller_phone:
        logger.warning(f"No caller phone extracted. call_data body keys: {list(call_data.get('body', {}).keys())}")

    logger.info(f"Call started: {call_sid} from {caller_phone}")

    # Initialize session and state machine
    session = CallSession(phone_number=caller_phone)
    session.call_sid = call_sid
    session.start_time = time.time()
    machine = StateMachine()
    tools = V2Client(
        base_url=os.getenv("V2_BACKEND_URL", ""),
        api_key=os.getenv("V2_API_KEY", ""),
    )

    # Twilio transport
    serializer = TwilioFrameSerializer(
        stream_sid=stream_sid,
        call_sid=call_sid,
        account_sid=os.getenv("TWILIO_ACCOUNT_SID"),
        auth_token=os.getenv("TWILIO_AUTH_TOKEN"),
    )
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            vad_analyzer=SileroVADAnalyzer(
                params=VADParams(
                    confidence=0.85,   # Higher threshold to ignore TV/background noise
                    start_secs=0.4,    # Require 400ms of speech before triggering
                    stop_secs=0.3,     # Wait 300ms of silence before ending utterance
                    min_volume=0.8,    # Ignore quieter sounds (TV, ambient noise)
                ),
            ),
            serializer=serializer,
        ),
    )

    # Services
    stt = DeepgramSTTService(api_key=os.getenv("DEEPGRAM_API_KEY"))

    llm = OpenAILLMService(
        api_key=os.getenv("OPENAI_API_KEY"),
        model="gpt-4o",
    )

    http_session = aiohttp.ClientSession()

    primary_tts = InworldHttpTTSService(
        api_key=os.getenv("INWORLD_API_KEY"),
        aiohttp_session=http_session,
        voice_id=os.getenv("INWORLD_VOICE_ID", "Ashley"),
        model=os.getenv("INWORLD_MODEL", "inworld-tts-1.5-max"),
        streaming=True,
        sample_rate=16000,
        aggregate_sentences=False,
    )

    fallback_tts = DeepgramHttpTTSService(
        api_key=os.getenv("DEEPGRAM_API_KEY"),
        aiohttp_session=http_session,
        voice=os.getenv("DEEPGRAM_TTS_VOICE", "aura-2-helena-en"),
        sample_rate=16000,
        encoding="linear16",
        aggregate_sentences=False,
    )

    tts = FallbackTTSService(
        primary=primary_tts,
        fallback=fallback_tts,
        primary_timeout=5.0,
        sample_rate=16000,
    )

    # LLM context with initial system prompt
    messages = [{"role": "system", "content": get_system_prompt(session)}]
    context = OpenAILLMContext(messages)
    context_aggregator = llm.create_context_aggregator(context)

    # State machine processor — intercepts transcriptions before LLM
    sm_processor = StateMachineProcessor(
        session=session,
        machine=machine,
        tools=tools,
        context=context,
    )

    # Resample 16kHz TTS -> 8kHz for Twilio (bypasses soxr entirely)
    resampler = AudioResampleProcessor(target_rate=8000)

    # Build pipeline: STT -> StateMachine -> ContextAgg -> LLM -> TTS -> Resample
    pipeline = Pipeline([
        transport.input(),
        stt,
        sm_processor,
        context_aggregator.user(),
        llm,
        tts,
        resampler,
        transport.output(),
        context_aggregator.assistant(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=8000,
            audio_out_sample_rate=8000,
            allow_interruptions=True,
        ),
    )

    # Send greeting directly via TTS (bypasses LLM for speed + avoids VAD interruption)
    greeting = "Thanks for calling ACE Cooling, how can I help you?"

    @transport.event_handler("on_client_connected")
    async def on_connected(transport, client):
        # Speak the greeting directly — no LLM round-trip
        await task.queue_frames([TTSSpeakFrame(greeting)])

    @transport.event_handler("on_client_disconnected")
    async def on_disconnected(transport, client):
        logger.info(f"Client disconnected, ending pipeline for {call_sid}")
        await task.queue_frames([EndFrame()])

    runner = PipelineRunner()
    await runner.run(task)
    await http_session.close()

    # Post-call: classify and sync to dashboard
    try:
        await handle_call_ended(session)
    except Exception as e:
        logger.error(f"Post-call handler failed: {e}")

    logger.info(f"Call ended: {call_sid}")
