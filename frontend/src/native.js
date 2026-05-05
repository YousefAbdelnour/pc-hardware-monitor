import { invoke, isTauri } from "@tauri-apps/api/core";

const SETTINGS_STORAGE_KEY = "pc-hardware-monitor.settings.v2";

export const DEFAULT_SETTINGS = {
  launchAtStartup: false,
  startMinimized: false,
  closeToTray: true,
  backgroundLogging: true,
  refreshIntervalMs: 500,
  temperatureUnit: "c",
  capacityUnit: "gb",
};

function clampRefreshInterval(interval) {
  switch (interval) {
    case 250:
    case 500:
    case 1000:
    case 2000:
      return interval;
    default:
      return DEFAULT_SETTINGS.refreshIntervalMs;
  }
}

export function normalizeSettings(input = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...input,
    launchAtStartup: Boolean(input.launchAtStartup),
    startMinimized: Boolean(input.startMinimized),
    closeToTray: input.closeToTray == null ? DEFAULT_SETTINGS.closeToTray : Boolean(input.closeToTray),
    backgroundLogging:
      input.backgroundLogging == null
        ? DEFAULT_SETTINGS.backgroundLogging
        : Boolean(input.backgroundLogging),
    refreshIntervalMs: clampRefreshInterval(Number(input.refreshIntervalMs)),
    temperatureUnit: input.temperatureUnit === "f" ? "f" : "c",
    capacityUnit: input.capacityUnit === "mb" ? "mb" : "gb",
  };
}

function loadBrowserSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveBrowserSettings(settings) {
  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export function supportsNativeShell() {
  return isTauri();
}

export async function loadAppSettings() {
  if (supportsNativeShell()) {
    return normalizeSettings(await invoke("load_settings"));
  }

  return loadBrowserSettings();
}

export async function saveAppSettings(nextSettings) {
  const normalized = normalizeSettings(nextSettings);

  if (supportsNativeShell()) {
    return normalizeSettings(await invoke("save_settings", { settings: normalized }));
  }

  saveBrowserSettings(normalized);
  return normalized;
}

export async function loadRuntimeDiagnostics() {
  if (supportsNativeShell()) {
    return await invoke("get_runtime_diagnostics");
  }

  return {
    mode: "browser",
    capturedAtMs: Date.now(),
    backendProcess: { running: false, pid: null, exitCode: null },
    backendPortOpen: false,
    sensorReaderProcess: { running: false, pid: null, exitCode: null },
    sensorReaderPortOpen: false,
    lastBackendError: null,
    lastSensorReaderError: null,
    settingsPath: null,
    localDataDir: null,
    launchAtStartup: false,
  };
}

export async function hideAppToTray() {
  if (!supportsNativeShell()) {
    return;
  }

  await invoke("hide_to_tray");
}

function triggerBrowserDownload(filename, contents) {
  const blob = new Blob([contents], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function saveSessionCsv(filename, contents) {
  if (supportsNativeShell()) {
    return await invoke("save_session_csv", { fileName: filename, contents });
  }

  triggerBrowserDownload(filename, contents);
  return filename;
}

export async function finishAppBoot() {
  if (!supportsNativeShell()) {
    return;
  }

  await invoke("finish_app_boot");
}

export async function openReleasePage() {
  if (supportsNativeShell()) {
    await invoke("open_release_page");
    return;
  }

  window.open("https://github.com/YousefAbdelnour/pc-hardware-monitor/releases", "_blank", "noopener,noreferrer");
}
