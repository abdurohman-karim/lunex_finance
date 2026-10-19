from utils.ui import format_amount

SEPARATOR = "━━━━━━━━━━━━━━━━"

EMOJI = {
    "income": "💰",
    "expense": "💸",
    "goal": "🎯",
    "budget": "📅",
    "progress": "📈",
    "insights": "📊",
    "smart": "🤖",
    "tip": "💡",
    "success": "✅",
    "warning": "⚠️",
    "info": "ℹ️",
}


def header(title: str, emoji_key: str | None = None) -> str:
    emoji = EMOJI.get(emoji_key, "") if emoji_key else ""
    prefix = f"{emoji} " if emoji else ""
    return f"{prefix}<b>{title}</b>"


def line(label: str, value: str, emoji_key: str | None = None) -> str:
    emoji = EMOJI.get(emoji_key, "") if emoji_key else ""
    prefix = f"{emoji} " if emoji else ""
    return f"{prefix}{label}: <b>{value}</b>"


def money_line(label: str, amount, emoji_key: str | None = None, sign: str | None = None, currency: dict | None = None) -> str:
    return line(label, format_amount(amount, currency=currency, sign=sign), emoji_key=emoji_key)


def section(title: str, lines: list[str], emoji_key: str | None = None, footer: str | None = None) -> str:
    parts = [header(title, emoji_key), "", *lines]
    if footer:
        parts += [SEPARATOR, footer]
    return "\n".join([p for p in parts if p])


def soft_error(text: str) -> str:
    return f"{EMOJI['warning']} {text}"


def soft_success(text: str) -> str:
    return f"{EMOJI['success']} {text}"
