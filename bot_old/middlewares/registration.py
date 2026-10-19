from aiogram import BaseMiddleware, types
from aiogram.types import ReplyKeyboardMarkup, KeyboardButton

from rpc import telegram_status, RPCTransportError
from storage.registration_store import store
from i18n import t
from storage.language_store import store as language_store
from i18n import normalize_lang
from handlers.settings import send_language_prompt
from states.language_selection import LanguageSelection


class RegistrationMiddleware(BaseMiddleware):
    def __init__(self):
        self.store = store

    async def __call__(self, handler, event, data):
        user = getattr(event, "from_user", None)
        if not user:
            return await handler(event, data)

        lang = data.get("lang")
        state = data.get("state")

        if state:
            current = await state.get_state()
            if current == LanguageSelection.waiting_choice.state:
                if self._is_language_only_event(event):
                    return await handler(event, data)
                suggested = normalize_lang(getattr(user, "language_code", None))
                await send_language_prompt(event, suggested=suggested, context="start", lang=lang)
                return None

        if not language_store.get(user.id) and not self._is_language_event(event) and not self._is_start_event(event):
            if state:
                await state.set_state(LanguageSelection.waiting_choice)
            suggested = normalize_lang(getattr(user, "language_code", None))
            await send_language_prompt(event, suggested=suggested, context="start", lang=lang)
            return None

        if self._is_allowed_event(event):
            return await handler(event, data)

        try:
            status = await telegram_status(user.id)
            is_registered = bool(status.get("registered"))
            self.store.set_registered(user.id, is_registered)
            if is_registered:
                return await handler(event, data)
        except RPCTransportError:
            await self._notify_backend_unavailable(event, lang)
            return None

        await self._prompt_registration(event, lang)
        return None

    def _is_allowed_event(self, event) -> bool:
        if isinstance(event, types.Message):
            if event.text and event.text.startswith(("/start", "/register")):
                return True
            if event.contact:
                return True
        if isinstance(event, types.CallbackQuery):
            if event.data and event.data.startswith("onb_"):
                return True
            if event.data and event.data.startswith("lang_"):
                return True
        return False

    def _is_language_only_event(self, event) -> bool:
        if isinstance(event, types.CallbackQuery):
            return bool(event.data and event.data.startswith("lang_"))
        if isinstance(event, types.Message):
            return bool(event.text and event.text.startswith("/start"))
        return False

    def _is_language_event(self, event) -> bool:
        return isinstance(event, types.CallbackQuery) and bool(event.data and event.data.startswith("lang_"))

    def _is_start_event(self, event) -> bool:
        return isinstance(event, types.Message) and bool(event.text and event.text.startswith("/start"))

    async def _prompt_registration(self, event, lang: str | None = None):
        text = (
            f"{t('registration.prompt.title', lang)}\n\n"
            f"{t('registration.prompt.body', lang)}"
        )

        keyboard = ReplyKeyboardMarkup(
            keyboard=[[KeyboardButton(text=t("registration.button.send_contact", lang), request_contact=True)]],
            resize_keyboard=True,
            one_time_keyboard=True,
        )

        if isinstance(event, types.CallbackQuery):
            await event.message.answer(text, reply_markup=keyboard)
            await event.answer()
        elif isinstance(event, types.Message):
            await event.answer(text, reply_markup=keyboard)

    async def _notify_backend_unavailable(self, event, lang: str | None = None):
        text = t("common.error.backend_unavailable", lang)
        if isinstance(event, types.CallbackQuery):
            await event.answer(text, show_alert=True)
            await event.message.answer(text)
        elif isinstance(event, types.Message):
            await event.answer(text)
