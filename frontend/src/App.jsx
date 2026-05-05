import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { getVersion } from "@tauri-apps/api/app";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BellRing,
  ChevronsLeft,
  ChevronsRight,
  ClipboardList,
  Cpu,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Fan,
  Gauge,
  HardDrive,
  History,
  LayoutDashboard,
  MemoryStick,
  Menu,
  Monitor,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Thermometer,
  TimerReset,
  X,
  Zap,
} from "lucide-react";
import {
  compareVersions,
  DEFAULT_ARCHIVE,
  DEFAULT_PROFILE,
  fetchLatestRelease,
  loadArchive,
  loadProfile,
  mergeAlerts,
  QUICK_PILL_KEYS,
  saveArchive,
  saveProfile,
  upsertSessionSummary,
} from "./local-data";
import {
  DEFAULT_SETTINGS,
  finishAppBoot,
  hideAppToTray,
  loadAppSettings,
  loadRuntimeDiagnostics,
  openReleasePage,
  saveAppSettings,
  saveSessionCsv,
  supportsNativeShell,
} from "./native";

const HAS_NATIVE_SHELL = supportsNativeShell();
const SCREEN_OVERVIEW = "overview";
const SCREEN_SESSION = "session";
const SCREEN_DIAGNOSTICS = "diagnostics";
const SHORT_HISTORY_LENGTH = 120;
const MAX_SESSION_LOG_SAMPLES = 720;
const SESSION_LOG_SAMPLE_INTERVAL_MS = 1000;
const DIAGNOSTICS_REFRESH_INTERVAL_MS = 20000;
const BOOT_MIN_VISIBLE_MS = 850;
const BOOT_MAX_WAIT_MS = 1800;
const BOOT_REVEAL_MS = 780;
const TEMP_ALERT_OPTIONS_C = [70, 75, 80, 85, 90, 95];
const LOAD_ALERT_OPTIONS = [75, 80, 85, 90, 95, 100];
const REFRESH_OPTIONS = [250, 500, 1000, 2000];
const TEMPERATURE_UNIT = { c: "\u00b0C", f: "\u00b0F" };
const GAUGE_TICK_ANGLES = [-120, -90, -60, -30, 0, 30, 60, 90, 120];

const CARD_LABELS = {
  cpu: "CPU",
  gpu: "GPU",
  ram: "RAM",
  vram: "VRAM",
  storage: "Storage",
  motherboard: "Motherboard",
};

const QUICK_PILL_LABELS = {
  fans: "Fans",
  systemLoad: "System load",
  cpuPower: "CPU power",
  cpuClock: "CPU clock",
  gpuTemp: "GPU temp",
  uptime: "Uptime",
  vram: "VRAM used",
  connection: "Connection",
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function polarToCartesian(cx, cy, radius, angleDeg) {
  const angle = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle),
  };
}

function describeArc(x, y, radius, startAngle, endAngle) {
  const start = polarToCartesian(x, y, radius, endAngle);
  const end = polarToCartesian(x, y, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  return ["M", start.x, start.y, "A", radius, radius, 0, largeArcFlag, 0, end.x, end.y].join(" ");
}

function getNeedleAngle(value, max = 100) {
  return -120 + clamp((value ?? 0) / max, 0, 1) * 240;
}

function usageStatus(value) {
  if (value >= 90) return "Bad";
  if (value >= 70) return "Meh";
  return "Good";
}

function tempStatus(value) {
  if (value == null) return "Offline";
  if (value >= 90) return "Bad";
  if (value >= 75) return "Meh";
  return "Good";
}

function usageColor(value) {
  if (value >= 90) return "#ef4444";
  if (value >= 70) return "#facc15";
  return "#22c55e";
}

function tempColor(value) {
  if (value == null) return "rgba(255,255,255,0.72)";
  if (value >= 90) return "#ef4444";
  if (value >= 75) return "#facc15";
  return "#22c55e";
}

function toUnitTemperature(value, unit) {
  if (value == null) return null;
  return unit === "f" ? value * (9 / 5) + 32 : value;
}

function formatValue(value, suffix = "", digits = 0) {
  if (value == null || !Number.isFinite(Number(value))) return "--";
  return digits > 0 ? `${Number(value).toFixed(digits)}${suffix}` : `${Math.round(value)}${suffix}`;
}

function formatTemperature(value, settings) {
  if (value == null || !Number.isFinite(Number(value))) return "--";
  const unit = settings?.temperatureUnit ?? DEFAULT_SETTINGS.temperatureUnit;
  return `${Math.round(toUnitTemperature(value, unit))}${TEMPERATURE_UNIT[unit]}`;
}

function formatCapacityValue(value, settings, digits = 1) {
  if (value == null || !Number.isFinite(Number(value))) return "--";
  const unit = settings?.capacityUnit ?? DEFAULT_SETTINGS.capacityUnit;
  if (unit === "mb") return `${Math.round(Number(value) * 1024)} MB`;
  return `${Number(value).toFixed(digits)} GB`;
}

function formatTimestamp(timestamp) {
  if (!timestamp) return "--";
  return new Intl.DateTimeFormat([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function summarizeReleaseNotes(notes) {
  if (!notes) return null;

  const cleaned = String(notes)
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#>\s]+/, "").trim())
    .filter((line) => line && !/^what'?s changed$/i.test(line) && !/^bump /i.test(line));

  return cleaned.find((line) => line.length > 18) ?? cleaned[0] ?? null;
}

function buildSparklinePath(values, width = 220, height = 56, padding = 6) {
  if (!values.length) return "";

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return values
    .map((entry, index) => {
      const x = padding + (index / Math.max(values.length - 1, 1)) * (width - padding * 2);
      const y = height - padding - ((entry - min) / range) * (height - padding * 2);
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
}

function buildCsv(samples, settings) {
  const rows = [
    [
      "Timestamp",
      "CPU Usage",
      "CPU Temp",
      "GPU Usage",
      "GPU Temp",
      "RAM Usage",
      "Storage Usage",
      "Sensor Connected",
    ],
  ];

  for (const sample of samples) {
    rows.push([
      new Date(sample.timestamp).toISOString(),
      sample.cpuUsage ?? "",
      sample.cpuTemp == null ? "" : formatTemperature(sample.cpuTemp, settings),
      sample.gpuUsage ?? "",
      sample.gpuTemp == null ? "" : formatTemperature(sample.gpuTemp, settings),
      sample.ramUsage ?? "",
      sample.storageUsage ?? "",
      sample.sensorConnected ? "yes" : "no",
    ]);
  }

  return rows.map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
}

function createMetricSummary(metrics) {
  return {
    cpuUsage: metrics?.cpu?.usage ?? null,
    cpuTemp: metrics?.cpu?.temp ?? null,
    gpuUsage: metrics?.gpu?.usage ?? null,
    gpuTemp: metrics?.gpu?.temp ?? null,
    ramUsage: metrics?.ram?.usage ?? null,
    storageUsage: metrics?.storage?.usage ?? null,
    sensorConnected: Boolean(metrics?.telemetry?.sensor_connected),
  };
}

function createInitialSessionStats() {
  return {
    startedAt: Date.now(),
    sampleCount: 0,
    loggedSampleCount: 0,
    sensorConnected: false,
    cpuUsageSum: 0,
    gpuUsageSum: 0,
    ramUsageSum: 0,
    cpuPeakC: null,
    gpuPeakC: null,
    avgCpuLoad: null,
    avgGpuLoad: null,
    avgRamLoad: null,
    alertCount: 0,
  };
}

function createSessionSample(metrics, timestamp = Date.now()) {
  return {
    timestamp,
    ...createMetricSummary(metrics),
  };
}

function mergePeak(currentPeak, nextValue) {
  if (nextValue == null || !Number.isFinite(Number(nextValue))) return currentPeak;
  if (currentPeak == null || !Number.isFinite(Number(currentPeak))) return nextValue;
  return Math.max(currentPeak, nextValue);
}

function updateSessionStats(previous, sample) {
  const sampleCount = previous.sampleCount + 1;
  const cpuUsageSum = previous.cpuUsageSum + (sample.cpuUsage ?? 0);
  const gpuUsageSum = previous.gpuUsageSum + (sample.gpuUsage ?? 0);
  const ramUsageSum = previous.ramUsageSum + (sample.ramUsage ?? 0);

  return {
    ...previous,
    sampleCount,
    sensorConnected: previous.sensorConnected || Boolean(sample.sensorConnected),
    cpuUsageSum,
    gpuUsageSum,
    ramUsageSum,
    cpuPeakC: mergePeak(previous.cpuPeakC, sample.cpuTemp),
    gpuPeakC: mergePeak(previous.gpuPeakC, sample.gpuTemp),
    avgCpuLoad: cpuUsageSum / sampleCount,
    avgGpuLoad: gpuUsageSum / sampleCount,
    avgRamLoad: ramUsageSum / sampleCount,
  };
}

function normalizePeak(value) {
  return Number.isFinite(value) ? value : null;
}

function pushRollingValue(values, nextValue, maxLen = SHORT_HISTORY_LENGTH) {
  values.push(nextValue ?? 0);
  if (values.length > maxLen) values.shift();
  return values;
}

function appendSessionLogInPlace(values, sample) {
  values.push(sample);
  if (values.length > MAX_SESSION_LOG_SAMPLES) values.shift();
  return values;
}

function cloneHistoryState(history) {
  return {
    cpu: [...history.cpu],
    gpu: [...history.gpu],
    ram: [...history.ram],
    vram: [...history.vram],
    storage: [...history.storage],
  };
}

function moveItem(values, index, direction) {
  const next = [...values];
  const swapIndex = index + direction;
  if (swapIndex < 0 || swapIndex >= next.length) return values;
  [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  return next;
}

function toggleArrayValue(values, value) {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

function buildAlertEntry({ kind, title, message, value, threshold, sessionId }) {
  return {
    id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    sessionId,
    kind,
    title,
    message,
    value,
    threshold,
    timestamp: Date.now(),
    severity: "warn",
  };
}

function buildSessionSummary(sessionId, stats) {
  return {
    id: sessionId,
    startedAt: stats.startedAt,
    endedAt: Date.now(),
    sampleCount: stats.sampleCount,
    loggedSampleCount: stats.loggedSampleCount,
    sensorConnected: stats.sensorConnected,
    cpuPeakC: normalizePeak(stats.cpuPeakC),
    gpuPeakC: normalizePeak(stats.gpuPeakC),
    avgCpuLoad: stats.avgCpuLoad == null ? null : Number(stats.avgCpuLoad.toFixed(1)),
    avgGpuLoad: stats.avgGpuLoad == null ? null : Number(stats.avgGpuLoad.toFixed(1)),
    avgRamLoad: stats.avgRamLoad == null ? null : Number(stats.avgRamLoad.toFixed(1)),
    alertCount: stats.alertCount,
  };
}

function copyText(value) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(value);
  }

  const field = document.createElement("textarea");
  field.value = value;
  document.body.appendChild(field);
  field.select();
  document.execCommand("copy");
  field.remove();
  return Promise.resolve();
}

function Sparkline({ values, color }) {
  const path = useMemo(() => buildSparklinePath(values), [values]);

  return (
    <div className="sparkline-shell">
      <svg viewBox="0 0 220 56" style={{ width: "100%", height: 56 }}>
        <path d={path} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function ToastStack({ toasts, onDismiss }) {
  return (
    <div className="toast-stack">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            className="toast-card"
          >
            <div className="toast-row">
              <div className="toast-icon">
                <AlertTriangle size={18} />
              </div>
              <div className="toast-copy">
                <div className="toast-eyebrow">Monitor alert</div>
                <div className="toast-title">{toast.title}</div>
                <div className="toast-message">{toast.message}</div>
              </div>
              <button className="icon-button" onClick={() => onDismiss(toast.id)} aria-label="Dismiss alert">
                <X size={18} />
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function ActionButton({ icon: Icon, children, variant = "default", ...props }) {
  return (
    <button className={`action-button ${variant === "ghost" ? "action-button-ghost" : ""}`} {...props}>
      {Icon ? <Icon size={16} /> : null}
      <span>{children}</span>
    </button>
  );
}

function GaugeCard({ label, value, temp, icon: Icon, subtext, history, settings }) {
  const angle = getNeedleAngle(value, 100);
  const normalized = clamp(value ?? 0, 0, 100);
  const currentUsageColor = usageColor(normalized);
  const currentTempColor = tempColor(temp);

  return (
    <motion.div className="card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
      <div className="card-top">
        <div className="card-heading">
          <Icon size={16} />
          <div>
            <div className="card-title">{label}</div>
            {subtext ? <div className="panel-subtitle">{subtext}</div> : null}
          </div>
        </div>

        <div className="badge" style={{ borderColor: `${currentUsageColor}55`, color: currentUsageColor }}>
          {usageStatus(normalized)}
        </div>
      </div>

      <div className="gauge-wrap">
        <svg viewBox="0 0 240 160" style={{ width: "100%", height: "100%", overflow: "visible" }}>
          <path
            d={describeArc(120, 120, 84, -120, 120)}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth="18"
            strokeLinecap="round"
          />
          <path d={describeArc(120, 120, 84, -120, -15)} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="18" strokeLinecap="round" />
          <path d={describeArc(120, 120, 84, -15, 60)} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="18" strokeLinecap="round" />
          <path d={describeArc(120, 120, 84, 60, 120)} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="18" strokeLinecap="round" />

          {GAUGE_TICK_ANGLES.map((tickAngle) => {
            const outer = polarToCartesian(120, 120, 100, tickAngle);
            const inner = polarToCartesian(120, 120, 88, tickAngle);
            return (
              <line
                key={tickAngle}
                x1={inner.x}
                y1={inner.y}
                x2={outer.x}
                y2={outer.y}
                stroke="rgba(255,255,255,0.35)"
                strokeWidth="2"
                strokeLinecap="round"
              />
            );
          })}

          <g transform={`rotate(${angle} 120 120)`}>
            <line x1="120" y1="120" x2="120" y2="45" stroke={currentUsageColor} strokeWidth="4" strokeLinecap="round" />
          </g>

          <circle cx="120" cy="120" r="8" fill={currentUsageColor} />
        </svg>

        <div className="gauge-center">
          <div className="gauge-caption">usage</div>
        </div>
      </div>

      <div className="meta-grid">
        <div className="meta-box">
          <div className="meta-label">Temperature</div>
          <div className="meta-value" style={{ color: currentTempColor }}>
            {formatTemperature(temp, settings)}
          </div>
          <div className="meta-helper">{tempStatus(temp)}</div>
        </div>

        <div className="meta-box">
          <div className="meta-label">Load</div>
          <div className="meta-value">{Math.round(normalized)}%</div>
          <div className="progress">
            <div className="progress-bar" style={{ background: currentUsageColor, width: `${normalized}%` }} />
          </div>
        </div>
      </div>

      {history?.length ? <Sparkline values={history} color={currentUsageColor} /> : null}
    </motion.div>
  );
}

function TempOnlyCard({ label, temp, icon: Icon, subtitle, settings }) {
  const color = tempColor(temp);

  return (
    <motion.div className="card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
      <div className="card-top">
        <div className="card-heading">
          <Icon size={16} />
          <div>
            <div className="card-title">{label}</div>
            <div className="panel-subtitle">{subtitle}</div>
          </div>
        </div>

        <div className="badge" style={{ borderColor: `${color}55`, color }}>
          {tempStatus(temp)}
        </div>
      </div>

      <div className="temp-card-copy">
        <div className="temp-card-value" style={{ color }}>
          {formatTemperature(temp, settings)}
        </div>
        <div className="temp-card-subtitle">Board temperature from the active sensor feed.</div>
      </div>
    </motion.div>
  );
}

function Pill({ icon: Icon, label, value }) {
  return (
    <div className="pill">
      <div className="pill-label">
        <Icon size={14} />
        <span>{label}</span>
      </div>
      <div className="pill-value">{value}</div>
    </div>
  );
}

function FanPill({ fans, aliases = {} }) {
  return (
    <div className="pill fan-pill">
      <div className="pill-label fan-pill-label">
        <Fan size={14} />
        <span>Fans</span>
      </div>

      {fans?.length ? (
        <div className="fan-chip-list">
          {fans.map((fan, index) => {
            const name = aliases?.[fan.name]?.trim() || fan.name;
            return (
              <div className="fan-chip" key={`${fan.name}-${fan.rpm}-${index}`}>
                <span className="fan-chip-name">{name}</span>
                <span className="fan-chip-rpm">{formatValue(fan.rpm, " RPM")}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="pill-value fan-pill-empty">--</div>
      )}
    </div>
  );
}

function SidebarButton({ icon: Icon, label, active, compact = false, ...props }) {
  const { collapsed = false, ...buttonProps } = props;

  return (
    <button
      className={`sidebar-button ${active ? "sidebar-button-active" : ""} ${compact ? "sidebar-button-compact" : ""} ${collapsed ? "sidebar-button-collapsed" : ""}`}
      aria-label={label}
      title={label}
      {...buttonProps}
    >
      <Icon size={16} />
      <AnimatePresence initial={false}>
        {!collapsed ? (
          <motion.span
            key="label"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.16 }}
          >
            {label}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </button>
  );
}

function SettingToggle({ title, description, value, onChange }) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <div className="setting-title">{title}</div>
        <div className="setting-description">{description}</div>
      </div>
      <button
        type="button"
        className={`toggle-switch ${value ? "toggle-switch-on" : ""}`}
        onClick={() => onChange(!value)}
        aria-pressed={value}
      >
        <span className="toggle-thumb" />
      </button>
    </div>
  );
}

function SelectField({ title, description, value, options, onChange }) {
  return (
    <label className="setting-field">
      <div className="setting-title">{title}</div>
      <div className="setting-description">{description}</div>
      <select className="setting-select" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextField({ title, description, value, placeholder, onChange }) {
  return (
    <label className="setting-field">
      <div className="setting-title">{title}</div>
      <div className="setting-description">{description}</div>
      <input
        className="setting-select"
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function SettingsSection({ title, description, children }) {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div className="setting-title">{title}</div>
        <div className="setting-description">{description}</div>
      </div>
      <div className="settings-stack">{children}</div>
    </section>
  );
}

function ChipToggle({ label, selected, onToggle }) {
  return (
    <button type="button" className={`chip-toggle ${selected ? "chip-toggle-selected" : ""}`} onClick={onToggle}>
      {selected ? <Eye size={14} /> : <EyeOff size={14} />}
      <span>{label}</span>
    </button>
  );
}

function MenuSheet({ open, onClose, children }) {
  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        className="menu-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      >
        <motion.div
          className="menu-sheet"
          initial={{ opacity: 0, x: 32, scale: 0.985 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: 32, scale: 0.985 }}
          transition={{ type: "spring", stiffness: 250, damping: 28 }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="menu-sheet-top">
            <div>
              <div className="menu-sheet-title">Control Center</div>
              <div className="menu-sheet-subtitle">
                Startup, tray, alerts, sensor layout, and release tools live here so the main dashboard stays clean.
              </div>
            </div>
            <button className="icon-button menu-sheet-close" onClick={onClose} aria-label="Close control center">
              <X size={20} />
            </button>
          </div>
          <div className="menu-sheet-body">{children}</div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function SettingsPanel({
  settings,
  profile,
  metrics,
  settingsStatus,
  onUpdateSettings,
  onUpdateProfile,
  onHideToTray,
  onCheckForUpdates,
  onOpenReleasePage,
}) {
  const fanAliases = profile.sensorLayout.fanAliases ?? {};

  return (
    <div className="panel-card">
      <div className="panel-top control-panel-top">
        <div className="panel-heading control-panel-heading">
          <Settings2 size={18} />
          <div>
            <div className="panel-title">Control Center</div>
            <div className="panel-subtitle">Startup, tray, refresh, alerts, and layout preferences.</div>
          </div>
        </div>

        <div className="control-panel-actions">
          <ActionButton icon={Activity} onClick={onHideToTray}>Hide to tray</ActionButton>
          <ActionButton icon={Download} variant="ghost" onClick={onCheckForUpdates}>Check updates</ActionButton>
          <ActionButton icon={ExternalLink} variant="ghost" onClick={onOpenReleasePage}>Open releases</ActionButton>
        </div>
      </div>

      <SettingsSection title="Window & Startup" description="How the desktop app behaves when it launches or closes.">
        <SettingToggle
          title="Launch at startup"
          description="Starts the installed app with Windows. Because the app elevates for full telemetry, Windows may still ask for admin approval."
          value={settings.launchAtStartup}
          onChange={(value) => onUpdateSettings({ launchAtStartup: value })}
        />
        <SettingToggle
          title="Start minimized to tray"
          description="Open straight into the tray instead of showing the main dashboard immediately."
          value={settings.startMinimized}
          onChange={(value) => onUpdateSettings({ startMinimized: value })}
        />
        <SettingToggle
          title="Close to tray"
          description="Closing the window keeps the monitor running in the tray instead of exiting."
          value={settings.closeToTray}
          onChange={(value) => onUpdateSettings({ closeToTray: value })}
        />
      </SettingsSection>

      <SettingsSection title="Stream & Units" description="Fine tune refresh speed, stored session logging, and display units.">
        <SettingToggle
          title="Background logging"
          description="Keep a rolling session log so Session Lab can export CSV data and preserve recent launch summaries."
          value={settings.backgroundLogging}
          onChange={(value) => onUpdateSettings({ backgroundLogging: value })}
        />
        <div className="settings-grid">
          <SelectField
            title="Refresh rate"
            description="Choose how quickly readings update from the backend stream."
            value={String(settings.refreshIntervalMs)}
            options={REFRESH_OPTIONS.map((option) => ({ value: String(option), label: `${option} ms` }))}
            onChange={(value) => onUpdateSettings({ refreshIntervalMs: Number(value) })}
          />
          <SelectField
            title="Temperature unit"
            description="Show temperatures in Celsius or Fahrenheit."
            value={settings.temperatureUnit}
            options={[
              { value: "c", label: "Celsius" },
              { value: "f", label: "Fahrenheit" },
            ]}
            onChange={(value) => onUpdateSettings({ temperatureUnit: value })}
          />
          <SelectField
            title="Capacity unit"
            description="Display RAM and storage capacity in gigabytes or megabytes."
            value={settings.capacityUnit}
            options={[
              { value: "gb", label: "Gigabytes" },
              { value: "mb", label: "Megabytes" },
            ]}
            onChange={(value) => onUpdateSettings({ capacityUnit: value })}
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Custom Alerts" description="Choose which thresholds should notify you while the app is running.">
        <div className="settings-grid">
          <SelectField
            title="CPU temperature"
            description="Threshold for CPU temperature alerts."
            value={String(profile.alerts.cpuTempThresholdC)}
            options={TEMP_ALERT_OPTIONS_C.map((option) => ({ value: String(option), label: `${option} °C` }))}
            onChange={(value) =>
              onUpdateProfile({
                alerts: {
                  ...profile.alerts,
                  cpuTempEnabled: true,
                  cpuTempThresholdC: Number(value),
                },
              })
            }
          />
          <SettingToggle
            title="Enable CPU temperature alerts"
            description="Send a toast when CPU heat crosses the selected threshold."
            value={profile.alerts.cpuTempEnabled}
            onChange={(value) => onUpdateProfile({ alerts: { ...profile.alerts, cpuTempEnabled: value } })}
          />
          <SelectField
            title="GPU temperature"
            description="Threshold for GPU temperature alerts."
            value={String(profile.alerts.gpuTempThresholdC)}
            options={TEMP_ALERT_OPTIONS_C.map((option) => ({ value: String(option), label: `${option} °C` }))}
            onChange={(value) =>
              onUpdateProfile({
                alerts: {
                  ...profile.alerts,
                  gpuTempEnabled: true,
                  gpuTempThresholdC: Number(value),
                },
              })
            }
          />
          <SettingToggle
            title="Enable GPU temperature alerts"
            description="Send a toast when GPU heat crosses the selected threshold."
            value={profile.alerts.gpuTempEnabled}
            onChange={(value) => onUpdateProfile({ alerts: { ...profile.alerts, gpuTempEnabled: value } })}
          />
          <SelectField
            title="CPU usage"
            description="Threshold for CPU load alerts."
            value={String(profile.alerts.cpuUsageThreshold)}
            options={LOAD_ALERT_OPTIONS.map((option) => ({ value: String(option), label: `${option}%` }))}
            onChange={(value) =>
              onUpdateProfile({
                alerts: {
                  ...profile.alerts,
                  cpuUsageEnabled: true,
                  cpuUsageThreshold: Number(value),
                },
              })
            }
          />
          <SettingToggle
            title="Enable CPU usage alerts"
            description="Notify when sustained CPU usage crosses the threshold."
            value={profile.alerts.cpuUsageEnabled}
            onChange={(value) => onUpdateProfile({ alerts: { ...profile.alerts, cpuUsageEnabled: value } })}
          />
          <SelectField
            title="GPU usage"
            description="Threshold for GPU load alerts."
            value={String(profile.alerts.gpuUsageThreshold)}
            options={LOAD_ALERT_OPTIONS.map((option) => ({ value: String(option), label: `${option}%` }))}
            onChange={(value) =>
              onUpdateProfile({
                alerts: {
                  ...profile.alerts,
                  gpuUsageEnabled: true,
                  gpuUsageThreshold: Number(value),
                },
              })
            }
          />
          <SettingToggle
            title="Enable GPU usage alerts"
            description="Notify when sustained GPU usage crosses the threshold."
            value={profile.alerts.gpuUsageEnabled}
            onChange={(value) => onUpdateProfile({ alerts: { ...profile.alerts, gpuUsageEnabled: value } })}
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Sensor Layout" description="Choose what appears on the dashboard and tidy the fan names.">
        <div className="settings-grid">
          <div className="setting-field">
            <div className="setting-title">Sensor cards</div>
            <div className="setting-description">Hide cards you do not care about or change their order.</div>
            <div className="sensor-order-list">
              {profile.sensorLayout.cardOrder.map((key, index) => {
                const hidden = profile.sensorLayout.hiddenCards.includes(key);
                return (
                  <div className="sensor-order-row" key={key}>
                    <div>
                      <div className="sensor-order-name">{CARD_LABELS[key]}</div>
                      <div className="sensor-order-note">{hidden ? "Hidden from overview" : "Visible on overview"}</div>
                    </div>
                    <div className="sensor-order-actions">
                      <button className="icon-button" onClick={() => onUpdateProfile({
                        sensorLayout: {
                          ...profile.sensorLayout,
                          cardOrder: moveItem(profile.sensorLayout.cardOrder, index, -1),
                        },
                      })} aria-label={`Move ${CARD_LABELS[key]} up`}>
                        <ArrowUp size={16} />
                      </button>
                      <button className="icon-button" onClick={() => onUpdateProfile({
                        sensorLayout: {
                          ...profile.sensorLayout,
                          cardOrder: moveItem(profile.sensorLayout.cardOrder, index, 1),
                        },
                      })} aria-label={`Move ${CARD_LABELS[key]} down`}>
                        <ArrowDown size={16} />
                      </button>
                      <button className="icon-button" onClick={() => onUpdateProfile({
                        sensorLayout: {
                          ...profile.sensorLayout,
                          hiddenCards: toggleArrayValue(profile.sensorLayout.hiddenCards, key),
                        },
                      })} aria-label={`Toggle ${CARD_LABELS[key]}`}>
                        {hidden ? <Eye size={16} /> : <EyeOff size={16} />}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="setting-field">
            <div className="setting-title">Top summary pills</div>
            <div className="setting-description">Choose which quick stats stay pinned under the hero heading.</div>
            <div className="chip-toggle-list">
              {QUICK_PILL_KEYS.map((key) => (
                <ChipToggle
                  key={key}
                  label={QUICK_PILL_LABELS[key]}
                  selected={profile.sensorLayout.visiblePills.includes(key)}
                  onToggle={() =>
                    onUpdateProfile({
                      sensorLayout: {
                        ...profile.sensorLayout,
                        visiblePills: toggleArrayValue(profile.sensorLayout.visiblePills, key),
                      },
                    })
                  }
                />
              ))}
            </div>
          </div>

          {metrics?.fans?.length ? (
            <div className="setting-field">
              <div className="setting-title">Fan labels</div>
              <div className="setting-description">Rename the detected fans so the overview chips read more clearly.</div>
              <div className="fan-alias-list">
                {metrics.fans.map((fan) => (
                  <TextField
                    key={fan.name}
                    title={fan.name}
                    description={`Currently showing ${fan.rpm} RPM.`}
                    value={fanAliases[fan.name] ?? ""}
                    placeholder="Optional display name"
                    onChange={(value) =>
                      onUpdateProfile({
                        sensorLayout: {
                          ...profile.sensorLayout,
                          fanAliases: {
                            ...fanAliases,
                            [fan.name]: value,
                          },
                        },
                      })
                    }
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </SettingsSection>

      <div className={`status-line status-line-${settingsStatus.kind}`}>{settingsStatus.message}</div>
    </div>
  );
}

function TrendCard({ title, current, min, max, avg, accent = "rgba(255,255,255,0.82)" }) {
  return (
    <div className="trend-card">
      <div className="trend-top">
        <div className="panel-title">{title}</div>
        <div className="badge" style={{ color: accent, borderColor: `${accent}44` }}>{current}</div>
      </div>
      <div className="trend-stats">
        <div className="trend-stat">
          <span>Min</span>
          <strong>{min}</strong>
        </div>
        <div className="trend-stat">
          <span>Peak</span>
          <strong>{max}</strong>
        </div>
        <div className="trend-stat">
          <span>Average</span>
          <strong>{avg}</strong>
        </div>
      </div>
    </div>
  );
}

function ArchiveSessionCard({ entry, settings }) {
  return (
    <div className="diagnostic-block">
      <div className="diagnostic-block-label">{formatTimestamp(entry.startedAt)}</div>
      <div className="diagnostic-block-value">
        Avg CPU {formatValue(entry.avgCpuLoad, "%")} | Avg GPU {formatValue(entry.avgGpuLoad, "%")} | Alerts {entry.alertCount}
      </div>
      <div className="history-footer">
        Peak CPU {formatTemperature(entry.cpuPeakC, settings)} | Peak GPU {formatTemperature(entry.gpuPeakC, settings)}
      </div>
    </div>
  );
}

function AlertList({ alerts, settings }) {
  if (!alerts.length) {
    return <div className="history-footer">No alerts have fired in the current archive yet.</div>;
  }

  return (
    <div className="diagnostic-stack">
      {alerts.map((alert) => (
        <div className="diagnostic-block" key={alert.id}>
          <div className="diagnostic-block-label">{formatTimestamp(alert.timestamp)}</div>
          <div className="diagnostic-block-value">{alert.title}</div>
          <div className="history-footer">
            {alert.message}
            {alert.kind.includes("temp") && alert.value != null ? ` (${formatTemperature(alert.value, settings)})` : ""}
            {alert.kind.includes("usage") && alert.value != null ? ` (${Math.round(alert.value)}%)` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}

function DiagnosticsRow({ label, value, tone = "good" }) {
  return (
    <div className="diagnostic-row">
      <div className="diagnostic-label">{label}</div>
      <div className={`diagnostic-value diagnostic-value-${tone}`}>{value}</div>
    </div>
  );
}

function HistoryPanel({ sessionStats, sessionLog, archive, settings, onResetSession, onResetArchive }) {
  const summarize = (values) => {
    if (!values.length) return { current: "--", min: "--", max: "--", avg: "--" };
    return {
      current: `${Math.round(values.at(-1))}%`,
      min: `${Math.round(Math.min(...values))}%`,
      max: `${Math.round(Math.max(...values))}%`,
      avg: `${Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)}%`,
    };
  };

  const cpuSummary = summarize(sessionLog.map((sample) => sample.cpuUsage ?? 0));
  const gpuSummary = summarize(sessionLog.map((sample) => sample.gpuUsage ?? 0));
  const ramSummary = summarize(sessionLog.map((sample) => sample.ramUsage ?? 0));

  return (
    <div className="dashboard-stack">
      <div className="history-card">
        <div className="panel-top">
          <div className="panel-heading">
            <History size={18} />
            <div>
              <div className="panel-title">Session Lab</div>
              <div className="panel-subtitle">
                Current-session trends, saved launch snapshots, and cleanup tools for your local history.
              </div>
            </div>
          </div>
          <div className="panel-actions">
            <ActionButton icon={TimerReset} variant="ghost" onClick={onResetSession}>
              Reset Session
            </ActionButton>
            <ActionButton icon={X} variant="ghost" onClick={onResetArchive}>
              Clear Archive
            </ActionButton>
          </div>
        </div>

        <div className="session-overview">
          <div className="session-overview-item">
            <span>Session Started</span>
            <strong>{formatTimestamp(sessionStats.startedAt)}</strong>
          </div>
          <div className="session-overview-item">
            <span>Samples Logged</span>
            <strong>{sessionStats.loggedSampleCount}</strong>
          </div>
          <div className="session-overview-item">
            <span>Alerts Fired</span>
            <strong>{sessionStats.alertCount}</strong>
          </div>
        </div>

        <div className="history-grid">
          <TrendCard
            title="CPU Load"
            current={cpuSummary.current}
            min={cpuSummary.min}
            max={cpuSummary.max}
            avg={cpuSummary.avg}
            accent="#8bdaff"
          />
          <TrendCard
            title="GPU Load"
            current={gpuSummary.current}
            min={gpuSummary.min}
            max={gpuSummary.max}
            avg={gpuSummary.avg}
            accent="#99f6b7"
          />
          <TrendCard
            title="RAM Load"
            current={ramSummary.current}
            min={ramSummary.min}
            max={ramSummary.max}
            avg={ramSummary.avg}
            accent="#facc15"
          />
          <TrendCard
            title="Thermal Peaks"
            current={`CPU ${formatTemperature(sessionStats.cpuPeakC, settings)}`}
            min={`GPU ${formatTemperature(sessionStats.gpuPeakC, settings)}`}
            max={`Avg CPU ${formatValue(sessionStats.avgCpuLoad, "%")}`}
            avg={`Avg GPU ${formatValue(sessionStats.avgGpuLoad, "%")}`}
            accent="#f97316"
          />
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-top">
          <div className="panel-heading">
            <ClipboardList size={18} />
            <div>
              <div className="panel-title">Recent Launches</div>
              <div className="panel-subtitle">Persistent session summaries saved locally from your recent runs.</div>
            </div>
          </div>
        </div>
        <div className="diagnostic-stack">
          {archive.sessions.length ? (
            archive.sessions.map((entry) => <ArchiveSessionCard key={entry.id} entry={entry} settings={settings} />)
          ) : (
            <div className="history-footer">
              No saved launches yet. Keep the app open a little longer or reset the session to create the
              first archive entry.
            </div>
          )}
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-top">
          <div className="panel-heading">
            <BellRing size={18} />
            <div>
              <div className="panel-title">Alert Timeline</div>
              <div className="panel-subtitle">Recent threshold alerts saved across launches.</div>
            </div>
          </div>
        </div>
        <AlertList alerts={archive.alerts} settings={settings} />
      </div>
    </div>
  );
}

function UpdateCenterPanel({ appVersion, updateCenter, onCheckForUpdates, onOpenReleasePage }) {
  const tone =
    updateCenter.state === "update-available" ? "warn" : updateCenter.state === "error" ? "bad" : "good";
  const releaseSummary = summarizeReleaseNotes(updateCenter.notes);

  return (
    <div className="panel-card">
      <div className="panel-top">
        <div className="panel-heading">
          <Download size={18} />
          <div>
            <div className="panel-title">Update Center</div>
            <div className="panel-subtitle">
              Check the latest release and jump to the installer page when a newer build is published.
            </div>
          </div>
        </div>
        <div className="panel-actions">
          <ActionButton icon={RefreshCw} onClick={onCheckForUpdates}>
            Check now
          </ActionButton>
          <ActionButton icon={ExternalLink} variant="ghost" onClick={onOpenReleasePage}>
            Open releases
          </ActionButton>
        </div>
      </div>

      <div className="diagnostic-list">
        <DiagnosticsRow label="Current app version" value={appVersion ?? "1.1.0"} tone="good" />
        <DiagnosticsRow label="Latest published version" value={updateCenter.latestVersion ?? "Unknown"} tone={tone} />
        <DiagnosticsRow
          label="Last checked"
          value={updateCenter.lastCheckedAt ? formatTimestamp(updateCenter.lastCheckedAt) : "Never"}
          tone="good"
        />
        <DiagnosticsRow label="Status" value={updateCenter.message} tone={tone} />
      </div>

      {releaseSummary ? <div className="history-footer">{releaseSummary}</div> : null}
    </div>
  );
}

function DiagnosticsPanel({
  diagnostics,
  metrics,
  connected,
  settings,
  lastSocketError,
  updateCenter,
  appVersion,
  onRefresh,
  onCheckForUpdates,
  onOpenReleasePage,
}) {
  const connectionLabel = connected ? (metrics?.telemetry?.sensor_connected ? "Live" : "Fallback") : "Offline";

  return (
    <div className="dashboard-stack">
      <div className="panel-card">
        <div className="panel-top">
          <div className="panel-heading">
            <ShieldAlert size={18} />
            <div>
              <div className="panel-title">Diagnostics</div>
              <div className="panel-subtitle">Runtime health, startup wiring, and the latest issues reported by the desktop shell.</div>
            </div>
          </div>
          <div className="panel-actions">
            <ActionButton icon={RefreshCw} onClick={onRefresh}>
              Refresh diagnostics
            </ActionButton>
          </div>
        </div>

        <div className="diagnostic-list">
          <DiagnosticsRow label="Frontend connection" value={connectionLabel} tone={connected ? "good" : "bad"} />
          <DiagnosticsRow
            label="Backend process"
            value={diagnostics?.backendProcess?.running ? "Running" : "Stopped"}
            tone={diagnostics?.backendProcess?.running ? "good" : "bad"}
          />
          <DiagnosticsRow
            label="Sensor reader"
            value={diagnostics?.sensorReaderProcess?.running ? "Running" : "Stopped"}
            tone={diagnostics?.sensorReaderProcess?.running ? "good" : "bad"}
          />
          <DiagnosticsRow
            label="Backend port"
            value={diagnostics?.backendPortOpen ? "Open" : "Closed"}
            tone={diagnostics?.backendPortOpen ? "good" : "bad"}
          />
          <DiagnosticsRow
            label="Sensor port"
            value={diagnostics?.sensorReaderPortOpen ? "Open" : "Closed"}
            tone={diagnostics?.sensorReaderPortOpen ? "good" : "warn"}
          />
          <DiagnosticsRow
            label="Launch at startup"
            value={diagnostics?.launchAtStartup ? "Enabled" : "Disabled"}
            tone={diagnostics?.launchAtStartup ? "good" : "warn"}
          />
          <DiagnosticsRow label="Refresh rate" value={`${settings.refreshIntervalMs} ms`} tone="good" />
        </div>

        <div className="history-grid">
          <div className="diagnostic-block">
            <div className="diagnostic-block-label">Settings path</div>
            <div className="diagnostic-block-value diagnostic-code">{diagnostics?.settingsPath ?? "Browser preview mode"}</div>
          </div>
          <div className="diagnostic-block">
            <div className="diagnostic-block-label">Local data directory</div>
            <div className="diagnostic-block-value diagnostic-code">{diagnostics?.localDataDir ?? "Browser storage"}</div>
          </div>
          <div className="diagnostic-block">
            <div className="diagnostic-block-label">Last backend error</div>
            <div className="diagnostic-block-value">{diagnostics?.lastBackendError ?? "None"}</div>
          </div>
          <div className="diagnostic-block">
            <div className="diagnostic-block-label">Last sensor reader error</div>
            <div className="diagnostic-block-value">{diagnostics?.lastSensorReaderError ?? "None"}</div>
          </div>
        </div>

        <div className="panel-note">
          <AlertTriangle size={16} />
          <div>
            WebSocket: {lastSocketError ?? "No websocket errors captured."}
            <br />
            Telemetry source: {metrics?.telemetry?.source_name ?? "Fallback source"}
          </div>
        </div>
      </div>

      <UpdateCenterPanel
        appVersion={appVersion}
        updateCenter={updateCenter}
        onCheckForUpdates={onCheckForUpdates}
        onOpenReleasePage={onOpenReleasePage}
      />
    </div>
  );
}

function SidebarRail({
  activeScreen,
  onChangeScreen,
  collapsed,
  onToggleCollapse,
  onOpenMenu,
  onCopyDiagnostics,
  onExportCsv,
  appVersion,
  connectionLabel,
}) {
  return (
    <motion.aside
      className={`sidebar-rail ${collapsed ? "sidebar-rail-collapsed" : ""}`}
      initial={false}
      animate={{ width: collapsed ? 88 : 248 }}
      transition={{ type: "spring", stiffness: 260, damping: 28 }}
    >
      <div className="sidebar-top">
        <div className={`sidebar-brand ${collapsed ? "sidebar-brand-collapsed" : ""}`}>
          <img className="sidebar-brand-mark" src="/brand-mark.png" alt="PC Hardware Monitor" />
          <AnimatePresence initial={false}>
            {!collapsed ? (
              <motion.div
                key="brand-copy"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.18 }}
              >
                <div className="sidebar-brand-title">Hardware Monitor</div>
                <div className="sidebar-brand-copy">Overview, session log, diagnostics, and quick actions.</div>
              </motion.div>
            ) : null}
          </AnimatePresence>
          <button
            className="sidebar-collapse"
            type="button"
            onClick={onToggleCollapse}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
          </button>
        </div>

        <div className="sidebar-group">
          <SidebarButton
            icon={LayoutDashboard}
            label="Overview"
            active={activeScreen === SCREEN_OVERVIEW}
            collapsed={collapsed}
            onClick={() => onChangeScreen(SCREEN_OVERVIEW)}
          />
          <SidebarButton
            icon={History}
            label="Session Lab"
            active={activeScreen === SCREEN_SESSION}
            collapsed={collapsed}
            onClick={() => onChangeScreen(SCREEN_SESSION)}
          />
          <SidebarButton
            icon={ShieldAlert}
            label="Diagnostics"
            active={activeScreen === SCREEN_DIAGNOSTICS}
            collapsed={collapsed}
            onClick={() => onChangeScreen(SCREEN_DIAGNOSTICS)}
          />
        </div>
      </div>

      <div className="sidebar-group sidebar-group-actions">
        <SidebarButton icon={Menu} label="Menu" compact collapsed={collapsed} onClick={onOpenMenu} />
        <SidebarButton icon={ClipboardList} label="Copy diagnostics" compact collapsed={collapsed} onClick={onCopyDiagnostics} />
        <SidebarButton icon={Download} label="Export CSV" compact collapsed={collapsed} onClick={onExportCsv} />
      </div>

      <div className={`sidebar-footer ${collapsed ? "sidebar-footer-collapsed" : ""}`}>
        <div className={`sidebar-status sidebar-status-${connectionLabel.toLowerCase()}`} title={connectionLabel}>
          {collapsed ? <span className="sidebar-status-dot" /> : connectionLabel}
        </div>
        {!collapsed ? <div className="sidebar-version">v{appVersion ?? "1.1.0"}</div> : null}
      </div>
    </motion.aside>
  );
}

function OverviewScreen({ metrics, connected, cards, quickPills }) {
  const sensorConnected = Boolean(metrics?.telemetry?.sensor_connected);
  const liveLabel = connected ? (sensorConnected ? "Live telemetry" : "Fallback telemetry") : "Offline";

  return (
    <>
      <div className="hero">
        <div className="hero-copy">
          <div className="eyebrow">PC Hardware Monitor</div>
          <h1 className="title">Telemetry deck</h1>
          <div className="subtitle">Live hardware readings with cleaner history, diagnostics, and desktop controls.</div>
        </div>

        <div className="hero-actions">
          <div className={`sidebar-status sidebar-status-${(connected ? (sensorConnected ? "live" : "fallback") : "offline")}`}>
            {liveLabel}
          </div>
        </div>

        <div className="pills">{quickPills}</div>
      </div>

      <div className="grid">{cards}</div>
    </>
  );
}

function BootVeil({ phase }) {
  return (
    <motion.div
      className="boot-veil"
      initial={{ opacity: 1 }}
      animate={phase === "revealing" ? { opacity: 0, scale: 1.02 } : { opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.72, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="boot-veil-grid" />
      <div className="boot-veil-orb boot-veil-orb-a" />
      <div className="boot-veil-orb boot-veil-orb-b" />
      <motion.div
        className="boot-panel"
        initial={{ opacity: 0, y: 18 }}
        animate={phase === "revealing" ? { opacity: 0, y: -12 } : { opacity: 1, y: 0 }}
        transition={{ duration: 0.56, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="boot-mark-shell">
          <span className="boot-mark-ring boot-mark-ring-a" />
          <span className="boot-mark-ring boot-mark-ring-b" />
          <img className="boot-mark-image" src="/brand-mark.png" alt="PC Hardware Monitor" />
        </div>
        <div className="eyebrow">PC Hardware Monitor</div>
        <h1 className="boot-title">Syncing live telemetry</h1>
        <p className="boot-copy">Warming up the sensor reader, local backend, and the realtime deck.</p>
        <div className="boot-loader" aria-hidden="true">
          <div className="boot-loader-track">
            <span className="boot-loader-fill" />
          </div>
          <div className="boot-loader-meta">
            <span>Loading</span>
            <span>Hold tight</span>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function App() {
  const [metrics, setMetrics] = useState(null);
  const [connected, setConnected] = useState(false);
  const [history, setHistory] = useState({ cpu: [], gpu: [], ram: [], vram: [], storage: [] });
  const [sessionLog, setSessionLog] = useState([]);
  const [sessionStats, setSessionStats] = useState(createInitialSessionStats);
  const [toasts, setToasts] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [historyArchive, setHistoryArchive] = useState(DEFAULT_ARCHIVE);
  const [settingsStatus, setSettingsStatus] = useState({ kind: "idle", message: "Ready." });
  const [diagnostics, setDiagnostics] = useState(null);
  const [lastSocketError, setLastSocketError] = useState(null);
  const [appVersion, setAppVersion] = useState("1.1.0");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [activeScreen, setActiveScreen] = useState(SCREEN_OVERVIEW);
  const [isPageVisible, setIsPageVisible] = useState(() =>
    typeof document === "undefined" ? true : document.visibilityState !== "hidden"
  );
  const [bootPhase, setBootPhase] = useState(HAS_NATIVE_SHELL ? "launching" : "ready");
  const [settingsHydrated, setSettingsHydrated] = useState(!HAS_NATIVE_SHELL);
  const [diagnosticsHydrated, setDiagnosticsHydrated] = useState(!HAS_NATIVE_SHELL);

  const settingsRef = useRef(DEFAULT_SETTINGS);
  const profileRef = useRef(DEFAULT_PROFILE);
  const archiveRef = useRef(DEFAULT_ARCHIVE);
  const historyRef = useRef({ cpu: [], gpu: [], ram: [], vram: [], storage: [] });
  const sessionLogRef = useRef([]);
  const sessionStatsRef = useRef(createInitialSessionStats());
  const activeScreenRef = useRef(SCREEN_OVERVIEW);
  const saveTicketRef = useRef(0);
  const currentSessionIdRef = useRef("session-initial");
  const lastSessionLogAtRef = useRef(0);
  const lastAlertRef = useRef({
    cpuTemp: 0,
    gpuTemp: 0,
    cpuUsage: 0,
    gpuUsage: 0,
  });
  const refreshDiagnosticsRef = useRef(null);
  const checkForUpdatesRef = useRef(null);
  const recordAlertRef = useRef(null);
  const persistArchiveSnapshotRef = useRef(null);
  const showToastRef = useRef(null);
  const bootStartedAtRef = useRef(0);
  const bootFinishedRef = useRef(!HAS_NATIVE_SHELL);

  useEffect(() => {
    if (bootStartedAtRef.current === 0) {
      bootStartedAtRef.current = Date.now();
    }
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  useEffect(() => {
    archiveRef.current = historyArchive;
  }, [historyArchive]);

  useEffect(() => {
    sessionStatsRef.current = sessionStats;
  }, [sessionStats]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;

    const syncVisibility = () => {
      setIsPageVisible(document.visibilityState !== "hidden");
    };

    document.addEventListener("visibilitychange", syncVisibility);
    syncVisibility();
    return () => document.removeEventListener("visibilitychange", syncVisibility);
  }, []);

  useEffect(() => {
    activeScreenRef.current = activeScreen;
  }, [activeScreen]);

  useEffect(() => {
    if (activeScreen === SCREEN_OVERVIEW) {
      setHistory(cloneHistoryState(historyRef.current));
    }

    if (activeScreen === SCREEN_SESSION) {
      setSessionLog([...sessionLogRef.current]);
      setSessionStats({ ...sessionStatsRef.current });
    }
  }, [activeScreen]);

  useEffect(() => {
    setProfile(loadProfile());
    setHistoryArchive(loadArchive());
  }, []);

  useEffect(() => {
    currentSessionIdRef.current = `session-${Date.now()}`;
  }, []);

  useEffect(() => {
    let mounted = true;

    loadAppSettings()
      .then((loaded) => {
        if (!mounted) return;
        setSettings(loaded);
        settingsRef.current = loaded;
      })
      .catch(() => {
        if (!mounted) return;
        setSettingsStatus({ kind: "error", message: "Could not load desktop settings." });
      })
      .finally(() => {
        if (mounted) {
          setSettingsHydrated(true);
        }
      });

    if (HAS_NATIVE_SHELL) {
      getVersion()
        .then((version) => {
          if (mounted) setAppVersion(version);
        })
        .catch(() => {});
    }

    return () => {
      mounted = false;
    };
  }, []);

  const dismissToast = (id) => {
    setToasts((previous) => previous.filter((toast) => toast.id !== id));
  };

  const showToast = (title, message) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((previous) => [...previous, { id, title, message }]);
    window.setTimeout(() => dismissToast(id), 4800);
  };

  const refreshDiagnostics = async () => {
    try {
      const next = await loadRuntimeDiagnostics();
      setDiagnostics(next);
    } finally {
      setDiagnosticsHydrated(true);
    }
  };

  const updateProfileState = (patch) => {
    setProfile((previous) => {
      const next = saveProfile({ ...previous, ...patch });
      profileRef.current = next;
      return next;
    });
  };

  const updateSettings = async (patch) => {
    const previous = settingsRef.current;
    const optimistic = { ...previous, ...patch };
    const ticket = ++saveTicketRef.current;

    setSettings(optimistic);
    setSettingsStatus({ kind: "saving", message: "Saving control center changes..." });

    try {
      const saved = await saveAppSettings(optimistic);
      if (ticket !== saveTicketRef.current) return;
      settingsRef.current = saved;
      setSettings(saved);
      setSettingsStatus({ kind: "saved", message: "Control center updated." });
      await refreshDiagnosticsRef.current?.();
    } catch (error) {
      if (ticket !== saveTicketRef.current) return;
      settingsRef.current = previous;
      setSettings(previous);
      setSettingsStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not save settings.",
      });
      showToast("Control center update failed", "The desktop shell could not save that setting.");
    }
  };

  const persistArchiveSnapshot = () => {
    const stats = sessionStatsRef.current;
    if (!stats.sampleCount) return;

    const summary = buildSessionSummary(currentSessionIdRef.current, stats);
    setHistoryArchive((previous) => {
      const next = saveArchive({
        ...previous,
        sessions: upsertSessionSummary(previous.sessions, summary),
      });
      archiveRef.current = next;
      return next;
    });
  };

  const recordAlert = (alert) => {
    const nextStats = { ...sessionStatsRef.current, alertCount: sessionStatsRef.current.alertCount + 1 };
    sessionStatsRef.current = nextStats;
    if (activeScreenRef.current === SCREEN_SESSION) {
      setSessionStats({ ...nextStats });
    }

    setHistoryArchive((previous) => {
      const next = saveArchive({
        ...previous,
        alerts: mergeAlerts(previous.alerts, [alert]),
      });
      archiveRef.current = next;
      return next;
    });
  };

  const checkForUpdates = async () => {
    updateProfileState({
      updateCenter: {
        ...profileRef.current.updateCenter,
        state: "checking",
        message: "Checking GitHub for the latest release...",
        lastCheckedAt: Date.now(),
      },
    });

    try {
      const release = await fetchLatestRelease();
      const comparison = compareVersions(appVersion, release.version);
      updateProfileState({
        updateCenter: {
          state: comparison < 0 ? "update-available" : "up-to-date",
          message:
            comparison < 0 ? `Version ${release.version} is available.` : "You already have the latest installer.",
          latestVersion: release.version,
          downloadUrl: release.downloadUrl,
          publishedAt: release.publishedAt,
          notes: release.notes,
          lastCheckedAt: Date.now(),
        },
      });
    } catch (error) {
      updateProfileState({
        updateCenter: {
          ...profileRef.current.updateCenter,
          state: "error",
          message: error instanceof Error ? error.message : "Update check failed.",
          lastCheckedAt: Date.now(),
        },
      });
      showToast("Update check failed", "The app could not reach the release feed right now.");
    }
  };

  const handleOpenReleasePage = async () => {
    try {
      await openReleasePage();
    } catch {
      showToast("Release page unavailable", "The app could not open the release page.");
    }
  };

  const hideToTray = async () => {
    try {
      await hideAppToTray();
    } catch (error) {
      showToast(
        "Tray action failed",
        error instanceof Error ? error.message : "Unable to hide the window to tray."
      );
    }
  };

  const copyDiagnostics = async () => {
    const runtimeSnapshot = await loadRuntimeDiagnostics().catch(() => diagnostics);
    if (runtimeSnapshot) {
      setDiagnostics(runtimeSnapshot);
      setDiagnosticsHydrated(true);
    }

    const diagnosticSource = runtimeSnapshot ?? diagnostics;
    const connectionLabel = connected ? (metrics?.telemetry?.sensor_connected ? "Live" : "Fallback") : "Offline";
    const diagnosticText = [
      `PC Hardware Monitor ${appVersion}`,
      `Connection: ${connectionLabel}`,
      `Backend process: ${diagnosticSource?.backendProcess?.running ? "running" : "stopped"}`,
      `Sensor reader: ${diagnosticSource?.sensorReaderProcess?.running ? "running" : "stopped"}`,
      `Backend port: ${diagnosticSource?.backendPortOpen ? "open" : "closed"}`,
      `Sensor port: ${diagnosticSource?.sensorReaderPortOpen ? "open" : "closed"}`,
      `Launch at startup: ${settings.launchAtStartup}`,
      `Start minimized: ${settings.startMinimized}`,
      `Close to tray: ${settings.closeToTray}`,
      `Refresh interval: ${settings.refreshIntervalMs}`,
      `Update state: ${profile.updateCenter.state}`,
      `Latest version: ${profile.updateCenter.latestVersion ?? "unknown"}`,
      `Last backend error: ${diagnosticSource?.lastBackendError ?? "none"}`,
      `Last sensor error: ${diagnosticSource?.lastSensorReaderError ?? "none"}`,
      `Last websocket error: ${lastSocketError ?? "none"}`,
    ].join("\n");

    await copyText(diagnosticText);
    showToast("Diagnostics copied", "The runtime snapshot is ready to paste.");
  };

  const exportCsv = async () => {
    if (!sessionLog.length) {
      showToast("No session data yet", "Leave the dashboard open for a moment so there is something to export.");
      return;
    }

    const filename = `pc-hardware-monitor-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.csv`;
    try {
      const savedTo = await saveSessionCsv(filename, buildCsv(sessionLog, settingsRef.current));
      const successMessage = HAS_NATIVE_SHELL
        ? `Saved the current session log to ${savedTo}.`
        : "The current session log has been downloaded.";
      showToast("CSV exported", successMessage);
    } catch (error) {
      showToast(
        "CSV export failed",
        error instanceof Error ? error.message : "The session log could not be saved right now."
      );
    }
  };

  const resetSession = () => {
    persistArchiveSnapshotRef.current?.();
    currentSessionIdRef.current = `session-${Date.now()}`;
    const fresh = createInitialSessionStats();
    historyRef.current = { cpu: [], gpu: [], ram: [], vram: [], storage: [] };
    sessionLogRef.current = [];
    lastSessionLogAtRef.current = 0;
    sessionStatsRef.current = fresh;
    setSessionLog([]);
    setSessionStats(fresh);
    setHistory({ cpu: [], gpu: [], ram: [], vram: [], storage: [] });
    showToast("Session reset", "Session Lab started a fresh log without clearing the saved archive.");
  };

  const resetArchive = () => {
    const cleared = saveArchive(DEFAULT_ARCHIVE);
    archiveRef.current = cleared;
    setHistoryArchive(cleared);
    showToast("Archive cleared", "Saved sessions and alerts have been removed from local storage.");
  };

  useEffect(() => {
    refreshDiagnosticsRef.current = refreshDiagnostics;
    checkForUpdatesRef.current = checkForUpdates;
    recordAlertRef.current = recordAlert;
    persistArchiveSnapshotRef.current = persistArchiveSnapshot;
    showToastRef.current = showToast;
  });

  useEffect(() => {
    refreshDiagnosticsRef.current?.();
    const interval = window.setInterval(() => {
      if (!isPageVisible) return;
      refreshDiagnosticsRef.current?.();
    }, DIAGNOSTICS_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [isPageVisible]);

  useEffect(() => {
    if (!isPageVisible) return;
    refreshDiagnosticsRef.current?.();
  }, [isPageVisible]);

  useEffect(() => {
    const lastCheckedAt = profile.updateCenter.lastCheckedAt ?? 0;
    if (Date.now() - lastCheckedAt > 1000 * 60 * 60 * 12) {
      checkForUpdatesRef.current?.();
    }
  }, [profile.updateCenter.lastCheckedAt]);

  useEffect(() => {
    if (!HAS_NATIVE_SHELL || bootFinishedRef.current) return;

    const elapsed = Date.now() - bootStartedAtRef.current;
    const hasEnoughState = settingsHydrated && (metrics != null || diagnosticsHydrated || elapsed >= BOOT_MAX_WAIT_MS);

    if (!hasEnoughState || elapsed < BOOT_MIN_VISIBLE_MS) return;

    bootFinishedRef.current = true;
    setBootPhase("revealing");

    finishAppBoot()
      .catch(() => {})
      .finally(() => {
        window.setTimeout(() => {
          setBootPhase("ready");
        }, BOOT_REVEAL_MS);
      });
  }, [diagnosticsHydrated, metrics, settingsHydrated]);

  const effectiveRefreshIntervalMs = isPageVisible
    ? settings.refreshIntervalMs
    : Math.max(settings.refreshIntervalMs, 2000);

  useEffect(() => {
    let socket;
    let retryTimer;
    let stopped = false;

    const connect = () => {
      if (stopped) return;

      socket = new WebSocket(`ws://127.0.0.1:8000/ws?interval_ms=${effectiveRefreshIntervalMs}`);

      socket.onopen = () => {
        setConnected(true);
        setLastSocketError(null);
      };

      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        const sampledAt = Date.now();
        const sample = createSessionSample(data, sampledAt);
        const nextHistory = historyRef.current;

        pushRollingValue(nextHistory.cpu, data.cpu?.usage);
        pushRollingValue(nextHistory.gpu, data.gpu?.usage);
        pushRollingValue(nextHistory.ram, data.ram?.usage);
        pushRollingValue(nextHistory.vram, data.gpu?.vram_usage);
        pushRollingValue(nextHistory.storage, data.storage?.usage);

        const nextSessionStats = updateSessionStats(sessionStatsRef.current, sample);
        const logIntervalMs = Math.max(SESSION_LOG_SAMPLE_INTERVAL_MS, settingsRef.current.refreshIntervalMs);
        let didAppendSessionLog = false;

        if (
          sampledAt - lastSessionLogAtRef.current >= logIntervalMs
          || sessionLogRef.current.length === 0
        ) {
          lastSessionLogAtRef.current = sampledAt;
          appendSessionLogInPlace(sessionLogRef.current, sample);
          didAppendSessionLog = true;
        }

        nextSessionStats.loggedSampleCount = sessionLogRef.current.length;
        sessionStatsRef.current = nextSessionStats;

        startTransition(() => {
          setMetrics(data);

          if (activeScreenRef.current === SCREEN_OVERVIEW) {
            setHistory(cloneHistoryState(nextHistory));
          }

          if (activeScreenRef.current === SCREEN_SESSION) {
            if (didAppendSessionLog) {
              setSessionLog([...sessionLogRef.current]);
            }
            setSessionStats({ ...nextSessionStats });
          }
        });
      };

      socket.onerror = () => {
        setConnected(false);
        setLastSocketError("The websocket connection reported an error.");
      };

      socket.onclose = () => {
        setConnected(false);
        if (!stopped) {
          retryTimer = window.setTimeout(connect, 500);
        }
      };
    };

    connect();

    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      if (socket) socket.close();
    };
  }, [effectiveRefreshIntervalMs]);

  useEffect(() => {
    if (!metrics) return;

    const cooldownMs = 20000;
    const now = Date.now();
    const alerts = profile.alerts;
    const triggers = [
      {
        key: "cpuTemp",
        enabled: alerts.cpuTempEnabled,
        current: metrics.cpu?.temp,
        threshold: alerts.cpuTempThresholdC,
        title: "CPU running hot",
        message: `CPU temperature reached ${formatTemperature(metrics.cpu?.temp, settings)}.`,
      },
      {
        key: "gpuTemp",
        enabled: alerts.gpuTempEnabled,
        current: metrics.gpu?.temp,
        threshold: alerts.gpuTempThresholdC,
        title: "GPU running hot",
        message: `GPU temperature reached ${formatTemperature(metrics.gpu?.temp, settings)}.`,
      },
      {
        key: "cpuUsage",
        enabled: alerts.cpuUsageEnabled,
        current: metrics.cpu?.usage,
        threshold: alerts.cpuUsageThreshold,
        title: "CPU load alert",
        message: `CPU usage reached ${Math.round(metrics.cpu?.usage ?? 0)}%.`,
      },
      {
        key: "gpuUsage",
        enabled: alerts.gpuUsageEnabled,
        current: metrics.gpu?.usage,
        threshold: alerts.gpuUsageThreshold,
        title: "GPU load alert",
        message: `GPU usage reached ${Math.round(metrics.gpu?.usage ?? 0)}%.`,
      },
    ];

    for (const trigger of triggers) {
      if (!trigger.enabled || trigger.current == null || trigger.current < trigger.threshold) continue;
      if (now - lastAlertRef.current[trigger.key] < cooldownMs) continue;
      lastAlertRef.current[trigger.key] = now;
      showToastRef.current?.(trigger.title, trigger.message);
      recordAlertRef.current?.(
        buildAlertEntry({
          kind: trigger.key,
          title: trigger.title,
          message: trigger.message,
          value: trigger.current,
          threshold: trigger.threshold,
          sessionId: currentSessionIdRef.current,
        })
      );
    }
  }, [metrics, profile.alerts, settings]);

  useEffect(() => {
    if (!settings.backgroundLogging) return;

    const interval = window.setInterval(() => {
      persistArchiveSnapshotRef.current?.();
    }, 15000);

    return () => window.clearInterval(interval);
  }, [settings.backgroundLogging]);

  useEffect(() => {
    return () => {
      persistArchiveSnapshotRef.current?.();
    };
  }, []);

  const connectionLabel = connected ? (metrics?.telemetry?.sensor_connected ? "Live" : "Fallback") : "Offline";
  const sidebarCollapsed = profile.ui.sidebarCollapsed;
  const isOverviewScreen = activeScreen === SCREEN_OVERVIEW;
  const avgLoad =
    isOverviewScreen && metrics
      ? Math.round(((metrics.cpu?.usage ?? 0) + (metrics.gpu?.usage ?? 0) + (metrics.ram?.usage ?? 0)) / 3)
      : 0;

  const cardLibrary = isOverviewScreen
    ? {
        cpu: (
          <GaugeCard
            key="cpu"
            label="CPU"
            value={metrics?.cpu?.usage}
            temp={metrics?.cpu?.temp}
            icon={Cpu}
            subtext={
              metrics?.cpu?.clock_mhz != null && metrics?.cpu?.power_w != null
                ? `${Math.round(metrics.cpu.clock_mhz)} MHz | ${metrics.cpu.power_w.toFixed(1)} W`
                : metrics?.cpu?.clock_mhz != null
                  ? `${Math.round(metrics.cpu.clock_mhz)} MHz`
                  : metrics?.cpu?.power_w != null
                    ? `${metrics.cpu.power_w.toFixed(1)} W`
                    : "Load, clock, and temperature"
            }
            history={history.cpu}
            settings={settings}
          />
        ),
        gpu: (
          <GaugeCard
            key="gpu"
            label="GPU"
            value={metrics?.gpu?.usage}
            temp={metrics?.gpu?.temp}
            icon={Monitor}
            subtext="Graphics load and die temperature"
            history={history.gpu}
            settings={settings}
          />
        ),
        ram: (
          <GaugeCard
            key="ram"
            label="RAM"
            value={metrics?.ram?.usage}
            temp={metrics?.ram?.temp}
            icon={MemoryStick}
            subtext={
              metrics?.ram?.used_gb != null && metrics?.ram?.total_gb != null
                ? `${formatCapacityValue(metrics.ram.used_gb, settings)} / ${formatCapacityValue(metrics.ram.total_gb, settings)}`
                : "System memory usage"
            }
            history={history.ram}
            settings={settings}
          />
        ),
        vram: (
          <GaugeCard
            key="vram"
            label="VRAM"
            value={metrics?.gpu?.vram_usage}
            temp={metrics?.gpu?.vram_temp}
            icon={Gauge}
            subtext={
              metrics?.gpu?.vram_used_mb != null && metrics?.gpu?.vram_total_mb != null
                ? `${Math.round(metrics.gpu.vram_used_mb)} / ${Math.round(metrics.gpu.vram_total_mb)} MB`
                : "Graphics memory usage"
            }
            history={history.vram}
            settings={settings}
          />
        ),
        storage: (
          <GaugeCard
            key="storage"
            label="Storage"
            value={metrics?.storage?.usage}
            temp={metrics?.storage?.temp}
            icon={HardDrive}
            subtext={
              metrics?.storage?.used_gb != null && metrics?.storage?.total_gb != null
                ? `${formatCapacityValue(metrics.storage.used_gb, settings)} / ${formatCapacityValue(metrics.storage.total_gb, settings)}`
                : "Primary drive usage"
            }
            history={history.storage}
            settings={settings}
          />
        ),
        motherboard: (
          <TempOnlyCard
            key="motherboard"
            label="Motherboard"
            temp={metrics?.motherboard?.temp}
            icon={Thermometer}
            subtitle="Board temperature"
            settings={settings}
          />
        ),
      }
    : {};

  const renderedCards = isOverviewScreen
    ? profile.sensorLayout.cardOrder
        .filter((key) => !profile.sensorLayout.hiddenCards.includes(key))
        .map((key) => cardLibrary[key])
        .filter(Boolean)
    : [];

  const quickPillLibrary = isOverviewScreen
    ? {
        fans: <FanPill key="fans" fans={metrics?.fans ?? []} aliases={profile.sensorLayout.fanAliases ?? {}} />,
        systemLoad: <Pill key="systemLoad" icon={Gauge} label="System load" value={`${avgLoad}%`} />,
        cpuPower: <Pill key="cpuPower" icon={Zap} label="CPU power" value={formatValue(metrics?.cpu?.power_w, " W", 1)} />,
        cpuClock: <Pill key="cpuClock" icon={Cpu} label="CPU clock" value={formatValue(metrics?.cpu?.clock_mhz, " MHz")} />,
        gpuTemp: <Pill key="gpuTemp" icon={Thermometer} label="GPU temp" value={formatTemperature(metrics?.gpu?.temp, settings)} />,
        uptime: <Pill key="uptime" icon={HardDrive} label="Uptime" value={metrics?.system?.uptime ?? "--"} />,
        vram: (
          <Pill
            key="vram"
            icon={MemoryStick}
            label="VRAM used"
            value={
              metrics?.gpu?.vram_used_mb != null && metrics?.gpu?.vram_total_mb != null
                ? `${Math.round(metrics.gpu.vram_used_mb)} / ${Math.round(metrics.gpu.vram_total_mb)} MB`
                : "--"
            }
          />
        ),
        connection: <Pill key="connection" icon={Activity} label="Connection" value={connectionLabel} />,
      }
    : {};

  const quickPills = isOverviewScreen
    ? profile.sensorLayout.visiblePills.map((key) => quickPillLibrary[key]).filter(Boolean)
    : [];

  return (
    <div className="page">
      <AnimatePresence>{bootPhase !== "ready" ? <BootVeil phase={bootPhase} /> : null}</AnimatePresence>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <MenuSheet open={isMenuOpen} onClose={() => setIsMenuOpen(false)}>
        <SettingsPanel
          settings={settings}
          profile={profile}
          metrics={metrics}
          settingsStatus={settingsStatus}
          onUpdateSettings={updateSettings}
          onUpdateProfile={updateProfileState}
          onHideToTray={hideToTray}
          onCheckForUpdates={checkForUpdates}
          onOpenReleasePage={handleOpenReleasePage}
        />
      </MenuSheet>

      <div className="workspace-shell">
        <SidebarRail
          activeScreen={activeScreen}
          onChangeScreen={setActiveScreen}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() =>
            updateProfileState({
              ui: {
                ...profile.ui,
                sidebarCollapsed: !sidebarCollapsed,
              },
            })
          }
          onOpenMenu={() => setIsMenuOpen(true)}
          onCopyDiagnostics={copyDiagnostics}
          onExportCsv={exportCsv}
          appVersion={appVersion}
          connectionLabel={connectionLabel}
        />

        <main className="workspace-main">
          <AnimatePresence mode="wait" initial={false}>
            <motion.section
              key={activeScreen}
              className="screen-stage"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
            >
              {activeScreen === SCREEN_OVERVIEW ? (
                <OverviewScreen metrics={metrics} connected={connected} cards={renderedCards} quickPills={quickPills} />
              ) : null}

              {activeScreen === SCREEN_SESSION ? (
                <HistoryPanel
                  sessionStats={sessionStats}
                  sessionLog={sessionLog}
                  archive={historyArchive}
                  settings={settings}
                  onResetSession={resetSession}
                  onResetArchive={resetArchive}
                />
              ) : null}

              {activeScreen === SCREEN_DIAGNOSTICS ? (
                <DiagnosticsPanel
                  diagnostics={diagnostics}
                  metrics={metrics}
                  connected={connected}
                  settings={settings}
                  lastSocketError={lastSocketError}
                  updateCenter={profile.updateCenter}
                  appVersion={appVersion}
                  onRefresh={refreshDiagnostics}
                  onCheckForUpdates={checkForUpdates}
                  onOpenReleasePage={handleOpenReleasePage}
                />
              ) : null}
            </motion.section>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
