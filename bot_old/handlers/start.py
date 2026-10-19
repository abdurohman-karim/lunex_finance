# handlers/start.py
from aiogram import Router, types
from aiogram.fsm.context import FSMContext
from aiogram.filters import Command

from rpc import rpc, RPCError, RPCTransportError, telegram_status
from ui.menus import get_main_menu, get_user_flags
from handlers.onboarding import start_onboarding
from handlers.registration import send_registration_prompt
from handlers.settings import send_language_prompt
from storage.registration_store import store
from storage.language_store import store as language_store
from storage.currency_store import store as currency_store
from i18n import t, normalize_lang, DEFAULT_LANG
from states.language_selection import LanguageSelection
from utils.ui import normalize_currency

router = Router()


@router.message(Command("start"))
async def cmd_start(message: types.Message, state: FSMContext, lang: str | None = None):
    tg_id = message.from_user.id
    bootstrap = {}

    try:
        bootstrap = await rpc("user.register", {
            "tg_user_id": tg_id,
            "name": message.from_user.full_name
        })
    except (RPCError, RPCTransportError):
        await message.answer(
            t("start.service_unavailable", lang)
        )

    current_state = await state.get_state()
    if current_state == LanguageSelection.waiting_choice.state:
        suggested = normalize_lang(getattr(message.from_user, "language_code", None))
        await send_language_prompt(message, suggested=suggested, context="start", lang=lang)
        return

    await state.clear()

    stored_lang = language_store.get(tg_id)
    status = {}
    try:
        status = await telegram_status(tg_id)
    except RPCTransportError:
        status = {}

    backend_lang = status.get("language")
    backend_lang = normalize_lang(backend_lang) if backend_lang else None
    is_registered = bool(status.get("registered"))

    if not stored_lang:
        if not is_registered and (not backend_lang or backend_lang == DEFAULT_LANG):
            suggested = normalize_lang(getattr(message.from_user, "language_code", None))
            await state.set_state(LanguageSelection.waiting_choice)
            await send_language_prompt(message, suggested=suggested, context="start", lang=lang)
            return

        if backend_lang:
            stored_lang = backend_lang
            language_store.set(tg_id, stored_lang)
        else:
            stored_lang = normalize_lang(getattr(message.from_user, "language_code", None))
            language_store.set(tg_id, stored_lang)

    if status and backend_lang and stored_lang and backend_lang != stored_lang:
        try:
            from rpc import telegram_set_language
            await telegram_set_language(tg_id, stored_lang)
        except RPCTransportError:
            pass

    if status.get("currency"):
        currency_store.set(tg_id, normalize_currency(status.get("currency")))

    if not status:
        await message.answer(t("common.error.backend_unavailable", stored_lang))
        return

    if not is_registered:
        store.set_registered(tg_id, False)
        return await send_registration_prompt(message, lang=stored_lang)

    store.set_registered(tg_id, True)

    flags = await get_user_flags(tg_id, bootstrap=bootstrap if isinstance(bootstrap, dict) else None)
    if flags.get("is_new_user"):
        return await start_onboarding(message, state, lang=stored_lang)

    await message.answer(
        t("start.welcome_back", stored_lang),
        reply_markup=await get_main_menu(tg_id, stored_lang)
    )
