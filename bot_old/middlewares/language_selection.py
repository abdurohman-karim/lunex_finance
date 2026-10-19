from aiogram import BaseMiddleware, types

from handlers.settings import send_language_prompt
from i18n import normalize_lang
from states.language_selection import LanguageSelection


class LanguageSelectionMiddleware(BaseMiddleware):
    async def __call__(self, handler, event, data):
        state = data.get("state")
        if not state:
            return await handler(event, data)

        current = await state.get_state()
        if current != LanguageSelection.waiting_choice.state:
            return await handler(event, data)

        if self._is_allowed_event(event):
            return await handler(event, data)

        suggested = normalize_lang(getattr(getattr(event, "from_user", None), "language_code", None))
        await send_language_prompt(event, suggested=suggested, context="start", lang=data.get("lang"))
        return None

    def _is_allowed_event(self, event) -> bool:
        if isinstance(event, types.CallbackQuery):
            return bool(event.data and event.data.startswith("lang_"))
        if isinstance(event, types.Message):
            return bool(event.text and event.text.startswith("/start"))
        return False
