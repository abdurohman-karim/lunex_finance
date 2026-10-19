import html
import json
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Optional


DEFAULT_CURRENCY = {
    "code": "UZS",
    "name": "Uzbekistan Som",
    "symbol": "сум",
    "is_default": True,
}

ZERO_DECIMAL_CURRENCIES = {"UZS", "JPY", "KRW"}
MAX_AMOUNT = Decimal("1000000000000")


def escape_html(value) -> str:
    if value is None:
        return ""
    return html.escape(str(value), quote=False)


def clean_text(text, max_len: int = 120) -> str:
    if text is None:
        return ""
    if not isinstance(text, str):
        try:
            if isinstance(text, dict):
                lines = []
                for key, value in text.items():
                    if isinstance(value, (dict, list)):
                        value = json.dumps(value, ensure_ascii=False)
                    else:
                        value = "" if value is None else str(value)
                    if key:
                        lines.append(f"{key}\n{value}".strip())
                    elif value:
                        lines.append(str(value))
                text = "\n".join([line for line in lines if line])
            elif isinstance(text, list):
                text = "\n".join([str(item) for item in text if item is not None])
            else:
                text = str(text)
        except Exception:
            text = str(text)
    if not text:
        return ""
    text = text.strip()
    return text if len(text) <= max_len else text[: max_len - 1] + "…"


def safe_html_text(text, max_len: int | None = None) -> str:
    return escape_html(clean_text(text, max_len or 10000))


def normalize_currency(currency: dict | None) -> dict:
    merged = dict(DEFAULT_CURRENCY)
    if isinstance(currency, dict):
        merged.update({k: v for k, v in currency.items() if v not in (None, "")})
    merged["code"] = str(merged.get("code") or DEFAULT_CURRENCY["code"]).upper()
    return merged


def currency_code(currency: dict | None) -> str:
    return normalize_currency(currency)["code"]


def currency_has_decimals(currency: dict | None) -> bool:
    return currency_code(currency) not in ZERO_DECIMAL_CURRENCIES


def currency_label(currency: dict | None) -> str:
    current = normalize_currency(currency)
    symbol = current.get("symbol") or current["code"]
    return f"{current['code']} ({symbol})" if symbol != current["code"] else current["code"]


def _detect_decimal_separator(raw: str) -> str | None:
    comma_pos = raw.rfind(",")
    dot_pos = raw.rfind(".")
    if comma_pos == -1 and dot_pos == -1:
        return None

    if comma_pos != -1 and dot_pos != -1:
        return "," if comma_pos > dot_pos else "."

    separator = "," if comma_pos != -1 else "."
    parts = raw.split(separator)
    if len(parts) <= 1:
        return None

    tail_len = len(parts[-1])
    if tail_len in (1, 2):
        return separator

    if tail_len == 3 and all(len(part) == 3 for part in parts[1:]):
        return None

    return separator


def parse_amount(text: str, currency: dict | None = None) -> Optional[int | float]:
    raw = (text or "").strip().replace(" ", "")
    if not raw or raw.startswith("-"):
        return None

    decimal_separator = _detect_decimal_separator(raw)
    has_decimals = currency_has_decimals(currency)

    if decimal_separator and not has_decimals:
        return None

    normalized = raw
    if decimal_separator:
        thousands_sep = "," if decimal_separator == "." else "."
        normalized = normalized.replace(thousands_sep, "")
        normalized = normalized.replace(decimal_separator, ".")
    else:
        normalized = normalized.replace(",", "").replace(".", "")

    if not re.fullmatch(r"\d+(\.\d{1,2})?", normalized):
        return None

    try:
        value = Decimal(normalized)
    except InvalidOperation:
        return None

    if value <= 0 or value > MAX_AMOUNT:
        return None

    if not has_decimals:
        if value != value.to_integral_value():
            return None
        return int(value)

    quantized = value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return int(quantized) if quantized == quantized.to_integral_value() else float(quantized)


def to_float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def to_int(value, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def format_amount(value, currency: dict | None = None, with_currency: bool = True, sign: str | None = None) -> str:
    try:
        number = to_float(value)
    except Exception:
        return "—"

    current = normalize_currency(currency)
    code = current["code"]
    symbol = current.get("symbol") or code
    symbol_position = "prefix" if symbol in {"$", "€", "£", "¥"} else "suffix"
    decimals = 0 if code in ZERO_DECIMAL_CURRENCIES else 2

    formatted = f"{abs(number):,.{decimals}f}"
    if symbol_position == "suffix":
        formatted = formatted.replace(",", " ")

    if decimals == 0:
        formatted = formatted.split(".")[0]

    if sign in {"+", "-"}:
        formatted = f"{sign}{formatted}"
    elif number < 0:
        formatted = f"-{formatted}"

    if not with_currency:
        return formatted

    return f"{symbol}{formatted}" if symbol_position == "prefix" else f"{formatted} {symbol}"


def format_date(date_str: str) -> str:
    if not date_str:
        return "—"
    try:
        dt = datetime.strptime(date_str[:10], "%Y-%m-%d")
        return dt.strftime("%d.%m.%Y")
    except ValueError:
        return date_str


def format_datetime(dt_str: str) -> str:
    if not dt_str:
        return ""
    try:
        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        return dt.strftime("%d.%m.%Y %H:%M")
    except ValueError:
        return dt_str
