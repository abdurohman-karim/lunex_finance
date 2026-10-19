from __future__ import annotations


def _error_text(exc: Exception) -> str:
    return str(exc).lower()


def is_message_not_modified(exc: Exception) -> bool:
    return "message is not modified" in _error_text(exc)


def is_edit_message_error(exc: Exception) -> bool:
    text = _error_text(exc)
    markers = (
        "message can't be edited",
        "message to edit not found",
        "chat not found",
        "message identifier is not specified",
    )
    return any(marker in text for marker in markers)


async def safe_edit_text(message, text: str, reply_markup=None):
    try:
        return await message.edit_text(text, reply_markup=reply_markup)
    except Exception as exc:
        if is_message_not_modified(exc):
            return message
        if is_edit_message_error(exc):
            return await message.answer(text, reply_markup=reply_markup)
        raise


async def safe_edit_message_text(bot, chat_id: int, message_id: int, text: str, reply_markup=None):
    try:
        return await bot.edit_message_text(
            chat_id=chat_id,
            message_id=message_id,
            text=text,
            reply_markup=reply_markup,
        )
    except Exception as exc:
        if is_message_not_modified(exc):
            return None
        if is_edit_message_error(exc):
            return await bot.send_message(chat_id, text, reply_markup=reply_markup)
        raise
