"""Atomic JSON snapshots, resilient to temporary Windows file sharing conflicts."""
import json
import os
import tempfile
import time
from pathlib import Path

def atomic_text(path, content):
    """Atomic JSON with private temp names and bounded Windows sharing retries."""
    path = Path(path)
    descriptor, name = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            stream.write(content)
        for attempt in range(8):
            try:
                os.replace(temporary, path)
                break
            except PermissionError:
                if attempt == 7:
                    raise
                time.sleep(min(.01 * 2 ** attempt, .2))
    finally:
        temporary.unlink(missing_ok=True)


def dump(path, value):
    atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))
