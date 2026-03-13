const settings = {
  /** Camera height (metres) above which aircraft icons switch to dot markers */
  ICON_MAX_DISTANCE: 3_000_000,

  /** Max satellites rendered — frontend cap independent of backend MAX_SATELLITES */
  MAX_SATELLITES: 500,

  /** Satellite SGP4 sampling interval (seconds) — lower = smoother, higher CPU cost */
  SATELLITE_STEP_SEC: 120,

  /** Half-window around "now" used to build each satellite's orbital trail (seconds = ±45 min) */
  SATELLITE_HALF_WINDOW_SEC: 2_700,

  /** Duration of the satellite trail polyline shown on the globe (seconds = 30 min) */
  SATELLITE_TRAIL_TIME_SEC: 1_800,
} as const;

export default settings;
