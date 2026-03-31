from __future__ import annotations

import time
from datetime import datetime

import psutil
import requests

BOOT_TIME = datetime.fromtimestamp(psutil.boot_time())
LHM_URL = "http://127.0.0.1:8085/data.json"
LHM_TIMEOUT = (0.1, 0.25)
LHM_CACHE_TTL_SECONDS = 5.0
LHM_SESSION = requests.Session()
CPU_PATH_HINTS = ("cpu", "amd", "intel", "ryzen", "core")
GPU_PATH_HINTS = ("gpu", "nvidia", "geforce", "radeon", "rtx", "gtx")
BOARD_PATH_HINTS = ("mainboard", "motherboard", "lpc", "superio", "nuvoton", "ite")
STORAGE_PATH_HINTS = (
    "nvme",
    "ssd",
    "hdd",
    "drive",
    "disk",
    "samsung",
    "wd",
    "wdc",
    "crucial",
    "kingston",
    "seagate",
)
LAST_LHM_DATA = None
LAST_LHM_SUCCESS_AT = 0.0

# Prime psutil so subsequent cpu_percent calls are instantaneous.
psutil.cpu_percent(interval=None)


def bytes_to_gb(value: int | float) -> float:
    return round(value / (1024**3), 2)


def parse_numeric_value(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        # Sensor strings can arrive with a few different encoding artifacts
        # depending on how LibreHardwareMonitor formats the payload.
        cleaned = (
            value.replace("°C", "")
            .replace("Â°C", "")
            .replace("Ã‚Â°C", "")
            .replace("Ãƒâ€šÃ‚Â°C", "")
            .replace("ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°C", "")
            .replace("%", "")
            .replace(" MHz", "")
            .replace(" GB", "")
            .replace(" MB", "")
            .replace(" RPM", "")
            .replace(" W", "")
            .replace(" V", "")
            .strip()
        )
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def walk_children(node: dict, path=None):
    if path is None:
        path = []
    current_path = path + [str(node.get("Text", ""))]
    yield node, current_path
    for child in node.get("Children", []) or []:
        yield from walk_children(child, current_path)


def text_contains_all(text: str, terms: tuple[str, ...] | list[str]):
    return all(term.lower() in text for term in terms)


def text_contains_any(text: str, terms: tuple[str, ...] | list[str]):
    return any(term.lower() in text for term in terms)


def first_present(*values):
    for value in values:
        if value is not None:
            return value
    return None


def read_lhm_data() -> dict | None:
    global LAST_LHM_DATA, LAST_LHM_SUCCESS_AT

    try:
        response = LHM_SESSION.get(LHM_URL, timeout=LHM_TIMEOUT)
        response.raise_for_status()
        LAST_LHM_DATA = response.json()
        LAST_LHM_SUCCESS_AT = time.monotonic()
        return LAST_LHM_DATA
    except Exception:
        # A short cache keeps the UI from flickering empty when LHM takes a
        # beat to respond even though the process is still healthy.
        if LAST_LHM_DATA is not None and time.monotonic() - LAST_LHM_SUCCESS_AT <= LHM_CACHE_TTL_SECONDS:
            return LAST_LHM_DATA
        return None


def normalize_type(sensor_type: str) -> str:
    return sensor_type.lower().replace(" ", "")


def find_first_sensor(
    data: dict,
    sensor_type: str,
    path_all_terms: list[str] | None = None,
    text_all_terms: list[str] | None = None,
    path_any_terms: tuple[str, ...] | list[str] | None = None,
    text_any_terms: tuple[str, ...] | list[str] | None = None,
    exclude_path_terms: tuple[str, ...] | list[str] | None = None,
    exclude_text_terms: tuple[str, ...] | list[str] | None = None,
):
    if not data:
        return None

    # Sensor names vary a lot between vendors, so matching is based on a mix
    # of path hints and display text instead of one rigid exact name.
    wanted_type = normalize_type(sensor_type)
    path_all_terms = path_all_terms or []
    text_all_terms = text_all_terms or []
    path_any_terms = path_any_terms or []
    text_any_terms = text_any_terms or []
    exclude_path_terms = exclude_path_terms or []
    exclude_text_terms = exclude_text_terms or []

    for node, path in walk_children(data):
        node_type = normalize_type(str(node.get("Type", "")))
        text = str(node.get("Text", "")).lower()
        full_path = " / ".join(part.lower() for part in path)

        if node_type != wanted_type:
            continue

        if path_all_terms and not text_contains_all(full_path, path_all_terms):
            continue

        if path_any_terms and not text_contains_any(full_path, path_any_terms):
            continue

        if text_all_terms and not text_contains_all(text, text_all_terms):
            continue

        if text_any_terms and not text_contains_any(text, text_any_terms):
            continue

        if exclude_path_terms and text_contains_any(full_path, exclude_path_terms):
            continue

        if exclude_text_terms and text_contains_any(text, exclude_text_terms):
            continue

        numeric = parse_numeric_value(node.get("Value"))
        if numeric is not None:
            return round(numeric, 1)

    return None


def extract_active_fans(data: dict) -> list[dict]:
    fans = []
    if not data:
        return fans

    for node, _path in walk_children(data):
        if normalize_type(str(node.get("Type", ""))) != "fan":
            continue

        rpm = parse_numeric_value(node.get("Value"))
        if rpm is None or rpm <= 0:
            continue

        name = str(node.get("Text", "")).strip() or "Fan"
        fans.append({
            "name": name,
            "rpm": round(rpm),
        })

    return fans


def get_psutil_metrics() -> dict:
    vm = psutil.virtual_memory()
    du = psutil.disk_usage("C:/")
    net = psutil.net_io_counters()
    uptime = str(datetime.now() - BOOT_TIME).split(".")[0]

    return {
        "cpu": {
            "usage": round(psutil.cpu_percent(interval=None), 1),
            "temp": None,
            "clock_mhz": None,
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
        "network": {
            "bytes_sent": net.bytes_sent,
            "bytes_recv": net.bytes_recv,
        },
        "system": {
            "uptime": uptime,
        },
        "telemetry": {
            "lhm_connected": False,
        },
        "motherboard": {
            "usage": None,
            "temp": None,
        },
        "fans": [],
    }


def merge_lhm_metrics(base: dict) -> dict:
    lhm = read_lhm_data()
    if not lhm:
        return base

    # Prefer known exact matches first, then fall back to broader vendor-aware
    # matching so the dashboard still works across different hardware.
    cpu_temp = first_present(
        find_first_sensor(
            lhm,
            "temperature",
            path_all_terms=["amd ryzen 7 7700x", "temperatures"],
            text_all_terms=["core (tctl/tdie)"],
        ),
        find_first_sensor(
            lhm,
            "temperature",
            path_all_terms=["temperatures"],
            path_any_terms=CPU_PATH_HINTS,
            text_any_terms=["tctl", "tdie", "package", "cpu package"],
        ),
    )
    cpu_usage = first_present(
        find_first_sensor(
            lhm,
            "load",
            path_all_terms=["amd ryzen 7 7700x", "load"],
            text_all_terms=["cpu total"],
        ),
        find_first_sensor(
            lhm,
            "load",
            path_all_terms=["load"],
            path_any_terms=CPU_PATH_HINTS,
            text_any_terms=["cpu total", "total"],
        ),
    )
    cpu_clock = first_present(
        find_first_sensor(
            lhm,
            "clock",
            path_all_terms=["amd ryzen 7 7700x", "clocks"],
            text_all_terms=["cores (average)"],
        ),
        find_first_sensor(
            lhm,
            "clock",
            path_all_terms=["clocks"],
            path_any_terms=CPU_PATH_HINTS,
            text_any_terms=["average", "effective clock"],
        ),
    )
    cpu_power = first_present(
        find_first_sensor(
            lhm,
            "power",
            path_all_terms=["amd ryzen 7 7700x", "powers"],
            text_all_terms=["package"],
        ),
        find_first_sensor(
            lhm,
            "power",
            path_all_terms=["powers"],
            path_any_terms=CPU_PATH_HINTS,
            text_any_terms=["package", "cpu package", "total"],
        ),
    )

    gpu_temp = first_present(
        find_first_sensor(
            lhm,
            "temperature",
            path_all_terms=["nvidia", "temperatures"],
            text_all_terms=["gpu core"],
        ),
        find_first_sensor(
            lhm,
            "temperature",
            path_all_terms=["temperatures"],
            path_any_terms=GPU_PATH_HINTS,
            text_any_terms=["gpu core", "hot spot", "edge"],
        ),
    )
    vram_temp = first_present(
        find_first_sensor(
            lhm,
            "temperature",
            path_all_terms=["nvidia", "temperatures"],
            text_all_terms=["gpu memory junction"],
        ),
        find_first_sensor(
            lhm,
            "temperature",
            path_all_terms=["temperatures"],
            path_any_terms=GPU_PATH_HINTS,
            text_any_terms=["memory junction", "memory", "vram"],
        ),
    )
    gpu_usage = first_present(
        find_first_sensor(
            lhm,
            "load",
            path_all_terms=["nvidia", "load"],
            text_all_terms=["gpu core"],
        ),
        find_first_sensor(
            lhm,
            "load",
            path_all_terms=["load"],
            path_any_terms=GPU_PATH_HINTS,
            text_any_terms=["gpu core", "gpu"],
        ),
    )
    vram_usage = first_present(
        find_first_sensor(
            lhm,
            "load",
            path_all_terms=["nvidia", "load"],
            text_all_terms=["gpu memory"],
        ),
        find_first_sensor(
            lhm,
            "load",
            path_all_terms=["load"],
            path_any_terms=GPU_PATH_HINTS,
            text_any_terms=["gpu memory", "vram", "memory controller"],
        ),
    )
    vram_used_mb = first_present(
        find_first_sensor(
            lhm,
            "smalldata",
            path_all_terms=["nvidia", "data"],
            text_all_terms=["gpu memory used"],
        ),
        find_first_sensor(
            lhm,
            "smalldata",
            path_all_terms=["data"],
            path_any_terms=GPU_PATH_HINTS,
            text_any_terms=["memory used", "vram used"],
        ),
    )
    if vram_used_mb is None:
        vram_used_mb = find_first_sensor(
            lhm,
            "data",
            path_all_terms=["data"],
            path_any_terms=GPU_PATH_HINTS,
            text_any_terms=["memory used", "vram used"],
        )

    vram_total_mb = first_present(
        find_first_sensor(
            lhm,
            "smalldata",
            path_all_terms=["nvidia", "data"],
            text_all_terms=["gpu memory total"],
        ),
        find_first_sensor(
            lhm,
            "smalldata",
            path_all_terms=["data"],
            path_any_terms=GPU_PATH_HINTS,
            text_any_terms=["memory total", "vram total"],
        ),
    )
    if vram_total_mb is None:
        vram_total_mb = find_first_sensor(
            lhm,
            "data",
            path_all_terms=["data"],
            path_any_terms=GPU_PATH_HINTS,
            text_any_terms=["memory total", "vram total"],
        )

    motherboard_temp = first_present(
        find_first_sensor(
            lhm,
            "temperature",
            path_all_terms=["asus prime x670e-pro wifi", "nuvoton nct6799d", "temperatures"],
            text_all_terms=["temperature #1"],
        ),
        find_first_sensor(
            lhm,
            "temperature",
            path_all_terms=["temperatures"],
            path_any_terms=BOARD_PATH_HINTS,
            text_any_terms=["temperature #1", "motherboard", "system", "board"],
            exclude_path_terms=CPU_PATH_HINTS + GPU_PATH_HINTS + STORAGE_PATH_HINTS,
        ),
    )
    storage_temp = first_present(
        find_first_sensor(
            lhm,
            "temperature",
            path_all_terms=["samsung", "temperatures"],
            text_all_terms=["composite"],
        ),
        find_first_sensor(
            lhm,
            "temperature",
            path_all_terms=["temperatures"],
            path_any_terms=STORAGE_PATH_HINTS,
            text_any_terms=["composite", "temperature #1", "temperature"],
            exclude_path_terms=GPU_PATH_HINTS,
        ),
    )

    fans = extract_active_fans(lhm)
    base["telemetry"]["lhm_connected"] = True

    if cpu_usage is not None:
        base["cpu"]["usage"] = cpu_usage
    if cpu_temp is not None:
        base["cpu"]["temp"] = cpu_temp
    if cpu_clock is not None:
        base["cpu"]["clock_mhz"] = cpu_clock
    if cpu_power is not None:
        base["cpu"]["power_w"] = cpu_power

    if gpu_usage is not None:
        base["gpu"]["usage"] = gpu_usage
    if gpu_temp is not None:
        base["gpu"]["temp"] = gpu_temp
    if vram_usage is not None:
        base["gpu"]["vram_usage"] = vram_usage
    if vram_temp is not None:
        base["gpu"]["vram_temp"] = vram_temp
    if vram_used_mb is not None:
        base["gpu"]["vram_used_mb"] = vram_used_mb
    if vram_total_mb is not None:
        base["gpu"]["vram_total_mb"] = vram_total_mb

    if motherboard_temp is not None:
        base["motherboard"]["temp"] = motherboard_temp
    if storage_temp is not None:
        base["storage"]["temp"] = storage_temp

    base["fans"] = fans
    return base


def get_all_metrics() -> dict:
    base = get_psutil_metrics()
    return merge_lhm_metrics(base)
