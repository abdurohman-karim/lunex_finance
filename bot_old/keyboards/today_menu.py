# keyboards/today_menu.py
from aiogram.utils.keyboard import InlineKeyboardBuilder
from i18n import t

def today_menu(lang: str | None = None):
    kb = InlineKeyboardBuilder()
    kb.button(text=t("today.menu.add_expense", lang), callback_data="menu_add_transaction")
    kb.button(text=t("today.menu.add_income", lang), callback_data="menu_add_income")
    kb.button(text=t("common.back", lang), callback_data="menu_back")
    kb.adjust(1)
    return kb.as_markup()
