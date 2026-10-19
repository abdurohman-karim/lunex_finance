import json
import logging
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock
from typing import Any


def load_json_dict(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}

    try:
        content = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logging.exception("Failed to load JSON cache file: %s", path)
        return {}

    if isinstance(content, dict):
        return content

    logging.error("JSON cache file must contain an object: %s", path)
    return {}


def atomic_write_json(path: Path, payload: dict[str, Any], ensure_ascii: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    with NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=str(path.parent),
        delete=False,
    ) as tmp:
        json.dump(payload, tmp, ensure_ascii=ensure_ascii)
        tmp.flush()
        temp_path = Path(tmp.name)

    temp_path.replace(path)


class JsonStore:
    def __init__(self, path: str, ensure_ascii: bool = True):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()
        self._ensure_ascii = ensure_ascii
        self._data = load_json_dict(self.path)

    def _save(self) -> None:
        with self._lock:
            atomic_write_json(self.path, self._data, ensure_ascii=self._ensure_ascii)
