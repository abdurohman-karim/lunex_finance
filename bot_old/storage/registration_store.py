from storage.json_store import JsonStore


class RegistrationStore(JsonStore):
    def __init__(self, path: str = "data/registrations.json"):
        super().__init__(path)

    def is_registered(self, tg_user_id: int) -> bool:
        return bool(self._data.get(str(tg_user_id)))

    def set_registered(self, tg_user_id: int, value: bool = True) -> None:
        self._data[str(tg_user_id)] = bool(value)
        self._save()


store = RegistrationStore()
