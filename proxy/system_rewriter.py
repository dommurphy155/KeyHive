from __future__ import annotations

import logging
import os
from typing import Any

# Rewrites the system message before the proxy forwards a request upstream.
#
# Why this exists: Claude Code bolts a large Anthropic-authored system prompt
# onto every request client-side ("You are Claude Code, Anthropic's official
# CLI...", the # Harness rules, # Environment, # Memory, gitStatus, etc). The
# upstream model is GLM-5.2, not Claude, so that prompt is both token-expensive
# and aimed at the wrong model. The proxy is the single chokepoint every
# request passes through, so this is the place to reshape it.
#
# The rewriter only ever touches messages[0] when role == "system". User,
# assistant, and tool messages are passed through untouched.

logger = logging.getLogger("keyhive-proxy")

# Strategy selection via env so the behaviour can change without a code edit.
#   replace  -> swap in SYSTEM_REPLACEMENT_TEXT (default: a compact GLM-targeted
#              system prompt). Biggest token win; most opinionated.
#   strip    -> drop the system message entirely.
#   passthrough -> leave it alone (disables the rewriter).
REWRITE_STRATEGY = os.getenv("KEYHIVE_SYSTEM_REWRITE", "replace").strip().lower()

# Compact replacement system prompt tuned for a coding agent on GLM-5.2.
DEFAULT_REPLACEMENT = (
    "You are an autonomous coding agent with shell, filesystem, and tool access. "
    "Execute the user's task precisely. Use tools to inspect and modify the codebase; "
    "prefer dedicated file/search tools over shell commands when one fits. "
    "Reference code as file_path:line_number. "
    "Write code that matches the surrounding style. "
    "For destructive or hard-to-reverse actions, confirm first unless told to proceed. "
    "Report outcomes faithfully: say when tests fail or a step was skipped. "
    "Be direct and concise."
)

REPLACEMENT_TEXT = os.getenv("KEYHIVE_SYSTEM_TEXT", DEFAULT_REPLACEMENT)


def _first_system_index(messages: list[dict[str, Any]]) -> int:
    # The system message is conventionally messages[0], but be defensive: some
    # clients interleave or omit it. Rewrite the first system-role message only.
    for i, msg in enumerate(messages):
        if isinstance(msg, dict) and msg.get("role") == "system":
            return i
    return -1


def rewrite_system(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # Returns a new message list with the system message reshaped per strategy.
    # Never mutates the caller's list in place.
    if not isinstance(messages, list) or not messages:
        return messages

    idx = _first_system_index(messages)
    if idx < 0:
        # No system message to rewrite; nothing to do.
        return messages

    if REWRITE_STRATEGY == "passthrough":
        return messages

    original_len = 0
    msg = messages[idx]
    if isinstance(msg.get("content"), str):
        original_len = len(msg["content"])
    elif isinstance(msg.get("content"), list):
        original_len = sum(
            len(str(b.get("text") or ""))
            for b in msg["content"]
            if isinstance(b, dict) and b.get("type") == "text"
        )

    if REWRITE_STRATEGY == "strip":
        new_messages = [m for i, m in enumerate(messages) if i != idx]
        logger.info(
            "[PROXY] system rewrite (strip): removed %s-char system message, %s messages remain",
            original_len,
            len(new_messages),
        )
        return new_messages

    if REWRITE_STRATEGY == "replace":
        new_messages = list(messages)
        new_messages[idx] = {"role": "system", "content": REPLACEMENT_TEXT}
        logger.info(
            "[PROXY] system rewrite (replace): %s-char system message -> %s chars",
            original_len,
            len(REPLACEMENT_TEXT),
        )
        return new_messages

    # Unknown strategy falls back to passthrough so a bad env value can't break
    # requests — log it so it's visible.
    logger.warning(
        "[PROXY] unknown KEYHIVE_SYSTEM_REWRITE=%r; leaving system message untouched",
        REWRITE_STRATEGY,
    )
    return messages