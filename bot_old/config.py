import os

from dotenv import load_dotenv
load_dotenv()

BACKEND_BASE_URL = os.getenv("BACKEND_BASE_URL", "http://localhost:5136/api").rstrip("/")
APP_TIMEZONE = os.getenv("APP_TIMEZONE", "Asia/Tashkent")

BOT_TOKEN = os.getenv("BOT_TOKEN")
RPC_TOKEN = os.getenv("RPC_TOKEN")
TELEGRAM_BOT_SECRET = os.getenv("TELEGRAM_BOT_WEBHOOK_SECRET") or RPC_TOKEN

RPC_URL = f"{BACKEND_BASE_URL}/rpc"
TELEGRAM_REGISTER_URL = f"{BACKEND_BASE_URL}/telegram/register"
TELEGRAM_STATUS_URL = f"{BACKEND_BASE_URL}/telegram/status"
TELEGRAM_SET_LANGUAGE_URL = f"{BACKEND_BASE_URL}/telegram/set-language"


def validate_config() -> None:
    missing = []
    if not BOT_TOKEN:
        missing.append("BOT_TOKEN")
    if not RPC_TOKEN:
        missing.append("RPC_TOKEN")
    if not BACKEND_BASE_URL:
        missing.append("BACKEND_BASE_URL")

    if missing:
        names = ", ".join(missing)
        raise RuntimeError(
            f"Missing required environment variables: {names}. "
            "Set real values in the environment before starting the bot."
        )
