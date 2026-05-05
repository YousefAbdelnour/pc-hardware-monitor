from __future__ import annotations

import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

import main


def test_resolve_update_interval_seconds_clamps_to_safe_range():
    assert main.resolve_update_interval_seconds(None) == 0.5
    assert main.resolve_update_interval_seconds("100") == 0.25
    assert main.resolve_update_interval_seconds("250") == 0.25
    assert main.resolve_update_interval_seconds("5000") == 2.0
    assert main.resolve_update_interval_seconds("wat") == 0.5
