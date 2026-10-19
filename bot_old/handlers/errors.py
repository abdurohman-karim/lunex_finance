import logging

from aiogram import Router, types

from i18n import t, normalize_lang

router = Router()


@router.error()
async def global_error_handler(event):
    logging.exception("Unhandled bot error: %s", type(event.exception).__name__)

    update = getattr(event, "update", None)
    callback = getattr(update, "callback_query", None)
    message = getattr(update, "message", None)

    user = None
    if callback is not None:
        user = callback.from_user
    elif message is not None:
        user = message.from_user

    lang = normalize_lang(getattr(user, "language_code", None))
    text = t("common.error.unexpected", lang)

    if callback is not None:
        try:
            await callback.answer(text, show_alert=True)
        except Exception:
            pass
        try:
            await callback.message.answer(text)
        except Exception:
            pass
        return True

    if message is not None:
        try:
            await message.answer(text)
        except Exception:
            pass
        return True

    return True
