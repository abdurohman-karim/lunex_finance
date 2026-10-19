# handlers/router.py
from aiogram import Router
import logging

from .start import router as start_router
from .errors import router as error_router
from .smart import router as smart_router
from .ai import router as ai_router
from .progress import router as progress_router
from .navigation import router as navigation_router
from handlers.goals.goal_analysis import router as analysis_router
from .budget import router as budget_router
from .daily import router as daily_router
from .add_transaction import router as add_tr_router
from .add_income import router as add_income_router
from .clear_chat import router as clear_chat_router
from .registration import router as registration_router
from .onboarding import router as onboarding_router
from .insights import router as insights_router
from .settings import router as settings_router

from handlers.goals.goal_create import router as goals_create_router
from handlers.goals.goal_manage import router as goals_manage_router

logging.basicConfig(level=logging.INFO)

main_router = Router()
main_router.include_router(error_router)

# базовые
main_router.include_router(start_router)
main_router.include_router(smart_router)
main_router.include_router(ai_router)
main_router.include_router(progress_router)
main_router.include_router(navigation_router)
main_router.include_router(analysis_router)
main_router.include_router(budget_router)
main_router.include_router(daily_router)
main_router.include_router(add_tr_router)
main_router.include_router(add_income_router)
main_router.include_router(clear_chat_router)
main_router.include_router(registration_router)
main_router.include_router(onboarding_router)
main_router.include_router(insights_router)
main_router.include_router(settings_router)

# цели
main_router.include_router(goals_create_router)
main_router.include_router(goals_manage_router)
