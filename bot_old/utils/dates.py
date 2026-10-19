from __future__ import annotations

from datetime import datetime, date
from zoneinfo import ZoneInfo

from config import APP_TIMEZONE


def now_local() -> datetime:
    try:
        tz = ZoneInfo(APP_TIMEZONE)
    except Exception:
        tz = ZoneInfo("UTC")
    return datetime.now(tz)


def today_local() -> date:
    return now_local().date()


def today_iso() -> str:
    return today_local().isoformat()


def current_month() -> str:
    return today_local().strftime("%Y-%m")
