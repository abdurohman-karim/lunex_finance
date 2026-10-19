# handlers/smart.py
from aiogram import Router, types, F
from aiogram.fsm.context import FSMContext
from aiogram.utils.keyboard import InlineKeyboardBuilder
import calendar
import time

from rpc import rpc, RPCError, RPCTransportError
from ui.menus import get_main_menu
from ui.formatting import header, money_line, SEPARATOR
from states.smart_save import SmartSaveFallback, SmartSaveConfirm
from utils.ui import format_amount, safe_html_text, escape_html, to_float
from i18n import t
from utils.dates import today_local, current_month
from utils.telegram import safe_edit_text

router = Router()
PREVIEW_TTL_SECONDS = 15 * 60


@router.callback_query(F.data == "menu_smart")
async def smart_save(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None, currency: dict | None = None):
    try:
        res = await rpc("smart.save.run", {
            "tg_user_id": cb.from_user.id,
            "preview": True
        })
    except RPCTransportError:
        await safe_edit_text(
            cb.message,
            t("smart.error.service_unavailable", lang),
            reply_markup=await get_main_menu(cb.from_user.id, lang)
        )
        return await cb.answer()
    except RPCError:
        await safe_edit_text(
            cb.message,
            t("smart.error.failed", lang),
            reply_markup=await get_main_menu(cb.from_user.id, lang)
        )
        return await cb.answer()

    status = res.get("status")
    if status == "preview":
        goal = res.get("goal", {})
        amount = res.get("safe_save")
        active_currency = res.get("currency") or goal.get("currency") or currency
        if not amount or not goal:
            await safe_edit_text(
                cb.message,
                t("smart.status.generic", lang),
                reply_markup=await get_main_menu(cb.from_user.id, lang)
            )
            return await cb.answer()

        await state.set_state(SmartSaveConfirm.waiting_for_confirm)
        await state.update_data(
            amount=amount,
            goal_id=goal.get("id"),
            goal_title=goal.get("title"),
            preview_currency=active_currency,
            preview_token=res.get("preview_token"),
            preview_generated_at=int(time.time()),
        )

        text = (
            header(t("smart.title", lang), "smart")
            + "\n\n"
            + f"💡 {t('smart.confirm.offer', lang, amount=f'<b>{escape_html(format_amount(amount, currency=active_currency))}</b>')}\n"
            + f"🎯 {t('label.goal', lang)}: <b>{safe_html_text(goal.get('title', '—'), 120)}</b>\n"
            + f"{SEPARATOR}\n"
            + f"{t('smart.confirm.note', lang)}\n\n"
            + t("smart.confirm.question", lang)
        )

        await safe_edit_text(cb.message, text, reply_markup=smart_confirm_keyboard(lang))
        return await cb.answer()

    if status not in {"ok", "success"}:
        if status in {"no_spare_money", "too_small", "no_budget"}:
            fallback = await build_fallback_smart_save(cb.from_user.id, res, lang)
            if fallback:
                await state.set_state(SmartSaveFallback.waiting_for_confirm)
                await state.update_data(
                    amount=fallback["amount"],
                    goal_id=fallback["goal"]["id"],
                    goal_title=fallback["goal"]["title"],
                    preview_currency=fallback.get("currency"),
                    preview_generated_at=int(time.time()),
                )
                await safe_edit_text(
                    cb.message,
                    render_fallback_prompt(fallback, lang),
                    reply_markup=fallback_confirm_keyboard(lang)
                )
                return await cb.answer()

        status_map = {
            "no_goal": t("smart.status.no_goal", lang),
            "no_budget": t("smart.status.no_budget", lang),
            "no_spare_money": t("smart.status.no_spare_money", lang),
            "too_small": t("smart.status.too_small", lang),
            "already_saved": t("smart.status.already_saved", lang),
            "insufficient_balance": t("smart.status.insufficient_balance", lang),
            "goal_completed": t("smart.status.goal_completed", lang),
            "currency_mismatch": t("smart.status.currency_mismatch", lang),
        }
        message = status_map.get(status, t("smart.status.generic", lang))
        await safe_edit_text(
            cb.message,
            f"ℹ️ {message}",
            reply_markup=await get_main_menu(cb.from_user.id, lang)
        )
        return await cb.answer()

    goal = res.get("goal", {})
    deposited = res.get("deposited") or res.get("safe_save")
    progress = res.get("goal_progress") or goal.get("progress", 0)

    text = (
        header(t("smart.title", lang), "smart")
        + "\n\n"
        + money_line(t("smart.saved_label", lang), deposited, "income", currency=res.get("currency") or goal.get("currency") or currency)
        + "\n"
        + t(
            "smart.success.progress_line",
            lang,
            title=safe_html_text(goal.get("title", "—"), 120),
            progress=escape_html(progress),
        )
        + "\n\n"
        + t("smart.success.footer", lang)
    )

    await safe_edit_text(cb.message, text, reply_markup=await get_main_menu(cb.from_user.id, lang))
    await cb.answer()


def fallback_confirm_keyboard(lang: str | None = None):
    kb = InlineKeyboardBuilder()
    kb.button(text=t("smart.fallback.button_confirm", lang), callback_data="smart_fallback_confirm")
    kb.button(text=t("common.cancel", lang), callback_data="menu_cancel")
    kb.adjust(1)
    return kb.as_markup()


def smart_confirm_keyboard(lang: str | None = None):
    kb = InlineKeyboardBuilder()
    kb.button(text=t("smart.confirm.button", lang), callback_data="smart_confirm")
    kb.button(text=t("common.cancel", lang), callback_data="menu_cancel")
    kb.adjust(1)
    return kb.as_markup()


def render_fallback_prompt(data: dict, lang: str | None = None) -> str:
    amount = data["amount"]
    goal = data["goal"]
    note = data["note"]
    active_currency = data.get("currency") or goal.get("currency")

    return (
        header(t("smart.title", lang), "smart")
        + "\n\n"
        + f"💡 {t('smart.fallback.offer', lang, amount=f'<b>{escape_html(format_amount(amount, currency=active_currency))}</b>')}\n"
        + f"🎯 {t('label.goal', lang)}: <b>{safe_html_text(goal.get('title', '—'), 120)}</b>\n"
        + f"{SEPARATOR}\n"
        + f"{note}\n\n"
        + t("smart.fallback.confirm", lang)
    )


@router.callback_query(SmartSaveFallback.waiting_for_confirm, F.data == "smart_fallback_confirm")
async def smart_fallback_confirm(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None, currency: dict | None = None):
    data = await state.get_data()
    amount = data.get("amount")
    goal_id = data.get("goal_id")
    generated_at = int(data.get("preview_generated_at") or 0)

    if not amount or not goal_id or not generated_at:
        await state.clear()
        await safe_edit_text(
            cb.message,
            t("smart.fallback.error.retry", lang),
            reply_markup=await get_main_menu(cb.from_user.id, lang)
        )
        return await cb.answer()

    if time.time() - generated_at > PREVIEW_TTL_SECONDS:
        await state.clear()
        await safe_edit_text(
            cb.message,
            t("smart.confirm.expired", lang),
            reply_markup=await get_main_menu(cb.from_user.id, lang)
        )
        return await cb.answer()

    try:
        result = await rpc("goal.deposit", {
            "tg_user_id": cb.from_user.id,
            "goal_id": goal_id,
            "amount": amount,
            "method": "smart_fallback"
        })
    except (RPCError, RPCTransportError):
        await state.clear()
        await safe_edit_text(
            cb.message,
            t("smart.fallback.error.failed", lang),
            reply_markup=await get_main_menu(cb.from_user.id, lang)
        )
        return await cb.answer()

    goal = result.get("result") or result
    text = (
        header(t("smart.title", lang), "smart")
        + "\n\n"
        + money_line(t("smart.saved_label", lang), amount, "income", currency=goal.get("currency") or currency)
        + "\n"
        + f"🎯 {t('label.goal', lang)}: <b>{safe_html_text(goal.get('title', '—'), 120)}</b>\n"
        + f"📊 {t('label.progress', lang)}: <b>{escape_html(goal.get('progress', 0))}%</b>\n\n"
        + t("smart.fallback.success", lang)
    )

    await state.clear()
    await safe_edit_text(cb.message, text, reply_markup=await get_main_menu(cb.from_user.id, lang))
    await cb.answer(t("common.done", lang))


@router.callback_query(SmartSaveConfirm.waiting_for_confirm, F.data == "smart_confirm")
async def smart_confirm(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None, currency: dict | None = None):
    data = await state.get_data()
    amount = data.get("amount")
    goal_id = data.get("goal_id")
    preview_currency = data.get("preview_currency") or currency
    preview_token = data.get("preview_token")
    generated_at = int(data.get("preview_generated_at") or 0)

    if not amount or not goal_id or not generated_at:
        await state.clear()
        await safe_edit_text(
            cb.message,
            t("smart.confirm.error.retry", lang),
            reply_markup=await get_main_menu(cb.from_user.id, lang)
        )
        return await cb.answer()

    if time.time() - generated_at > PREVIEW_TTL_SECONDS:
        await state.clear()
        await safe_edit_text(
            cb.message,
            t("smart.confirm.expired", lang),
            reply_markup=await get_main_menu(cb.from_user.id, lang)
        )
        return await cb.answer()

    await state.set_state(SmartSaveConfirm.processing)
    await safe_edit_text(
        cb.message,
        t("smart.confirm.processing", lang),
        reply_markup=None
    )
    await cb.answer()

    try:
        res = await rpc("smart.save.run", {
            "tg_user_id": cb.from_user.id,
            "preview_token": preview_token,
            "expected_goal_id": goal_id,
            "expected_amount": amount,
        })
    except (RPCError, RPCTransportError):
        await state.clear()
        await safe_edit_text(
            cb.message,
            t("smart.error.failed", lang),
            reply_markup=await get_main_menu(cb.from_user.id, lang)
        )
        return

    status = res.get("status")
    if status == "already_saved":
        await state.clear()
        await safe_edit_text(
            cb.message,
            f"ℹ️ {t('smart.status.already_saved', lang)}",
            reply_markup=await get_main_menu(cb.from_user.id, lang)
        )
        return

    if status == "insufficient_balance":
        await state.clear()
        await safe_edit_text(
            cb.message,
            f"ℹ️ {t('smart.status.insufficient_balance', lang)}",
            reply_markup=await get_main_menu(cb.from_user.id, lang)
        )
        return

    if status == "goal_completed":
        await state.clear()
        await safe_edit_text(
            cb.message,
            f"ℹ️ {t('smart.status.goal_completed', lang)}",
            reply_markup=await get_main_menu(cb.from_user.id, lang)
        )
        return

    if status == "currency_mismatch":
        await state.clear()
        await safe_edit_text(
            cb.message,
            f"ℹ️ {t('smart.status.currency_mismatch', lang)}",
            reply_markup=await get_main_menu(cb.from_user.id, lang)
        )
        return

    if status not in {"ok", "success"}:
        await state.clear()
        await safe_edit_text(
            cb.message,
            t("smart.error.failed", lang),
            reply_markup=await get_main_menu(cb.from_user.id, lang)
        )
        return

    goal = res.get("goal", {})
    deposited = res.get("deposited") or res.get("safe_save") or amount
    progress = res.get("goal_progress") or goal.get("progress", 0)
    actual_goal_id = goal.get("id")

    if (
        actual_goal_id is not None and actual_goal_id != goal_id
    ) or abs(to_float(deposited) - to_float(amount)) > 0.009:
        await state.clear()
        await safe_edit_text(
            cb.message,
            t(
                "smart.confirm.mismatch",
                lang,
                expected_amount=escape_html(format_amount(amount, currency=preview_currency)),
                actual_amount=escape_html(format_amount(deposited, currency=res.get("currency") or goal.get("currency") or preview_currency)),
            ),
            reply_markup=await get_main_menu(cb.from_user.id, lang)
        )
        return await cb.answer()

    text = (
        header(t("smart.title", lang), "smart")
        + "\n\n"
        + money_line(t("smart.saved_label", lang), deposited, "income", currency=res.get("currency") or goal.get("currency") or currency)
        + "\n"
        + t(
            "smart.success.progress_line",
            lang,
            title=safe_html_text(goal.get("title", "—"), 120),
            progress=escape_html(progress),
        )
        + "\n\n"
        + t("smart.success.footer", lang)
    )

    await state.clear()
    await safe_edit_text(cb.message, text, reply_markup=await get_main_menu(cb.from_user.id, lang))
    await cb.answer()


async def build_fallback_smart_save(tg_user_id: int, res: dict, lang: str | None = None) -> dict | None:
    today = today_local()
    last_day = calendar.monthrange(today.year, today.month)[1]
    end_of_month = today.replace(day=last_day)
    days_left = (end_of_month - today).days + 1

    balance = None

    daily_limit = to_float(res.get("daily_limit", 0) or 0)
    if res.get("status") in {"no_spare_money", "too_small"} and daily_limit > 0:
        return None

    try:
        budget = await rpc("budget.recalculate", {
            "tg_user_id": tg_user_id,
            "month": current_month(),
        })
        income = to_float(budget.get("income", 0))
        expense = to_float(budget.get("expenses", 0))
        balance = income - expense
    except (RPCError, RPCTransportError):
        return None

    if balance is None or balance <= 0:
        return None

    safe_amount = compute_safe_fallback(balance, days_left)
    if safe_amount <= 0:
        return None

    target_currency = (res.get("currency") or {}).get("code")
    goal = await select_fallback_goal(tg_user_id, target_currency)
    if not goal:
        return None

    note = (
        t("smart.fallback.note.no_budget", lang)
        if res.get("status") == "no_budget"
        else t("smart.fallback.note.balance", lang)
    )

    return {
        "amount": safe_amount,
        "goal": goal,
        "note": note,
        "currency": budget.get("currency") or goal.get("currency"),
    }


async def select_fallback_goal(tg_user_id: int, currency_code: str | None = None) -> dict | None:
    try:
        goals_res = await rpc("goal.list", {"tg_user_id": tg_user_id})
    except (RPCError, RPCTransportError):
        return None

    goals = goals_res.get("goals", [])
    if currency_code:
        goals = [
            goal for goal in goals
            if str(((goal.get("currency") or {}).get("code") or "")).upper() == str(currency_code).upper()
        ]
    if not goals:
        return None

    primary = next((g for g in goals if g.get("is_primary")), None)
    return primary or goals[0]


def compute_safe_fallback(balance: float, days_left: int) -> int:
    days_left = max(1, days_left)
    base = balance / days_left
    safe = round(base * 0.5)
    if safe <= 0:
        return max(1, int(balance))
    # Minimum sensible amount
    if safe < 1000:
        safe = min(int(balance), 1000)
    return int(min(balance, safe))
