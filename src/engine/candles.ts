/**
 * OHLC candle aggregation over the deterministic 1-second price path.
 * Nothing is stored: any historical window is recomputed on demand by
 * evaluating ticks (O(window)). A single pass evaluates each second exactly
 * once; bars are grouped by their (floor-aligned) open second, and the final
 * bar is partial when the window ends mid-bar (charts never see future ticks).
 */

import type { Candle } from "./model";
import { floorDiv } from "./math";
import { pricePaise } from "./price";

export const TIMEFRAMES = [60, 300, 900] as const; // 1m / 5m / 15m
export type TimeframeSec = (typeof TIMEFRAMES)[number];

export function buildCandles(
  symbol: string,
  fromSec: number,
  toSec: number,
  tfSec: number,
): Candle[] {
  if (toSec < fromSec) return [];
  const tf = BigInt(tfSec);
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let curBarStart = -1n;

  for (let s = BigInt(fromSec); s <= BigInt(toSec); s += 1n) {
    const barStart = floorDiv(s, tf) * tf;
    const p = pricePaise(symbol, s);
    if (cur === null || barStart !== curBarStart) {
      if (cur) out.push(cur);
      cur = {
        time: Number(barStart),
        openPaise: p,
        highPaise: p,
        lowPaise: p,
        closePaise: p,
      };
      curBarStart = barStart;
    } else {
      if (p > cur.highPaise) cur.highPaise = p;
      if (p < cur.lowPaise) cur.lowPaise = p;
      cur.closePaise = p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** The trailing `barCount` bars ending at (or just before) untilSec. */
export function candleSeries(
  symbol: string,
  untilSec: number,
  tfSec: number,
  barCount: number,
): Candle[] {
  const tf = BigInt(tfSec);
  const lastBarStart = floorDiv(BigInt(untilSec), tf) * tf;
  const firstBarStart = lastBarStart - BigInt(Math.max(0, barCount - 1)) * tf;
  return buildCandles(symbol, Number(firstBarStart), untilSec, tfSec);
}

/**
 * Incremental live extension: continue a previously built series forward to
 * untilSec by evaluating ONLY the ticks that were not yet seen (the prior
 * series already aggregated everything through prevEndSec). Bars are merged
 * across the seam when both sides share a bar, then the series is trimmed to
 * the trailing maxBars window. Deterministic and byte-identical to a full
 * rebuild — but O(delta) per tick instead of O(window).
 */
export function extendLiveSeries(
  symbol: string,
  prev: Candle[],
  prevEndSec: number,
  untilSec: number,
  tfSec: number,
  maxBars: number,
): { candles: Candle[]; endSec: number } {
  if (untilSec <= prevEndSec) {
    return {
      candles: prev.slice(-maxBars),
      endSec: prevEndSec,
    };
  }
  let out = prev.slice();
  const part = buildCandles(symbol, prevEndSec + 1, untilSec, tfSec);
  if (part.length > 0) {
    const last = out[out.length - 1];
    const first = part[0];
    if (last && first.time === last.time) {
      // Same bar straddles the seam — roll the new ticks into it.
      out[out.length - 1] = {
        time: last.time,
        openPaise: last.openPaise,
        highPaise:
          first.highPaise > last.highPaise ? first.highPaise : last.highPaise,
        lowPaise: first.lowPaise < last.lowPaise ? first.lowPaise : last.lowPaise,
        closePaise: first.closePaise,
      };
      out = out.concat(part.slice(1));
    } else {
      out = out.concat(part);
    }
  }
  if (out.length > maxBars) out = out.slice(out.length - maxBars);
  return { candles: out, endSec: untilSec };
}
