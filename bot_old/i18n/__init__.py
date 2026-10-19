from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SUPPORTED_LANGS = ("ru", "uz", "en")
DEFAULT_LANG = "ru"


def normalize_lang(lang: str | None) -> str:
    if not lang:
        return DEFAULT_LANG
    lang = lang.lower()
    if lang.startswith("ru"):
        return "ru"
    if lang.startswith("uz"):
        return "uz"
    if lang.startswith("en"):
        return "en"
    return DEFAULT_LANG


def _load_translations() -> dict[str, dict[str, Any]]:
    base = Path(__file__).resolve().parent.parent / "locales"
    data: dict[str, dict[str, Any]] = {}
    for code in SUPPORTED_LANGS:
        path = base / f"{code}.json"
        if not path.exists():
            data[code] = {}
            continue
        data[code] = json.loads(path.read_text(encoding="utf-8"))
    return data


_TRANSLATIONS = _load_translations()


def t(key: str, lang: str | None = None, **kwargs) -> str:
    lang = normalize_lang(lang)
    value = _TRANSLATIONS.get(lang, {}).get(key)
    if value is None:
        value = _TRANSLATIONS.get(DEFAULT_LANG, {}).get(key, key)
    if kwargs:
        try:
            return str(value).format(**kwargs)
        except KeyError:
            return str(value)
    return str(value)


def get_language_label(lang: str, ui_lang: str | None = None) -> str:
    lang = normalize_lang(lang)
    return t(f"language.options.{lang}", ui_lang or lang)
