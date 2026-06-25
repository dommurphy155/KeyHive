from __future__ import annotations

import logging
import os
import sys
import tempfile
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from proxy.fallback.manager import FallbackManager
from proxy.key_store import KeyStore
from proxy.hf_client import HFResponse
from proxy.fallback.nvidia_client import NvidiaResponse


# This is a small runtime sanity test for the proxy fallback path. It checks
# that exhausted HF keys get removed and that 402 responses can still fall back
# to NVIDIA when the provider is available.
async def check_key_removal() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        keys_file = Path(tmp) / "keys.txt"
        keys_file.write_text("hf_fake_one\nhf_fake_two\n")

        store = KeyStore(str(keys_file), reload_seconds=5)
        await store.load(force=True)
        first = await store.acquire()
        assert first is not None
        await store.exhaust_key(first)
        remaining = [line.strip() for line in keys_file.read_text().splitlines() if line.strip()]

        assert first.token not in remaining
        assert len(remaining) == 1
    assert store.stats()["exhausted_keys_this_runtime"] == 1


async def check_402_uses_nvidia_fallback() -> None:
    # Patch the live proxy module with fake clients so the fallback branch can
    # be exercised without making network calls.
    import proxy.keyhive_proxy as proxy_app

    class FakeHFClient:
        async def chat(self, token: str, payload: dict) -> HFResponse:
            return HFResponse(
                status_code=402,
                json_data={"error": "credits depleted"},
                text="credits depleted",
            )

    class FakeNvidiaClient:
        @property
        def available(self) -> bool:
            return True

        async def chat(self, payload: dict) -> NvidiaResponse:
            return NvidiaResponse(
                status_code=200,
                json_data={
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": "fallback ok",
                            }
                        }
                    ]
                },
            )

    with tempfile.TemporaryDirectory() as tmp:
        keys_file = Path(tmp) / "keys.txt"
        keys_file.write_text("hf_exhausted\n")

        original_store = proxy_app.key_store
        original_hf = proxy_app.hf_client
        original_nvidia = proxy_app.nvidia_client
        original_fallback = proxy_app.fallback_manager
        try:
            proxy_app.key_store = KeyStore(str(keys_file), reload_seconds=5)
            await proxy_app.key_store.load(force=True)
            proxy_app.hf_client = FakeHFClient()
            proxy_app.nvidia_client = FakeNvidiaClient()
            proxy_app.fallback_manager = FallbackManager(logging.getLogger("keyhive-402-test"))

            response = await proxy_app.handle_non_stream(
                "test-model",
                {
                    "model": "test-model",
                    "messages": [{"role": "user", "content": "hello"}],
                    "stream": False,
                },
            )
            body = response.body.decode("utf-8")

            assert response.status_code == 200
            assert "fallback ok" in body
            assert "credits depleted" not in body
            assert keys_file.read_text() == ""
            assert proxy_app.key_store.stats()["exhausted_keys_this_runtime"] == 1
        finally:
            proxy_app.key_store = original_store
            proxy_app.hf_client = original_hf
            proxy_app.nvidia_client = original_nvidia
            proxy_app.fallback_manager = original_fallback


def test_hysteresis() -> None:
    # Verify the fallback manager stays on HF until the enter threshold is hit,
    # then stays on NVIDIA until the exit threshold restores HF.
    os.environ["KEYHIVE_FALLBACK_ENABLED"] = "1"
    os.environ["KEYHIVE_FALLBACK_PROVIDER"] = "nvidia"
    os.environ["KEYHIVE_FALLBACK_ENTER_AT"] = "0"
    os.environ["KEYHIVE_FALLBACK_EXIT_AT"] = "10"

    manager = FallbackManager(logging.getLogger("keyhive-fallback-test"))

    assert manager.evaluate(2, nvidia_available=True) == "hf"
    assert manager.evaluate(0, nvidia_available=True) == "nvidia"
    assert manager.evaluate(9, nvidia_available=True) == "nvidia"
    assert manager.evaluate(10, nvidia_available=True) == "hf"


def test_key_removal() -> None:
    asyncio.run(check_key_removal())


def test_402_uses_nvidia_fallback() -> None:
    asyncio.run(check_402_uses_nvidia_fallback())


async def main() -> None:
    await check_key_removal()
    await check_402_uses_nvidia_fallback()
    test_hysteresis()
    print("fallback state test passed")


if __name__ == "__main__":
    asyncio.run(main())
