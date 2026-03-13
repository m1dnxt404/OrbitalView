import { useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import * as satellite from "satellite.js";
import type { WorldPayload, LayerVisibility, VisualMode, WeatherLayerKey, WeatherLayers } from "../types";

interface GlobeViewProps {
  payload: WorldPayload | null;
  layers: LayerVisibility;
  visualMode: VisualMode;
  weatherLayers: WeatherLayers;
  onViewerReady?: (viewer: Cesium.Viewer) => void;
}

interface SelectedInfo {
  type: "aircraft" | "military" | "satellite" | "earthquake";
  data: Record<string, unknown>;
}

// ── GLSL shaders ──────────────────────────────────────────────────────────────

const CRT_SHADER = `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
out vec4 fragColor;
void main() {
  vec2 uv = v_textureCoordinates;
  vec4 c = texture(colorTexture, uv);
  float scan = mod(floor(uv.y * 1200.0), 3.0);
  if (scan < 1.0) c.rgb *= 0.4;
  vec2 vig = uv - 0.5;
  c.rgb *= clamp(1.0 - dot(vig, vig) * 3.0, 0.0, 1.0);
  c.r *= 0.75;
  c.b *= 0.60;
  fragColor = c;
}
`;

const NIGHT_VISION_SHADER = `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
out vec4 fragColor;
void main() {
  vec4 c = texture(colorTexture, v_textureCoordinates);
  float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  float grain = fract(sin(dot(v_textureCoordinates * 300.0, vec2(12.9898, 78.233))) * 43758.5453) * 0.04;
  lum = clamp(lum + grain, 0.0, 1.0);
  fragColor = vec4(0.0, lum * 1.4, 0.0, 1.0);
}
`;

const FLIR_SHADER = `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
out vec4 fragColor;
vec3 thermalPalette(float t) {
  if (t < 0.25) return mix(vec3(0.0, 0.0, 0.0), vec3(0.5, 0.0, 0.5), t * 4.0);
  if (t < 0.5)  return mix(vec3(0.5, 0.0, 0.5), vec3(1.0, 0.0, 0.0), (t - 0.25) * 4.0);
  if (t < 0.75) return mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 0.0), (t - 0.5) * 4.0);
  return mix(vec3(1.0, 1.0, 0.0), vec3(1.0, 1.0, 1.0), (t - 0.75) * 4.0);
}
void main() {
  vec4 c = texture(colorTexture, v_textureCoordinates);
  float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  fragColor = vec4(thermalPalette(lum), 1.0);
}
`;

// ── Info panel helpers ────────────────────────────────────────────────────────

const TYPE_META: Record<SelectedInfo["type"], { icon: string; label: string; color: string }> = {
  aircraft:   { icon: "✈", label: "AIRCRAFT",   color: "#87CEEB" },
  military:   { icon: "⬟", label: "MILITARY",   color: "#FF4444" },
  satellite:  { icon: "◎", label: "SATELLITE",  color: "#00FFFF" },
  earthquake: { icon: "⬡", label: "EARTHQUAKE", color: "#FF8C00" },
};

function fmt(value: unknown, unit = ""): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return `${value.toLocaleString()}${unit ? " " + unit : ""}`;
  return String(value);
}

function InfoPanel({
  info,
  onClose,
}: {
  info: SelectedInfo;
  onClose: () => void;
}) {
  const meta = TYPE_META[info.type];
  const d = info.data;

  let rows: Array<[string, string]> = [];

  if (info.type === "aircraft" || info.type === "military") {
    rows = [
      ["Callsign",    fmt(d.callsign) || "—"],
      ["ICAO24",      fmt(d.icao24)],
      ["Country",     fmt(d.origin_country) || "—"],
      ["Altitude",    d.altitude != null ? `${Number(d.altitude).toLocaleString()} m` : "—"],
      ["Speed",       d.velocity != null ? `${Number(d.velocity).toFixed(0)} m/s` : "—"],
      ["Heading",     d.heading != null ? `${Number(d.heading).toFixed(0)}°` : "—"],
      ["Vert. Rate",  d.vertical_rate != null ? `${Number(d.vertical_rate).toFixed(1)} m/s` : "—"],
      ["Status",      d.on_ground ? "On ground" : "Airborne"],
    ];
  } else if (info.type === "satellite") {
    rows = [
      ["Name",        fmt(d.name)],
      ["NORAD ID",    fmt(d.norad_id)],
      ["Altitude",    d.altitude_km != null ? `${Number(d.altitude_km).toLocaleString()} km` : "—"],
      ["Velocity",    d.velocity_km_s != null ? `${Number(d.velocity_km_s).toFixed(2)} km/s` : "—"],
    ];
  } else if (info.type === "earthquake") {
    const ms = d.time_ms as number | null;
    const timeStr = ms ? new Date(ms).toUTCString().slice(17, 25) + " UTC" : "—";
    rows = [
      ["Location",   fmt(d.place)],
      ["Magnitude",  d.magnitude != null ? `M${Number(d.magnitude).toFixed(1)}` : "—"],
      ["Depth",      d.depth_km != null ? `${Number(d.depth_km).toFixed(1)} km` : "—"],
      ["Time",       timeStr],
    ];
  }

  return (
    <div style={panelStyles.container}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ ...panelStyles.typeLabel, color: meta.color }}>
          {meta.icon} {meta.label}
        </span>
        <button style={panelStyles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div style={{ ...panelStyles.divider, borderColor: meta.color + "44" }} />
      {/* Data rows */}
      {rows.map(([label, value]) => (
        <div key={label} style={panelStyles.row}>
          <span style={panelStyles.rowLabel}>{label}</span>
          <span style={{ ...panelStyles.rowValue, color: label === "Callsign" || label === "Name" ? "#E2E8F0" : "#94A3B8" }}>
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

const panelStyles: Record<string, React.CSSProperties> = {
  container: {
    position: "absolute",
    top: 16,
    right: 16,
    zIndex: 1000,
    width: 230,
    backgroundColor: "rgba(2, 6, 23, 0.90)",
    border: "1px solid #1E293B",
    borderRadius: 8,
    padding: "12px 14px",
    backdropFilter: "blur(12px)",
    fontFamily: "'Courier New', Courier, monospace",
    color: "#E2E8F0",
    userSelect: "none",
  },
  typeLabel: {
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: "0.14em",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "#475569",
    cursor: "pointer",
    fontSize: 12,
    padding: 2,
    lineHeight: 1,
  },
  divider: {
    height: 1,
    borderTop: "1px solid",
    marginBottom: 10,
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 5,
    gap: 8,
  },
  rowLabel: {
    fontSize: 10,
    letterSpacing: "0.1em",
    color: "#475569",
    flexShrink: 0,
  },
  rowValue: {
    fontSize: 11,
    textAlign: "right",
    wordBreak: "break-word",
  },
};

// ── Satellite icon ─────────────────────────────────────────────────────────────

function createSatelliteIcon(color = "#00FFFF", size = 24): string {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const cx = size / 2;
  const cy = size / 2;

  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;

  // Body
  ctx.fillRect(cx - 3.5, cy - 2.5, 7, 5);

  // Solar panels — left and right
  ctx.fillRect(cx - 3.5 - 8, cy - 1.5, 7, 3);
  ctx.fillRect(cx + 3.5 + 1,  cy - 1.5, 7, 3);

  // Antenna
  ctx.beginPath();
  ctx.moveTo(cx, cy - 2.5);
  ctx.lineTo(cx, cy - 6.5);
  ctx.stroke();

  return canvas.toDataURL();
}

const SATELLITE_ICON = createSatelliteIcon();

// ── Aircraft icons ─────────────────────────────────────────────────────────────

type AircraftCategory = "WIDE" | "NARROW" | "REGIONAL" | "HELI" | "GENERAL";

const ICON_SIZES: Record<AircraftCategory, number> = {
  WIDE: 28, NARROW: 22, REGIONAL: 17, HELI: 17, GENERAL: 17,
};

// Distance (metres from camera to surface) above which icons switch to dots.
const ICON_MAX_DISTANCE = 3_000_000;

function getAircraftCategory(typecode: string): AircraftCategory {
  const t = (typecode ?? "").toUpperCase();
  if (!t) return "GENERAL";
  // Helicopters
  if (/^(EC|R22|R44|H6|AS3|AW|S76|B06|MBB|PZL)/.test(t)) return "HELI";
  // Wide-body jets
  if (/^(B74|B77|B78|A38|A35|A34|A33|IL9|AN1|C17|B76)/.test(t)) return "WIDE";
  // Narrow-body jets
  if (/^(B73|B75|B71|B72|A31|A32|MD8|MD9|DC9|73|32|TU2|YA4)/.test(t)) return "NARROW";
  // Regional / turboprops
  if (/^(CRJ|E17|E19|E75|AT4|AT7|DH8|SF3|BE2|E50|C56|C17|P28|C208|PC12|JS4|SA2)/.test(t)) return "REGIONAL";
  return "GENERAL";
}

function createAircraftIcon(category: AircraftCategory): string {
  const s = ICON_SIZES[category];
  const canvas = document.createElement("canvas");
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#FFFFFF";
  ctx.strokeStyle = "#FFFFFF";
  const cx = s / 2;

  if (category === "HELI") {
    // Rotor cross + oval body
    ctx.lineWidth = 1.5;
    ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(2, cx); ctx.lineTo(s - 2, cx); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, 2); ctx.lineTo(cx, s - 2); ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cx + 1, 2.5, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    return canvas.toDataURL();
  }

  // Fixed-wing silhouette — nose points UP (positive Y down in canvas)
  const fuseW = category === "WIDE" ? 2.8 : category === "NARROW" ? 2.2 : 1.7;
  const noseY = 2;
  const tailY = s - 3;

  // Fuselage (tapered body)
  ctx.beginPath();
  ctx.moveTo(cx, noseY);
  ctx.lineTo(cx + fuseW, noseY + fuseW * 2.5);
  ctx.lineTo(cx + fuseW, tailY - fuseW * 1.5);
  ctx.lineTo(cx, tailY);
  ctx.lineTo(cx - fuseW, tailY - fuseW * 1.5);
  ctx.lineTo(cx - fuseW, noseY + fuseW * 2.5);
  ctx.closePath();
  ctx.fill();

  // Main wings
  const wingSpan = category === "WIDE" ? s * 0.93 : category === "NARROW" ? s * 0.82 : s * 0.76;
  const wingY    = s * 0.43;
  const sweep    = category === "WIDE" ? s * 0.13 : category === "NARROW" ? s * 0.10 : s * 0.05;
  const chord    = s * 0.13;

  ctx.beginPath();
  ctx.moveTo(cx,                wingY);
  ctx.lineTo(cx - wingSpan / 2, wingY + sweep + chord);
  ctx.lineTo(cx - wingSpan / 2, wingY + sweep);
  ctx.lineTo(cx,                wingY - chord * 0.15);
  ctx.lineTo(cx + wingSpan / 2, wingY + sweep);
  ctx.lineTo(cx + wingSpan / 2, wingY + sweep + chord);
  ctx.closePath();
  ctx.fill();

  // Tail stabilizer
  const tSpan  = wingSpan * 0.36;
  const tBaseY = s - 4;
  const tSweep = tSpan * (category === "WIDE" ? 0.28 : 0.18);
  const tChord = tSpan * 0.18;

  ctx.beginPath();
  ctx.moveTo(cx,             tBaseY);
  ctx.lineTo(cx - tSpan / 2, tBaseY + tSweep + tChord);
  ctx.lineTo(cx - tSpan / 2, tBaseY + tSweep);
  ctx.lineTo(cx,             tBaseY - tChord * 0.2);
  ctx.lineTo(cx + tSpan / 2, tBaseY + tSweep);
  ctx.lineTo(cx + tSpan / 2, tBaseY + tSweep + tChord);
  ctx.closePath();
  ctx.fill();

  return canvas.toDataURL();
}

const AIRCRAFT_ICONS: Record<AircraftCategory, string> = {
  WIDE:     createAircraftIcon("WIDE"),
  NARROW:   createAircraftIcon("NARROW"),
  REGIONAL: createAircraftIcon("REGIONAL"),
  HELI:     createAircraftIcon("HELI"),
  GENERAL:  createAircraftIcon("GENERAL"),
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function GlobeView({ payload, layers, visualMode, weatherLayers, onViewerReady }: GlobeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const handlerRef = useRef<Cesium.ScreenSpaceEventHandler | null>(null);

  const aircraftColRef = useRef<Cesium.PointPrimitiveCollection | null>(null);
  const militaryColRef = useRef<Cesium.PointPrimitiveCollection | null>(null);
  const satelliteDsRef = useRef<Cesium.CustomDataSource | null>(null);
  const earthquakeColRef = useRef<Cesium.PointPrimitiveCollection | null>(null);
  const aircraftTrailsRef = useRef<Cesium.PolylineCollection | null>(null);
  const militaryTrailsRef = useRef<Cesium.PolylineCollection | null>(null);
  const aircraftBillboardsRef = useRef<Cesium.BillboardCollection | null>(null);
  const militaryBillboardsRef = useRef<Cesium.BillboardCollection | null>(null);

  const crtStageRef = useRef<Cesium.PostProcessStage | null>(null);
  const nvStageRef = useRef<Cesium.PostProcessStage | null>(null);
  const flirStageRef = useRef<Cesium.PostProcessStage | null>(null);
  const weatherLayerRefsRef = useRef<Partial<Record<WeatherLayerKey, Cesium.ImageryLayer>>>({});

  const [selectedInfo, setSelectedInfo] = useState<SelectedInfo | null>(null);

  // ── Initialise viewer ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    Cesium.Ion.defaultAccessToken = "";

    const viewer = new Cesium.Viewer(containerRef.current, {
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      navigationHelpButton: false,
      sceneModePicker: false,
    });

    viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();

    // ── Imagery — ESRI World Imagery (free, no API key) ─────────────────────
    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.addImageryProvider(
      new Cesium.UrlTemplateImageryProvider({
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        credit: "Tiles © Esri — Source: Esri, USGS, NOAA",
        maximumLevel: 19,
      })
    );

    // ── Weather overlays — OpenWeatherMap tile layers (hidden until toggled) ──
    const OWM_KEY = import.meta.env.VITE_OWM_API_KEY ?? "";
    const OWM_LAYER_NAMES: Record<WeatherLayerKey, string> = {
      clouds:   "clouds_new",
      rain:     "precipitation_new",
      wind:     "wind_new",
      temp:     "temp_new",
      pressure: "pressure_new",
    };
    if (OWM_KEY) {
      const weatherRefs: Partial<Record<WeatherLayerKey, Cesium.ImageryLayer>> = {};
      for (const [key, owmName] of Object.entries(OWM_LAYER_NAMES) as [WeatherLayerKey, string][]) {
        const layer = viewer.imageryLayers.addImageryProvider(
          new Cesium.UrlTemplateImageryProvider({
            url: `https://tile.openweathermap.org/map/${owmName}/{z}/{x}/{y}.png?appid=${OWM_KEY}`,
            credit: "Weather © OpenWeatherMap",
            maximumLevel: 6,
          })
        );
        layer.show  = false;
        layer.alpha = 0.7;
        weatherRefs[key] = layer;
      }
      weatherLayerRefsRef.current = weatherRefs;
    }

    // ── Lighting — sun-based day/night terminator ────────────────────────────
    viewer.scene.globe.enableLighting = true;
    viewer.scene.globe.atmosphereLightIntensity  = 5.0;
    viewer.scene.globe.atmosphereHueShift        = 0.0;
    viewer.scene.globe.atmosphereSaturationShift = 0.1;
    viewer.scene.globe.atmosphereBrightnessShift = 0.1;

    // ── Atmosphere — richer sky glow ─────────────────────────────────────────
    if (viewer.scene.skyAtmosphere) {
      viewer.scene.skyAtmosphere.show = true;
      viewer.scene.skyAtmosphere.atmosphereLightIntensity = 15.0;
      viewer.scene.skyAtmosphere.atmosphereRayleighCoefficient =
        new Cesium.Cartesian3(5.5e-6, 13.0e-6, 28.4e-6);
    }

    // ── Fog — depth perception ───────────────────────────────────────────────
    viewer.scene.fog.enabled               = true;
    viewer.scene.fog.density               = 0.0002;
    viewer.scene.fog.screenSpaceErrorFactor = 4.0;

    // ── High-DPI ─────────────────────────────────────────────────────────────
    viewer.resolutionScale = window.devicePixelRatio;

    try {
      (viewer.cesiumWidget.creditContainer as HTMLElement).style.display = "none";
    } catch {
      // Ignore if unavailable
    }

    // ── Primitive collections ────────────────────────────────────────────────
    const aircraftCol = viewer.scene.primitives.add(
      new Cesium.PointPrimitiveCollection()
    ) as Cesium.PointPrimitiveCollection;
    const militaryCol = viewer.scene.primitives.add(
      new Cesium.PointPrimitiveCollection()
    ) as Cesium.PointPrimitiveCollection;
    const earthquakeCol = viewer.scene.primitives.add(
      new Cesium.PointPrimitiveCollection()
    ) as Cesium.PointPrimitiveCollection;

    aircraftColRef.current = aircraftCol;
    militaryColRef.current = militaryCol;
    earthquakeColRef.current = earthquakeCol;

    const aircraftTrails = viewer.scene.primitives.add(
      new Cesium.PolylineCollection()
    ) as Cesium.PolylineCollection;
    const militaryTrails = viewer.scene.primitives.add(
      new Cesium.PolylineCollection()
    ) as Cesium.PolylineCollection;
    aircraftTrailsRef.current = aircraftTrails;
    militaryTrailsRef.current = militaryTrails;

    const aircraftBillboards = viewer.scene.primitives.add(
      new Cesium.BillboardCollection({ scene: viewer.scene })
    ) as Cesium.BillboardCollection;
    const militaryBillboards = viewer.scene.primitives.add(
      new Cesium.BillboardCollection({ scene: viewer.scene })
    ) as Cesium.BillboardCollection;
    aircraftBillboardsRef.current = aircraftBillboards;
    militaryBillboardsRef.current = militaryBillboards;

    // ── Satellite data source (entity-based for SampledPositionProperty) ──────
    const satelliteDs = new Cesium.CustomDataSource("satellites");
    viewer.dataSources.add(satelliteDs);
    satelliteDsRef.current = satelliteDs;

    // ── Clock — real-time animation ──────────────────────────────────────────
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date());
    viewer.clock.clockRange = Cesium.ClockRange.UNBOUNDED;
    viewer.clock.shouldAnimate = true;
    viewer.clock.multiplier = 1;

    // ── Post-process stages (disabled by default) ────────────────────────────
    const crtStage = viewer.scene.postProcessStages.add(
      new Cesium.PostProcessStage({ fragmentShader: CRT_SHADER, name: "wv_crt" })
    ) as Cesium.PostProcessStage;
    crtStage.enabled = false;

    const nvStage = viewer.scene.postProcessStages.add(
      new Cesium.PostProcessStage({ fragmentShader: NIGHT_VISION_SHADER, name: "wv_nv" })
    ) as Cesium.PostProcessStage;
    nvStage.enabled = false;

    const flirStage = viewer.scene.postProcessStages.add(
      new Cesium.PostProcessStage({ fragmentShader: FLIR_SHADER, name: "wv_flir" })
    ) as Cesium.PostProcessStage;
    flirStage.enabled = false;

    crtStageRef.current = crtStage;
    nvStageRef.current = nvStage;
    flirStageRef.current = flirStage;

    // ── Click handler ────────────────────────────────────────────────────────
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(
      (click: { position: Cesium.Cartesian2 }) => {
        const picked = viewer.scene.pick(click.position);
        if (!Cesium.defined(picked)) {
          setSelectedInfo(null);
          return;
        }
        // Primitive pick: id is SelectedInfo directly
        if (picked.id && !(picked.id instanceof Cesium.Entity)) {
          setSelectedInfo(picked.id as SelectedInfo);
          return;
        }
        // Entity pick (satellite): SelectedInfo stored in properties.info
        if (picked.id instanceof Cesium.Entity && picked.id.properties) {
          const info = picked.id.properties.getValue(
            viewer.clock.currentTime
          ) as { info?: SelectedInfo } | undefined;
          if (info?.info) {
            setSelectedInfo(info.info);
            return;
          }
        }
        setSelectedInfo(null);
      },
      Cesium.ScreenSpaceEventType.LEFT_CLICK
    );
    handlerRef.current = handler;

    viewerRef.current = viewer;
    onViewerReady?.(viewer);

    return () => {
      handlerRef.current?.destroy();
      handlerRef.current = null;
      viewerRef.current = null;
      aircraftColRef.current = null;
      militaryColRef.current = null;
      satelliteDsRef.current = null;
      earthquakeColRef.current = null;
      aircraftTrailsRef.current = null;
      militaryTrailsRef.current = null;
      aircraftBillboardsRef.current = null;
      militaryBillboardsRef.current = null;
      crtStageRef.current = null;
      nvStageRef.current = null;
      flirStageRef.current = null;
      weatherLayerRefsRef.current = {};
      if (!viewer.isDestroyed()) {
        viewer.destroy();
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Update primitives when payload arrives ─────────────────────────────────
  useEffect(() => {
    if (!payload) return;

    const ac = aircraftColRef.current;
    const mil = militaryColRef.current;
    const sat = satelliteDsRef.current;
    const eq = earthquakeColRef.current;
    const acTrails = aircraftTrailsRef.current;
    const milTrails = militaryTrailsRef.current;
    const acBillboards = aircraftBillboardsRef.current;
    const milBillboards = militaryBillboardsRef.current;
    if (!ac || !mil || !sat || !eq || !acTrails || !milTrails || !acBillboards || !milBillboards) return;

    const DOT_RANGE   = new Cesium.DistanceDisplayCondition(ICON_MAX_DISTANCE, Number.MAX_VALUE);
    const ICON_RANGE  = new Cesium.DistanceDisplayCondition(0, ICON_MAX_DISTANCE);

    // Aircraft — silhouette icons (close) + dots (far out)
    ac.removeAll();
    acBillboards.removeAll();
    acTrails.removeAll();
    for (const f of payload.aircraft.features) {
      const [lon, lat] = f.geometry.coordinates as [number, number];
      const alt = (f.properties.altitude as number | null) ?? 0;
      const clampedAlt = Math.max(alt, 0);
      const color =
        alt > 9000
          ? Cesium.Color.fromCssColorString("#00E5FF")
          : alt > 4000
          ? Cesium.Color.fromCssColorString("#87CEEB")
          : Cesium.Color.WHITE;
      const pos = Cesium.Cartesian3.fromDegrees(lon, lat, clampedAlt);
      const id: SelectedInfo = { type: "aircraft", data: f.properties };

      // Dot for far zoom
      ac.add({
        position: pos,
        color,
        pixelSize: 4,
        outlineColor: color.withAlpha(0.25),
        outlineWidth: 1,
        distanceDisplayCondition: DOT_RANGE,
        id,
      });

      // Silhouette icon for close zoom
      const category = getAircraftCategory(f.properties.typecode as string ?? "");
      const heading = (f.properties.heading as number | null) ?? 0;
      acBillboards.add({
        position: pos,
        image: AIRCRAFT_ICONS[category],
        width:  ICON_SIZES[category],
        height: ICON_SIZES[category],
        color,
        rotation: -(heading * Math.PI / 180),
        alignedAxis: Cesium.Cartesian3.UNIT_Z,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: ICON_RANGE,
        id,
      });

      // Trail
      const trail = (f.properties.trail as number[][] | undefined) ?? [];
      if (trail.length >= 2) {
        for (let i = 0; i < trail.length - 1; i++) {
          const alpha = ((i + 1) / (trail.length - 1)) * 0.7;
          acTrails.add({
            positions: [
              Cesium.Cartesian3.fromDegrees(trail[i][0], trail[i][1], Math.max(trail[i][2] ?? 0, 0)),
              Cesium.Cartesian3.fromDegrees(trail[i + 1][0], trail[i + 1][1], Math.max(trail[i + 1][2] ?? 0, 0)),
            ],
            width: 1,
            material: Cesium.Material.fromType("Color", { color: color.withAlpha(alpha) }),
          });
        }
      }
    }

    // Military — silhouette icons (close) + dots (far out), red tint
    mil.removeAll();
    milBillboards.removeAll();
    milTrails.removeAll();
    for (const f of payload.military.features) {
      const [lon, lat] = f.geometry.coordinates as [number, number];
      const alt = Math.max((f.properties.altitude as number | null) ?? 0, 0);
      const pos = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
      const id: SelectedInfo = { type: "military", data: f.properties };

      // Dot for far zoom
      mil.add({
        position: pos,
        color: Cesium.Color.RED,
        pixelSize: 6,
        outlineColor: Cesium.Color.fromCssColorString("#FF4444").withAlpha(0.4),
        outlineWidth: 2,
        distanceDisplayCondition: DOT_RANGE,
        id,
      });

      // Silhouette icon for close zoom
      const category = getAircraftCategory(f.properties.typecode as string ?? "");
      const heading = (f.properties.heading as number | null) ?? 0;
      milBillboards.add({
        position: pos,
        image: AIRCRAFT_ICONS[category],
        width:  ICON_SIZES[category],
        height: ICON_SIZES[category],
        color: Cesium.Color.RED,
        rotation: -(heading * Math.PI / 180),
        alignedAxis: Cesium.Cartesian3.UNIT_Z,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: ICON_RANGE,
        id,
      });

      // Trail
      const trail = (f.properties.trail as number[][] | undefined) ?? [];
      if (trail.length >= 2) {
        for (let i = 0; i < trail.length - 1; i++) {
          const alpha = ((i + 1) / (trail.length - 1)) * 0.7;
          milTrails.add({
            positions: [
              Cesium.Cartesian3.fromDegrees(trail[i][0], trail[i][1], Math.max(trail[i][2] ?? 0, 0)),
              Cesium.Cartesian3.fromDegrees(trail[i + 1][0], trail[i + 1][1], Math.max(trail[i + 1][2] ?? 0, 0)),
            ],
            width: 1,
            material: Cesium.Material.fromType("Color", { color: Cesium.Color.RED.withAlpha(alpha) }),
          });
        }
      }
    }

    // Satellites — animated entities driven by SampledPositionProperty + satellite.js SGP4
    sat.entities.suspendEvents();
    sat.entities.removeAll();

    const nowMs = Date.now();
    const STEP_SEC = 120;         // sample every 2 minutes
    const HALF_WINDOW_SEC = 2700; // ±45 minutes → ~45 samples per satellite

    for (const tle of payload.tles ?? []) {
      const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
      const positionProp = new Cesium.SampledPositionProperty();
      positionProp.setInterpolationOptions({
        interpolationDegree: 5,
        interpolationAlgorithm: Cesium.LagrangePolynomialApproximation,
      });

      let valid = true;
      for (let offset = -HALF_WINDOW_SEC; offset <= HALF_WINDOW_SEC; offset += STEP_SEC) {
        const date = new Date(nowMs + offset * 1000);
        const pv = satellite.propagate(satrec, date);
        if (!pv || !pv.position || typeof pv.position === "boolean") {
          valid = false;
          break;
        }
        const gmst = satellite.gstime(date);
        const geo = satellite.eciToGeodetic(pv.position as satellite.EciVec3<number>, gmst);
        const lon = satellite.degreesLong(geo.longitude);
        const lat = satellite.degreesLat(geo.latitude);
        const altM = (geo.height as number) * 1000;
        positionProp.addSample(
          Cesium.JulianDate.fromDate(date),
          Cesium.Cartesian3.fromDegrees(lon, lat, altM),
        );
      }
      if (!valid) continue;

      // Current altitude & velocity from a single propagation at now
      let altitudeKm: number | null = null;
      let velocityKmS: number | null = null;
      const pvNow = satellite.propagate(satrec, new Date(nowMs));
      if (pvNow?.position && typeof pvNow.position !== "boolean") {
        const gmstNow = satellite.gstime(new Date(nowMs));
        const geoNow = satellite.eciToGeodetic(pvNow.position as satellite.EciVec3<number>, gmstNow);
        altitudeKm = Math.round(geoNow.height as number);
        if (pvNow.velocity && typeof pvNow.velocity !== "boolean") {
          const v = pvNow.velocity as satellite.EciVec3<number>;
          velocityKmS = Math.round(Math.sqrt(v.x ** 2 + v.y ** 2 + v.z ** 2) * 100) / 100;
        }
      }

      sat.entities.add({
        position: positionProp,
        billboard: new Cesium.BillboardGraphics({
          image: SATELLITE_ICON,
          width:  20,
          height: 20,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance:        new Cesium.NearFarScalar(5e5, 1.4, 1.5e7, 0.5),
          translucencyByDistance: new Cesium.NearFarScalar(1e6, 1.0, 2e8,  0.5),
        }),
        label: new Cesium.LabelGraphics({
          text: tle.name,
          font: "11px 'Courier New', Courier, monospace",
          fillColor:    Cesium.Color.fromCssColorString("#00FFFF"),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style:       Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -18),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance:        new Cesium.NearFarScalar(5e5, 0.9, 5e6, 0.0),
          translucencyByDistance: new Cesium.NearFarScalar(5e5, 1.0, 5e6, 0.0),
        }),
        path: new Cesium.PathGraphics({
          resolution: 60,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.3,
            color: Cesium.Color.fromCssColorString("#00FFFF").withAlpha(0.6),
          }),
          width:     2,
          leadTime:  new Cesium.ConstantProperty(0),
          trailTime: new Cesium.ConstantProperty(1800),
        }),
        // Store SelectedInfo on the entity so the click handler can read it
        properties: new Cesium.PropertyBag({
          info: { type: "satellite", data: { norad_id: tle.norad_id, name: tle.name, altitude_km: altitudeKm, velocity_km_s: velocityKmS } } satisfies SelectedInfo,
        }),
      });
    }

    sat.entities.resumeEvents();

    // Earthquakes — orange/red dots sized by magnitude
    eq.removeAll();
    for (const f of payload.earthquakes.features) {
      const [lon, lat] = f.geometry.coordinates as [number, number];
      const mag = (f.properties.magnitude as number) ?? 2.5;
      const size = Math.max(4, mag * 4);
      const hue = Math.max(0.0, 0.09 - (mag - 2.5) / 55);
      eq.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        color: Cesium.Color.fromHsl(hue, 1.0, 0.55),
        pixelSize: size,
        outlineColor: Cesium.Color.YELLOW.withAlpha(0.3),
        outlineWidth: 1,
        id: { type: "earthquake", data: f.properties } satisfies SelectedInfo,
      });
    }
  }, [payload]);

  // ── Layer visibility ───────────────────────────────────────────────────────
  useEffect(() => {
    if (aircraftColRef.current) aircraftColRef.current.show = layers.aircraft;
    if (aircraftBillboardsRef.current) aircraftBillboardsRef.current.show = layers.aircraft;
    if (militaryColRef.current) militaryColRef.current.show = layers.military;
    if (militaryBillboardsRef.current) militaryBillboardsRef.current.show = layers.military;
    if (satelliteDsRef.current) satelliteDsRef.current.show = layers.satellites;
    if (earthquakeColRef.current) earthquakeColRef.current.show = layers.earthquakes;
    if (aircraftTrailsRef.current) aircraftTrailsRef.current.show = layers.trails;
    if (militaryTrailsRef.current) militaryTrailsRef.current.show = layers.trails;
  }, [layers]);

  // ── Visual mode shaders ────────────────────────────────────────────────────
  useEffect(() => {
    if (!crtStageRef.current || !nvStageRef.current || !flirStageRef.current) return;
    crtStageRef.current.enabled = visualMode === "crt";
    nvStageRef.current.enabled = visualMode === "nightvision";
    flirStageRef.current.enabled = visualMode === "flir";
  }, [visualMode]);

  // ── Weather layer visibility ───────────────────────────────────────────────
  useEffect(() => {
    const refs = weatherLayerRefsRef.current;
    (Object.keys(weatherLayers) as WeatherLayerKey[]).forEach((key) => {
      if (refs[key]) refs[key]!.show = weatherLayers[key];
    });
  }, [weatherLayers]);

  return (
    <div style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      {selectedInfo && (
        <InfoPanel info={selectedInfo} onClose={() => setSelectedInfo(null)} />
      )}
    </div>
  );
}
