# handlers/add_income.py
from aiogram import Router, types, F
from aiogram.fsm.context import FSMContext
from aiogram.utils.keyboard import InlineKeyboardBuilder
from datetime import datetime

from states.incomes import IncomeStates
from keyboards.keyboards import cancel_button, back_button
from rpc import rpc
from utils.ui import parse_amount, format_amount, format_date, safe_html_text, escape_html
from ui.menus import get_main_menu
from utils.categories import INCOME_CATEGORY_KEYS, income_category_label, income_category_backend_value
from i18n import t
from utils.dates import today_local
from utils.telegram import safe_edit_message_text, safe_edit_text

router = Router()


def income_category_keyboard(lang: str | None = None):
    kb = InlineKeyboardBuilder()
    for key in INCOME_CATEGORY_KEYS:
        kb.button(text=income_category_label(key, lang), callback_data=f"inc_{key}")
    kb.button(text=t("common.back", lang), callback_data="inc_back")
    kb.button(text=t("common.cancel", lang), callback_data="menu_cancel")
    kb.adjust(2)
    return kb.as_markup()


def description_keyboard(lang: str | None = None):
    kb = InlineKeyboardBuilder()
    kb.button(text=t("common.skip", lang), callback_data="inc_desc_skip")
    kb.button(text=t("common.cancel", lang), callback_data="menu_cancel")
    kb.adjust(2)
    return kb.as_markup()


def date_keyboard(lang: str | None = None):
    kb = InlineKeyboardBuilder()
    kb.button(text=t("deadline.today", lang, date=today_local()), callback_data="inc_date_today")
    kb.button(text=t("deadline.manual", lang), callback_data="inc_date_manual")
    kb.button(text=t("common.cancel", lang), callback_data="menu_cancel")
    kb.adjust(1)
    return kb.as_markup()


async def safe_delete(msg: types.Message):
    try:
        await msg.delete()
    except Exception:
        pass


async def update_window(obj, state: FSMContext, message_id: int, text: str, reply_markup=None):
    if isinstance(obj, types.CallbackQuery):
        bot = obj.bot
        chat_id = obj.message.chat.id
    else:
        bot = obj.bot
        chat_id = obj.chat.id

    sent = await safe_edit_message_text(
        bot,
        chat_id=chat_id,
        message_id=message_id,
        text=text,
        reply_markup=reply_markup
    )
    if sent is not None:
        await state.update_data(bot_message_id=sent.message_id)


@router.callback_query(F.data == "menu_add_income")
async def add_income_start(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None, currency: dict | None = None):
    await state.set_state(IncomeStates.waiting_for_amount)

    msg = await safe_edit_text(
        cb.message,
        f"{t('income.new.title', lang)}\n\n{t('income.new.body', lang)}",
        reply_markup=back_button(lang)
    )

    await state.update_data(bot_message_id=msg.message_id, currency=currency)
    await cb.answer()


@router.message(IncomeStates.waiting_for_amount)
async def income_amount(message: types.Message, state: FSMContext, lang: str | None = None):
    await safe_delete(message)

    currency = (await state.get_data()).get("currency")
    amt = parse_amount(message.text, currency=currency)
    if amt is None:
        return await message.answer(t("income.amount_invalid", lang))

    await state.update_data(amount=amt)
    await state.set_state(IncomeStates.waiting_for_category)

    data = await state.get_data()
    bot_message_id = data["bot_message_id"]

    await update_window(
        message,
        state,
        bot_message_id,
        t("income.category.title", lang),
        income_category_keyboard(lang)
    )


@router.callback_query(F.data.in_([f"inc_{key}" for key in INCOME_CATEGORY_KEYS]))
async def set_income_category(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None):
    key = cb.data.replace("inc_", "")
    if key not in INCOME_CATEGORY_KEYS:
        return await cb.answer(t("income.category.not_found", lang))

    await state.update_data(
        category_key=key,
        category_label=income_category_label(key, lang),
        category_value=income_category_backend_value(key),
    )
    await state.set_state(IncomeStates.waiting_for_description)

    data = await state.get_data()
    bot_message_id = data["bot_message_id"]

    await update_window(
        cb,
        state,
        bot_message_id,
        t("income.description.title", lang),
        description_keyboard(lang)
    )
    await cb.answer()


@router.callback_query(F.data == "inc_desc_skip")
async def skip_income_description(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None):
    await state.update_data(description=None)
    await state.set_state(IncomeStates.waiting_for_date)

    data = await state.get_data()
    bot_message_id = data["bot_message_id"]

    await update_window(
        cb,
        state,
        bot_message_id,
        t("income.date.title", lang),
        date_keyboard(lang)
    )
    await cb.answer()


@router.message(IncomeStates.waiting_for_description)
async def income_description(message: types.Message, state: FSMContext, lang: str | None = None):
    await safe_delete(message)

    await state.update_data(description=message.text.strip())
    await state.set_state(IncomeStates.waiting_for_date)

    data = await state.get_data()
    bot_message_id = data["bot_message_id"]

    await update_window(
        message,
        state,
        bot_message_id,
        t("income.date.title", lang),
        date_keyboard(lang)
    )


@router.callback_query(F.data == "inc_date_today")
async def choose_today_income(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None, currency: dict | None = None):
    await prepare_income_confirmation(cb, state, today_local().isoformat(), lang, currency)


@router.callback_query(F.data == "inc_date_manual")
async def manual_date_income(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None):
    await state.set_state(IncomeStates.waiting_for_date)

    data = await state.get_data()
    bot_message_id = data["bot_message_id"]

    await update_window(
        cb,
        state,
        bot_message_id,
        t("income.date.manual_prompt", lang),
        cancel_button(lang)
    )
    await cb.answer()


@router.message(IncomeStates.waiting_for_date)
async def manual_date_income_enter(message: types.Message, state: FSMContext, lang: str | None = None, currency: dict | None = None):
    date_value = message.text.strip()
    try:
        datetime.strptime(date_value, "%Y-%m-%d")
    except ValueError:
        return await message.answer(t("income.date.invalid", lang))
    await prepare_income_confirmation(message, state, date_value, lang, currency)



def confirm_keyboard(lang: str | None = None):
    kb = InlineKeyboardBuilder()
    kb.button(text=t("common.save", lang), callback_data="income_confirm")
    kb.button(text=t("common.cancel", lang), callback_data="menu_cancel")
    kb.adjust(1)
    return kb.as_markup()


async def prepare_income_confirmation(obj, state: FSMContext, date_value: str, lang: str | None = None, currency: dict | None = None):
    data = await state.get_data()
    await state.update_data(date=date_value)
    await state.set_state(IncomeStates.waiting_for_confirm)

    amount_text = format_amount(data["amount"], currency=currency)
    category = data.get("category_label") or data.get("category_value")
    description = safe_html_text(data.get("description") or "—", 120)
    date_text = format_date(date_value)

    text = (
        f"{t('income.confirm.title', lang)}\n\n"
        f"💵 {t('label.amount', lang)}: <b>{escape_html(amount_text)}</b>\n"
        f"🏦 {t('label.source', lang)}: <b>{safe_html_text(category, 80)}</b>\n"
        f"📝 {t('label.description', lang)}: <b>{description}</b>\n"
        f"📅 {t('label.date', lang)}: <b>{escape_html(date_text)}</b>\n\n"
        f"{t('income.confirm.question', lang)}"
    )

    await update_window(
        obj,
        state,
        data["bot_message_id"],
        text=text,
        reply_markup=confirm_keyboard(lang)
    )


@router.callback_query(IncomeStates.waiting_for_confirm, F.data == "income_confirm")
async def finish_income(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None, currency: dict | None = None):
    data = await state.get_data()
    date_value = data.get("date")

    payload = {
        "tg_user_id": cb.from_user.id,
        "items": [{
            "amount": abs(data["amount"]),
            "category": data.get("category_value"),
            "description": data.get("description"),
            "datetime": date_value,
        }],
        "source": "manual",
    }

    try:
        await rpc("transaction.import", payload)
    except Exception:
        await state.clear()
        return await safe_edit_text(
            cb.message,
            t("income.save.error", lang),
            reply_markup=await get_main_menu(cb.from_user.id, lang)
        )

    await state.clear()

    await safe_edit_message_text(
        cb.bot,
        chat_id=cb.message.chat.id,
        message_id=data["bot_message_id"],
        text=(
            f"{t('income.save.success', lang, amount=escape_html(format_amount(data['amount'], currency=currency)), category=safe_html_text(data.get('category_label') or data.get('category_value'), 80), date=escape_html(format_date(date_value)))}"
            f"\n{t('income.save.success.footer', lang)}"
        ),
        reply_markup=await get_main_menu(cb.from_user.id, lang, bootstrap={"has_transactions": True})
    )
    await cb.answer()


@router.callback_query(F.data == "inc_back")
async def income_back_to_amount(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None):
    await state.set_state(IncomeStates.waiting_for_amount)

    data = await state.get_data()
    bot_message_id = data.get("bot_message_id")

    if bot_message_id:
        await update_window(
            cb,
            state,
            bot_message_id,
            f"{t('income.new.title', lang)}\n\n{t('income.new.body', lang)}",
            back_button(lang)
        )
    await cb.answer()
