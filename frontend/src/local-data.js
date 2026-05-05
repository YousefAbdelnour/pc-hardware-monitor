const PROFILE_STORAGE_KEY = "pc-hardware-monitor.profile.v1";
const ARCHIVE_STORAGE_KEY = "pc-hardware-monitor.archive.v1";
const RELEASE_ENDPOINT =
  "https://api.github.com/repos/YousefAbdelnour/pc-hardware-monitor/releases/latest";

export const SENSOR_CARD_KEYS = ["cpu", "gpu", "ram", "vram", "storage", "motherboard"];
export const QUICK_PILL_KEYS = [
  "fans",
  "systemLoad",
  "cpuPower",
  "cpuClock",
  "gpuTemp",
  "uptime",
  "vram",
  "connection",
];

export const DEFAULT_PROFILE = {
  ui: {
    sidebarCollapsed: false,
  },
  alerts: {
    cpuTempEnabled: true,
    cpuTempThresholdC: 85,
    gpuTempEnabled: true,
    gpuTempThresholdC: 85,
    cpuUsageEnabled: false,
    cpuUsageThreshold: 95,
    gpuUsageEnabled: false,
    gpuUsageThreshold: 95,
  },
  sensorLayout: {
    cardOrder: SENSOR_CARD_KEYS,
    hiddenCards: [],
    visiblePills: QUICK_PILL_KEYS,
    fanAliases: {},
  },
  updateCenter: {
    state: "idle",
    message: "Ready to check for updates.",
    latestVersion: null,
    downloadUrl: null,
    publishedAt: null,
    notes: null,
    lastCheckedAt: null,
  },
};

export const DEFAULT_ARCHIVE = {
  sessions: [],
  alerts: [],
};

function normalizeThreshold(value, fallback, min, max) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return fallback;
  return Math.min(Math.max(Math.round(numeric), min), max);
}

function normalizeSession(entry = {}) {
  return {
    id: entry.id ?? `session-${Date.now()}`,
    startedAt: Number(entry.startedAt) || Date.now(),
    endedAt: Number(entry.endedAt) || Date.now(),
    sampleCount: Number(entry.sampleCount) || 0,
    loggedSampleCount: Number(entry.loggedSampleCount) || 0,
    sensorConnected: Boolean(entry.sensorConnected),
    cpuPeakC: entry.cpuPeakC == null ? null : Number(entry.cpuPeakC),
    gpuPeakC: entry.gpuPeakC == null ? null : Number(entry.gpuPeakC),
    avgCpuLoad: entry.avgCpuLoad == null ? null : Number(entry.avgCpuLoad),
    avgGpuLoad: entry.avgGpuLoad == null ? null : Number(entry.avgGpuLoad),
    avgRamLoad: entry.avgRamLoad == null ? null : Number(entry.avgRamLoad),
    alertCount: Number(entry.alertCount) || 0,
  };
}

function normalizeAlert(entry = {}) {
  return {
    id: entry.id ?? `alert-${Date.now()}`,
    sessionId: entry.sessionId ?? "unknown-session",
    kind: entry.kind ?? "alert",
    title: entry.title ?? "Monitor alert",
    message: entry.message ?? "",
    value: entry.value == null ? null : Number(entry.value),
    threshold: entry.threshold == null ? null : Number(entry.threshold),
    timestamp: Number(entry.timestamp) || Date.now(),
    severity: entry.severity ?? "warn",
  };
}

function dedupeKeys(values, allowed) {
  return values.filter((value, index) => allowed.includes(value) && values.indexOf(value) === index);
}

export function normalizeProfile(input = {}) {
  const ui = input.ui ?? {};
  const alerts = input.alerts ?? {};
  const sensorLayout = input.sensorLayout ?? {};
  const updateCenter = input.updateCenter ?? {};

  return {
    ui: {
      sidebarCollapsed: Boolean(ui.sidebarCollapsed),
    },
    alerts: {
      cpuTempEnabled:
        alerts.cpuTempEnabled == null ? DEFAULT_PROFILE.alerts.cpuTempEnabled : Boolean(alerts.cpuTempEnabled),
      cpuTempThresholdC: normalizeThreshold(
        alerts.cpuTempThresholdC,
        DEFAULT_PROFILE.alerts.cpuTempThresholdC,
        65,
        100
      ),
      gpuTempEnabled:
        alerts.gpuTempEnabled == null ? DEFAULT_PROFILE.alerts.gpuTempEnabled : Boolean(alerts.gpuTempEnabled),
      gpuTempThresholdC: normalizeThreshold(
        alerts.gpuTempThresholdC,
        DEFAULT_PROFILE.alerts.gpuTempThresholdC,
        65,
        100
      ),
      cpuUsageEnabled:
        alerts.cpuUsageEnabled == null ? DEFAULT_PROFILE.alerts.cpuUsageEnabled : Boolean(alerts.cpuUsageEnabled),
      cpuUsageThreshold: normalizeThreshold(
        alerts.cpuUsageThreshold,
        DEFAULT_PROFILE.alerts.cpuUsageThreshold,
        70,
        100
      ),
      gpuUsageEnabled:
        alerts.gpuUsageEnabled == null ? DEFAULT_PROFILE.alerts.gpuUsageEnabled : Boolean(alerts.gpuUsageEnabled),
      gpuUsageThreshold: normalizeThreshold(
        alerts.gpuUsageThreshold,
        DEFAULT_PROFILE.alerts.gpuUsageThreshold,
        70,
        100
      ),
    },
    sensorLayout: {
      cardOrder:
        dedupeKeys(sensorLayout.cardOrder ?? [], SENSOR_CARD_KEYS).length === SENSOR_CARD_KEYS.length
          ? dedupeKeys(sensorLayout.cardOrder ?? [], SENSOR_CARD_KEYS)
          : SENSOR_CARD_KEYS,
      hiddenCards: dedupeKeys(sensorLayout.hiddenCards ?? [], SENSOR_CARD_KEYS),
      visiblePills: (() => {
        const next = dedupeKeys(sensorLayout.visiblePills ?? [], QUICK_PILL_KEYS);
        return next.length ? next : QUICK_PILL_KEYS;
      })(),
      fanAliases:
        sensorLayout.fanAliases && typeof sensorLayout.fanAliases === "object" ? sensorLayout.fanAliases : {},
    },
    updateCenter: {
      state: updateCenter.state ?? DEFAULT_PROFILE.updateCenter.state,
      message: updateCenter.message ?? DEFAULT_PROFILE.updateCenter.message,
      latestVersion: updateCenter.latestVersion ?? null,
      downloadUrl: updateCenter.downloadUrl ?? null,
      publishedAt: updateCenter.publishedAt ?? null,
      notes: updateCenter.notes ?? null,
      lastCheckedAt: updateCenter.lastCheckedAt ?? null,
    },
  };
}

export function loadProfile() {
  try {
    const raw = window.localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return DEFAULT_PROFILE;
    return normalizeProfile(JSON.parse(raw));
  } catch {
    return DEFAULT_PROFILE;
  }
}

export function saveProfile(profile) {
  const normalized = normalizeProfile(profile);
  window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function normalizeArchive(input = {}) {
  return {
    sessions: Array.isArray(input.sessions) ? input.sessions.map(normalizeSession).slice(0, 14) : [],
    alerts: Array.isArray(input.alerts) ? input.alerts.map(normalizeAlert).slice(0, 80) : [],
  };
}

export function loadArchive() {
  try {
    const raw = window.localStorage.getItem(ARCHIVE_STORAGE_KEY);
    if (!raw) return DEFAULT_ARCHIVE;
    return normalizeArchive(JSON.parse(raw));
  } catch {
    return DEFAULT_ARCHIVE;
  }
}

export function saveArchive(archive) {
  const normalized = normalizeArchive(archive);
  window.localStorage.setItem(ARCHIVE_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function upsertSessionSummary(sessions, summary) {
  const next = [summary, ...sessions.filter((entry) => entry.id !== summary.id)];
  next.sort((left, right) => right.startedAt - left.startedAt);
  return next.slice(0, 14);
}

export function mergeAlerts(alerts, additions) {
  const next = [...additions, ...alerts.filter((entry) => !additions.some((alert) => alert.id === entry.id))];
  next.sort((left, right) => right.timestamp - left.timestamp);
  return next.slice(0, 80);
}

function parseVersion(version) {
  return String(version)
    .replace(/^v/i, "")
    .split(".")
    .map((segment) => Number(segment) || 0);
}

export function compareVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  const width = Math.max(left.length, right.length);

  for (let index = 0; index < width; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }

  return 0;
}

export async function fetchLatestRelease() {
  const response = await fetch(RELEASE_ENDPOINT, {
    headers: {
      Accept: "application/vnd.github+json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`GitHub release check failed with status ${response.status}.`);
  }

  const payload = await response.json();
  return {
    version: String(payload.tag_name ?? "").replace(/^v/i, ""),
    downloadUrl: payload.html_url ?? null,
    publishedAt: payload.published_at ?? null,
    notes: payload.body ?? "",
  };
}
