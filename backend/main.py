import asyncio
import json

import uvicorn
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from hardware import get_all_metrics

app = FastAPI(title="PC Monitor API")
# Keep the feed responsive without hammering the local machine unnecessarily.
UPDATE_INTERVAL_SECONDS = 0.2

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/metrics")
def metrics():
    return get_all_metrics()

@app.websocket("/ws")
async def websocket_metrics(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            data = get_all_metrics()
            await websocket.send_text(json.dumps(data))
            await asyncio.sleep(UPDATE_INTERVAL_SECONDS)
    except Exception:
        pass

if __name__ == "__main__":
    # An explicit server config is more reliable than uvicorn.run(...) in the
    # windowless PyInstaller build that the Tauri app ships with.
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=8000,
        log_config=None,
        access_log=False,
    )
    server = uvicorn.Server(config)
    server.run()
