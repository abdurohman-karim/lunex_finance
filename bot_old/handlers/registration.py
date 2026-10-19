# handlers/registration.py
from aiogram import Router, types
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.types import ReplyKeyboardMarkup, KeyboardButton, ReplyKeyboardRemove

import logging

from rpc import telegram_register, RegistrationError, RPCTransportError
from storage.registration_store import store
from ui.menus import get_main_menu, get_user_flags
from handlers.onboarding import start_onboarding
from i18n import t

router = Router()


def contact_keyboard(lang: str | None = None):
    return ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text=t("registration.button.send_contact", lang), request_contact=True)]],
        resize_keyboard=True,
        one_time_keyboard=True,
    )


async def send_registration_prompt(message: types.Message, lang: str | None = None):
    await message.answer(
        f"{t('registration.prompt.title', lang)}\n\n{t('registration.prompt.body', lang)}",
        reply_markup=contact_keyboard(lang)
    )


@router.message(Command("register"))
async def register_start(message: types.Message, state: FSMContext, lang: str | None = None):
    await state.clear()
    await send_registration_prompt(message, lang=lang)


@router.message(lambda m: m.contact is not None)
async def register_contact(message: types.Message, state: FSMContext, lang: str | None = None):
    contact = message.contact

    if not contact.user_id or contact.user_id != message.from_user.id:
        return await message.answer(
            t("registration.error.own_contact", lang),
            reply_markup=contact_keyboard(lang)
        )

    try:
        await telegram_register(
            tg_user_id=message.from_user.id,
            phone=contact.phone_number,
            name=message.from_user.full_name,
        )
    except RegistrationError as e:
        if e.code == "phone_in_use":
            text = t("registration.error.phone_in_use", lang)
        elif e.code == "invalid_phone":
            text = t("registration.error.invalid_phone", lang)
        else:
            text = t("registration.error.generic", lang)

        return await message.answer(
            text,
            reply_markup=contact_keyboard(lang)
        )
    except RPCTransportError:
        logging.exception("Registration transport error")
        return await message.answer(
            t("registration.error.transport", lang),
            reply_markup=contact_keyboard(lang)
        )

    store.set_registered(message.from_user.id, True)
    await state.clear()

    await message.answer(
        f"{t('registration.success.title', lang)}\n\n{t('registration.success.body', lang)}",
        reply_markup=ReplyKeyboardRemove()
    )

    flags = await get_user_flags(message.from_user.id)
    if flags.get("is_new_user"):
        return await start_onboarding(message, state, lang=lang)

    await message.answer(
        t("registration.continue", lang),
        reply_markup=await get_main_menu(message.from_user.id, lang)
    )
