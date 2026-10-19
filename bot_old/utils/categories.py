from i18n import t, SUPPORTED_LANGS

EXPENSE_CATEGORY_KEYS = [
    "food",
    "transport",
    "market",
    "shopping",
    "subscriptions",
    "fun",
]

INCOME_CATEGORY_KEYS = [
    "salary",
    "transfer",
    "business",
    "sale",
    "gift",
]


def expense_category_label(key: str, lang: str | None = None) -> str:
    return t(f"category.expense.{key}", lang)


def income_category_label(key: str, lang: str | None = None) -> str:
    return t(f"category.income.{key}", lang)


def expense_category_backend_value(key: str) -> str:
    return t(f"category.expense.{key}", "ru")


def income_category_backend_value(key: str) -> str:
    return t(f"category.income.{key}", "ru")


def localize_category(label: str | None, lang: str | None = None) -> str:
    if not label:
        return ""

    mapping = _category_label_map()
    mapped = mapping.get(label)
    if not mapped:
        return label

    category_type, key = mapped
    return t(f"category.{category_type}.{key}", lang)


_CATEGORY_LABEL_MAP: dict[str, tuple[str, str]] | None = None


def _category_label_map() -> dict[str, tuple[str, str]]:
    global _CATEGORY_LABEL_MAP
    if _CATEGORY_LABEL_MAP is not None:
        return _CATEGORY_LABEL_MAP

    mapping: dict[str, tuple[str, str]] = {}
    for key in EXPENSE_CATEGORY_KEYS:
        for lang in SUPPORTED_LANGS:
            label = t(f"category.expense.{key}", lang)
            mapping[label] = ("expense", key)

    for key in INCOME_CATEGORY_KEYS:
        for lang in SUPPORTED_LANGS:
            label = t(f"category.income.{key}", lang)
            mapping[label] = ("income", key)

    _CATEGORY_LABEL_MAP = mapping
    return mapping
