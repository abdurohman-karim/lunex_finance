# handlers/navigation.py
from aiogram import Router, types
from aiogram.fsm.context import FSMContext

from ui.menus import get_main_menu
from ui.formatting import header
from i18n import t
from utils.telegram import safe_edit_text

router = Router()


@router.callback_query(lambda c: c.data == "menu_back")
async def back_to_main(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None):
    await state.clear()
    await safe_edit_text(
        cb.message,
        header(t("menu.main.title", lang), None) + "\n\n" + t("menu.main.subtitle", lang),
        reply_markup=await get_main_menu(cb.from_user.id, lang)
    )
    await cb.answer()


@router.callback_query(lambda c: c.data == "menu_cancel")
async def cancel_action(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None):
    await state.clear()

    await safe_edit_text(
        cb.message,
        f"{t('nav.cancel.title', lang)}\n\n{t('nav.cancel.body', lang)}",
        reply_markup=await get_main_menu(cb.from_user.id, lang)
    )
    await cb.answer()
