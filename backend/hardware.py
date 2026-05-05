from __future__ import annotations

import time
from datetime import datetime

import psutil
import requests

BOOT_TIME = datetime.fromtimestamp(psutil.boot_time())
SENSOR_READER_URL = "http://127.0.0.1:8095/metrics"
SENSOR_READER_TIMEOUT = (0.05, 0.12)
SENSOR_READER_CACHE_TTL_SECONDS = 5.0
METRICS_CACHE_TTL_SECONDS = 0.25
SENSOR_READER_SESSION = requests.Session()
LAST_SENSOR_DATA = None
LAST_SENSOR_SUCCESS_AT = 0.0
LAST_METRICS_DATA = None
LAST_METRICS_AT = 0.0

# Prime psutil so subsequent cpu_percent calls are instantaneous.
psutil.cpu_percent(interval=None)


def bytes_to_gb(value: int | float) -> float:
    return round(value / (1024**3), 2)


def coerce_float(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.strip().replace(",", "")
        if not cleaned:
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def positive_float(value):
    numeric = coerce_float(value)
    if numeric is None or numeric <= 0:
        return None
    return numeric


def read_cpu_clock_mhz() -> float | None:
    try:
        frequency = psutil.cpu_freq()
    except Exception:
        return None

    if frequency is None:
        return None

    current = positive_float(getattr(frequency, "current", None))
    return round(current, 1) if current is not None else None


def read_sensor_metrics() -> dict | None:
    global LAST_SENSOR_DATA, LAST_SENSOR_SUCCESS_AT

    try:
        response = SENSOR_READER_SESSION.get(SENSOR_READER_URL, timeout=SENSOR_READER_TIMEOUT)
        response.raise_for_status()
        LAST_SENSOR_DATA = response.json()
        LAST_SENSOR_SUCCESS_AT = time.monotonic()
        return LAST_SENSOR_DATA
    except Exception:
        if (
            LAST_SENSOR_DATA is not None
            and time.monotonic() - LAST_SENSOR_SUCCESS_AT <= SENSOR_READER_CACHE_TTL_SECONDS
        ):
            return LAST_SENSOR_DATA
        return None


def normalize_fan_name(name) -> str:
    cleaned = str(name or "Fan").replace("#", " ")
    return " ".join(cleaned.split()) or "Fan"


def normalize_fans(fans) -> list[dict]:
    normalized = []

    for fan in fans or []:
        if not isinstance(fan, dict):
            continue

        rpm = coerce_float(fan.get("rpm"))
        if rpm is None or rpm <= 0:
            continue

        normalized.append(
            {
                "name": normalize_fan_name(fan.get("name")),
                "rpm": round(rpm),
            }
        )

    return normalized


def overlay_section(base: dict, reader: dict, keys: tuple[str, ...]):
    if not isinstance(reader, dict):
        return

    for key in keys:
        value = coerce_float(reader.get(key))
        if value is not None:
            base[key] = round(value, 1)


def get_psutil_metrics() -> dict:
    vm = psutil.virtual_memory()
    du = psutil.disk_usage("C:/")
    uptime = str(datetime.now() - BOOT_TIME).split(".")[0]

    return {
        "cpu": {
            "usage": round(psutil.cpu_percent(interval=None), 1),
            "temp": None,
            "clock_mhz": read_cpu_clock_mhz(),
            "power_w": None,
        },
        "gpu": {
            "usage": None,
            "temp": None,
            "vram_usage": None,
            "vram_temp": None,
            "vram_used_mb": None,
            "vram_total_mb": None,
        },
        "ram": {
            "usage": round(vm.percent, 1),
            "temp": None,
            "used_gb": bytes_to_gb(vm.used),
            "total_gb": bytes_to_gb(vm.total),
        },
        "storage": {
            "usage": round(du.percent, 1),
            "temp": None,
            "used_gb": bytes_to_gb(du.used),
            "total_gb": bytes_to_gb(du.total),
        },
        "system": {
            "uptime": uptime,
        },
        "telemetry": {
            "sensor_connected": False,
            "source_name": None,
            "sampled_at": None,
        },
        "motherboard": {
            "usage": None,
            "temp": None,
        },
        "fans": [],
    }


def merge_sensor_metrics(base: dict, reader_data: dict | None) -> dict:
    if not isinstance(reader_data, dict):
        return base

    overlay_section(base["cpu"], reader_data.get("cpu"), ("usage",))
    overlay_positive_fields(base["cpu"], reader_data.get("cpu"), ("temp", "clock_mhz", "power_w"))
    overlay_section(
        base["gpu"],
        reader_data.get("gpu"),
        ("usage", "temp", "vram_usage", "vram_temp", "vram_used_mb", "vram_total_mb"),
    )
    overlay_section(base["motherboard"], reader_data.get("motherboard"), ("temp",))
    overlay_section(base["storage"], reader_data.get("storage"), ("temp",))

    base["telemetry"]["sensor_connected"] = True
    base["telemetry"]["source_name"] = str(reader_data.get("source") or "Monitor Sensor Reader")
    base["telemetry"]["sampled_at"] = reader_data.get("sampled_at")
    base["fans"] = normalize_fans(reader_data.get("fans"))
    return base


def overlay_positive_fields(base: dict, reader: dict, keys: tuple[str, ...]):
    if not isinstance(reader, dict):
        return

    for key in keys:
        value = positive_float(reader.get(key))
        if value is not None:
            base[key] = round(value, 1)


def get_all_metrics() -> dict:
    global LAST_METRICS_DATA, LAST_METRICS_AT

    now = time.monotonic()
    if LAST_METRICS_DATA is not None and now - LAST_METRICS_AT <= METRICS_CACHE_TTL_SECONDS:
        return LAST_METRICS_DATA

    LAST_METRICS_DATA = merge_sensor_metrics(get_psutil_metrics(), read_sensor_metrics())
    LAST_METRICS_AT = now
    return LAST_METRICS_DATA
