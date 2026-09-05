import { useEffect, useState } from "react";

/**
 * Browser market clock: returns the current UTC epoch SECOND and re-renders
 * on every tick of the given interval. Used purely for DISPLAY — candles,
 * spot quotes and chart rendering. Settlement never reads this: the Convex
 * server derives time from its own clock (server-authoritative fills), so
 * this hook never sends a timestamp anywhere.
 */
export function useNowSec(intervalMs = 1000): number {
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return nowSec;
}
