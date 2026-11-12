import inspect
import os
import tempfile
from pathlib import Path
import pytest


@pytest.fixture(autouse=True)
def windows_cleanup(monkeypatch):
    """Defer only gltest's Windows open-message-file unlink, never VM failures."""
    if os.name != "nt":
        yield
        return
    original, pending = os.unlink, []
    temporary = Path(tempfile.gettempdir()).resolve()
    def unlink(path, *args, **kwargs):
        try:
            return original(path, *args, **kwargs)
        except PermissionError as exc:
            caller = inspect.currentframe().f_back.f_code.co_name
            resolved = Path(path).resolve()
            if (getattr(exc, "winerror", None) != 32 or caller != "_inject_message_to_fd0"
                    or resolved.parent != temporary or not resolved.name.startswith("tmp")):
                raise
            pending.append(resolved)
    monkeypatch.setattr(os, "unlink", unlink)
    yield
    for path in pending:
        try:
            original(path)
        except FileNotFoundError:
            pass
