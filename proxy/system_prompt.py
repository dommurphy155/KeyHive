"""System prompt override — replaces harness-injected system messages."""

from pathlib import Path

OVERRIDE_PATH = Path(__file__).resolve().parents[1] / "data" / "system_prompt_override.txt"


def _read_override() -> str | None:
    """Read the override file. Returns None if empty or missing."""
    try:
        text = OVERRIDE_PATH.read_text(encoding="utf-8").strip()
        return text if text else None
    except FileNotFoundError:
        return None


def replace_system_prompt(body: dict, provider: str = "openai") -> dict:
    """Replace all system-role messages with the override file content.

    Mutates body in-place and returns it.
    - OpenAI format: messages with role "system"
    - Anthropic format: top-level "system" field
    """
    override = _read_override()
    if not override:
        return body

    if provider == "anthropic":
        body["system"] = override
    else:
        messages = body.get("messages", [])
        if isinstance(messages, list):
            for msg in messages:
                if isinstance(msg, dict) and msg.get("role") == "system":
                    msg["content"] = override
    return body
