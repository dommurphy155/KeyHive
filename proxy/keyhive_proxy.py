from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from proxy.fallback.manager import FallbackManager
from proxy.fallback.nvidia_client import NvidiaClient
from proxy.hf_client import HFClient, retry_after_seconds
from proxy.key_store import KeyState, KeyStore
from proxy.openai_compat import (
    extract_router_content,
    anthropic_response,
    anthropic_sse,
    non_stream_response,
    normalize_messages,
    openai_error,
    sse_from_text,
)

load_dotenv("/root/api_maker/.env")

HOST = os.getenv("KEYHIVE_PROXY_HOST", "127.0.0.1")
PORT = int(os.getenv("KEYHIVE_PROXY_PORT", "8787"))
KEYS_FILE = os.getenv("KEYHIVE_KEYS_FILE", "/root/api_maker/data/keys.txt")
DEFAULT_PROVIDER = os.getenv("KEYHIVE_PROXY_DEFAULT_PROVIDER", "hf")
FALLBACK_PROVIDER = os.getenv("KEYHIVE_PROXY_FALLBACK_PROVIDER", "nvidia")
HF_BASE_URL = os.getenv("KEYHIVE_HF_BASE_URL", "https://router.huggingface.co/v1")
DEFAULT_MODEL = os.getenv("KEYHIVE_PROXY_DEFAULT_MODEL", "zai-org/GLM-5.2")
NVIDIA_MODEL = os.getenv("KEYHIVE_PROXY_NVIDIA_MODEL", "moonshotai/kimi-k2.6")
NVIDIA_BASE_URL = os.getenv("KEYHIVE_NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1/chat/completions")
NVDA_KEY = os.getenv("NVDA_KEY", "")
RELOAD_SECONDS = int(os.getenv("KEYHIVE_PROXY_RELOAD_SECONDS", "10"))
REQUEST_TIMEOUT = float(os.getenv("KEYHIVE_PROXY_REQUEST_TIMEOUT", "300"))
MAX_RETRIES = int(os.getenv("KEYHIVE_PROXY_MAX_RETRIES", "2"))
DEBUG = os.getenv("KEYHIVE_PROXY_DEBUG", "0") == "1"
MAX_BODY_BYTES = 2 * 1024 * 1024

logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.INFO,
    format="%(asctime)s %(levelname)s keyhive-proxy %(message)s",
)
logger = logging.getLogger("keyhive-proxy")

key_store = KeyStore(KEYS_FILE, RELOAD_SECONDS)
hf_client = HFClient(REQUEST_TIMEOUT, logger, HF_BASE_URL)
nvidia_client = NvidiaClient(NVDA_KEY, NVIDIA_BASE_URL, REQUEST_TIMEOUT)
fallback_manager = FallbackManager(logger)
watch_task: asyncio.Task[None] | None = None
fallback_watch_task: asyncio.Task[None] | None = None
active_requests = 0


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    global watch_task, fallback_watch_task
    await key_store.load(force=True)
    refresh_provider_mode()
    watch_task = asyncio.create_task(key_store.watch())
    fallback_watch_task = asyncio.create_task(watch_provider_mode())
    logger.info("proxy started on %s:%s using keys_file=%s", HOST, PORT, KEYS_FILE)
    try:
        yield
    finally:
        for task in (watch_task, fallback_watch_task):
            if task:
                task.cancel()
        for task in (watch_task, fallback_watch_task):
            if not task:
                continue
            try:
                await task
            except asyncio.CancelledError:
                pass
        await hf_client.close()
        await nvidia_client.close()


app = FastAPI(title="KeyHive Proxy", lifespan=lifespan)


def json_error(message: str, code: str, status: int) -> JSONResponse:
    return JSONResponse(openai_error(message, code, status), status_code=status)


def hf_usable_keys() -> int:
    return key_store.stats()["keys_available"]


def refresh_provider_mode() -> str:
    return fallback_manager.evaluate(hf_usable_keys(), nvidia_client.available)


async def watch_provider_mode() -> None:
    while True:
        try:
            await key_store.reload_if_changed()
            refresh_provider_mode()
        except Exception as exc:
            logger.warning("fallback provider watch failed: %s", exc.__class__.__name__)
        await asyncio.sleep(RELOAD_SECONDS)


async def parse_request_body(request: Request) -> dict[str, Any] | JSONResponse:
    size = request.headers.get("content-length")
    if size:
        try:
            if int(size) > MAX_BODY_BYTES:
                return json_error("request body too large", "request_too_large", 413)
        except ValueError:
            return json_error("invalid content-length", "bad_request", 400)

    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        return json_error("request body too large", "request_too_large", 413)

    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return json_error("bad json", "bad_json", 400)

    if not isinstance(payload, dict):
        return json_error("json body must be an object", "bad_json", 400)
    return payload


def upstream_error_text(response: Any) -> str:
    if response.json_data:
        return json.dumps(response.json_data)
    return response.text or "upstream error"


def upstream_error_code(response: Any) -> str:
    if not response.json_data:
        return ""
    error = response.json_data.get("error")
    if isinstance(error, dict):
        return str(error.get("code") or "")
    return ""


async def mark_status(state: KeyState, status: int, headers: httpx.Headers | None) -> None:
    if status in {401, 403}:
        await key_store.invalidate_key(state, f"upstream {status}")
        logger.warning("disabled invalid key %s after upstream %s", state.fingerprint, status)
    elif status == 429:
        seconds = retry_after_seconds(headers)
        await key_store.cooldown_key(state, seconds)
        logger.warning("cooling key %s for %ss after upstream 429", state.fingerprint, seconds)
    elif status >= 500:
        await key_store.fail_key(state)


async def choose_key_or_503() -> KeyState | JSONResponse:
    await key_store.reload_if_changed()
    state = await key_store.acquire()
    if state is None:
        return json_error("no usable keys are available", "no_usable_keys", 503)
    return state


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "keyhive-proxy",
        "current_provider": refresh_provider_mode(),
        "host": HOST,
        "port": PORT,
    }


@app.get("/stats")
async def stats() -> dict[str, Any]:
    data = key_store.stats()
    fallback = fallback_manager.get_status(
        hf_usable_keys=data["keys_available"],
        nvidia_available=nvidia_client.available,
        nvidia_model=NVIDIA_MODEL,
    )
    return {
        "status": "ok",
        **data,
        "active_requests": active_requests,
        "default_provider": DEFAULT_PROVIDER,
        "fallback_provider": FALLBACK_PROVIDER,
        "hf_base_url": HF_BASE_URL,
        "default_model": DEFAULT_MODEL,
        "keys_file": KEYS_FILE,
        "last_reload": key_store.last_reload,
        **fallback,
    }


@app.get("/v1/models")
async def models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [
            {
                "id": DEFAULT_MODEL,
                "object": "model",
                "created": 0,
                "owned_by": "huggingface",
            }
        ],
    }


@app.post("/v1/chat/completions", response_model=None)
async def chat_completions(request: Request) -> JSONResponse | StreamingResponse:
    global active_requests
    body = await parse_request_body(request)
    if isinstance(body, JSONResponse):
        return body

    try:
        messages = normalize_messages(body.get("messages"))
    except ValueError as exc:
        return json_error(str(exc), "bad_request", 400)

    model = str(body.get("model") or DEFAULT_MODEL)
    if model == "default":
        model = DEFAULT_MODEL

    upstream_payload = dict(body)
    upstream_payload["model"] = model
    upstream_payload["messages"] = messages
    stream = bool(upstream_payload.get("stream", False))

    if stream:
        active_requests += 1
        response = await handle_stream(model, upstream_payload)
        if isinstance(response, JSONResponse):
            active_requests -= 1
        return response

    active_requests += 1
    try:
        return await handle_non_stream(model, upstream_payload)
    finally:
        active_requests -= 1


@app.post("/v1/messages", response_model=None)
async def anthropic_messages(request: Request) -> JSONResponse | StreamingResponse:
    global active_requests
    body = await parse_request_body(request)
    if isinstance(body, JSONResponse):
        return body

    try:
        messages = normalize_messages(body.get("messages"))
    except ValueError as exc:
        return json_error(str(exc), "bad_request", 400)

    system = body.get("system")
    if system:
        messages.insert(0, {"role": "system", "content": str(system)})

    requested_model = str(body.get("model") or "claude")
    upstream_model = DEFAULT_MODEL

    payload = {
        "model": upstream_model,
        "messages": messages,
        "max_tokens": body.get("max_tokens", 1024),
        "temperature": body.get("temperature", 0.7),
        "stream": False,
    }

    active_requests += 1
    try:
        status, content = await complete_text(requested_model, payload)
    finally:
        active_requests -= 1

    if body.get("stream"):
        return StreamingResponse(
            anthropic_sse(requested_model, content if status == 200 else f"KeyHive proxy error ({status}): {content}"),
            status_code=200 if status < 500 else status,
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    if status != 200:
        return JSONResponse(
            {"type": "error", "error": {"type": "api_error", "message": content}},
            status_code=status,
        )
    return JSONResponse(anthropic_response(requested_model, content))


async def complete_text(model: str, payload: dict[str, Any]) -> tuple[int, str]:
    response = await handle_non_stream(model, payload)
    data = json.loads(response.body.decode("utf-8"))
    if response.status_code != 200:
        message = data.get("error", {}).get("message", "proxy error")
        return response.status_code, str(message)
    choices = data.get("choices") or []
    if choices:
        message = choices[0].get("message", {})
        return 200, str(message.get("content", ""))
    return 200, ""


async def handle_non_stream(model: str, payload: dict[str, Any]) -> JSONResponse:
    if refresh_provider_mode() == "nvidia":
        return await handle_nvidia_non_stream(NVIDIA_MODEL, {**payload, "model": NVIDIA_MODEL})

    attempts = max(1, key_store.stats()["keys_total"] + MAX_RETRIES)
    last_status = 503
    last_message = "no usable keys are available"
    rate_limit_failovers = 0
    server_retries = 0

    for _ in range(attempts):
        state_or_error = await choose_key_or_503()
        if isinstance(state_or_error, JSONResponse):
            if refresh_provider_mode() == "nvidia":
                return await handle_nvidia_non_stream(NVIDIA_MODEL, {**payload, "model": NVIDIA_MODEL})
            return state_or_error
        state = state_or_error

        try:
            response = await hf_client.chat(state.token, payload)
        except httpx.TimeoutException:
            await key_store.fail_key(state)
            return json_error("upstream request timed out", "upstream_timeout", 504)
        except httpx.HTTPError as exc:
            await key_store.fail_key(state)
            last_status = 502
            last_message = f"upstream request failed: {exc.__class__.__name__}"
            continue

        if response.status_code < 400 and response.json_data is not None:
            content = extract_router_content(response.json_data)
            return JSONResponse(non_stream_response(model, content))

        await mark_status(state, response.status_code, response.headers)
        last_status = response.status_code
        last_message = upstream_error_text(response)

        if (
            response.status_code == 400
            and upstream_error_code(response) in {"model_not_found", "model_not_supported"}
            and nvidia_client.available
        ):
            logger.warning("HF model rejected by provider; using NVIDIA fallback for this request")
            return await handle_nvidia_non_stream(NVIDIA_MODEL, {**payload, "model": NVIDIA_MODEL})

        if response.status_code == 429:
            if rate_limit_failovers >= 1:
                break
            rate_limit_failovers += 1
            continue

        if response.status_code in {500, 502, 503, 504}:
            if server_retries >= MAX_RETRIES:
                break
            server_retries += 1
            continue

        if response.status_code not in {401, 403}:
            break

    if refresh_provider_mode() == "nvidia":
        return await handle_nvidia_non_stream(NVIDIA_MODEL, {**payload, "model": NVIDIA_MODEL})
    return json_error(last_message, "upstream_error", last_status)


async def handle_stream(model: str, payload: dict[str, Any]) -> StreamingResponse | JSONResponse:
    if refresh_provider_mode() == "nvidia":
        return await handle_nvidia_stream(NVIDIA_MODEL, {**payload, "model": NVIDIA_MODEL})

    attempts = max(1, key_store.stats()["keys_total"] + MAX_RETRIES)
    rate_limit_failovers = 0
    server_retries = 0

    for _ in range(attempts):
        state_or_error = await choose_key_or_503()
        if isinstance(state_or_error, JSONResponse):
            if refresh_provider_mode() == "nvidia":
                return await handle_nvidia_stream(NVIDIA_MODEL, {**payload, "model": NVIDIA_MODEL})
            return state_or_error
        state = state_or_error

        try:
            status, headers, iterator = await hf_client.stream_chat(state.token, payload)
        except httpx.TimeoutException:
            await key_store.fail_key(state)
            return stream_error(model, "upstream request timed out", 504)
        except httpx.HTTPError as exc:
            await key_store.fail_key(state)
            logger.warning("stream request failed with %s", exc.__class__.__name__)
            continue

        if status < 400:
            return StreamingResponse(
                stream_with_active_count(stream_router_sse(iterator)),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

        await mark_status(state, status, headers)
        if status == 429:
            if rate_limit_failovers >= 1:
                return stream_error(model, "upstream rate limited all usable failover keys", 429)
            rate_limit_failovers += 1
            continue

        if status in {500, 502, 503, 504}:
            if server_retries >= MAX_RETRIES:
                return stream_error(model, f"upstream returned {status}", status)
            server_retries += 1
            continue

        if status not in {401, 403}:
            return stream_error(model, f"upstream returned {status}", status)

    if refresh_provider_mode() == "nvidia":
        return await handle_nvidia_stream(NVIDIA_MODEL, {**payload, "model": NVIDIA_MODEL})
    return stream_error(model, "no usable keys are available", 503)


async def handle_nvidia_non_stream(model: str, payload: dict[str, Any]) -> JSONResponse:
    if not nvidia_client.available:
        return json_error("NVIDIA fallback is not configured", "no_fallback_key", 503)
    try:
        response = await nvidia_client.chat(payload)
    except httpx.TimeoutException:
        return json_error("NVIDIA fallback timed out", "upstream_timeout", 504)
    except httpx.HTTPError as exc:
        return json_error(f"NVIDIA fallback failed: {exc.__class__.__name__}", "upstream_error", 502)
    if response.status_code >= 400:
        return json_error(upstream_error_text(response), "upstream_error", response.status_code)
    content = extract_router_content(response.json_data or {})
    return JSONResponse(non_stream_response(model, content))


async def handle_nvidia_stream(model: str, payload: dict[str, Any]) -> StreamingResponse | JSONResponse:
    if not nvidia_client.available:
        return stream_error(model, "NVIDIA fallback is not configured", 503)
    try:
        status, _, iterator = await nvidia_client.stream_chat(payload)
    except httpx.TimeoutException:
        return stream_error(model, "NVIDIA fallback timed out", 504)
    except httpx.HTTPError as exc:
        return stream_error(model, f"NVIDIA fallback failed: {exc.__class__.__name__}", 502)
    if status >= 400:
        return stream_error(model, f"NVIDIA fallback returned {status}", status)
    return StreamingResponse(
        stream_with_active_count(stream_router_sse(iterator)),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def stream_router_sse(iterator: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    saw_done = False
    async for chunk in iterator:
        if b"data: [DONE]" in chunk:
            saw_done = True
        yield chunk
    if not saw_done:
        yield b"data: [DONE]\n\n"


async def stream_with_active_count(iterator: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    global active_requests
    try:
        async for chunk in iterator:
            yield chunk
    finally:
        active_requests -= 1


def stream_error(model: str, message: str, status: int) -> StreamingResponse:
    async def iterator() -> AsyncIterator[bytes]:
        async for chunk in sse_from_text(model, f"KeyHive proxy error ({status}): {message}"):
            yield chunk

    return StreamingResponse(
        stream_with_active_count(iterator()),
        status_code=status,
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the KeyHive OpenAI-compatible proxy.")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", default=PORT, type=int)
    args = parser.parse_args()
    uvicorn.run("proxy.keyhive_proxy:app", host=args.host, port=args.port, log_level="debug" if DEBUG else "info")


if __name__ == "__main__":
    main()
