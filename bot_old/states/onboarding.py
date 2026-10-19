from aiogram.fsm.state import State, StatesGroup


class OnboardingStates(StatesGroup):
    welcome = State()
    focus = State()
    offer_goal = State()
    offer_income = State()
