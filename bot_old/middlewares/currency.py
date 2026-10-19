from aiogram import BaseMiddleware

from rpc import telegram_status, RPCTransportError
from storage.currency_store import store
from utils.ui import normalize_currency


class CurrencyMiddleware(BaseMiddleware):
    def __init__(self):
        self.store = store

    async def __call__(self, handler, event, data):
        user = getattr(event, "from_user", None)
        if not user:
            return await handler(event, data)

        currency = self.store.get(user.id)
        if currency is None or not isinstance(currency, dict) or not currency.get("code"):
            try:
                status = await telegram_status(user.id)
                currency = status.get("currency")
                if currency:
                    currency = normalize_currency(currency)
                    self.store.set(user.id, currency)
            except RPCTransportError:
                currency = None

        data["currency"] = currency
        return await handler(event, data)
