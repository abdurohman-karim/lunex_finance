from aiogram import Router, types, F
from aiogram.utils.keyboard import InlineKeyboardBuilder
from aiogram.fsm.context import FSMContext
import logging

from i18n import t, normalize_lang, get_language_label
from ui.menus import get_main_menu, get_user_flags
from rpc import (
    telegram_set_language,
    telegram_status,
    currency_list,
    currency_get,
    currency_set,
    RPCTransportError,
)
from storage.language_store import store as language_store
from storage.currency_store import store as currency_store
from storage.registration_store import store as registration_store
from handlers.onboarding import start_onboarding
from handlers.registration import send_registration_prompt
from states.language_selection import LanguageSelection
from utils.ui import currency_label, escape_html, normalize_currency
from utils.telegram import safe_edit_text

router = Router()


def settings_menu_keyboard(lang: str | None = None):
    kb = InlineKeyboardBuilder()
    kb.button(text=t("settings.language", lang), callback_data="settings_language")
    kb.button(text=t("settings.currency", lang), callback_data="settings_currency")
    kb.button(text=t("common.back", lang), callback_data="menu_back")
    kb.adjust(1)
    return kb.as_markup()


def language_keyboard(context: str, suggested: str | None = None, lang: str | None = None):
    kb = InlineKeyboardBuilder()
    for code in ("ru", "uz", "en"):
        label = t(f"language.options.{code}", code)
        if suggested and code == suggested:
            label = f"⭐ {label}"
        kb.button(text=label, callback_data=f"lang_{context}_{code}")
    kb.adjust(1)
    return kb.as_markup()


def currency_keyboard(currencies: list[dict], current_code: str | None = None, lang: str | None = None):
    kb = InlineKeyboardBuilder()
    for item in currencies:
        code = str(item.get("code") or "").upper()
        label = currency_label(item)
        if current_code and code == current_code:
            label = f"⭐ {label}"
        kb.button(text=label, callback_data=f"currency_set_{code}")
    kb.button(text=t("common.back", lang), callback_data="menu_settings")
    kb.adjust(1)
    return kb.as_markup()


def render_settings_text(lang: str | None = None, currency: dict | None = None) -> str:
    lines = [
        t("settings.title", lang),
        "",
        t("settings.subtitle", lang),
    ]

    if currency:
        lines.extend([
            "",
            f"{t('settings.current_currency', lang)}: <b>{escape_html(currency_label(currency))}</b>",
        ])

    return "\n".join(lines)


async def send_language_prompt(target: types.Message | types.CallbackQuery, suggested: str | None = None, context: str = "start", lang: str | None = None):
    text = t("language.prompt", lang)
    if suggested:
        text += f"\n\n{t('language.recommended', lang)}: {get_language_label(suggested, lang)}"

    if isinstance(target, types.CallbackQuery):
        await safe_edit_text(target.message, text, reply_markup=language_keyboard(context, suggested, lang))
        await target.answer()
        return

    await target.answer(text, reply_markup=language_keyboard(context, suggested, lang))


@router.callback_query(F.data == "menu_settings")
async def open_settings(cb: types.CallbackQuery, lang: str | None = None, currency: dict | None = None):
    text = render_settings_text(lang, currency)
    await safe_edit_text(cb.message, text, reply_markup=settings_menu_keyboard(lang))
    await cb.answer()


@router.callback_query(F.data == "settings_language")
async def open_language_settings(cb: types.CallbackQuery, lang: str | None = None):
    suggested = normalize_lang(getattr(cb.from_user, "language_code", None))
    await send_language_prompt(cb, suggested=suggested, context="settings", lang=lang)


@router.callback_query(F.data == "settings_currency")
async def open_currency_settings(cb: types.CallbackQuery, lang: str | None = None, currency: dict | None = None):
    try:
        currencies = await currency_list(cb.from_user.id)
        current = await currency_get(cb.from_user.id) or currency
    except RPCTransportError:
        await cb.answer(t("settings.currency.load_failed", lang), show_alert=True)
        return

    current_code = str((current or {}).get("code") or "").upper() or None
    text = (
        f"{t('settings.currency.title', lang)}\n\n"
        f"{t('settings.currency.prompt', lang)}"
    )
    if current:
        text += f"\n\n{t('settings.current_currency', lang)}: <b>{escape_html(currency_label(current))}</b>"

    await safe_edit_text(
        cb.message,
        text,
        reply_markup=currency_keyboard(currencies, current_code=current_code, lang=lang)
    )
    await cb.answer()


@router.callback_query(F.data.startswith("lang_"))
async def set_language(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None):
    parts = cb.data.split("_")
    if len(parts) < 3:
        await cb.answer()
        return

    context = parts[1]
    lang_code = normalize_lang(parts[2])

    language_store.set(cb.from_user.id, lang_code)
    sync_failed = False
    try:
        await telegram_set_language(cb.from_user.id, lang_code)
    except RPCTransportError:
        logging.exception("Set language failed")
        sync_failed = True

    if context == "settings":
        text = render_settings_text(lang_code, currency_store.get(cb.from_user.id))
        if sync_failed:
            text += "\n\n" + t("language.sync_failed", lang_code)
        await safe_edit_text(cb.message, text, reply_markup=settings_menu_keyboard(lang_code))
        await cb.answer()
        return

    current_state = await state.get_state()
    if current_state == LanguageSelection.waiting_choice.state:
        await state.clear()

    # Default behavior for start flow
    text = t("language.changed", lang_code, language=get_language_label(lang_code, lang_code))
    if sync_failed:
        text += "\n\n" + t("language.sync_failed", lang_code)

    await safe_edit_text(
        cb.message,
        text,
        reply_markup=None,
    )

    try:
        status = await telegram_status(cb.from_user.id)
        is_registered = status.get("registered")
    except RPCTransportError:
        is_registered = registration_store.is_registered(cb.from_user.id)

    if not is_registered:
        await send_registration_prompt(cb.message, lang=lang_code)
        await cb.answer()
        return

    registration_store.set_registered(cb.from_user.id, True)
    flags = await get_user_flags(cb.from_user.id)
    if flags.get("is_new_user"):
        await cb.answer()
        return await start_onboarding(cb.message, state, lang=lang_code)

    await cb.message.answer(
        t("registration.continue", lang_code),
        reply_markup=await get_main_menu(cb.from_user.id, lang_code)
    )
    await cb.answer()


@router.callback_query(F.data.startswith("currency_set_"))
async def set_currency_handler(cb: types.CallbackQuery, lang: str | None = None, currency: dict | None = None):
    currency_code = cb.data.replace("currency_set_", "").upper()

    try:
        updated = await currency_set(cb.from_user.id, currency_code)
    except RPCTransportError:
        await cb.answer(t("settings.currency.update_failed", lang), show_alert=True)
        return

    if not updated:
        await cb.answer(t("settings.currency.update_failed", lang), show_alert=True)
        return

    updated = normalize_currency(updated)
    currency_store.set(cb.from_user.id, updated)
    await safe_edit_text(
        cb.message,
        render_settings_text(lang, updated),
        reply_markup=settings_menu_keyboard(lang)
    )
    await cb.answer(
        t("settings.currency.updated", lang, currency=currency_label(updated))
    )
