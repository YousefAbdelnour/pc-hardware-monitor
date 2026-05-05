from __future__ import annotations

import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

import hardware


def test_merge_sensor_metrics_overlays_reader_payload():
    base = hardware.get_psutil_metrics()
    reader_payload = {
        "cpu": {
            "usage": 42.5,
            "temp": 71.2,
            "clock_mhz": 4987.4,
            "power_w": 92.3,
        },
        "gpu": {
            "usage": 11.1,
            "temp": 33.8,
            "vram_usage": 24.7,
            "vram_temp": 47.0,
            "vram_used_mb": 4102,
            "vram_total_mb": 16303,
        },
        "motherboard": {"temp": 36.0},
        "storage": {"temp": 25.0},
        "fans": [
            {"name": "Fan #2", "rpm": 1400},
            {"name": "GPU Fan 1", "rpm": 0},
            {"name": "", "rpm": 987},
        ],
        "source": "Monitor Sensor Reader",
        "sampled_at": "2026-04-06T22:07:57.0959337+00:00",
    }

    merged = hardware.merge_sensor_metrics(base, reader_payload)

    assert merged["cpu"] == {
        "usage": 42.5,
        "temp": 71.2,
        "clock_mhz": 4987.4,
        "power_w": 92.3,
    }
    assert merged["gpu"] == {
        "usage": 11.1,
        "temp": 33.8,
        "vram_usage": 24.7,
        "vram_temp": 47.0,
        "vram_used_mb": 4102.0,
        "vram_total_mb": 16303.0,
    }
    assert merged["motherboard"]["temp"] == 36.0
    assert merged["storage"]["temp"] == 25.0
    assert merged["fans"] == [
        {"name": "Fan 2", "rpm": 1400},
        {"name": "Fan", "rpm": 987},
    ]
    assert merged["telemetry"] == {
        "sensor_connected": True,
        "source_name": "Monitor Sensor Reader",
        "sampled_at": "2026-04-06T22:07:57.0959337+00:00",
    }


def test_merge_sensor_metrics_preserves_fallback_values_when_reader_is_sparse():
    base = hardware.get_psutil_metrics()
    fallback_cpu_usage = base["cpu"]["usage"]
    fallback_storage_usage = base["storage"]["usage"]

    merged = hardware.merge_sensor_metrics(
        base,
        {
            "cpu": {"temp": 68.0},
            "gpu": {"temp": None},
            "fans": [{"name": "Fan #7", "rpm": 3000}],
            "source": "Monitor Sensor Reader",
            "sampled_at": "2026-04-06T22:10:00+00:00",
        },
    )

    assert merged["cpu"]["usage"] == fallback_cpu_usage
    assert merged["cpu"]["temp"] == 68.0
    assert merged["storage"]["usage"] == fallback_storage_usage
    assert merged["storage"]["temp"] is None
    assert merged["fans"] == [{"name": "Fan 7", "rpm": 3000}]


def test_merge_sensor_metrics_ignores_impossible_cpu_zero_values():
    base = hardware.get_psutil_metrics()
    base["cpu"]["clock_mhz"] = 4501.0
    base["cpu"]["temp"] = None
    base["cpu"]["power_w"] = None

    merged = hardware.merge_sensor_metrics(
        base,
        {
            "cpu": {"usage": 12.5, "temp": 0, "clock_mhz": 0, "power_w": 0},
            "source": "Monitor Sensor Reader",
            "sampled_at": "2026-05-05T01:20:00+00:00",
        },
    )

    assert merged["cpu"] == {
        "usage": 12.5,
        "temp": None,
        "clock_mhz": 4501.0,
        "power_w": None,
    }


class DummyResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


def test_read_sensor_metrics_uses_recent_cache_on_failure(monkeypatch):
    payload = {"cpu": {"usage": 55.0}}
    request_count = {"value": 0}

    def fake_get(_url, timeout):
        request_count["value"] += 1
        assert timeout == hardware.SENSOR_READER_TIMEOUT
        if request_count["value"] == 1:
            return DummyResponse(payload)
        raise RuntimeError("reader offline")

    monotonic_values = iter([10.0, 11.0, 11.0])

    monkeypatch.setattr(hardware.SENSOR_READER_SESSION, "get", fake_get)
    monkeypatch.setattr(hardware.time, "monotonic", lambda: next(monotonic_values))
    monkeypatch.setattr(hardware, "LAST_SENSOR_DATA", None)
    monkeypatch.setattr(hardware, "LAST_SENSOR_SUCCESS_AT", 0.0)

    assert hardware.read_sensor_metrics() == payload
    assert hardware.read_sensor_metrics() == payload


def test_get_all_metrics_reuses_recent_merged_snapshot(monkeypatch):
    counts = {"psutil": 0, "sensor": 0}

    def fake_psutil_metrics():
        counts["psutil"] += 1
        return {
            "cpu": {"usage": 10.0, "temp": None, "clock_mhz": None, "power_w": None},
            "gpu": {
                "usage": None,
                "temp": None,
                "vram_usage": None,
                "vram_temp": None,
                "vram_used_mb": None,
                "vram_total_mb": None,
            },
            "ram": {"usage": 20.0, "temp": None, "used_gb": 8.0, "total_gb": 16.0},
            "storage": {"usage": 30.0, "temp": None, "used_gb": 100.0, "total_gb": 500.0},
            "network": {"bytes_sent": 0, "bytes_recv": 0},
            "system": {"uptime": "0:00:01"},
            "telemetry": {"sensor_connected": False, "source_name": None, "sampled_at": None},
            "motherboard": {"usage": None, "temp": None},
            "fans": [],
        }

    def fake_sensor_metrics():
        counts["sensor"] += 1
        return {"cpu": {"temp": 65.0}, "fans": [], "source": "Reader", "sampled_at": "now"}

    monotonic_values = iter([50.0, 50.1, 50.4])

    monkeypatch.setattr(hardware, "get_psutil_metrics", fake_psutil_metrics)
    monkeypatch.setattr(hardware, "read_sensor_metrics", fake_sensor_metrics)
    monkeypatch.setattr(hardware.time, "monotonic", lambda: next(monotonic_values))
    monkeypatch.setattr(hardware, "LAST_METRICS_DATA", None)
    monkeypatch.setattr(hardware, "LAST_METRICS_AT", 0.0)

    first = hardware.get_all_metrics()
    second = hardware.get_all_metrics()
    third = hardware.get_all_metrics()

    assert first is second
    assert third is not second
    assert counts == {"psutil": 2, "sensor": 2}


def test_read_cpu_clock_mhz_uses_psutil_frequency(monkeypatch):
    class DummyFrequency:
        current = 4501.0

    monkeypatch.setattr(hardware.psutil, "cpu_freq", lambda: DummyFrequency())

    assert hardware.read_cpu_clock_mhz() == 4501.0
