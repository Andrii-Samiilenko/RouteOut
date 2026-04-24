import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * WebSocket hook with auto-reconnect (exponential back-off, max 10 s).
 *
 * React StrictMode (dev) mounts → unmounts → remounts every effect.
 * The cleanup from mount-1 calls ws.close(), but ws.onclose fires
 * asynchronously — AFTER mount-2 has already reset unmounted=false.
 * Without a generation counter, the stale onclose from mount-1 sees
 * unmounted=false and queues a spurious reconnect, creating a cycle.
 *
 * Fix: every connect() call increments `gen`. Callbacks only act if their
 * captured `gen` still matches the current one.
 */
export function useWebSocket() {
  const [data, setData] = useState(null);
  const [connected, setConnected] = useState(false);

  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const attempts = useRef(0);
  const unmounted = useRef(false);
  const genRef = useRef(0); // incremented on each connect() call

  const connect = useCallback(() => {
    if (unmounted.current) return;

    const gen = ++genRef.current; // capture this connection's generation
    // Use window.location.host so the connection goes through the Vite proxy
    // (port 3000) — works for both localhost and a phone on the same WiFi.
    const url = `ws://${window.location.host}/ws`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      // Stale if a newer connection already took over, or component is gone
      if (gen !== genRef.current || unmounted.current) {
        ws.close();
        return;
      }
      setConnected(true);
      attempts.current = 0;
    };

    ws.onmessage = (e) => {
      if (gen !== genRef.current || unmounted.current) return;
      try {
        setData(JSON.parse(e.data));
      } catch {
        // malformed frame — ignore
      }
    };

    ws.onclose = () => {
      // Only reconnect if this is still the active connection and component is mounted
      if (gen !== genRef.current || unmounted.current) return;
      setConnected(false);
      const delay = Math.min(500 * 2 ** attempts.current, 10_000);
      attempts.current += 1;
      reconnectTimer.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      // onclose fires immediately after — reconnect is handled there
    };
  }, []);

  useEffect(() => {
    unmounted.current = false;
    connect();
    return () => {
      unmounted.current = true;
      clearTimeout(reconnectTimer.current);
      // Increment gen so any in-flight callbacks from this connection are silenced
      genRef.current += 1;
      wsRef.current?.close();
    };
  }, [connect]);

  return { data, connected };
}
