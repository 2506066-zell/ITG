"""Serverless Python chatbot endpoint.

Stateless, fast, and compatible with Vercel Python runtime.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler

from chatbot.processor import process_message


MAX_BODY_BYTES = 8 * 1024
ALLOWED_PATHS = {"/api/chat.py", "/api/chat", "/api/chatbot"}


def _send_json(handler: BaseHTTPRequestHandler, status_code: int, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    handler.send_response(status_code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _read_json_body(handler: BaseHTTPRequestHandler) -> dict:
    raw_length = str(handler.headers.get("Content-Length", "0")).strip()
    try:
        length = int(raw_length)
    except Exception:
        length = 0

    if length <= 0:
        return {}
    if length > MAX_BODY_BYTES:
        return {"_error": "payload_too_large"}

    raw = handler.rfile.read(length).decode("utf-8", errors="ignore")
    try:
        parsed = json.loads(raw)
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


class handler(BaseHTTPRequestHandler):  # pylint: disable=invalid-name
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        # Suppress default stdout logs in serverless.
        return

    def do_GET(self) -> None:  # noqa: N802
        _send_json(
            self,
            200,
            {
                "ok": True,
                "service": "chatbot-python",
                "endpoint": "/api/chat",
                "mode": "stateless",
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path not in ALLOWED_PATHS:
            _send_json(self, 404, {"error": "Not Found"})
            return

        payload = _read_json_body(self)
        if payload.get("_error") == "payload_too_large":
            _send_json(self, 413, {"error": "Payload too large"})
            return

        message = payload.get("message")
        if not isinstance(message, str) or not message.strip():
            _send_json(self, 400, {"error": "message is required"})
            return

        reply = process_message(message)
        _send_json(self, 200, {"reply": reply})

