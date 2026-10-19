from aiogram.utils.keyboard import InlineKeyboardBuilder
from i18n import t

# Placeholder keyboard for a future goal-icon flow.
# It is intentionally not wired into the current goal creation UX.
ICONS = [
    "📱", "🚗", "🏠", "🎁",
    "🎓", "🛋", "💻", "✈️",
]

def icons_keyboard(lang: str | None = None):
    kb = InlineKeyboardBuilder()
    for icon in ICONS:
        kb.button(text=icon, callback_data=f"goal_icon_{icon}")
    kb.button(text=t("common.cancel", lang), callback_data="menu_cancel")
    kb.adjust(4, 1)
    return kb.as_markup()
