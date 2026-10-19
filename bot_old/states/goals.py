# states/goals.py
from aiogram.fsm.state import State, StatesGroup

class GoalStates(StatesGroup):
    waiting_for_title = State()
    waiting_for_amount = State()
    waiting_for_deadline = State()
    waiting_for_manual_deadline = State()


class DepositGoal(StatesGroup):
    waiting_for_amount = State()
    waiting_for_confirm = State()
