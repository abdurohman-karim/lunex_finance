from aiogram.utils.keyboard import InlineKeyboardBuilder
from i18n import t

def goals_list_keyboard(goals, lang: str | None = None):
    kb = InlineKeyboardBuilder()
    for g in goals:
        primary = "⭐" if g.get("is_primary") else ""
        pr = g.get("priority", 1)
        icon = g.get("icon", "🎯")

        kb.button(
            text=f"{icon} {g['title']} {primary} ({t('goals.list.priority_short', lang, priority=pr)})",
            callback_data=f"goal_manage_{g['id']}"
        )

    kb.button(text=t("goals.menu.create_button", lang), callback_data="menu_newgoal")
    kb.button(text=t("common.back", lang), callback_data="menu_back")
    kb.adjust(1)
    return kb.as_markup()


def goal_manage_keyboard(goal_id, is_primary, status, lang: str | None = None):
    kb = InlineKeyboardBuilder()

    if status == "active":
        if not is_primary:
            kb.button(
                text=t("goals.button.set_primary", lang),
                callback_data=f"goal_set_primary_{goal_id}"
            )

        kb.button(
            text=t("goals.button.deposit", lang),
            callback_data=f"goal_deposit_{goal_id}"
        )

        kb.adjust(1)

        kb.button(
            text=t("goals.button.priority_up", lang),
            callback_data=f"goal_priority_up_{goal_id}"
        )
        kb.button(
            text=t("goals.button.priority_down", lang),
            callback_data=f"goal_priority_down_{goal_id}"
        )
        kb.adjust(2)

        kb.button(
            text=t("goals.button.close", lang),
            callback_data=f"goal_close_completed_{goal_id}"
        )
    else:
        kb.button(
            text=t("goals.button.reopen", lang),
            callback_data=f"goal_reopen_{goal_id}"
        )

    kb.button(text=t("goals.button.analysis", lang), callback_data=f"analyze_goal_{goal_id}")
    kb.button(text=t("common.back", lang), callback_data="menu_goals")
    kb.adjust(1)

    return kb.as_markup()
