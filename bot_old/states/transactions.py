from aiogram.fsm.state import State, StatesGroup

class TransactionStates(StatesGroup):
    waiting_for_amount = State()
    waiting_for_category = State()
    waiting_for_description = State()

    waiting_for_date = State()
    waiting_for_date_manual = State()
    waiting_for_confirm = State()
