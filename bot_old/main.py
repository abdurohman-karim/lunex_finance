# main.py
import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties

from config import BOT_TOKEN, validate_config
from handlers.router import main_router
from middlewares.registration import RegistrationMiddleware
from middlewares.currency import CurrencyMiddleware
from middlewares.language import LanguageMiddleware
from middlewares.language_selection import LanguageSelectionMiddleware
from rpc import close_http_client


async def main():
    validate_config()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    bot = Bot(
        token=BOT_TOKEN,
        default=DefaultBotProperties(parse_mode="HTML"),
    )
    dp = Dispatcher()

    dp.message.middleware(CurrencyMiddleware())
    dp.callback_query.middleware(CurrencyMiddleware())

    dp.message.middleware(LanguageMiddleware())
    dp.callback_query.middleware(LanguageMiddleware())

    dp.message.middleware(LanguageSelectionMiddleware())
    dp.callback_query.middleware(LanguageSelectionMiddleware())

    dp.message.middleware(RegistrationMiddleware())
    dp.callback_query.middleware(RegistrationMiddleware())

    dp.include_router(main_router)

    logging.info("Bot starting...")
    try:
        await bot.delete_webhook(drop_pending_updates=True)
        await dp.start_polling(bot)
    finally:
        await close_http_client()


if __name__ == "__main__":
    asyncio.run(main())
