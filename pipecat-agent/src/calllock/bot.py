import os
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import PlainTextResponse, Response

from calllock.pipeline import create_pipeline

load_dotenv()

app = FastAPI(title="CallLock Voice Agent")

HOST = os.getenv("FLY_APP_NAME", "calllock-voice")


@app.get("/health")
async def health():
    return PlainTextResponse("ok")


@app.api_route("/twiml", methods=["GET", "POST"])
async def twiml(request: Request):
    """Serve TwiML that tells Twilio to open a WebSocket stream to this server."""
    xml = (
        '<Response>'
        '<Connect>'
        f'<Stream url="wss://{HOST}.fly.dev/ws/twilio" />'
        '</Connect>'
        '</Response>'
    )
    return Response(content=xml, media_type="application/xml")


@app.api_route("/twiml-test", methods=["GET", "POST"])
async def twiml_test(request: Request):
    """TwiML that routes to the instrumented Pipecat test pipeline."""
    xml = (
        '<Response>'
        '<Connect>'
        f'<Stream url="wss://{HOST}.fly.dev/ws/twilio-test" />'
        '</Connect>'
        '</Response>'
    )
    return Response(content=xml, media_type="application/xml")


@app.websocket("/ws/twilio")
async def twilio_websocket(websocket: WebSocket):
    await websocket.accept()
    await create_pipeline(websocket)


@app.websocket("/ws/twilio-test")
async def twilio_test_websocket(websocket: WebSocket):
    """Minimal test pipeline: just TTS -> transport, no LLM, no state machine."""
    await websocket.accept()
    await _run_test_pipeline(websocket)


async def _run_test_pipeline(websocket: WebSocket):
    """Minimal test pipeline with ONLY websocket send logging (no extra processors)."""
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineParams, PipelineTask
    from pipecat.transports.websocket.fastapi import (
        FastAPIWebsocketTransport,
        FastAPIWebsocketParams,
    )
    from pipecat.serializers.twilio import TwilioFrameSerializer
    from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
    from pipecat.frames.frames import TTSSpeakFrame
    from pipecat.runner.utils import parse_telephony_websocket
    from loguru import logger

    logger.info("=== SEND-LOGGING TEST PIPELINE ===")

    # --- Only diagnostic: wrap websocket sends ---
    _original_send_text = websocket.send_text
    _send_count = 0

    async def _logged_send_text(data, **kwargs):
        nonlocal _send_count
        _send_count += 1
        # Analyze mulaw payload for silence detection
        import json as _json, base64 as _b64
        try:
            msg = _json.loads(data)
            if msg.get("event") == "media":
                raw = _b64.b64decode(msg["media"]["payload"])
                silence = sum(1 for b in raw if b == 0xFF)
                logger.info(
                    f">>> WS_SEND #{_send_count}: {len(raw)} mulaw bytes, "
                    f"silence={silence}/{len(raw)} ({100*silence//len(raw)}%), "
                    f"first_16={raw[:16].hex()}"
                )
            else:
                logger.info(f">>> WS_SEND #{_send_count}: event={msg.get('event')}")
        except Exception:
            logger.info(f">>> WS_SEND #{_send_count}: {len(data)} chars (non-JSON)")
        await _original_send_text(data, **kwargs)

    websocket.send_text = _logged_send_text

    _original_send_bytes = websocket.send_bytes

    async def _logged_send_bytes(data, **kwargs):
        nonlocal _send_count
        _send_count += 1
        logger.info(f">>> WS_SEND_BYTES #{_send_count}: {len(data)} bytes")
        await _original_send_bytes(data, **kwargs)

    websocket.send_bytes = _logged_send_bytes

    # --- Fix: bypass soxr resampler, use audioop.ratecv instead ---
    import audioop as _audioop
    from pipecat.audio.resamplers.soxr_stream_resampler import SOXRStreamAudioResampler

    async def _audioop_resample(self, audio, in_rate, out_rate):
        if in_rate == out_rate:
            return audio
        resampled, _ = _audioop.ratecv(audio, 2, 1, in_rate, out_rate, None)
        return resampled

    SOXRStreamAudioResampler.resample = _audioop_resample
    logger.info("### RESAMPLER PATCHED: using audioop.ratecv instead of soxr")

    # --- Standard Pipecat setup (identical to old working code) ---
    transport_type, call_data = await parse_telephony_websocket(websocket)
    stream_sid = call_data["stream_id"]
    call_sid = call_data["call_id"]
    logger.info(f"Test call: {call_sid}, stream: {stream_sid}")

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
            serializer=serializer,
        ),
    )

    tts = ElevenLabsTTSService(
        api_key=os.getenv("ELEVENLABS_API_KEY"),
        voice_id=os.getenv("ELEVENLABS_VOICE_ID"),
    )

    pipeline = Pipeline([
        transport.input(),
        tts,
        transport.output(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=8000,
            audio_out_sample_rate=16000,
        ),
    )

    @transport.event_handler("on_client_connected")
    async def on_connected(transport, client):
        logger.info("=== TEST: Client connected, sending TTS ===")
        await task.queue_frames([TTSSpeakFrame("Hello! This is a test. Can you hear me clearly?")])

    runner = PipelineRunner()
    await runner.run(task)
    logger.info(f"=== TEST PIPELINE ENDED === (ws sends: {_send_count})")


@app.websocket("/ws/twilio-raw")
async def twilio_raw_websocket(websocket: WebSocket):
    """Raw WebSocket test — bypasses Pipecat completely.

    Generates a 440Hz sine tone as mulaw, sends directly to Twilio.
    If you hear a beep, the WebSocket path works and the issue is in Pipecat.
    """
    import asyncio
    import audioop
    import base64
    import json
    import math
    import struct
    import logging

    logger = logging.getLogger(__name__)
    await websocket.accept()
    logger.info("=== RAW WEBSOCKET TEST ===")

    # Read Twilio handshake (connected + start messages)
    first_msg = json.loads(await websocket.receive_text())
    logger.info(f"Raw test msg 1: event={first_msg.get('event')}")
    second_msg = json.loads(await websocket.receive_text())
    logger.info(f"Raw test msg 2: event={second_msg.get('event')}")

    # Extract stream SID from whichever message has it
    stream_sid = None
    for msg in [first_msg, second_msg]:
        if msg.get("event") == "start":
            stream_sid = msg["start"]["streamSid"]
            break

    if not stream_sid:
        logger.error("No stream SID found!")
        await websocket.close()
        return

    logger.info(f"Raw test stream SID: {stream_sid}")

    # Generate 2 seconds of 440Hz sine tone at 8kHz, 16-bit PCM
    sample_rate = 8000
    duration = 2.0
    frequency = 440.0
    num_samples = int(sample_rate * duration)
    pcm_samples = []
    for i in range(num_samples):
        sample = int(16000 * math.sin(2 * math.pi * frequency * i / sample_rate))
        pcm_samples.append(struct.pack("<h", sample))
    pcm_bytes = b"".join(pcm_samples)

    # Convert to mulaw
    mulaw_bytes = audioop.lin2ulaw(pcm_bytes, 2)

    # Send in 20ms chunks (160 samples = 160 bytes mulaw at 8kHz)
    chunk_size = 160
    chunks_sent = 0
    for i in range(0, len(mulaw_bytes), chunk_size):
        chunk = mulaw_bytes[i : i + chunk_size]
        payload = base64.b64encode(chunk).decode("utf-8")
        message = json.dumps({
            "event": "media",
            "streamSid": stream_sid,
            "media": {"payload": payload},
        })
        await websocket.send_text(message)
        chunks_sent += 1
        # Pace at real-time (20ms per chunk)
        await asyncio.sleep(0.02)

    logger.info(f"Raw test: sent {chunks_sent} chunks ({duration}s of 440Hz tone)")

    # Keep connection open for a few seconds so Twilio plays the audio
    await asyncio.sleep(3)
    logger.info("=== RAW TEST COMPLETE ===")
    await websocket.close()


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8765"))
    uvicorn.run("calllock.bot:app", host="0.0.0.0", port=port, reload=True)
