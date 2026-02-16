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


@app.api_route("/twiml-raw", methods=["GET", "POST"])
async def twiml_raw(request: Request):
    """TwiML that routes to the raw WebSocket test (no Pipecat)."""
    xml = (
        '<Response>'
        '<Connect>'
        f'<Stream url="wss://{HOST}.fly.dev/ws/twilio-raw" />'
        '</Connect>'
        '</Response>'
    )
    return Response(content=xml, media_type="application/xml")


@app.api_route("/twiml-eleven", methods=["GET", "POST"])
async def twiml_eleven(request: Request):
    """TwiML that routes to ElevenLabs direct test (no Pipecat pipeline)."""
    xml = (
        '<Response>'
        '<Connect>'
        f'<Stream url="wss://{HOST}.fly.dev/ws/twilio-eleven" />'
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
    """Minimal test pipeline: TTS(16kHz) -> AudioResampleProcessor(8kHz) -> transport."""
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineParams, PipelineTask
    from pipecat.transports.websocket.fastapi import (
        FastAPIWebsocketTransport,
        FastAPIWebsocketParams,
    )
    from pipecat.serializers.twilio import TwilioFrameSerializer
    from pipecat.services.cartesia.tts import CartesiaTTSService
    from pipecat.frames.frames import TTSSpeakFrame
    from pipecat.runner.utils import parse_telephony_websocket
    from loguru import logger

    from calllock.audio_resample import AudioResampleProcessor

    logger.info("=== TEST PIPELINE: Cartesia TTS + AudioResampleProcessor ===")

    # Parse Twilio handshake
    transport_type, call_data = await parse_telephony_websocket(websocket)
    stream_sid = call_data["stream_id"]
    call_sid = call_data["call_id"]
    logger.info(f"Test call: {call_sid}, stream: {stream_sid}")

    # Transport
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

    # Cartesia TTS
    tts = CartesiaTTSService(
        api_key=os.getenv("CARTESIA_API_KEY"),
        voice_id="a5136bf9-224c-4d76-b823-52bd5efcffcc",
    )

    # Resample 16kHz -> 8kHz using audioop (bypasses soxr entirely)
    resampler = AudioResampleProcessor(target_rate=8000)

    pipeline = Pipeline([
        transport.input(),
        tts,
        resampler,
        transport.output(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=8000,
            audio_out_sample_rate=8000,  # Serializer does 8->8 (no soxr)
        ),
    )

    @transport.event_handler("on_client_connected")
    async def on_connected(transport, client):
        logger.info("=== TEST: Client connected, sending TTS ===")
        await task.queue_frames([TTSSpeakFrame("Hello! This is a test. Can you hear me clearly?")])

    runner = PipelineRunner()
    await runner.run(task)
    logger.info("=== TEST PIPELINE ENDED ===")


@app.websocket("/ws/twilio-eleven")
async def twilio_eleven_websocket(websocket: WebSocket):
    """ElevenLabs direct test — bypasses Pipecat completely.

    Calls ElevenLabs REST API directly, converts PCM to mulaw, sends to Twilio.
    If you hear speech, the issue is in Pipecat's pipeline processing.
    """
    import asyncio
    import audioop
    import base64
    import json
    import struct
    import logging
    import httpx

    logger = logging.getLogger(__name__)
    await websocket.accept()
    logger.info("=== ELEVENLABS DIRECT TEST ===")

    # Read Twilio handshake
    first_msg = json.loads(await websocket.receive_text())
    logger.info(f"Eleven test msg 1: event={first_msg.get('event')}")
    second_msg = json.loads(await websocket.receive_text())
    logger.info(f"Eleven test msg 2: event={second_msg.get('event')}")

    stream_sid = None
    for msg in [first_msg, second_msg]:
        if msg.get("event") == "start":
            stream_sid = msg["start"]["streamSid"]
            break

    if not stream_sid:
        logger.error("No stream SID found!")
        await websocket.close()
        return

    logger.info(f"Eleven test stream SID: {stream_sid}")

    try:
        # Call ElevenLabs REST API directly — no Pipecat
        api_key = os.getenv("ELEVENLABS_API_KEY")
        voice_id = os.getenv("ELEVENLABS_VOICE_ID")
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=pcm_16000"

        logger.info(f"Calling ElevenLabs REST API: voice={voice_id}")
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                url,
                headers={"xi-api-key": api_key, "Content-Type": "application/json"},
                json={
                    "text": "Hello! This is a direct ElevenLabs test. Can you hear me clearly?",
                },
            )

        if resp.status_code != 200:
            logger.error(f"ElevenLabs API error: {resp.status_code} {resp.text[:500]}")
            await websocket.close()
            return

        pcm_16k = resp.content
        logger.info(f"Got {len(pcm_16k)} bytes of 16kHz PCM from ElevenLabs")

        # Check PCM amplitude
        n_samples = len(pcm_16k) // 2
        if n_samples > 0:
            samples = struct.unpack(f'<{n_samples}h', pcm_16k)
            max_amp = max(abs(s) for s in samples)
            logger.info(f"PCM 16kHz: {n_samples} samples, max_amp={max_amp}")
        else:
            logger.error("No PCM samples!")
            await websocket.close()
            return

        # Resample 16kHz -> 8kHz using audioop
        pcm_8k, _ = audioop.ratecv(pcm_16k, 2, 1, 16000, 8000, None)
        logger.info(f"Resampled to {len(pcm_8k)} bytes of 8kHz PCM")

        # Convert to mulaw
        mulaw_bytes = audioop.lin2ulaw(pcm_8k, 2)

        # Verify mulaw is not silence
        silence = sum(1 for b in mulaw_bytes if b == 0xFF)
        logger.info(
            f"Mulaw: {len(mulaw_bytes)} bytes, silence={silence}/{len(mulaw_bytes)} "
            f"({100*silence//max(len(mulaw_bytes),1)}%)"
        )

        # Send in 160-byte chunks with real-time pacing (20ms per chunk)
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
            await asyncio.sleep(0.02)

        logger.info(f"Eleven test: sent {chunks_sent} chunks")

        # Keep connection open so Twilio plays the audio
        await asyncio.sleep(3)
        logger.info("=== ELEVENLABS DIRECT TEST COMPLETE ===")

    except Exception as e:
        logger.error(f"ELEVEN TEST ERROR: {type(e).__name__}: {e}")

    await websocket.close()


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
