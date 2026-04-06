import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Cpu,
  Gauge,
  HardDrive,
  MemoryStick,
  Monitor,
  Fan,
  Zap,
  Thermometer,
  AlertTriangle,
  X,
} from "lucide-react";

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const TEMP_UNIT = "\u00B0C";

function polarToCartesian(cx, cy, r, angleDeg) {
  const angle = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(angle),
    y: cy + r * Math.sin(angle),
  };
}

function describeArc(x, y, radius, startAngle, endAngle) {
  const start = polarToCartesian(x, y, radius, endAngle);
  const end = polarToCartesian(x, y, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  return ["M", start.x, start.y, "A", radius, radius, 0, largeArcFlag, 0, end.x, end.y].join(" ");
}

function getNeedleAngle(value, max = 100) {
  const pct = clamp((value ?? 0) / max, 0, 1);
  return -120 + pct * 240;
}

function usageStatus(value) {
  if (value >= 90) return "Bad";
  if (value >= 70) return "Meh";
  return "Good";
}

function tempStatus(value) {
  if (value == null) return "Sensor unavailable";
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
  if (value == null) return "rgba(255,255,255,0.7)";
  if (value >= 90) return "#ef4444";
  if (value >= 75) return "#facc15";
  return "#22c55e";
}

function formatValue(value, suffix = "", digits = 0) {
  if (value == null) return "--";
  if (digits > 0) return `${Number(value).toFixed(digits)}${suffix}`;
  return `${Math.round(value)}${suffix}`;
}

function formatTemperature(value) {
  if (value == null) return "--";
  return `${Math.round(value)}${TEMP_UNIT}`;
}

function pushHistory(prev, value, maxLen = 120) {
  const next = [...prev, value ?? 0];
  if (next.length > maxLen) next.shift();
  return next;
}

function buildSparklinePath(values, width = 220, height = 56, padding = 6) {
  if (!values.length) return "";

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return values
    .map((v, i) => {
      const x = padding + (i / Math.max(values.length - 1, 1)) * (width - padding * 2);
      const y = height - padding - ((v - min) / range) * (height - padding * 2);
      return `${i === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
}

function Sparkline({ values, color }) {
  const path = useMemo(() => buildSparklinePath(values), [values]);

  return (
    <div
      style={{
        marginTop: 10,
        paddingTop: 8,
        borderTop: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <svg viewBox="0 0 220 56" style={{ width: "100%", height: 56 }}>
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function ToastStack({ toasts, onDismiss }) {
  return (
    <div
      style={{
        position: "fixed",
        top: 20,
        right: 20,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        width: 340,
        maxWidth: "calc(100vw - 32px)",
      }}
    >
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            style={{
              borderRadius: 20,
              border: "1px solid rgba(239,68,68,0.35)",
              background: "rgba(15,15,18,0.92)",
              backdropFilter: "blur(14px)",
              boxShadow: "0 18px 50px rgba(0,0,0,0.35)",
              padding: 14,
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 12,
                  display: "grid",
                  placeItems: "center",
                  background: "rgba(239,68,68,0.12)",
                  color: "#f87171",
                  flexShrink: 0,
                }}
              >
                <AlertTriangle size={18} />
              </div>

              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontSize: 13,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: "rgba(255,255,255,0.45)",
                  }}
                >
                  Thermal alert
                </div>
                <div style={{ marginTop: 4, fontSize: 15, fontWeight: 700, color: "#f5f5f5" }}>
                  {toast.title}
                </div>
                <div style={{ marginTop: 4, fontSize: 13, color: "rgba(255,255,255,0.68)" }}>
                  {toast.message}
                </div>
              </div>

              <button
                onClick={() => onDismiss(toast.id)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "rgba(255,255,255,0.55)",
                  cursor: "pointer",
                  padding: 2,
                }}
              >
                <X size={18} />
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function GaugeCard({ label, value, temp, icon: Icon, subtext, history }) {
  const angle = useMemo(() => getNeedleAngle(value, 100), [value]);
  const normalized = clamp(value ?? 0, 0, 100);
  const currentUsageColor = usageColor(normalized);
  const currentTempColor = tempColor(temp);

  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="card-top">
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Icon size={16} />
          <div className="card-title">{label}</div>
        </div>

        <div
          className="badge"
          style={{
            borderColor: `${currentUsageColor}55`,
            color: currentUsageColor,
            boxShadow: `0 0 0 1px ${currentUsageColor}22 inset`,
          }}
        >
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
          <path
            d={describeArc(120, 120, 84, -120, -15)}
            fill="none"
            stroke="rgba(255,255,255,0.2)"
            strokeWidth="18"
            strokeLinecap="round"
          />
          <path
            d={describeArc(120, 120, 84, -15, 60)}
            fill="none"
            stroke="rgba(255,255,255,0.35)"
            strokeWidth="18"
            strokeLinecap="round"
          />
          <path
            d={describeArc(120, 120, 84, 60, 120)}
            fill="none"
            stroke="rgba(255,255,255,0.5)"
            strokeWidth="18"
            strokeLinecap="round"
          />

          {Array.from({ length: 9 }).map((_, i) => {
            const tickAngle = -120 + i * 30;
            const outer = polarToCartesian(120, 120, 100, tickAngle);
            const inner = polarToCartesian(120, 120, 88, tickAngle);
            return (
              <line
                key={i}
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
            <line
              x1="120"
              y1="120"
              x2="120"
              y2="45"
              stroke={currentUsageColor}
              strokeWidth="4"
              strokeLinecap="round"
            />
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
            {formatTemperature(temp)}
          </div>
          <div style={{ marginTop: 6, color: "rgba(255,255,255,0.5)", fontSize: 12 }}>
            {tempStatus(temp)}
          </div>
        </div>

        <div className="meta-box">
          <div className="meta-label">Capacity</div>
          <div className="meta-value">{Math.round(normalized)}%</div>
          <div className="progress">
            <motion.div
              className="progress-bar"
              style={{ background: currentUsageColor }}
              initial={{ width: 0 }}
              animate={{ width: `${normalized}%` }}
              transition={{ duration: 0.45 }}
            />
          </div>
          {subtext ? (
            <div style={{ marginTop: 8, color: "rgba(255,255,255,0.5)", fontSize: 12 }}>
              {subtext}
            </div>
          ) : null}
        </div>
      </div>

      {history?.length ? <Sparkline values={history} color={currentUsageColor} /> : null}
    </motion.div>
  );
}

function TempOnlyCard({ label, temp, icon: Icon, subtitle }) {
  const color = tempColor(temp);

  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}
    >
      <div className="card-top">
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Icon size={16} />
          <div className="card-title">{label}</div>
        </div>

        <div
          className="badge"
          style={{
            borderColor: `${color}55`,
            color,
            boxShadow: `0 0 0 1px ${color}22 inset`,
          }}
        >
          {tempStatus(temp)}
        </div>
      </div>

      <div style={{ padding: "18px 2px 8px" }}>
        <div
          style={{
            fontSize: 52,
            fontWeight: 700,
            letterSpacing: "-0.05em",
            color,
            lineHeight: 1,
          }}
        >
          {formatTemperature(temp)}
        </div>
        <div style={{ marginTop: 10, color: "rgba(255,255,255,0.55)", fontSize: 14 }}>
          {subtitle}
        </div>
      </div>
    </motion.div>
  );
}

function Pill({ icon: Icon, label, value }) {
  return (
    <div className="pill">
      <div className="pill-label" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Icon size={14} />
        {label}
      </div>
      <div className="pill-value">{value}</div>
    </div>
  );
}

function FanPill({ fans }) {
  return (
    <div className="pill fan-pill">
      <div className="pill-label fan-pill-label">
        <Fan size={14} />
        Fans
      </div>

      {fans?.length ? (
        <div className="fan-chip-list">
          {fans.map((fan, index) => (
            <div className="fan-chip" key={`${fan.name}-${fan.rpm}-${index}`}>
              <span className="fan-chip-name">{fan.name}</span>
              <span className="fan-chip-rpm">{formatValue(fan.rpm, " RPM")}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="pill-value fan-pill-empty">--</div>
      )}
    </div>
  );
}

export default function App() {
  const [metrics, setMetrics] = useState(null);
  const [connected, setConnected] = useState(false);
  const [history, setHistory] = useState({
    cpu: [],
    gpu: [],
    ram: [],
  });
  const [toasts, setToasts] = useState([]);

  const lastAlertRef = useRef({
    cpu: 0,
    gpu: 0,
  });

  const sensorConnected = Boolean(metrics?.telemetry?.sensor_connected);

  function dismissToast(id) {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }

  function showToast(title, message) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, title, message }]);

    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 5500);
  }

  useEffect(() => {
    let socket;
    let retryTimer;
    let stopped = false;

    function connect() {
      if (stopped) return;

      socket = new WebSocket("ws://127.0.0.1:8000/ws");

      socket.onopen = () => {
        setConnected(true);
      };

      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        startTransition(() => {
          setMetrics(data);
          setHistory((prev) => ({
            cpu: pushHistory(prev.cpu, data.cpu?.usage ?? 0),
            gpu: pushHistory(prev.gpu, data.gpu?.usage ?? 0),
            ram: pushHistory(prev.ram, data.ram?.usage ?? 0),
          }));
        });
      };

      socket.onerror = () => {
        setConnected(false);
      };

      socket.onclose = () => {
        setConnected(false);

        if (!stopped) {
          retryTimer = window.setTimeout(() => {
            connect();
          }, 400);
        }
      };
    }

    connect();

    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      if (socket) socket.close();
    };
  }, []);

  useEffect(() => {
    if (!metrics) return;

    const now = Date.now();
    const alertCooldownMs = 20000;
    const cpuTemp = metrics.cpu?.temp;
    const gpuTemp = metrics.gpu?.temp;

    if (cpuTemp != null && cpuTemp >= 85 && now - lastAlertRef.current.cpu > alertCooldownMs) {
      lastAlertRef.current.cpu = now;
      showToast("CPU running hot", `CPU temperature reached ${formatTemperature(cpuTemp)}.`);
    }

    if (gpuTemp != null && gpuTemp >= 85 && now - lastAlertRef.current.gpu > alertCooldownMs) {
      lastAlertRef.current.gpu = now;
      showToast("GPU running hot", `GPU temperature reached ${formatTemperature(gpuTemp)}.`);
    }
  }, [metrics]);

  const avgLoad = metrics
    ? Math.round(
        ((metrics.cpu?.usage ?? 0) + (metrics.gpu?.usage ?? 0) + (metrics.ram?.usage ?? 0)) / 3
      )
    : 0;

  const gauges = metrics
    ? [
        {
          label: "CPU",
          value: metrics.cpu?.usage ?? 0,
          temp: metrics.cpu?.temp,
          icon: Cpu,
          subtext:
            metrics.cpu?.clock_mhz != null && metrics.cpu?.power_w != null
              ? `${Math.round(metrics.cpu.clock_mhz)} MHz | ${metrics.cpu.power_w.toFixed(1)} W`
              : metrics.cpu?.clock_mhz != null
                ? `${Math.round(metrics.cpu.clock_mhz)} MHz`
                : metrics.cpu?.power_w != null
                  ? `${metrics.cpu.power_w.toFixed(1)} W`
                  : null,
          history: history.cpu,
        },
        {
          label: "GPU",
          value: metrics.gpu?.usage ?? 0,
          temp: metrics.gpu?.temp,
          icon: Monitor,
          subtext:
            metrics.gpu?.vram_used_mb != null && metrics.gpu?.vram_total_mb != null
              ? `${Math.round(metrics.gpu.vram_used_mb)} / ${Math.round(metrics.gpu.vram_total_mb)} MB`
              : null,
          history: history.gpu,
        },
        {
          label: "RAM",
          value: metrics.ram?.usage ?? 0,
          temp: metrics.ram?.temp,
          icon: MemoryStick,
          subtext:
            metrics.ram?.used_gb != null && metrics.ram?.total_gb != null
              ? `${metrics.ram.used_gb} / ${metrics.ram.total_gb} GB`
              : null,
          history: history.ram,
        },
        {
          label: "VRAM",
          value: metrics.gpu?.vram_usage ?? 0,
          temp: metrics.gpu?.vram_temp,
          icon: Gauge,
          subtext:
            metrics.gpu?.vram_used_mb != null && metrics.gpu?.vram_total_mb != null
              ? `${Math.round(metrics.gpu.vram_used_mb)} / ${Math.round(metrics.gpu.vram_total_mb)} MB`
              : null,
        },
        {
          label: "Storage",
          value: metrics.storage?.usage ?? 0,
          temp: metrics.storage?.temp,
          icon: HardDrive,
          subtext:
            metrics.storage?.used_gb != null && metrics.storage?.total_gb != null
              ? `${metrics.storage.used_gb} / ${metrics.storage.total_gb} GB`
              : null,
        },
      ]
    : [];

  return (
    <div className="page">
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <div className="container">
        <div className="hero">
          <div>
            <div className="eyebrow">PC Hardware Monitor</div>
            <h1 className="title">Performance dashboard</h1>
            <div className="subtitle">
              Live hardware telemetry with history graphs and thermal alerts.
            </div>
          </div>

          <div className="pills">
            <FanPill fans={metrics?.fans ?? []} />
            <Pill icon={Gauge} label="System load" value={`${avgLoad}%`} />
            <Pill icon={Zap} label="CPU power" value={formatValue(metrics?.cpu?.power_w, " W", 1)} />
            <Pill icon={Cpu} label="CPU clock" value={formatValue(metrics?.cpu?.clock_mhz, " MHz")} />
            <Pill icon={Monitor} label="GPU temp" value={formatTemperature(metrics?.gpu?.temp)} />
            <Pill icon={HardDrive} label="Uptime" value={metrics?.system?.uptime ?? "--"} />
            <Pill
              icon={MemoryStick}
              label="VRAM used"
              value={
                metrics?.gpu?.vram_used_mb != null && metrics?.gpu?.vram_total_mb != null
                  ? `${Math.round(metrics.gpu.vram_used_mb)} / ${Math.round(metrics.gpu.vram_total_mb)} MB`
                  : "--"
              }
            />
            <Pill
              icon={Gauge}
              label="Connection"
              value={connected ? (sensorConnected ? "Live" : "Fallback") : "Offline"}
            />
          </div>
        </div>

        <div className="grid">
          {gauges.map((g) => (
            <GaugeCard
              key={g.label}
              label={g.label}
              value={g.value}
              temp={g.temp}
              icon={g.icon}
              subtext={g.subtext}
              history={g.history}
            />
          ))}

          <TempOnlyCard
            label="Motherboard"
            temp={metrics?.motherboard?.temp}
            icon={Thermometer}
            subtitle="Board temperature"
          />
        </div>

        <div className="footer-note">
          Live WebSocket mode enabled. Toast alerts trigger at 85{TEMP_UNIT} for CPU and GPU. History
          graphs show the most recent 120 updates.
        </div>
      </div>
    </div>
  );
}
