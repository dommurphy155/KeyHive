from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import time
import uuid
from pathlib import Path
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
from proxy.hf_client import HFClient
from proxy.key_store import KeyState, KeyStore
from proxy.openai_compat import (
    anthropic_openai_payload,
    anthropic_response_from_blocks,
    anthropic_sse_from_response,
    normalize_messages,
    openai_response_from_router,
    openai_response_to_anthropic,
    openai_error,
    sse_from_text,
)
from proxy.stats import record_failure, record_success, get_status as stats_status
from proxy.system_prompt import replace_system_prompt

MAX_BODY_BYTES = 2 * 1024 * 1024

ROOT_DIR = Path(__file__).resolve().parents[1]
load_dotenv(ROOT_DIR / ".env")

# The proxy exposes an OpenAI-compatible chat API backed by Hugging Face keys
# with NVIDIA fallback when the HF key pool gets thin or exhausted.
HOST = os.getenv("KEYHIVE_PROXY_HOST", "127.0.0.1")
PORT = int(os.getenv("KEYHIVE_PROXY_PORT", "8787"))
KEYS_FILE = os.getenv("KEYHIVE_KEYS_FILE", str(ROOT_DIR / "data" / "keys.txt"))
DEFAULT_PROVIDER = os.getenv("KEYHIVE_PROXY_DEFAULT_PROVIDER", "hf")
FALLBACK_PROVIDER = os.getenv("KEYHIVE_PROXY_FALLBACK_PROVIDER", "nvidia")
HF_BASE_URL = os.getenv("KEYHIVE_HF_BASE_URL", "https://router.huggingface.co/v1")
DEFAULT_MODEL = os.getenv("KEYHIVE_PROXY_DEFAULT_MODEL", "Qwen/Qwen3.6-35B-A3B")
NVIDIA_MODEL = os.getenv("KEYHIVE_PROXY_NVIDIA_MODEL", "moonshotai/kimi-k2.6")
NVIDIA_BASE_URL = os.getenv("KEYHIVE_NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1/chat/completions")
NVDA_KEY = os.getenv("NVDA_KEY", "")
RELOAD_SECONDS = int(os.getenv("KEYHIVE_PROXY_RELOAD_SECONDS", "5"))
REQUEST_TIMEOUT = float(os.getenv("KEYHIVE_PROXY_REQUEST_TIMEOUT", "300"))
MAX_RETRIES = int(os.getenv("KEYHIVE_PROXY_MAX_RETRIES", "2"))
MAX_KEY_FAILOVERS = int(os.getenv("KEYHIVE_PROXY_MAX_KEY_FAILOVERS", "3"))
DEBUG = os.getenv("KEYHIVE_PROXY_DEBUG", "0") == "1"
MAX_BODY_BYTES = 2 * 1024 * 1024


class _CleanFormatter(logging.Formatter):
    _COLORS = {
        "DEBUG": "\033[36m",
        "INFO": "\033[32m",
        "WARNING": "\033[33m",
        "ERROR": "\033[31m",
        "CRITICAL": "\033[35m",
    }
    _RESET = "\033[0m"

    def format(self, record: logging.LogRecord) -> str:
        ts = self.formatTime(record, "%d/%-m/%y %-H:%M")
        color = self._COLORS.get(record.levelname, "")
        level = f"{color}{record.levelname:<7}{self._RESET}"
        return f"{ts} {level} keyhive  {record.getMessage()}"


_handler = logging.StreamHandler()
_handler.setFormatter(_CleanFormatter())
logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.INFO,
    handlers=[_handler],
    force=True,
)
def _short_model(name: str) -> str:
    """Shorten model name for log display: Qwen/Qwen3.6-35B-A3B -> Qwen3.6-35B-A3B"""
    if "/" in name:
        return name.rsplit("/", 1)[1]
    return name


logger = logging.getLogger("keyhive-proxy")

# Silence everything that's not our logger
for _name in ("uvicorn", "uvicorn.access", "uvicorn.error", "httpx", "httpx._client", "watchfiles"):
    logging.getLogger(_name).setLevel(logging.CRITICAL)

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


def _generate_rid() -> str:
    """Generate a short request ID for tracing."""
    return uuid.uuid4().hex[:8]


def _extract_usage(json_data: dict[str, Any]) -> tuple[int, int, int, int]:
    """Extract (prompt_tokens, completion_tokens, total_tokens, tool_calls)."""
    usage = json_data.get("usage") if isinstance(json_data, dict) else None
    if not isinstance(usage, dict):
        return 0, 0, 0, 0
    pt = int(usage.get("prompt_tokens") or 0)
    ct = int(usage.get("completion_tokens") or 0)
    tt = int(usage.get("total_tokens") or 0)
    tc = 0
    for choice in (json_data.get("choices") or []):
        if isinstance(choice, dict):
            msg = choice.get("message")
            if isinstance(msg, dict):
                for item in (msg.get("tool_calls") or []):
                    if isinstance(item, dict):
                        tc += 1
    return pt, ct, tt, tc


def _remaining_keys() -> int:
    return key_store.stats()["usable_keys"]


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
    proxy_stats = stats_status()
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
        "keys_file_mtime": key_store.keys_mtime,
        **fallback,
        "proxy": proxy_stats,
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


# ── Request endpoints ──────────────────────────────────────────────────


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

    replace_system_prompt(upstream_payload, provider="openai")

    rid = _generate_rid()
    provider = refresh_provider_mode()
    started = time.monotonic()
    logger.info(">%s %s stream=%s provider=%s", rid, model, "yes" if stream else "no", provider)

    if stream:
        active_requests += 1
        try:
            response = await handle_stream(model, upstream_payload, rid, provider, started)
            return response
        except Exception:
            elapsed = time.monotonic() - started
            logger.info("<%s status=500 provider=%s %.1fs", rid, provider, elapsed)
            record_failure(provider)
            raise
        finally:
            active_requests -= 1

    active_requests += 1
    try:
        result = await handle_non_stream(model, upstream_payload, rid, provider, started)
        elapsed = time.monotonic() - started
        if result.status_code >= 400:
            logger.info("<%s status=%d provider=%s model=%s %.1fs", rid, result.status_code, provider, model, elapsed)
        return result
    finally:
        active_requests -= 1


@app.post("/v1/messages", response_model=None)
async def anthropic_messages(request: Request) -> JSONResponse | StreamingResponse:
    global active_requests
    body = await parse_request_body(request)
    if isinstance(body, JSONResponse):
        return body

    requested_model = str(body.get("model") or "claude")
    replace_system_prompt(body, provider="anthropic")

    try:
        payload = anthropic_openai_payload(body, DEFAULT_MODEL)
    except ValueError as exc:
        return JSONResponse(
            {"type": "error", "error": {"type": "invalid_request_error", "message": str(exc)}},
            status_code=400,
        )

    rid = _generate_rid()
    started = time.monotonic()

    active_requests += 1
    try:
        response = await handle_non_stream(DEFAULT_MODEL, payload, rid, "hf", started)
    finally:
        active_requests -= 1

    elapsed = time.monotonic() - started
    logger.info("<%s status=%d %.1fs", rid, response.status_code, elapsed)

    if response.status_code != 200:
        data = json.loads(response.body.decode("utf-8"))
        message = data.get("error", {}).get("message", "proxy error")
        status = response.status_code
        record_failure("hf")
        if body.get("stream"):
            error_response = anthropic_response_from_blocks(
                requested_model,
                [{"type": "text", "text": f"KeyHive proxy error ({status}): {message}"}],
                "error",
            )
            return StreamingResponse(
                anthropic_sse_from_response(error_response),
                status_code=200 if status < 500 else status,
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )
        return JSONResponse(
            {"type": "error", "error": {"type": "api_error", "message": str(message)}},
            status_code=status,
        )

    openai_payload = json.loads(response.body.decode("utf-8"))
    pt, ct, tt, tc = _extract_usage(openai_payload)
    record_success("hf", DEFAULT_MODEL, pt, ct, tt, tc)

    anthropic_payload = openai_response_to_anthropic(requested_model, openai_payload)

    if body.get("stream"):
        return StreamingResponse(
            anthropic_sse_from_response(anthropic_payload),
            status_code=200,
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return JSONResponse(anthropic_payload)


# ── Handler: non-streaming ────────────────────────────────────────────


async def handle_non_stream(
    model: str,
    payload: dict[str, Any],
    rid: str = "",
    provider: str = "hf",
    started: float = 0.0,
) -> JSONResponse:
    if provider == "nvidia":
        return await handle_nvidia_non_stream(NVIDIA_MODEL, {**payload, "model": NVIDIA_MODEL}, model, rid, started)

    attempts = max(1, key_store.stats()["keys_total"] + MAX_RETRIES)
    last_status = 503
    last_message = "no usable keys are available"
    key_failovers = 0
    server_retries = 0

    for _ in range(attempts):
        if key_failovers >= MAX_KEY_FAILOVERS:
            record_failure("hf")
            return json_error(
                "KeyHive exhausted the per-request key failover limit. Retry request.",
                "key_failover_limit",
                503,
            )
        state_or_error = await choose_key_or_503()
        if isinstance(state_or_error, JSONResponse):
            if refresh_provider_mode() == "nvidia":
                return await handle_nvidia_non_stream(
                    NVIDIA_MODEL, {**payload, "model": NVIDIA_MODEL}, model, rid, started
                )
            record_failure("hf")
            return no_provider_error()
        state = state_or_error

        try:
            response = await hf_client.chat(state.token, payload)
        except httpx.TimeoutException:
            await key_store.fail_key(state)
            record_failure("hf")
            return json_error("upstream request timed out", "upstream_timeout", 504)
        except httpx.HTTPError as exc:
            await key_store.fail_key(state)
            last_status = 502
            last_message = f"upstream request failed: {exc.__class__.__name__}"
            continue

        if response.status_code < 400 and response.json_data is not None:
            pt, ct, tt, tc = _extract_usage(response.json_data)
            record_success("hf", model, pt, ct, tt, tc)
            elapsed = time.monotonic() - started if started else 0
            logger.info(
                "<%s status=%d provider=%s model=%s tools=%d in_tokens=%d out_tokens=%d Total=%d %.1fs",
                rid, response.status_code, provider, model, tc, pt, ct, tt, elapsed,
            )
            return JSONResponse(openai_response_from_router(model, response.json_data))

        await mark_status(state, response.status_code, response.headers)
        last_status = response.status_code
        last_message = upstream_error_text(response)

        if response.status_code in {402, 429}:
            reason = "credits exhausted" if response.status_code == 402 else "quota/billing 429"
            await key_store.exhaust_key(state, reason)
            logger.warning("key dead (%s): %s (%d keys left)", reason, state.fingerprint, _remaining_keys())
            refresh_provider_mode()
            key_failovers += 1
            if refresh_provider_mode() == "nvidia":
                return await handle_nvidia_non_stream(
                    NVIDIA_MODEL, {**payload, "model": NVIDIA_MODEL}, model, rid, started
                )
            continue

        if (
            response.status_code == 400
            and upstream_error_code(response) in {"model_not_found", "model_not_supported"}
            and nvidia_client.available
        ):
            logger.warning("HF model rejected; using NVIDIA fallback")
            return await handle_nvidia_non_stream(
                NVIDIA_MODEL, {**payload, "model": NVIDIA_MODEL}, model, rid, started
            )

        if response.status_code in {500, 502, 503, 504}:
            if server_retries >= MAX_RETRIES:
                break
            server_retries += 1
            continue

        if response.status_code in {401, 403}:
            logger.warning("key invalid/forbidden: %s", state.fingerprint)
            refresh_provider_mode()
            key_failovers += 1
            if refresh_provider_mode() == "nvidia":
                return await handle_nvidia_non_stream(
                    NVIDIA_MODEL, {**payload, "model": NVIDIA_MODEL}, model, rid, started
                )
            continue

        if response.status_code not in {401, 403}:
            break

    if refresh_provider_mode() == "nvidia":
        return await handle_nvidia_non_stream(
            NVIDIA_MODEL, {**payload, "model": NVIDIA_MODEL}, model, rid, started
        )
    if last_status == 402:
        record_failure("hf")
        return no_provider_error()
    record_failure("hf")
    return json_error(last_message, "upstream_error", last_status)


# ── Handler: streaming ────────────────────────────────────────────────


async def handle_stream(
    model: str,
    payload: dict[str, Any],
    rid: str = "",
    provider: str = "hf",
    started: float = 0.0,
) -> StreamingResponse | JSONResponse:
    if provider == "nvidia":
        return await handle_nvidia_stream(
            NVIDIA_MODEL, {**payload, "model": NVIDIA_MODEL}, model, rid, started
        )

    attempts = max(1, key_store.stats()["keys_total"] + MAX_RETRIES)
    key_failovers = 0
    server_retries = 0

    for _ in range(attempts):
        if key_failovers >= MAX_KEY_FAILOVERS:
            record_failure("hf")
            return stream_error(model, "KeyHive exhausted the per-request key failover limit. Retry request.", 503)
        state_or_error = await choose_key_or_503()
        if isinstance(state_or_error, JSONResponse):
            if refresh_provider_mode() == "nvidia":
                return await handle_nvidia_stream(
                    NVIDIA_MODEL, {**payload, "model": NVIDIA_MODEL}, model, rid, started
                )
            record_failure("hf")
            return stream_error(model, "No usable provider available. Hugging Face keys exhausted and NVIDIA fallback unavailable.", 503)
        state = state_or_error

        try:
            status, headers, iterator = await hf_client.stream_chat(state.token, payload)
        except httpx.TimeoutException:
            await key_store.fail_key(state)
            record_failure("hf")
            return stream_error(model, "upstream request timed out", 504)
        except httpx.HTTPError as exc:
            await key_store.fail_key(state)
            logger.warning("stream request failed: %s", exc.__class__.__name__)
            continue

        if status < 400:
            return StreamingResponse(
                stream_with_active_count(stream_router_sse(iterator, model, rid, provider, started)),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

        await mark_status(state, status, headers)
        if status in {402, 429}:
            reason = "credits exhausted" if status == 402 else "quota/billing 429"
            await key_store.exhaust_key(state, reason)
            logger.warning("key dead (%s): %s (%d keys left)", reason, state.fingerprint, _remaining_keys())
            refresh_provider_mode()
            key_failovers += 1
            if refresh_provider_mode() == "nvidia":
                return await handle_nvidia_stream(
                    NVIDIA_MODEL, {**payload, "model": NVIDIA_MODEL}, model, rid, started
                )
            continue

        if status in {500, 502, 503, 504}:
            if server_retries >= MAX_RETRIES:
                record_failure("hf")
                return stream_error(model, f"upstream returned {status}", status)
            server_retries += 1
            continue

        if status in {401, 403}:
            logger.warning("key invalid/forbidden: %s", state.fingerprint)
            refresh_provider_mode()
            key_failovers += 1
            if refresh_provider_mode() == "nvidia":
                return await handle_nvidia_stream(
                    NVIDIA_MODEL, {**payload, "model": NVIDIA_MODEL}, model, rid, started
                )
            continue

        if status not in {401, 403}:
            record_failure("hf")
            return stream_error(model, f"upstream returned {status}", status)

    if refresh_provider_mode() == "nvidia":
        return await handle_nvidia_stream(
            NVIDIA_MODEL, {**payload, "model": NVIDIA_MODEL}, model, rid, started
        )
    record_failure("hf")
    return stream_error(model, "no usable keys are available", 503)


def no_provider_error() -> JSONResponse:
    return JSONResponse(
        {
            "error": {
                "message": "No usable provider available. Hugging Face keys exhausted and NVIDIA fallback unavailable.",
                "type": "keyhive_no_provider",
                "code": "no_provider",
            }
        },
        status_code=503,
    )


# ── Handler: NVIDIA non-streaming ─────────────────────────────────────


async def handle_nvidia_non_stream(
    model: str,
    payload: dict[str, Any],
    request_model: str = "",
    rid: str = "",
    started: float = 0.0,
) -> JSONResponse:
    if not nvidia_client.available:
        return json_error("NVIDIA fallback is not configured", "no_fallback_key", 503)
    try:
        response = await nvidia_client.chat(payload)
    except httpx.TimeoutException:
        record_failure("nvidia")
        return json_error("NVIDIA fallback timed out", "upstream_timeout", 504)
    except httpx.HTTPError as exc:
        record_failure("nvidia")
        return json_error(f"NVIDIA fallback failed: {exc.__class__.__name__}", "upstream_error", 502)
    if response.status_code >= 400:
        record_failure("nvidia")
        return json_error(upstream_error_text(response), "upstream_error", response.status_code)
    pt, ct, tt, tc = _extract_usage(response.json_data or {})
    record_success("nvidia", model, pt, ct, tt, tc)
    elapsed = time.monotonic() - started if started else 0
    logger.info(
        "<%s status=%d provider=nvidia model=%s tools=%d in_tokens=%d out_tokens=%d Total=%d %.1fs",
        rid, response.status_code, model, tc, pt, ct, tt, elapsed,
    )
    return JSONResponse(openai_response_from_router(model, response.json_data or {}))


# ── Handler: NVIDIA streaming ─────────────────────────────────────────


async def handle_nvidia_stream(
    model: str,
    payload: dict[str, Any],
    request_model: str = "",
    rid: str = "",
    started: float = 0.0,
) -> StreamingResponse | JSONResponse:
    if not nvidia_client.available:
        return stream_error(model, "NVIDIA fallback is not configured", 503)
    try:
        status, _, iterator = await nvidia_client.stream_chat(payload)
    except httpx.TimeoutException:
        record_failure("nvidia")
        return stream_error(model, "NVIDIA fallback timed out", 504)
    except httpx.HTTPError as exc:
        record_failure("nvidia")
        return stream_error(model, f"NVIDIA fallback failed: {exc.__class__.__name__}", 502)
    if status >= 400:
        record_failure("nvidia")
        return stream_error(model, f"NVIDIA fallback returned {status}", status)
    return StreamingResponse(
        stream_with_active_count(stream_router_sse(iterator, model, rid, "nvidia", started)),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── SSE helpers ───────────────────────────────────────────────────────


async def stream_router_sse(
    iterator: AsyncIterator[bytes],
    model: str,
    rid: str,
    provider: str,
    started: float,
) -> AsyncIterator[bytes]:
    """Stream SSE chunks, capturing the last chunk for usage data, then logging."""
    last_chunk = b""
    async for chunk in iterator:
        last_chunk = chunk
        yield chunk

    # Extract usage from the last SSE data line (contains the [DONE] or final chunk)
    try:
        text = last_chunk.decode("utf-8", errors="replace")
        # SSE usage comes in the last data: line before [DONE]
        for line in text.split("\n"):
            line = line.strip()
            if line.startswith("data: "):
                data_str = line[6:]
                if data_str == "[DONE]":
                    continue
                try:
                    data = json.loads(data_str)
                    usage = data.get("choices", [{}])[-1].get("usage")
                    if isinstance(usage, dict):
                        tt = int(usage.get("total_tokens", 0))
                        tc = 0
                        for item in (data.get("choices", [{}])[-1].get("delta", {}).get("tool_calls") or []):
                            if isinstance(item, dict):
                                tc += 1
                        # If no usage in last chunk, look at prior chunks
                        if tt == 0:
                            record_success(provider, model, 0, 0, 0, 0)
                        else:
                            pt = int(usage.get("prompt_tokens", 0))
                            ct = int(usage.get("completion_tokens", 0))
                            record_success(provider, model, pt, ct, tt, tc)
                        elapsed = time.monotonic() - started
                        logger.info(
                            "<%s status=200 provider=%s model=%s tools=%d in_tokens=%d out_tokens=%d Total=%d %.1fs",
                            rid, provider, model, tc, pt, ct, tt, elapsed,
                        )
                        return
                except (json.JSONDecodeError, IndexError, KeyError):
                    pass
        # No usage found — record zero
        record_success(provider, model, 0, 0, 0, 0)
        elapsed = time.monotonic() - started
        logger.info("<%s status=200 provider=%s model=%s tools=? in_tokens=? out_tokens=? %.1fs", rid, provider, model, elapsed)
    except Exception:
        record_success(provider, model, 0, 0, 0, 0)
        elapsed = time.monotonic() - started
        logger.info("<%s status=200 provider=%s model=%s %.1fs", rid, provider, model, elapsed)


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


# ── Entrypoint ────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the KeyHive OpenAI-compatible proxy.")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", default=PORT, type=int)
    args = parser.parse_args()
    config = uvicorn.Config(
        "proxy.keyhive_proxy:app",
        host=args.host,
        port=args.port,
        log_level="warning",
        access_log=False,
    )
    uvicorn.Server(config).run()


if __name__ == "__main__":
    main()
