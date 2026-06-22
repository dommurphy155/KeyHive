from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx


@dataclass
class NvidiaResponse:
    status_code: int
    json_data: dict[str, Any] | None = None
    text: str = ""
    headers: httpx.Headers | None = None


class NvidiaClient:
    def __init__(self, api_key: str, base_url: str, timeout: float) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(timeout))

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    async def close(self) -> None:
        await self._client.aclose()

    async def chat(self, payload: dict[str, Any]) -> NvidiaResponse:
        response = await self._client.post(
            f"{self.base_url}/chat/completions",
            headers=self._headers(),
            json=payload,
        )
        return self._response_from_httpx(response)

    async def stream_chat(self, payload: dict[str, Any]) -> tuple[int, httpx.Headers, AsyncIterator[bytes]]:
        request = self._client.build_request(
            "POST",
            f"{self.base_url}/chat/completions",
            headers=self._headers(),
            json=payload,
        )
        response = await self._client.send(request, stream=True)

        async def iterator() -> AsyncIterator[bytes]:
            try:
                async for chunk in response.aiter_bytes():
                    if chunk:
                        yield chunk
            finally:
                await response.aclose()

        return response.status_code, response.headers, iterator()

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    @staticmethod
    def _response_from_httpx(response: httpx.Response) -> NvidiaResponse:
        try:
            data = response.json()
        except ValueError:
            data = None
        return NvidiaResponse(
            status_code=response.status_code,
            json_data=data,
            text=response.text,
            headers=response.headers,
        )
