import os
import logging
from fastapi import WebSocket

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineTask
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketTransport,
    FastAPIWebsocketParams,
)
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.openai.llm import OpenAILLMService, OpenAILLMContext
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.frames.frames import LLMMessagesFrame
from pipecat.runner.utils import parse_telephony_websocket

from calllock.session import CallSession
from calllock.state_machine import StateMachine
from calllock.prompts import get_system_prompt
from calllock.tools import V2Client
from calllock.processor import StateMachineProcessor

logger = logging.getLogger(__name__)


async def create_pipeline(websocket: WebSocket):
    """Create and run the Pipecat pipeline for a Twilio call."""

    # Parse Twilio WebSocket handshake
    transport_type, call_data = await parse_telephony_websocket(websocket)
    stream_sid = call_data["stream_id"]
    call_sid = call_data["call_id"]
    caller_phone = call_data.get("body", {}).get("From", "")

    logger.info(f"Call started: {call_sid} from {caller_phone}")

    # Initialize session and state machine
    session = CallSession(phone_number=caller_phone)
    machine = StateMachine()
    tools = V2Client(base_url=os.getenv("V2_BACKEND_URL", ""))

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
            vad_analyzer=SileroVADAnalyzer(),
            serializer=serializer,
        ),
    )

    # Services
    stt = DeepgramSTTService(api_key=os.getenv("DEEPGRAM_API_KEY"))

    llm = OpenAILLMService(
        api_key=os.getenv("OPENAI_API_KEY"),
        model="gpt-4o",
    )

    tts = ElevenLabsTTSService(
        api_key=os.getenv("ELEVENLABS_API_KEY"),
        voice_id=os.getenv("ELEVENLABS_VOICE_ID"),
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

    # Build pipeline: STT -> StateMachine -> ContextAgg -> LLM -> TTS
    pipeline = Pipeline([
        transport.input(),
        stt,
        sm_processor,
        context_aggregator.user(),
        llm,
        tts,
        transport.output(),
        context_aggregator.assistant(),
    ])

    task = PipelineTask(pipeline)

    # Send initial greeting on connect
    @transport.event_handler("on_client_connected")
    async def on_connected(transport, client):
        await task.queue_frames([LLMMessagesFrame(messages)])

    runner = PipelineRunner()
    await runner.run(task)

    logger.info(f"Call ended: {call_sid}")
