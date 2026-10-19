import asyncio
import httpx
import logging

from config import (
    RPC_URL,
    RPC_TOKEN,
    TELEGRAM_BOT_SECRET,
    TELEGRAM_REGISTER_URL,
    TELEGRAM_STATUS_URL,
    TELEGRAM_SET_LANGUAGE_URL,
)
from utils.privacy import sanitize_log_payload


class RPCError(RuntimeError):
    """
    Ошибка прикладного уровня (jsonrpc.error).
    """

    def __init__(self, error: dict):
        self.error = error
        message = error.get("message") or "RPC error"
        code = error.get("code")
        super().__init__(f"{message} (code={code})")


class RPCTransportError(RuntimeError):
    """
    Ошибка сети / HTTP.
    """


class RegistrationError(RuntimeError):
    """
    Ошибка регистрации телефона.
    """

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


_HTTP_CLIENT: httpx.AsyncClient | None = None
_HTTP_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=10.0, pool=5.0)
_RETRYABLE_STATUS_CODES = {429, 502, 503, 504}
_RETRYABLE_RPC_METHODS = {
    "budget.getMonth",
    "budget.recalculate",
    "currency.get",
    "currency.list",
    "goal.get",
    "goal.list",
    "transaction.getDaily",
}


def _base_headers() -> dict:
    headers = {
        "Authorization": f"Bearer {RPC_TOKEN}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    if TELEGRAM_BOT_SECRET:
        headers["X-Telegram-Bot-Secret"] = TELEGRAM_BOT_SECRET

    return headers


async def _get_http_client() -> httpx.AsyncClient:
    global _HTTP_CLIENT
    if _HTTP_CLIENT is None or _HTTP_CLIENT.is_closed:
        _HTTP_CLIENT = httpx.AsyncClient(timeout=_HTTP_TIMEOUT)
    return _HTTP_CLIENT


async def close_http_client() -> None:
    global _HTTP_CLIENT
    if _HTTP_CLIENT is not None and not _HTTP_CLIENT.is_closed:
        await _HTTP_CLIENT.aclose()
    _HTTP_CLIENT = None


def _should_retry_rpc_method(method: str) -> bool:
    return method.startswith("ai.") or method in _RETRYABLE_RPC_METHODS


async def _post_json(
    url: str,
    payload: dict,
    *,
    action: str,
    allow_retry: bool = False,
) -> tuple[httpx.Response, dict]:
    attempts = 2 if allow_retry else 1
    safe_payload = sanitize_log_payload(payload)
    last_exc: Exception | None = None

    for attempt in range(1, attempts + 1):
        try:
            client = await _get_http_client()
            resp = await client.post(
                url,
                json=payload,
                headers=_base_headers(),
            )
        except httpx.RequestError as exc:
            last_exc = exc
            logging.warning(
                "%s transport error attempt=%s payload=%s error=%s",
                action,
                attempt,
                safe_payload,
                exc.__class__.__name__,
            )
            if attempt < attempts:
                await asyncio.sleep(0.3 * attempt)
                continue
            raise RPCTransportError(str(exc))

        if resp.status_code in _RETRYABLE_STATUS_CODES and attempt < attempts:
            logging.warning(
                "%s retryable status=%s attempt=%s payload=%s",
                action,
                resp.status_code,
                attempt,
                safe_payload,
            )
            await asyncio.sleep(0.3 * attempt)
            continue

        try:
            data = resp.json()
        except ValueError:
            logging.error(
                "%s returned non-json response status=%s payload=%s",
                action,
                resp.status_code,
                safe_payload,
            )
            raise RPCTransportError(f"HTTP {resp.status_code}")

        return resp, data

    raise RPCTransportError(str(last_exc) if last_exc else "Request failed")


async def rpc(method: str, params: dict | None = None) -> dict:
    """
    Универсальный вызов JSON-RPC.
    Возвращает УЖЕ result (а не весь JSON-RPC объект).
    В случае ошибки бросает RPCError / RPCTransportError.
    """
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params or {},
    }

    resp, data = await _post_json(
        RPC_URL,
        payload,
        action=f"rpc:{method}",
        allow_retry=_should_retry_rpc_method(method),
    )

    if resp.status_code >= 400:
        if "error" in data and data["error"]:
            error = data["error"]
            logging.error(
                "RPC logical error method=%s status=%s code=%s",
                method,
                resp.status_code,
                error.get("code"),
            )
            raise RPCError(data["error"])

        logging.error("RPC http error method=%s status=%s", method, resp.status_code)
        raise RPCTransportError(f"HTTP {resp.status_code}")

    logging.debug("RPC success method=%s keys=%s", method, list(data.keys()) if isinstance(data, dict) else type(data).__name__)

    if "error" in data and data["error"]:
        raise RPCError(data["error"])

    result = data.get("result") or data
    return result


async def telegram_register(tg_user_id: int, phone: str, name: str | None = None) -> dict:
    payload = {
        "tg_user_id": tg_user_id,
        "phone": phone,
        "name": name,
    }

    resp, data = await _post_json(
        TELEGRAM_REGISTER_URL,
        payload,
        action="telegram_register",
        allow_retry=False,
    )

    if resp.status_code >= 400 or data.get("status") == "error":
        code = data.get("code") or "registration_failed"
        message = data.get("message") or "Registration failed"
        logging.error(
            "Registration error status=%s code=%s payload=%s",
            resp.status_code,
            code,
            sanitize_log_payload(payload),
        )
        raise RegistrationError(code, message)

    return data


async def telegram_status(tg_user_id: int) -> dict:
    payload = {"tg_user_id": tg_user_id}
    resp, data = await _post_json(
        TELEGRAM_STATUS_URL,
        payload,
        action="telegram_status",
        allow_retry=True,
    )

    if resp.status_code >= 400 or data.get("status") != "ok":
        logging.error(
            "Registration status error status=%s payload=%s",
            resp.status_code,
            sanitize_log_payload(payload),
        )
        raise RPCTransportError(f"HTTP {resp.status_code}")

    return {
        "registered": bool(data.get("registered")),
        "language": data.get("language"),
        "currency": data.get("currency"),
    }


async def telegram_set_language(tg_user_id: int, language: str) -> dict:
    payload = {"tg_user_id": tg_user_id, "language": language}
    resp, data = await _post_json(
        TELEGRAM_SET_LANGUAGE_URL,
        payload,
        action="telegram_set_language",
        allow_retry=True,
    )

    if resp.status_code >= 400 or data.get("status") != "ok":
        logging.error(
            "Set language error status=%s payload=%s",
            resp.status_code,
            sanitize_log_payload(payload),
        )
        raise RPCTransportError(f"HTTP {resp.status_code}")

    return data


async def currency_list(tg_user_id: int) -> list[dict]:
    result = await rpc("currency.list", {"tg_user_id": tg_user_id})
    return result.get("data", []) if isinstance(result, dict) else []


async def currency_get(tg_user_id: int) -> dict | None:
    result = await rpc("currency.get", {"tg_user_id": tg_user_id})
    if not isinstance(result, dict):
        return None
    return result.get("data")


async def currency_set(tg_user_id: int, currency_code: str) -> dict | None:
    result = await rpc("currency.set", {
        "tg_user_id": tg_user_id,
        "currency_code": currency_code,
    })
    if not isinstance(result, dict):
        return None
    return result.get("data")
