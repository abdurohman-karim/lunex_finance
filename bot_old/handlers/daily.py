# handlers/daily.py
from aiogram import Router, types, F

from rpc import rpc, RPCError, RPCTransportError
from keyboards.today_menu import today_menu
from utils.ui import format_amount, format_date, format_datetime, safe_html_text, to_float
from ui.formatting import header, money_line, SEPARATOR
from i18n import t
from utils.categories import localize_category
from utils.dates import today_iso
from utils.telegram import safe_edit_text

router = Router()


@router.callback_query(F.data == "menu_today")
async def show_today_transactions(cb: types.CallbackQuery, lang: str | None = None, currency: dict | None = None):
    try:
        stats = await rpc("transaction.getDaily", {
            "tg_user_id": cb.from_user.id,
            "date": today_iso(),
        })
    except RPCTransportError:
        await safe_edit_text(
            cb.message,
            t("daily.error.service_unavailable", lang),
            reply_markup=today_menu(lang)
        )
        return await cb.answer()
    except RPCError:
        await safe_edit_text(
            cb.message,
            t("daily.error.failed", lang),
            reply_markup=today_menu(lang)
        )
        return await cb.answer()

    income = to_float(stats.get("income", 0))
    expense = to_float(stats.get("expense", 0))
    selected_currency = stats.get("currency") or currency
    summary_by_currency = stats.get("summary_by_currency", [])
    items = stats.get("items", [])

    if not items:
        text = (
            header(t("daily.title", lang), "insights")
            + "\n\n"
            + f"{t('daily.date_label', lang)}: <b>{format_date(stats.get('date'))}</b>\n"
            + t("daily.empty", lang)
        )
        await safe_edit_text(cb.message, text, reply_markup=today_menu(lang))
        return await cb.answer()

    balance = income - expense
    text = (
        header(t("daily.title", lang), "insights")
        + "\n\n"
        + f"{t('daily.date_label', lang)}: <b>{format_date(stats.get('date'))}</b>\n"
    )

    if summary_by_currency:
        for group in summary_by_currency:
            group_currency = group.get("currency") or selected_currency
            text += (
                money_line(t("label.income", lang), group.get("income", 0), "income", sign="+", currency=group_currency) + "\n"
                + money_line(t("label.expense", lang), group.get("expense", 0), "expense", sign="-", currency=group_currency) + "\n"
                + money_line(t("label.balance", lang), group.get("balance", 0), "progress", currency=group_currency) + "\n"
                + SEPARATOR + "\n"
            )
    else:
        text += (
            money_line(t("label.income", lang), income, "income", sign="+", currency=selected_currency) + "\n"
            + money_line(t("label.expense", lang), expense, "expense", sign="-", currency=selected_currency) + "\n"
            + SEPARATOR + "\n"
            + money_line(t("label.balance", lang), balance, "progress", currency=selected_currency) + "\n"
        )

    text += "\n" + t("daily.operations", lang) + "\n"

    for item in items:
        amount = to_float(item.get("amount"))
        sign = "➕" if amount > 0 else "➖"
        raw_cat = item.get("category") or t("daily.no_category", lang)
        cat = safe_html_text(localize_category(raw_cat, lang) or raw_cat, 80)
        desc = safe_html_text(item.get("description") or "", 60)
        dt = format_datetime(item.get("datetime") or "")
        amount_text = format_amount(abs(amount), currency=item.get("currency") or selected_currency)
        line = f"{sign} <b>{amount_text}</b> — {cat}"
        if dt:
            line += f" · {dt}"
        if desc:
            line += f" · {desc}"
        text += line + "\n"

    await safe_edit_text(
        cb.message,
        text,
        reply_markup=today_menu(lang)
    )
    await cb.answer()
