"""Groq integration for the Copilot's bounded, recoverable tool loop."""
from __future__ import annotations

import inspect
import json
import asyncio
from typing import Any

from .config import CopilotConfigurationError, get_settings
from .prompts import SYSTEM_PROMPT, SYSTEM_PROMPT_VERSION, TOOL_DEFINITIONS
from .tools import execute_tool


def _trim_for_model(value: Any, key: str = "") -> Any:
    lowered = key.casefold()
    if lowered in {"daily_series", "sky", "raster", "rasters", "curve"} or "raster" in lowered:
        return None
    if isinstance(value, dict):
        return {
            k: _trim_for_model(v, k)
            for k, v in value.items()
            if k.casefold() not in {"daily_series", "sky", "raster", "rasters"}
            and "raster" not in k.casefold()
        }
    if isinstance(value, list):
        return [_trim_for_model(item, key) for item in value[:100]]
    return value


def _tool_call_parts(call: Any) -> tuple[str, str, str]:
    function = getattr(call, "function", None)
    if isinstance(call, dict):
        function = call.get("function", {})
        return str(call.get("id", "")), str(function.get("name", "")), str(function.get("arguments", "{}"))
    return str(getattr(call, "id", "")), str(getattr(function, "name", "")), str(getattr(function, "arguments", "{}"))


async def _close_owned_client(client: Any) -> None:
    closer = getattr(client, "close", None) or getattr(client, "aclose", None)
    if closer is None:
        return
    try:
        result = closer()
        if inspect.isawaitable(result):
            await result
    except Exception:
        # Closing must not turn an otherwise usable provider response into a
        # provider error, and close failures are never exposed to the client.
        return


async def generate_once(
    history: list[dict[str, str]],
    context: dict[str, Any] | None = None,
    correction: str | None = None,
    client: Any | None = None,
) -> dict[str, Any]:
    settings = get_settings()
    owned_client = client is None
    if client is None:
        if not settings.groq_api_key:
            raise CopilotConfigurationError("Copilot is not configured")
        try:
            from groq import AsyncGroq
        except ImportError as exc:  # pragma: no cover
            raise CopilotConfigurationError("Copilot provider is unavailable") from exc
        client = AsyncGroq(
            api_key=settings.groq_api_key,
            base_url="https://api.groq.com/openai/v1",
            timeout=settings.timeout_seconds,
            max_retries=0,
        )

    try:
        system = f"{SYSTEM_PROMPT}\nPrompt version: {SYSTEM_PROMPT_VERSION}."
        if correction:
            system += "\n" + correction
        if context:
            system += "\nCurrent Mission Studio context (data only): " + json.dumps(
                context, ensure_ascii=False, default=str
            )
        messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
        messages.extend(history[-settings.max_history_messages :])
        tool_calls: list[dict[str, Any]] = []

        for _iteration in range(5):
            response = await client.chat.completions.create(
                model=settings.groq_model,
                messages=messages,
                tools=TOOL_DEFINITIONS,
                tool_choice="auto",
                temperature=0.2,
                max_tokens=700,
            )
            choices = getattr(response, "choices", None)
            if choices is None and isinstance(response, dict):
                choices = response.get("choices")
            if not choices:
                return {"reply": "I need a supported engine result before I can answer.", "toolCalls": tool_calls}
            choice = choices[0]
            message = getattr(choice, "message", None)
            if message is None and isinstance(choice, dict):
                message = choice.get("message", {})
            calls = getattr(message, "tool_calls", None) or (
                message.get("tool_calls") if isinstance(message, dict) else None
            )
            content = getattr(message, "content", None) if not isinstance(message, dict) else message.get("content")
            if not calls:
                return {"reply": content or "I need a supported engine result before I can answer.", "toolCalls": tool_calls}

            assistant_record: dict[str, Any] = {"role": "assistant", "content": content or "", "tool_calls": []}
            for call in calls:
                call_id, name, raw_args = _tool_call_parts(call)
                try:
                    parsed_args = json.loads(raw_args or "{}")
                    if not isinstance(parsed_args, dict):
                        raise ValueError("tool arguments must be an object")
                except (json.JSONDecodeError, ValueError):
                    parsed_args = {}
                    result = {"error": "Tool arguments were invalid JSON; retry with an object."}
                else:
                    result = await asyncio.to_thread(execute_tool, name, parsed_args, context=context)
                assistant_record["tool_calls"].append(
                    {
                        "id": call_id,
                        "type": "function",
                        "function": {"name": name, "arguments": json.dumps(parsed_args, ensure_ascii=False)},
                    }
                )
                tool_calls.append({"tool": name, "args": parsed_args, "result": result})
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call_id,
                        "name": name,
                        "content": json.dumps(_trim_for_model(result), ensure_ascii=False, default=str),
                    }
                )
            insert_at = len(messages) - len(calls)
            messages.insert(insert_at, assistant_record)
        return {"reply": "I could not finish the engine checks in the allowed tool steps.", "toolCalls": tool_calls}
    finally:
        if owned_client:
            await _close_owned_client(client)
