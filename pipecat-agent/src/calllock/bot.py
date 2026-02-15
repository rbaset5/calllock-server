import os
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket
from fastapi.responses import PlainTextResponse

from calllock.pipeline import create_pipeline

load_dotenv()

app = FastAPI(title="CallLock Voice Agent")


@app.get("/health")
async def health():
    return PlainTextResponse("ok")


@app.websocket("/ws/twilio")
async def twilio_websocket(websocket: WebSocket):
    await websocket.accept()
    await create_pipeline(websocket)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8765"))
    uvicorn.run("calllock.bot:app", host="0.0.0.0", port=port, reload=True)
