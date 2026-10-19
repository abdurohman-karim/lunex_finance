# handlers/budget.py
from aiogram import Router, types, F

from rpc import rpc, RPCError, RPCTransportError
from keyboards.keyboards import back_button
from ui.formatting import header, money_line
from i18n import t
from utils.dates import current_month
from utils.telegram import safe_edit_text
from utils.ui import escape_html, to_float

router = Router()


@router.callback_query(F.data == "menu_budget")
async def show_budget(cb: types.CallbackQuery, lang: str | None = None, currency: dict | None = None):
    try:
        budget = await rpc("budget.recalculate", {
            "tg_user_id": cb.from_user.id,
            "month": current_month(),
        })
    except RPCTransportError:
        await safe_edit_text(
            cb.message,
            t("budget.error.service_unavailable", lang),
            reply_markup=back_button(lang)
        )
        return await cb.answer()
    except RPCError:
        await safe_edit_text(
            cb.message,
            t("budget.error.failed", lang),
            reply_markup=back_button(lang)
        )
        return await cb.answer()

    income = to_float(budget.get("income", 0))
    expenses = to_float(budget.get("expenses", 0))
    daily_limit = to_float(budget.get("recommended_daily_limit", 0))
    budget_currency = budget.get("currency") or currency

    text = (
        header(t("budget.title", lang, month=escape_html(budget.get("month") or current_month())), "budget")
        + "\n\n"
        + money_line(t("label.budget_incomes", lang), income, "income", currency=budget_currency)
        + "\n"
        + money_line(t("label.budget_expenses", lang), expenses, "expense", currency=budget_currency)
        + "\n"
        + money_line(t("label.daily_limit", lang), daily_limit, "progress", currency=budget_currency)
        + "\n\n"
        + t("budget.footer", lang)
    )

    await safe_edit_text(
        cb.message,
        text,
        reply_markup=back_button(lang)
    )
    await cb.answer()
