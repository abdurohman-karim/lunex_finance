from aiogram.fsm.state import StatesGroup, State


class LanguageSelection(StatesGroup):
    waiting_choice = State()
