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


@app.websocket("/ws/twilio")
async def twilio_websocket(websocket: WebSocket):
    await websocket.accept()
    await create_pipeline(websocket)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8765"))
    uvicorn.run("calllock.bot:app", host="0.0.0.0", port=port, reload=True)
