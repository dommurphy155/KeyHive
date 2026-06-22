from __future__ import annotations

import json
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any


def completion_id() -> str:
    return f"chatcmpl_{uuid.uuid4().hex}"


def openai_error(message: str, code: str, status: int) -> dict[str, Any]:
    return {
        "error": {
            "message": message,
            "type": code,
            "code": status,
        }
    }


def normalize_messages(messages: Any) -> list[dict[str, str]]:
    if not isinstance(messages, list) or not messages:
        raise ValueError("messages must be a non-empty array")

    normalized: list[dict[str, str]] = []
    for message in messages:
        if not isinstance(message, dict):
            raise ValueError("each message must be an object")
        role = str(message.get("role") or "user")
        content = message.get("content")
        if isinstance(content, list):
            parts = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    parts.append(str(part.get("text") or ""))
            content = "\n".join(parts)
        if content is None:
            content = ""
        normalized.append({"role": role, "content": str(content)})
    return normalized


def non_stream_response(model: str, content: str) -> dict[str, Any]:
    return {
        "id": completion_id(),
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
    }


def chunk_payload(model: str, content: str) -> dict[str, Any]:
    return {
        "id": completion_id(),
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": {"content": content},
                "finish_reason": None,
            }
        ],
    }


async def sse_from_text(model: str, text: str) -> AsyncIterator[bytes]:
    if text:
        yield f"data: {json.dumps(chunk_payload(model, text), separators=(',', ':'))}\n\n".encode()
    yield b"data: [DONE]\n\n"


def extract_router_content(payload: dict[str, Any]) -> str:
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict):
                content = message.get("content")
                if content is not None:
                    return str(content)
            text = first.get("text")
            if text is not None:
                return str(text)
    generated = payload.get("generated_text")
    if generated is not None:
        return str(generated)
    return json.dumps(payload)


def anthropic_response(model: str, content: str) -> dict[str, Any]:
    return {
        "id": f"msg_{uuid.uuid4().hex}",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [{"type": "text", "text": content}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {"input_tokens": 0, "output_tokens": 0},
    }


async def anthropic_sse(model: str, content: str) -> AsyncIterator[bytes]:
    message = anthropic_response(model, "")
    yield f"event: message_start\ndata: {json.dumps({'type': 'message_start', 'message': message}, separators=(',', ':'))}\n\n".encode()
    yield b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n"
    if content:
        payload = {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "text_delta", "text": content},
        }
        yield f"event: content_block_delta\ndata: {json.dumps(payload, separators=(',', ':'))}\n\n".encode()
    yield b"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n"
    yield b"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":0}}\n\n"
    yield b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
