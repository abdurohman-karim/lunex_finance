from rpc import rpc, RPCError, RPCTransportError
from keyboards.keyboards import main_menu
from utils.dates import current_month, today_iso


def _bool_from_payload(payload: dict, *keys: str):
    for key in keys:
        if key in payload:
            return bool(payload.get(key))
    return None


async def get_user_flags(tg_user_id: int, bootstrap: dict | None = None) -> dict:
    flags = {
        "has_goals": True,
        "has_transactions": True,
        "has_budget": True,
        "smart_save_available": True,
        "is_new_user": False,
    }
    bootstrap = bootstrap or {}

    bootstrap_is_first_run = _bool_from_payload(bootstrap, "is_first_run", "is_new_user")
    bootstrap_has_goals = _bool_from_payload(bootstrap, "has_goals")
    bootstrap_has_transactions = _bool_from_payload(bootstrap, "has_any_transactions", "has_transactions")
    bootstrap_has_budget = _bool_from_payload(bootstrap, "has_budget_this_month", "has_budget")

    try:
        goals = await rpc("goal.list", {"tg_user_id": tg_user_id})
        flags["has_goals"] = bootstrap_has_goals if bootstrap_has_goals is not None else bool(goals.get("goals", []))
    except (RPCError, RPCTransportError):
        return flags

    try:
        budget = await rpc("budget.getMonth", {
            "tg_user_id": tg_user_id,
            "month": current_month(),
        })
        if bootstrap_has_budget is not None:
            flags["has_budget"] = bootstrap_has_budget
        else:
            flags["has_budget"] = bool(budget.get("exists", True))
    except (RPCError, RPCTransportError):
        flags["has_budget"] = True

    try:
        daily = await rpc("transaction.getDaily", {
            "tg_user_id": tg_user_id,
            "date": today_iso(),
        })
        if bootstrap_has_transactions is not None:
            flags["has_transactions"] = bootstrap_has_transactions
        else:
            flags["has_transactions"] = bool(
                daily.get("has_any_transactions")
                or daily.get("total_transactions_count")
                or daily.get("transactions_count_all_time")
                or daily.get("items", [])
            )
    except (RPCError, RPCTransportError):
        flags["has_transactions"] = True

    flags["smart_save_available"] = flags["has_goals"] and flags["has_budget"]
    if bootstrap_is_first_run is not None:
        flags["is_new_user"] = bootstrap_is_first_run
    else:
        flags["is_new_user"] = not flags["has_goals"] and not flags["has_budget"] and not flags["has_transactions"]
    return flags


async def get_main_menu(tg_user_id: int, lang: str | None = None, bootstrap: dict | None = None):
    flags = await get_user_flags(tg_user_id, bootstrap=bootstrap)
    return main_menu(flags, lang)
