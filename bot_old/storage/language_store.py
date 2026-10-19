from storage.json_store import JsonStore


class LanguageStore(JsonStore):
    def __init__(self, path: str = "data/languages.json"):
        super().__init__(path)

    def get(self, tg_user_id: int) -> str | None:
        return self._data.get(str(tg_user_id))

    def set(self, tg_user_id: int, language: str) -> None:
        self._data[str(tg_user_id)] = language
        self._save()


store = LanguageStore()
