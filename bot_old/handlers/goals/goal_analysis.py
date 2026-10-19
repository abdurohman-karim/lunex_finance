from aiogram import Router, types, F
from aiogram.utils.keyboard import InlineKeyboardBuilder

from rpc import rpc, RPCError, RPCTransportError
from keyboards.keyboards import back_button
from i18n import t
from utils.telegram import safe_edit_text
from utils.ui import safe_html_text, to_float

router = Router()


def back_to_goal_keyboard(goal_id: int, lang: str | None = None):
    kb = InlineKeyboardBuilder()
    kb.button(text=t("common.back", lang), callback_data=f"goal_manage_{goal_id}")
    kb.adjust(1)
    return kb.as_markup()


@router.callback_query(F.data.startswith("analyze_goal_"))
async def analyze_goal(cb: types.CallbackQuery, lang: str | None = None):
    goal_id = int(cb.data.split("_")[-1])
    user_id = cb.from_user.id

    await cb.answer(t("goals.analysis.loading", lang))

    try:
        ai = await rpc("ai.goal.analysis", {
            "tg_user_id": user_id,
            "goal_id": goal_id
        })
    except RPCTransportError:
        await safe_edit_text(
            cb.message,
            t("goals.analysis.error.service_unavailable", lang),
            reply_markup=back_button(lang)
        )
        return
    except RPCError:
        await safe_edit_text(
            cb.message,
            t("goals.analysis.error.failed", lang),
            reply_markup=back_button(lang)
        )
        return

    summary = safe_html_text(ai.get("summary", t("goals.analysis.no_data", lang)), 700)
    recommendation = safe_html_text(ai.get("recommendation", t("goals.analysis.no_recommendations", lang)), 500)
    numbers = ai.get("numbers", {}) or {}
    score = numbers.get("score") or numbers.get("progress_percent")

    if score is not None:
        score_float = to_float(score)
        if score_float <= 1:
            score_value = round(score_float * 100)
        else:
            score_value = round(score_float)
    else:
        score_value = None

    score_text = t("goals.analysis.score", lang, score=score_value) if score_value is not None else ""

    text = (
        f"{t('goals.analysis.title', lang)}\n\n"
        f"{t('goals.analysis.summary_title', lang)}\n{summary}\n\n"
        f"{t('goals.analysis.recommendation_title', lang)}\n{recommendation}\n\n"
        f"{score_text}"
    )

    await safe_edit_text(cb.message, text, reply_markup=back_to_goal_keyboard(goal_id, lang))
