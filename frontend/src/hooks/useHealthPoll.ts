import { useEffect, useState } from "react";
import type { HealthSources } from "../types";

export function useHealthPoll(intervalMs = 30_000): HealthSources | null {
  const [health, setHealth] = useState<HealthSources | null>(null);

  useEffect(() => {
    const baseUrl = ((import.meta.env.VITE_WS_URL as string) ?? "ws://localhost:8000/ws/live")
      .replace(/^ws/, "http")
      .replace(/\/ws\/.*$/, "");

    const poll = async () => {
      try {
        const res = await fetch(`${baseUrl}/health/detailed`);
        if (res.ok) {
          const data = await res.json();
          setHealth(data.sources as HealthSources);
        }
      } catch {
        // network error — keep previous state
      }
    };

    poll();
    const id = setInterval(poll, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return health;
}
