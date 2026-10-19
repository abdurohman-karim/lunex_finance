from storage.json_store import JsonStore


class CurrencyStore(JsonStore):
    def __init__(self, path: str = "data/currencies.json"):
        super().__init__(path, ensure_ascii=False)

    def get(self, tg_user_id: int) -> dict | None:
        value = self._data.get(str(tg_user_id))
        return value if isinstance(value, dict) else None

    def set(self, tg_user_id: int, currency: dict | None) -> None:
        key = str(tg_user_id)
        if currency is None:
            self._data.pop(key, None)
        else:
            self._data[key] = currency
        self._save()


store = CurrencyStore()
