"""
Tool-protocol compatibility tests for proxy/openai_compat.py.

The proxy translates between two different tool-calling formats so a single
Hugging Face / NVIDIA backend can serve both OpenAI-style clients and
Anthropic-style clients (e.g. Claude Code):

  - OpenAI: assistant messages carry a `tool_calls` array; tool results come
    back as `role: "tool"` messages with a `tool_call_id`.
  - Anthropic: assistant messages carry `tool_use` content blocks; tool
    results come back as `tool_result` blocks inside a user message, keyed by
    `tool_use_id`.

These tests pin the round-trip behavior so a refactor of openai_compat.py
cannot silently break tool calling for either client family.
"""

import json

import pytest

from proxy.openai_compat import (
    anthropic_openai_payload,
    normalize_messages,
    openai_response_from_router,
    openai_response_to_anthropic,
)


def test_normalize_messages_preserves_openai_tool_protocol() -> None:
    # A native OpenAI message array should pass through normalization with its
    # tool_calls and tool-result linkage intact — flattening must not strip
    # the protocol fields that downstream tool-using clients depend on.
    messages = normalize_messages(
        [
            {"role": "user", "content": "call the tool"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_123",
                        "type": "function",
                        "function": {"name": "read_file", "arguments": "{\"path\":\"README.md\"}"},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_123", "content": "contents"},
        ]
    )

    assert messages[1]["tool_calls"][0]["function"]["name"] == "read_file"
    assert messages[2] == {"role": "tool", "content": "contents", "tool_call_id": "call_123"}


def test_anthropic_payload_translates_tools_and_results_to_openai() -> None:
    # An Anthropic request (system block, tool_use, tool_result) must be
    # rewritten into the OpenAI shape the upstream provider expects: a system
    # message, an assistant tool_calls entry, a tool-role result, and an
    # OpenAI `tools` schema derived from the Anthropic `input_schema`.
    payload = anthropic_openai_payload(
        {
            "system": [{"type": "text", "text": "Be terse."}],
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "read README"}]},
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "toolu_1",
                            "name": "read_file",
                            "input": {"path": "README.md"},
                        }
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_1",
                            "content": [{"type": "text", "text": "README contents"}],
                        }
                    ],
                },
            ],
            "tools": [
                {
                    "name": "read_file",
                    "description": "Read a file",
                    "input_schema": {
                        "type": "object",
                        "properties": {"path": {"type": "string"}},
                        "required": ["path"],
                    },
                }
            ],
        },
        "zai-org/GLM-5.2",
    )

    assert payload["messages"][0] == {"role": "system", "content": "Be terse."}
    assert payload["messages"][2]["tool_calls"][0]["id"] == "toolu_1"
    assert json.loads(payload["messages"][2]["tool_calls"][0]["function"]["arguments"]) == {"path": "README.md"}
    assert payload["messages"][3] == {"role": "tool", "tool_call_id": "toolu_1", "content": "README contents"}
    assert payload["tools"][0]["function"]["parameters"]["required"] == ["path"]


def test_openai_tool_call_response_translates_to_anthropic_tool_use() -> None:
    # The reverse direction: an OpenAI chat completion that returned tool_calls
    # must be reshaped into an Anthropic message with tool_use content blocks,
    # a tool_use stop reason, and the token usage mapped to Anthropic field
    # names. This is what Claude Code receives back from the proxy.
    openai_payload = openai_response_from_router(
        "zai-org/GLM-5.2",
        {
            "id": "chatcmpl_test",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_abc",
                                "type": "function",
                                "function": {
                                    "name": "write_file",
                                    "arguments": "{\"path\":\"a.txt\",\"content\":\"hi\"}",
                                },
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
            "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5},
        },
    )

    anthropic_payload = openai_response_to_anthropic("claude-sonnet", openai_payload)

    assert anthropic_payload["stop_reason"] == "tool_use"
    assert anthropic_payload["content"] == [
        {
            "type": "tool_use",
            "id": "call_abc",
            "name": "write_file",
            "input": {"path": "a.txt", "content": "hi"},
        }
    ]
    assert anthropic_payload["usage"] == {"input_tokens": 2, "output_tokens": 3}


def test_invalid_anthropic_messages_rejected() -> None:
    # An empty messages array is not a valid request in either protocol, so the
    # translator should reject it up front with a clear ValueError rather than
    # forwarding a malformed payload upstream.
    with pytest.raises(ValueError, match="messages must be a non-empty array"):
        anthropic_openai_payload({"messages": []}, "model")
