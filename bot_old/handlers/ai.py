# handlers/ai.py
from aiogram import Router, types, F

from rpc import rpc, RPCError, RPCTransportError
from keyboards.keyboards import back_button
from ui.formatting import header
from i18n import t
from utils.telegram import safe_edit_text
from utils.ui import safe_html_text

router = Router()


# Legacy callback kept for backward compatibility with older inline messages.
# The current main menu routes users through the Insights section instead.
@router.callback_query(F.data == "menu_daily")
async def ai_daily(cb: types.CallbackQuery, lang: str | None = None):
    try:
        res = await rpc("ai.insight.daily", {
            "tg_user_id": cb.from_user.id
        })
    except RPCTransportError:
        await safe_edit_text(
            cb.message,
            t("ai.daily.error.service_unavailable", lang),
            reply_markup=back_button(lang)
        )
        return await cb.answer()
    except RPCError:
        await safe_edit_text(
            cb.message,
            t("ai.daily.error.failed", lang),
            reply_markup=back_button(lang)
        )
        return await cb.answer()

    insight = res.get("insight")
    if not insight:
        await safe_edit_text(
            cb.message,
            t("ai.daily.error.unavailable", lang),
            reply_markup=back_button(lang)
        )
        return await cb.answer()

    text = header(t("ai.daily.title", lang), "tip") + "\n\n" + safe_html_text(insight, 600)
    await safe_edit_text(cb.message, text, reply_markup=back_button(lang))
    await cb.answer()
    return None
