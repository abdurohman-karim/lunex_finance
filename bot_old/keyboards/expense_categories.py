from aiogram.utils.keyboard import InlineKeyboardBuilder
from i18n import t
from utils.categories import EXPENSE_CATEGORY_KEYS, expense_category_label


def expense_category_keyboard(lang: str | None = None):
    kb = InlineKeyboardBuilder()
    for key in EXPENSE_CATEGORY_KEYS:
        kb.button(text=expense_category_label(key, lang), callback_data=f"cat_{key}")
    kb.button(text=t("common.back", lang), callback_data="add_expense_back")
    kb.button(text=t("common.cancel", lang), callback_data="menu_cancel")
    kb.adjust(2)
    return kb.as_markup()

