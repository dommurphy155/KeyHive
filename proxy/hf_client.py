from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx


ROUTER_BASE_URL = "https://router.huggingface.co/v1"
INFERENCE_URL = "https://api-inference.huggingface.co/models/{model}"


@dataclass
class HFResponse:
    status_code: int
    json_data: dict[str, Any] | None = None
    text: str = ""
    headers: httpx.Headers | None = None


class HFClient:
    def __init__(self, timeout: float, logger: logging.Logger, base_url: str = ROUTER_BASE_URL) -> None:
        self.timeout = timeout
        self.logger = logger
        self.chat_url = f"{base_url.rstrip('/')}/chat/completions"
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(timeout))

    async def close(self) -> None:
        await self._client.aclose()

    async def chat(
        self,
        token: str,
        payload: dict[str, Any],
    ) -> HFResponse:
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        try:
            response = await self._client.post(self.chat_url, headers=headers, json=payload)
        except httpx.TimeoutException:
            raise
        except httpx.HTTPError as exc:
            self.logger.warning("router request failed: %s", exc.__class__.__name__)
            raise

        if response.status_code < 400:
            return self._response_from_httpx(response)

        # Fallback only for router shape/availability problems, not auth/limits.
        if response.status_code in {404, 422}:
            fallback = await self._fallback_inference(token, payload)
            if fallback.status_code < 400:
                return fallback

        return self._response_from_httpx(response)

    async def stream_chat(
        self,
        token: str,
        payload: dict[str, Any],
    ) -> tuple[int, httpx.Headers | None, AsyncIterator[bytes]]:
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        request = self._client.build_request("POST", self.chat_url, headers=headers, json=payload)
        response = await self._client.send(request, stream=True)

        async def iterator() -> AsyncIterator[bytes]:
            try:
                async for chunk in response.aiter_bytes():
                    if chunk:
                        yield chunk
            finally:
                await response.aclose()

        return response.status_code, response.headers, iterator()

    async def _fallback_inference(
        self,
        token: str,
        payload: dict[str, Any],
    ) -> HFResponse:
        model = str(payload.get("model") or "")
        messages = payload.get("messages") or []
        prompt = "\n".join(
            f"{msg.get('role', 'user')}: {msg.get('content', '')}"
            for msg in messages
            if isinstance(msg, dict)
        )
        body = {
            "inputs": prompt,
            "parameters": {
                "max_new_tokens": payload.get("max_tokens", 1024),
                "temperature": payload.get("temperature", 0.7),
                "return_full_text": False,
            },
        }
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        response = await self._client.post(
            INFERENCE_URL.format(model=model),
            headers=headers,
            json=body,
        )
        parsed = self._response_from_httpx(response)
        if parsed.status_code >= 400:
            return parsed

        content = ""
        data: Any = parsed.json_data
        if isinstance(data, list) and data:
            first = data[0]
            if isinstance(first, dict):
                content = str(first.get("generated_text") or "")
        elif isinstance(data, dict):
            content = str(data.get("generated_text") or data.get("summary_text") or "")

        return HFResponse(
            status_code=200,
            json_data={
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": content,
                        }
                    }
                ]
            },
            headers=response.headers,
        )

    @staticmethod
    def _response_from_httpx(response: httpx.Response) -> HFResponse:
        try:
            data = response.json()
        except json.JSONDecodeError:
            data = None
        return HFResponse(
            status_code=response.status_code,
            json_data=data,
            text=response.text,
            headers=response.headers,
        )


def retry_after_seconds(headers: httpx.Headers | None, default: int = 60) -> int:
    if headers is None:
        return default
    raw = headers.get("retry-after")
    if not raw:
        return default
    try:
        return max(1, int(float(raw)))
    except ValueError:
        return default
