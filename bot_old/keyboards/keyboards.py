from aiogram.utils.keyboard import InlineKeyboardBuilder
from i18n import t

def main_menu(flags: dict | None = None, lang: str | None = None):
    flags = flags or {}
    has_goals = flags.get("has_goals", True)
    has_transactions = flags.get("has_transactions", True)
    has_budget = flags.get("has_budget", True)
    smart_save_available = flags.get("smart_save_available", True)

    kb = InlineKeyboardBuilder()
    if not has_goals:
        kb.button(text=t("menu.action.create_first_goal", lang), callback_data="menu_newgoal")
    if not has_transactions:
        kb.button(text=t("menu.action.add_first_income", lang), callback_data="menu_add_income")
    if not has_budget:
        kb.button(text=t("menu.action.setup_budget", lang), callback_data="menu_budget")

    kb.button(text=t("menu.action.add_expense", lang), callback_data="menu_add_transaction")
    kb.button(text=t("menu.action.add_income", lang), callback_data="menu_add_income")
    kb.button(text=t("menu.action.today", lang), callback_data="menu_today")
    kb.button(text=t("menu.action.budget", lang), callback_data="menu_budget")

    if has_goals:
        kb.button(text=t("menu.action.goals", lang), callback_data="menu_goals")
        kb.button(text=t("menu.action.progress", lang), callback_data="menu_progress")
    else:
        kb.button(text=t("menu.action.goals", lang), callback_data="menu_goals")

    kb.button(text=t("menu.action.insights", lang), callback_data="menu_insights")

    if smart_save_available:
        kb.button(text=t("menu.action.smart_save", lang), callback_data="menu_smart")

    kb.button(text=t("menu.action.settings", lang), callback_data="menu_settings")
    kb.button(text=t("menu.action.clear_chat", lang), callback_data="clear_chat")
    kb.adjust(1, 2, 2, 2, 2, 1, 1)
    return kb.as_markup()

def back_button(lang: str | None = None):
    kb = InlineKeyboardBuilder()
    kb.button(text=t("common.back", lang), callback_data="menu_back")
    return kb.as_markup()

def cancel_button(lang: str | None = None):
    kb = InlineKeyboardBuilder()
    kb.button(text=t("common.cancel", lang), callback_data="menu_cancel")
    return kb.as_markup()


def insights_menu(lang: str | None = None):
    kb = InlineKeyboardBuilder()
    kb.button(text=t("insights.button.week", lang), callback_data="insights_week")
    kb.button(text=t("insights.button.trend", lang), callback_data="insights_trend")
    kb.button(text=t("insights.button.savings", lang), callback_data="insights_savings")
    kb.button(text=t("insights.button.tip", lang), callback_data="insights_tip")
    kb.button(text=t("common.back", lang), callback_data="menu_back")
    kb.adjust(1)
    return kb.as_markup()
