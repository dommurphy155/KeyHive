from __future__ import annotations

import importlib
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _reload_with_strategy(strategy: str) -> object:
    # The rewriter reads env at import time, so reimport per strategy.
    os.environ["KEYHIVE_SYSTEM_REWRITE"] = strategy
    if "proxy.system_rewriter" in sys.modules:
        del sys.modules["proxy.system_rewriter"]
    return importlib.import_module("proxy.system_rewriter")


def test_replace_swaps_system_message() -> None:
    sr = _reload_with_strategy("replace")
    messages = [
        {"role": "system", "content": "You are Claude Code, Anthropic's official CLI. " * 50},
        {"role": "user", "content": "hello"},
    ]
    out = sr.rewrite_system(messages)
    assert out[0]["role"] == "system"
    assert "Claude Code" not in out[0]["content"]
    assert out[0]["content"] == sr.REPLACEMENT_TEXT
    # User message untouched.
    assert out[1] == messages[1]
    # Original list not mutated.
    assert messages[0]["content"].startswith("You are Claude Code")


def test_strip_removes_system_message() -> None:
    sr = _reload_with_strategy("strip")
    messages = [
        {"role": "system", "content": "system prompt"},
        {"role": "user", "content": "hello"},
    ]
    out = sr.rewrite_system(messages)
    assert len(out) == 1
    assert out[0]["role"] == "user"
    assert messages == [
        {"role": "system", "content": "system prompt"},
        {"role": "user", "content": "hello"},
    ]


def test_passthrough_leaves_it_alone() -> None:
    sr = _reload_with_strategy("passthrough")
    messages = [
        {"role": "system", "content": "keep me"},
        {"role": "user", "content": "hello"},
    ]
    out = sr.rewrite_system(messages)
    assert out[0]["content"] == "keep me"


def test_no_system_message_is_noop() -> None:
    sr = _reload_with_strategy("replace")
    messages = [{"role": "user", "content": "hello"}]
    out = sr.rewrite_system(messages)
    assert out == messages


def test_unknown_strategy_falls_back_to_passthrough() -> None:
    sr = _reload_with_strategy("banana")
    messages = [
        {"role": "system", "content": "keep me"},
        {"role": "user", "content": "hello"},
    ]
    out = sr.rewrite_system(messages)
    assert out[0]["content"] == "keep me"


def test_custom_replacement_text_env() -> None:
    os.environ["KEYHIVE_SYSTEM_TEXT"] = "Be brief. Be correct."
    sr = _reload_with_strategy("replace")
    try:
        messages = [{"role": "system", "content": "old"}, {"role": "user", "content": "hi"}]
        out = sr.rewrite_system(messages)
        assert out[0]["content"] == "Be brief. Be correct."
    finally:
        del os.environ["KEYHIVE_SYSTEM_TEXT"]


def test_rewriter_hooked_in_handlers() -> None:
    # End-to-end: confirm the proxy actually rewrites the system message before
    # it would forward upstream. Patch the HF client to capture what it receives.
    import proxy.keyhive_proxy as proxy_app

    _reload_with_strategy("replace")  # ensure rewriter in replace mode
    # reimport proxy so it picks up the fresh system_rewriter module
    if "proxy.keyhive_proxy" in sys.modules:
        del sys.modules["proxy.keyhive_proxy"]
    import proxy.keyhive_proxy as pa

    captured: dict = {}

    class CaptureHFClient:
        async def chat(self, token: str, payload: dict) -> object:
            captured["messages"] = payload["messages"]
            from proxy.hf_client import HFResponse
            return HFResponse(
                status_code=200,
                json_data={"choices": [{"message": {"role": "assistant", "content": "ok"}}]},
                text="",
            )

    class FakeNvidia:
        @property
        def available(self) -> bool:
            return False

    with tempfile.TemporaryDirectory() as tmp:
        keys_file = Path(tmp) / "keys.txt"
        keys_file.write_text("hf_test\n")
        original_store = pa.key_store
        original_hf = pa.hf_client
        original_nvidia = pa.nvidia_client
        original_fallback = pa.fallback_manager
        try:
            pa.key_store = pa.KeyStore(str(keys_file), reload_seconds=5)
            import asyncio
            asyncio.run(pa.key_store.load(force=True))
            pa.hf_client = CaptureHFClient()
            pa.nvidia_client = FakeNvidia()
            import logging
            pa.fallback_manager = pa.FallbackManager(logging.getLogger("test"))

            import asyncio
            response = asyncio.run(pa.handle_non_stream(
                "test-model",
                {
                    "model": "test-model",
                    "messages": [
                        {"role": "system", "content": "You are Claude Code, Anthropic's official CLI. " * 20},
                        {"role": "user", "content": "hello"},
                    ],
                    "stream": False,
                },
            ))
            assert response.status_code == 200
            # The forwarded payload must NOT contain the Anthropic system prompt.
            forwarded = captured["messages"]
            assert forwarded[0]["role"] == "system"
            assert "Claude Code" not in forwarded[0]["content"]
            assert "Anthropic" not in forwarded[0]["content"]
            # User message preserved.
            assert forwarded[1]["content"] == "hello"
        finally:
            pa.key_store = original_store
            pa.hf_client = original_hf
            pa.nvidia_client = original_nvidia
            pa.fallback_manager = original_fallback


def main() -> None:
    test_replace_swaps_system_message()
    test_strip_removes_system_message()
    test_passthrough_leaves_it_alone()
    test_no_system_message_is_noop()
    test_unknown_strategy_falls_back_to_passthrough()
    test_custom_replacement_text_env()
    test_rewriter_hooked_in_handlers()
    print("system rewriter test passed")


if __name__ == "__main__":
    main()