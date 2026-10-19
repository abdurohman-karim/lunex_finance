# handlers/progress.py
from aiogram import Router, types, F

from rpc import rpc, RPCError, RPCTransportError
from keyboards.keyboards import back_button
from utils.ui import format_amount, safe_html_text, to_float
from ui.formatting import header, SEPARATOR
from i18n import t
from utils.telegram import safe_edit_text

router = Router()


@router.callback_query(F.data == "menu_progress")
async def menu_progress(cb: types.CallbackQuery, lang: str | None = None, currency: dict | None = None):
    user_id = cb.from_user.id

    try:
        res = await rpc("goal.list", {"tg_user_id": user_id})
    except (RPCError, RPCTransportError):
        await safe_edit_text(
            cb.message,
            t("progress.error", lang),
            reply_markup=back_button(lang)
        )
        return await cb.answer()

    goals = res.get("goals", [])
    if not goals:
        await safe_edit_text(
            cb.message,
            t("progress.empty", lang),
            reply_markup=back_button(lang)
        )
        return await cb.answer()

    text = header(t("progress.title", lang), "insights") + "\n\n"

    for g in goals:
        total = to_float(g.get("amount_total", 0))
        saved = to_float(g.get("amount_saved", 0))
        percent = int(saved / total * 100) if total else 0

        text += (
            f"🎯 <b>{safe_html_text(g.get('title') or '—', 120)}</b>\n"
            f"💰 {t('label.saved', lang)}: <b>{format_amount(saved, currency=g.get('currency') or currency)}</b> / {format_amount(total, currency=g.get('currency') or currency)}\n"
            f"📈 {t('label.progress', lang)}: <b>{percent}%</b>\n"
            f"{SEPARATOR}\n"
        )

    await safe_edit_text(
        cb.message,
        text,
        reply_markup=back_button(lang)
    )
    await cb.answer()
