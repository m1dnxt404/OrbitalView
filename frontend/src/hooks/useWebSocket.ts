import { useEffect, useRef, useState, useCallback } from "react";
import type { WorldPayload, ConnectionStatus } from "../types";
import { WorldPayloadSchema } from "../schemas";

const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;
const BACKOFF_MULTIPLIER = 1.5;

interface UseWebSocketResult {
  payload: WorldPayload | null;
  status: ConnectionStatus;
}

export function useWebSocket(url: string): UseWebSocketResult {
  const [payload, setPayload] = useState<WorldPayload | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelayRef = useRef<number>(RECONNECT_DELAY_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef<boolean>(true);

  const connect = useCallback(() => {
    if (!isMountedRef.current) return;

    setStatus("connecting");
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!isMountedRef.current) return;
      setStatus("connected");
      reconnectDelayRef.current = RECONNECT_DELAY_MS;
    };

    ws.onmessage = (event: MessageEvent) => {
      if (!isMountedRef.current) return;
      try {
        const raw = JSON.parse(event.data as string);
        const result = WorldPayloadSchema.safeParse(raw);
        if (!result.success) {
          console.error("[useWebSocket] Invalid payload:", result.error.issues);
          return;
        }
        setPayload(result.data as WorldPayload);
      } catch {
        console.error("[useWebSocket] Failed to parse message");
      }
    };

    ws.onerror = () => {
      if (!isMountedRef.current) return;
      setStatus("error");
    };

    ws.onclose = () => {
      if (!isMountedRef.current) return;
      setStatus("disconnected");

      const delay = Math.min(reconnectDelayRef.current, MAX_RECONNECT_DELAY_MS);
      reconnectDelayRef.current = Math.floor(delay * BACKOFF_MULTIPLIER);
      reconnectTimerRef.current = setTimeout(connect, delay);
    };
  }, [url]);

  useEffect(() => {
    isMountedRef.current = true;
    connect();

    return () => {
      isMountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [connect]);

  return { payload, status };
}
