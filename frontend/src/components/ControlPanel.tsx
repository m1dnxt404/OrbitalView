import React from "react";
import type { LayerVisibility, VisualMode, ConnectionStatus, WeatherLayerKey, WeatherLayers, HealthSources, SourceStatus } from "../types";

interface ControlPanelProps {
  counts: {
    aircraft: number;
    military: number;
    satellites: number;
    earthquakes: number;
  };
  status: ConnectionStatus;
  lastUpdated: Date | null;
  layers: LayerVisibility;
  onLayerToggle: (layer: keyof LayerVisibility) => void;
  visualMode: VisualMode;
  onVisualModeChange: (mode: VisualMode) => void;
  weatherLayers: WeatherLayers;
  onWeatherToggle: (layer: WeatherLayerKey) => void;
  health?: HealthSources | null;
}

const LAYER_SOURCE: Partial<Record<keyof LayerVisibility, keyof HealthSources>> = {
  aircraft:    "opensky",
  military:    "adsb",
  satellites:  "celestrak",
  earthquakes: "usgs",
  trails:      "opensky",
};

const POLLING_INTERVAL = 10; // seconds — matches backend default

function sourceColor(s: SourceStatus | undefined): string {
  if (!s || s.last_success === null) return "#555";
  if (s.is_rate_limited) return "#f59e0b";
  if (Date.now() / 1000 - s.last_success > POLLING_INTERVAL * 3) return "#ef4444";
  return "#22c55e";
}

const LAYER_CONFIG: Array<{
  key: keyof LayerVisibility;
  label: string;
  icon: string;
  color: string;
}> = [
  { key: "aircraft", label: "Aircraft", icon: "✈", color: "#87CEEB" },
  { key: "military", label: "Military", icon: "⬟", color: "#FF4444" },
  { key: "satellites", label: "Satellites", icon: "◎", color: "#00FFFF" },
  { key: "earthquakes", label: "Earthquakes", icon: "⬡", color: "#FF8C00" },
  { key: "trails", label: "Trails", icon: "—", color: "#87CEEB" },
];

const WEATHER_CONFIG: Array<{
  key: WeatherLayerKey;
  label: string;
  icon: string;
  color: string;
}> = [
  { key: "clouds",   label: "Clouds",   icon: "☁", color: "#94A3B8" },
  { key: "rain",     label: "Rain",     icon: "⛆", color: "#38BDF8" },
  { key: "wind",     label: "Wind",     icon: "~", color: "#A78BFA" },
  { key: "temp",     label: "Temp",     icon: "▲", color: "#FB923C" },
  { key: "pressure", label: "Pressure", icon: "◉", color: "#34D399" },
];

const VISUAL_MODES: Array<{ mode: VisualMode; label: string }> = [
  { mode: "normal", label: "NORMAL" },
  { mode: "crt", label: "CRT" },
  { mode: "nightvision", label: "NV" },
  { mode: "flir", label: "FLIR" },
];

const STATUS_COLOR: Record<ConnectionStatus, string> = {
  connected: "#00FF88",
  connecting: "#FFD700",
  disconnected: "#FF4444",
  error: "#FF4444",
};

export function ControlPanel({
  counts,
  status,
  lastUpdated,
  layers,
  onLayerToggle,
  visualMode,
  onVisualModeChange,
  weatherLayers,
  onWeatherToggle,
  health,
}: ControlPanelProps): React.ReactElement {
  const totalTracked =
    counts.aircraft + counts.military + counts.satellites + counts.earthquakes;

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.headerTitle}>ORBITALVIEW</span>
        <span style={styles.headerSub}>GEOSPATIAL MONITOR</span>
      </div>

      {/* Total count */}
      <div style={styles.totalRow}>
        <span style={styles.totalLabel}>TRACKING</span>
        <span style={styles.totalCount}>{totalTracked.toLocaleString()}</span>
      </div>

      <div style={styles.divider} />

      {/* Layer toggles */}
      <div style={styles.sectionLabel}>DATA LAYERS</div>
      {LAYER_CONFIG.map(({ key, label, icon, color }) => (
        <div key={key} style={styles.layerRow}>
          <button
            style={{
              ...styles.toggleBtn,
              backgroundColor: layers[key] ? color + "22" : "transparent",
              borderColor: layers[key] ? color : "#334155",
            }}
            onClick={() => onLayerToggle(key)}
            aria-pressed={layers[key]}
            aria-label={`Toggle ${label}`}
          >
            <span style={{ color: layers[key] ? color : "#64748B", fontSize: 14 }}>{icon}</span>
          </button>
          <span style={{ ...styles.layerLabel, color: layers[key] ? "#E2E8F0" : "#64748B" }}>
            {label}
          </span>
          {health && LAYER_SOURCE[key] && (
            <span style={{
              display: "inline-block",
              width: 6,
              height: 6,
              borderRadius: "50%",
              backgroundColor: sourceColor(health[LAYER_SOURCE[key]!]),
              flexShrink: 0,
            }} />
          )}
          <span style={{ ...styles.layerCount, color: layers[key] ? color : "#475569" }}>
            {counts[key].toLocaleString()}
          </span>
        </div>
      ))}

      <div style={styles.divider} />

      {/* Visual mode */}
      <div style={styles.sectionLabel}>VISUAL MODE</div>
      <div style={styles.modeRow}>
        {VISUAL_MODES.map(({ mode, label }) => (
          <button
            key={mode}
            style={{
              ...styles.modeBtn,
              backgroundColor: visualMode === mode ? "#1E40AF" : "transparent",
              borderColor: visualMode === mode ? "#3B82F6" : "#334155",
              color: visualMode === mode ? "#93C5FD" : "#64748B",
            }}
            onClick={() => onVisualModeChange(mode)}
            aria-pressed={visualMode === mode}
          >
            {label}
          </button>
        ))}
      </div>

      <div style={styles.divider} />

      {/* Weather overlays */}
      <div style={styles.sectionLabel}>WEATHER</div>
      {WEATHER_CONFIG.map(({ key, label, icon, color }) => (
        <div key={key} style={styles.layerRow}>
          <button
            style={{
              ...styles.toggleBtn,
              backgroundColor: weatherLayers[key] ? color + "22" : "transparent",
              borderColor: weatherLayers[key] ? color : "#334155",
            }}
            onClick={() => onWeatherToggle(key)}
            aria-pressed={weatherLayers[key]}
            aria-label={`Toggle ${label} weather layer`}
          >
            <span style={{ color: weatherLayers[key] ? color : "#64748B", fontSize: 13 }}>
              {icon}
            </span>
          </button>
          <span style={{ ...styles.layerLabel, color: weatherLayers[key] ? "#E2E8F0" : "#64748B" }}>
            {label}
          </span>
        </div>
      ))}

      <div style={styles.divider} />

      {/* Status */}
      <div style={styles.statusRow}>
        <span
          style={{
            ...styles.statusDot,
            backgroundColor: STATUS_COLOR[status],
            boxShadow: `0 0 6px ${STATUS_COLOR[status]}`,
          }}
        />
        <span style={styles.statusText}>{status.toUpperCase()}</span>
      </div>
      {lastUpdated && (
        <div style={styles.timestamp}>
          {lastUpdated.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: "absolute",
    top: 16,
    left: 16,
    zIndex: 1000,
    width: 220,
    backgroundColor: "rgba(2, 6, 23, 0.88)",
    border: "1px solid #1E293B",
    borderRadius: 8,
    padding: "14px 16px",
    backdropFilter: "blur(12px)",
    fontFamily: "'Courier New', Courier, monospace",
    color: "#E2E8F0",
    userSelect: "none",
  },
  header: {
    display: "flex",
    flexDirection: "column",
    marginBottom: 10,
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: "0.2em",
    color: "#38BDF8",
  },
  headerSub: {
    fontSize: 9,
    letterSpacing: "0.15em",
    color: "#475569",
    marginTop: 2,
  },
  totalRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 10,
  },
  totalLabel: {
    fontSize: 10,
    letterSpacing: "0.12em",
    color: "#64748B",
  },
  totalCount: {
    fontSize: 22,
    fontWeight: 700,
    color: "#38BDF8",
    letterSpacing: "-0.02em",
  },
  divider: {
    height: 1,
    backgroundColor: "#1E293B",
    margin: "10px 0",
  },
  sectionLabel: {
    fontSize: 9,
    letterSpacing: "0.18em",
    color: "#475569",
    marginBottom: 8,
  },
  layerRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  },
  toggleBtn: {
    width: 28,
    height: 28,
    border: "1px solid",
    borderRadius: 4,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    transition: "background-color 0.15s, border-color 0.15s",
    flexShrink: 0,
  },
  layerLabel: {
    fontSize: 11,
    letterSpacing: "0.08em",
    flex: 1,
    transition: "color 0.15s",
  },
  layerCount: {
    fontSize: 11,
    fontWeight: 700,
    minWidth: 36,
    textAlign: "right",
    transition: "color 0.15s",
  },
  modeRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr 1fr",
    gap: 4,
  },
  modeBtn: {
    border: "1px solid",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 9,
    fontFamily: "'Courier New', Courier, monospace",
    letterSpacing: "0.05em",
    padding: "5px 0",
    transition: "background-color 0.15s, color 0.15s, border-color 0.15s",
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
    transition: "background-color 0.3s, box-shadow 0.3s",
  },
  statusText: {
    fontSize: 10,
    letterSpacing: "0.15em",
    color: "#94A3B8",
  },
  timestamp: {
    fontSize: 10,
    color: "#475569",
    letterSpacing: "0.08em",
    paddingLeft: 16,
  },
};
