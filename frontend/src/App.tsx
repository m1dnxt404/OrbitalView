import React, { useCallback, useMemo, useRef, useState } from "react";
import * as Cesium from "cesium";
import GlobeView from "./components/GlobeView";
import { ControlPanel } from "./components/ControlPanel";
import { CameraPresets } from "./components/CameraPresets";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useWebSocket } from "./hooks/useWebSocket";
import { useHealthPoll } from "./hooks/useHealthPoll";
import type { LayerVisibility, VisualMode, WeatherLayers } from "./types";

const WS_URL = (import.meta.env.VITE_WS_URL as string) ?? "ws://localhost:8000/ws/live";

const DEFAULT_LAYERS: LayerVisibility = {
  aircraft: true,
  military: true,
  satellites: true,
  earthquakes: true,
  trails: true,
};

const DEFAULT_WEATHER: WeatherLayers = {
  clouds: false,
  rain: false,
  wind: false,
  temp: false,
  pressure: false,
};

export default function App(): React.ReactElement {
  const { payload, status } = useWebSocket(WS_URL);
  const health = useHealthPoll();

  const [layers, setLayers] = useState<LayerVisibility>(DEFAULT_LAYERS);
  const [visualMode, setVisualMode] = useState<VisualMode>("normal");
  const [weatherLayers, setWeatherLayers] = useState<WeatherLayers>(DEFAULT_WEATHER);
  const viewerRef = useRef<Cesium.Viewer | null>(null);

  const lastUpdated = useMemo(
    () => (payload ? new Date(payload.timestamp * 1000) : null),
    [payload]
  );

  const counts = useMemo(
    () =>
      payload?.counts ?? {
        aircraft: 0,
        military: 0,
        satellites: 0,
        earthquakes: 0,
      },
    [payload]
  );

  const handleLayerToggle = useCallback((layer: keyof LayerVisibility) => {
    setLayers((prev) => ({ ...prev, [layer]: !prev[layer] }));
  }, []);

  const handleWeatherToggle = useCallback((layer: keyof WeatherLayers) => {
    setWeatherLayers((prev) => ({ ...prev, [layer]: !prev[layer] }));
  }, []);

  const handleViewerReady = useCallback((viewer: Cesium.Viewer) => {
    viewerRef.current = viewer;
  }, []);

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative", overflow: "hidden" }}>
      <ErrorBoundary>
        <GlobeView
          payload={payload}
          layers={layers}
          visualMode={visualMode}
          weatherLayers={weatherLayers}
          onViewerReady={handleViewerReady}
        />
      </ErrorBoundary>
      <ControlPanel
        counts={counts}
        status={status}
        lastUpdated={lastUpdated}
        layers={layers}
        onLayerToggle={handleLayerToggle}
        visualMode={visualMode}
        onVisualModeChange={setVisualMode}
        weatherLayers={weatherLayers}
        onWeatherToggle={handleWeatherToggle}
        health={health}
      />
      <CameraPresets viewer={viewerRef.current} />
    </div>
  );
}
