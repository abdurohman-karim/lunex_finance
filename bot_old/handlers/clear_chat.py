import asyncio
import logging
from aiogram import Router, types, F
from aiogram.fsm.context import FSMContext
from ui.menus import get_main_menu
from i18n import t

router = Router()

_SCAN_WINDOW = 100  # Telegram API limit for deleteMessages


async def _delete_one(bot, chat_id: int, msg_id: int) -> None:
    try:
        await bot.delete_message(chat_id, msg_id)
    except Exception:
        pass


@router.callback_query(F.data == "clear_chat")
async def clear_chat(cb: types.CallbackQuery, state: FSMContext, lang: str | None = None):
    await cb.answer()
    await state.clear()

    chat_id = cb.message.chat.id
    current_id = cb.message.message_id
    candidate_ids = list(range(max(1, current_id - _SCAN_WINDOW + 1), current_id + 1))

    try:
        await cb.bot.delete_messages(chat_id, candidate_ids)
    except Exception as exc:
        logging.warning(
            "clear_chat: bulk delete_messages failed (%s), falling back to per-message delete",
            exc,
            exc_info=True,
        )
        await asyncio.gather(*[_delete_one(cb.bot, chat_id, mid) for mid in candidate_ids])

    await cb.message.answer(
        f"{t('clear_chat.title', lang)}\n\n{t('clear_chat.body', lang)}",
        reply_markup=await get_main_menu(cb.from_user.id, lang),
    )
