from __future__ import annotations

from typing import Any


def mask_phone(phone: str | None) -> str:
    if not phone:
        return ""
    digits = "".join(c for c in str(phone) if c.isdigit())
    if len(digits) <= 4:
        return "***"
    return f"+***{digits[-4:]}"


def mask_token(token: str | None) -> str:
    if not token:
        return ""
    if len(token) <= 8:
        return "***"
    return f"{token[:2]}***{token[-2:]}"


def mask_telegram_id(value: int | str | None) -> str:
    if value is None:
        return ""
    raw = str(value)
    if len(raw) <= 4:
        return "***"
    return f"***{raw[-4:]}"


def sanitize_log_value(value: Any) -> Any:
    if value is None:
        return None

    if isinstance(value, dict):
        return {str(k): sanitize_log_value(v) for k, v in value.items()}

    if isinstance(value, list):
        return [sanitize_log_value(v) for v in value]

    if isinstance(value, tuple):
        return tuple(sanitize_log_value(v) for v in value)

    text = str(value)
    lowered = text.lower()

    if "token" in lowered or "secret" in lowered:
        return mask_token(text)

    return value


def sanitize_log_payload(payload: dict[str, Any] | None) -> dict[str, Any]:
    payload = payload or {}
    safe: dict[str, Any] = {}

    for key, value in payload.items():
        lowered = key.lower()
        if lowered in {"phone", "phone_number"}:
            safe[key] = mask_phone(str(value) if value is not None else None)
        elif lowered in {"authorization", "token", "rpc_token", "bot_token", "secret"}:
            safe[key] = mask_token(str(value) if value is not None else None)
        elif lowered in {"tg_user_id", "telegram_id", "user_id"}:
            safe[key] = mask_telegram_id(value)
        elif lowered in {"name", "description", "summary", "recommendation", "insight", "title"}:
            safe[key] = "<redacted>"
        else:
            safe[key] = sanitize_log_value(value)

    return safe
