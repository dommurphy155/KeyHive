import json

import pytest

from proxy.openai_compat import (
    anthropic_openai_payload,
    normalize_messages,
    openai_response_from_router,
    openai_response_to_anthropic,
)


def test_normalize_messages_preserves_openai_tool_protocol() -> None:
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
    with pytest.raises(ValueError, match="messages must be a non-empty array"):
        anthropic_openai_payload({"messages": []}, "model")
