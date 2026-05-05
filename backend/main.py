from __future__ import annotations

import asyncio
import json
from http import HTTPStatus
from urllib.parse import parse_qs, urlsplit

from hardware import get_all_metrics
from websockets import ConnectionClosed, Headers, Request, Response, ServerConnection, serve

HOST = "127.0.0.1"
PORT = 8000
DEFAULT_UPDATE_INTERVAL_MS = 500
MIN_UPDATE_INTERVAL_MS = 250
MAX_UPDATE_INTERVAL_MS = 2000
JSON_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
}


def resolve_update_interval_seconds(raw_value: str | None) -> float:
    if raw_value is None:
        return DEFAULT_UPDATE_INTERVAL_MS / 1000

    try:
        interval_ms = int(raw_value)
    except (TypeError, ValueError):
        interval_ms = DEFAULT_UPDATE_INTERVAL_MS

    interval_ms = max(MIN_UPDATE_INTERVAL_MS, min(interval_ms, MAX_UPDATE_INTERVAL_MS))
    return interval_ms / 1000


def json_response(status: HTTPStatus, payload: dict) -> Response:
    body = json.dumps(payload).encode("utf-8")
    headers = Headers()
    for key, value in JSON_HEADERS.items():
        headers[key] = value
    return Response(status.value, status.phrase, headers, body)


async def process_request(_connection: ServerConnection, request: Request) -> Response | None:
    path = urlsplit(request.path).path.rstrip("/") or "/"

    if path == "/ws":
        return None

    if path in {"/", "/health"}:
        return json_response(HTTPStatus.OK, {"ok": True, "source": "PC Monitor Backend"})

    if path == "/metrics":
        try:
            return json_response(HTTPStatus.OK, get_all_metrics())
        except Exception as error:
            return json_response(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(error)})

    return json_response(HTTPStatus.NOT_FOUND, {"error": "Not found"})


async def websocket_metrics(connection: ServerConnection) -> None:
    request_path = connection.request.path if connection.request is not None else "/ws"
    parsed = urlsplit(request_path)
    interval_value = parse_qs(parsed.query).get("interval_ms", [None])[0]
    update_interval_seconds = resolve_update_interval_seconds(interval_value)

    try:
        while True:
            await connection.send(json.dumps(get_all_metrics()))
            await asyncio.sleep(update_interval_seconds)
    except ConnectionClosed:
        return


async def run_server() -> None:
    async with serve(
        websocket_metrics,
        HOST,
        PORT,
        process_request=process_request,
        compression=None,
        server_header=None,
        max_queue=4,
        write_limit=8192,
    ):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(run_server())
