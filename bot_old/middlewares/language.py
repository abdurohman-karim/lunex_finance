from aiogram import BaseMiddleware

from rpc import telegram_status, RPCTransportError
from storage.language_store import store
from i18n import normalize_lang, DEFAULT_LANG


class LanguageMiddleware(BaseMiddleware):
    def __init__(self):
        self.store = store

    async def __call__(self, handler, event, data):
        user = getattr(event, "from_user", None)
        if not user:
            return await handler(event, data)

        lang = self.store.get(user.id)
        if not lang:
            try:
                status = await telegram_status(user.id)
                status_lang = status.get("language")
                is_registered = bool(status.get("registered"))
                if status_lang:
                    normalized = normalize_lang(status_lang)
                    # For first-run (unregistered) users, do not auto-accept default language.
                    if is_registered or normalized != DEFAULT_LANG:
                        lang = normalized
                        self.store.set(user.id, lang)
            except RPCTransportError:
                lang = None

        if not lang:
            lang = normalize_lang(getattr(user, "language_code", None))

        data["lang"] = lang
        return await handler(event, data)
