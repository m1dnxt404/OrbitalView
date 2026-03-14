export interface GeoJSONPoint {
  type: "Point";
  coordinates: [number, number] | [number, number, number];
}

export interface AircraftProperties {
  icao24: string;
  callsign: string;
  origin_country: string;
  altitude: number | null;
  velocity: number | null;
  heading: number | null;
  vertical_rate: number | null;
  on_ground: boolean;
}

export interface TLERecord {
  norad_id: string;
  name: string;
  line1: string;
  line2: string;
}

export interface EarthquakeProperties {
  id: string;
  magnitude: number;
  place: string;
  depth_km: number;
  time_ms: number;
}

export interface GeoJSONFeature {
  type: "Feature";
  geometry: GeoJSONPoint;
  properties: Record<string, unknown>;
}

export interface GeoJSONFeatureCollection {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
}

export interface WorldPayload {
  aircraft: GeoJSONFeatureCollection;
  military: GeoJSONFeatureCollection;
  tles: TLERecord[];
  earthquakes: GeoJSONFeatureCollection;
  counts: {
    aircraft: number;
    military: number;
    satellites: number;
    earthquakes: number;
  };
  timestamp: number;
}

export interface LayerVisibility {
  aircraft: boolean;
  military: boolean;
  satellites: boolean;
  earthquakes: boolean;
  trails: boolean;
}

export type VisualMode = "normal" | "crt" | "nightvision" | "flir";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export type WeatherLayerKey = "clouds" | "rain" | "wind" | "temp" | "pressure";

export interface WeatherLayers {
  clouds:   boolean;
  rain:     boolean;
  wind:     boolean;
  temp:     boolean;
  pressure: boolean;
}

export interface SourceStatus {
  last_success: number | null;
  is_rate_limited: boolean;
  rate_limited_for_s: number;
}

export interface HealthSources {
  opensky: SourceStatus;
  celestrak: SourceStatus;
  usgs: SourceStatus;
  adsb: SourceStatus;
}
