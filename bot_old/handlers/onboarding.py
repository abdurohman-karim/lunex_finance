# handlers/onboarding.py
from aiogram import Router, types, F
from aiogram.fsm.context import FSMContext
from aiogram.utils.keyboard import InlineKeyboardBuilder

from states.onboarding import OnboardingStates
from ui.menus import get_main_menu
from ui.formatting import header, money_line, SEPARATOR
from rpc import rpc, RPCError, RPCTransportError
from handlers.goals.goal_create import new_goal_start
from handlers.add_income import add_income_start
from handlers.add_transaction import add_start
from i18n import t
from utils.dates import today_iso
from utils.telegram import safe_edit_text
from utils.ui import to_float

router = Router()


def onboarding_start_keyboard(lang: str | None = None):
    kb = InlineKeyboardBuilder()
    kb.button(text=t("onboarding.button.start", lang), callback_data="onb_start")
    kb.button(text=t("onboarding.button.skip", lang), callback_data="onb_skip")
    kb.adjust(2)
    return kb.as_markup()


def onboarding_focus_keyboard(lang: str | None = None):
    kb = InlineKeyboardBuilder()
    kb.button(text=t("onboarding.focus.save", lang), callback_data="onb_focus_save")
    kb.button(text=t("onboarding.focus.track", lang), callback_data="onb_focus_track")
    kb.button(text=t("onboarding.button.skip", lang), callback_data="onb_skip")
    kb.adjust(1)
    return kb.as_markup()


def onboarding_goal_keyboard(lang: str | None = None):
    kb = InlineKeyboardBuilder()
    kb.button(text=t("onboarding.goal.button.create", lang), callback_data="onb_goal_create")
    kb.button(text=t("onboarding.goal.button.skip", lang), callback_data="onb_goal_skip")
    kb.adjust(1)
    return kb.as_markup()


def onboarding_income_keyboard(lang: str | None = None):
    kb = InlineKeyboardBuilder()
    kb.button(text=t("onboarding.income.button.income", lang), callback_data="onb_income_add")
    kb.button(text=t("onboarding.income.button.expense", lang), callback_data="onb_expense_add")
    kb.button(text=t("onboarding.income.button.later", lang), callback_data="onb_finish")
    kb.adjust(1)
    return kb.as_markup()


async def start_onboarding(message: types.Message, state: FSMContext | None = None, lang: str | None = None):
    if state:
        await state.set_state(OnboardingStates.welcome)
    await message.answer(
        header(t("onboarding.start.title", lang), "info")
        + "\n\n"
        + t("onboarding.start.body", lang),
        reply_markup=onboarding_start_keyboard(lang)
    )


@router.callback_query(F.data == "onb_start")
async def onboarding_begin(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None):
    await state.set_state(OnboardingStates.focus)
    await safe_edit_text(
        cb.message,
        header(t("onboarding.focus.title", lang), "info")
        + "\n\n"
        + t("onboarding.focus.body", lang),
        reply_markup=onboarding_focus_keyboard(lang)
    )
    await cb.answer()


@router.callback_query(F.data == "onb_skip")
async def onboarding_skip(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None):
    await state.clear()
    await safe_edit_text(
        cb.message,
        header(t("menu.main.title", lang), None)
        + "\n\n"
        + t("menu.main.subtitle", lang),
        reply_markup=await get_main_menu(cb.from_user.id, lang)
    )
    await cb.answer()


@router.callback_query(F.data.in_(["onb_focus_save", "onb_focus_track"]))
async def onboarding_focus(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None):
    focus = "save" if cb.data == "onb_focus_save" else "track"
    await state.update_data(focus=focus)
    await state.set_state(OnboardingStates.offer_goal)

    title = t("onboarding.goal.title.save", lang) if focus == "save" else t("onboarding.goal.title.track", lang)
    text = (
        header(title, "goal")
        + "\n\n"
        + t("onboarding.goal.body", lang)
    )

    await safe_edit_text(cb.message, text, reply_markup=onboarding_goal_keyboard(lang))
    await cb.answer()


@router.callback_query(F.data == "onb_goal_create")
async def onboarding_goal_create(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None, currency: dict | None = None):
    await state.clear()
    await cb.answer()
    return await new_goal_start(cb, state, lang=lang, currency=currency)


@router.callback_query(F.data == "onb_goal_skip")
async def onboarding_goal_skip(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None):
    await state.set_state(OnboardingStates.offer_income)
    await safe_edit_text(
        cb.message,
        header(t("onboarding.income.title", lang), "info")
        + "\n\n"
        + t("onboarding.income.body", lang),
        reply_markup=onboarding_income_keyboard(lang)
    )
    await cb.answer()


@router.callback_query(F.data == "onb_income_add")
async def onboarding_income_add(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None):
    await state.clear()
    await cb.answer()
    return await add_income_start(cb, state, lang=lang)


@router.callback_query(F.data == "onb_expense_add")
async def onboarding_expense_add(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None):
    await state.clear()
    await cb.answer()
    return await add_start(cb, state, lang=lang)


@router.callback_query(F.data == "onb_finish")
async def onboarding_finish(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None, currency: dict | None = None):
    await state.clear()

    try:
        daily = await rpc("transaction.getDaily", {"tg_user_id": cb.from_user.id, "date": today_iso()})
    except (RPCError, RPCTransportError):
        daily = {}

    income = to_float(daily.get("income", 0))
    expense = to_float(daily.get("expense", 0))
    balance = float(income) - float(expense)

    lines = [
        money_line(t("label.income", lang), income, "income", sign="+", currency=daily.get("currency") or currency),
        money_line(t("label.expense", lang), expense, "expense", sign="-", currency=daily.get("currency") or currency),
        SEPARATOR,
        money_line(t("label.balance", lang), balance, "progress", currency=daily.get("currency") or currency),
    ]

    text = header(t("onboarding.finish.title", lang), "insights") + "\n\n" + "\n".join(lines)

    await safe_edit_text(
        cb.message,
        text,
        reply_markup=await get_main_menu(cb.from_user.id, lang)
    )
    await cb.answer()
