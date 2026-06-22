from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any


@dataclass
class FallbackConfig:
    enabled: bool
    provider: str
    enter_at: int
    exit_at: int


class FallbackManager:
    def __init__(self, logger: logging.Logger) -> None:
        self.logger = logger
        self.config = FallbackConfig(
            enabled=os.getenv("KEYHIVE_FALLBACK_ENABLED", "1") == "1",
            provider=os.getenv("KEYHIVE_FALLBACK_PROVIDER", "nvidia"),
            enter_at=int(os.getenv("KEYHIVE_FALLBACK_ENTER_AT", "0")),
            exit_at=int(os.getenv("KEYHIVE_FALLBACK_EXIT_AT", "10")),
        )
        self._provider = "hf"
        self._reason = "Hugging Face key pool is available"
        self._last_logged_provider: str | None = None
        self._nvidia_missing_logged = False

    def evaluate(self, hf_usable_keys: int, nvidia_available: bool) -> str:
        if not self.config.enabled:
            self._set_provider("hf", "fallback disabled", hf_usable_keys)
            return self._provider

        if self.config.provider != "nvidia":
            self._set_provider("hf", f"unsupported fallback provider {self.config.provider}", hf_usable_keys)
            return self._provider

        if not nvidia_available:
            if not self._nvidia_missing_logged:
                self.logger.warning("[PROXY] NVIDIA fallback unavailable: NVDA_KEY missing or invalid")
                self._nvidia_missing_logged = True
            self._set_provider("hf", "NVIDIA fallback unavailable: NVDA_KEY missing or invalid", hf_usable_keys)
            return self._provider

        if self._provider == "nvidia":
            if hf_usable_keys >= self.config.exit_at:
                self._set_provider(
                    "hf",
                    f"hf restored because usable HF key count reached {self.config.exit_at}",
                    hf_usable_keys,
                )
            return self._provider

        if hf_usable_keys <= self.config.enter_at:
            self._set_provider(
                "nvidia",
                f"nvidia fallback because usable HF key count is {hf_usable_keys}",
                hf_usable_keys,
            )
        else:
            self._set_provider("hf", "Hugging Face key pool is available", hf_usable_keys)
        return self._provider

    def current_provider(self) -> str:
        return self._provider

    def should_use_fallback(self) -> bool:
        return self._provider == "nvidia"

    def get_status(self, hf_usable_keys: int, nvidia_available: bool, nvidia_model: str) -> dict[str, Any]:
        return {
            "fallback_enabled": self.config.enabled,
            "current_provider": self._provider,
            "fallback_provider": self.config.provider,
            "fallback_enter_at": self.config.enter_at,
            "fallback_exit_at": self.config.exit_at,
            "hf_usable_keys": hf_usable_keys,
            "nvidia_available": nvidia_available,
            "nvidia_model": nvidia_model,
            "fallback_reason": self._reason,
        }

    def _set_provider(self, provider: str, reason: str, hf_usable_keys: int) -> None:
        changed = provider != self._provider
        self._provider = provider
        self._reason = reason

        if provider == self._last_logged_provider and not changed:
            return
        self._last_logged_provider = provider

        if provider == "hf" and changed:
            self.logger.info(
                "[PROXY] Provider mode: hf restored because usable HF key count reached %s",
                self.config.exit_at,
            )
        elif provider == "nvidia":
            self.logger.info("[PROXY] Provider mode: nvidia fallback because usable HF key count is %s", hf_usable_keys)
        else:
            self.logger.info("[PROXY] Provider mode: hf")
