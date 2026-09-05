/**
 * DETERMINISTIC MARKET PRICE GENERATOR — src/engine/price.ts
 *
 * ALGORITHM SPEC (single implementation: the Convex settlement functions, the
 * browser local matcher and the chart path all import THIS module, so there is
 * no second implementation to drift).
 *
 * price(symbol, epochSec) -> integer paise, multiple of TICK_PAISE
 *
 *   Let base = symbol.basePaise. Define an "anchor function" F over the
 *   60-second grid (grid point g is a multiple of 60 s):
 *
 *     F(g) = base + Σ_waves coarseWave_w(g)
 *
 *   Each coarse wave w has spacing A_w ∈ {86400, 21600, 3600, 600} seconds
 *   and half-range amplitude amp_w (integer paise, frozen per symbol:
 *   amp_w = floor(base·volBp·waveBp_w / 1_000_000)). Anchor k of wave w sits
 *   at second k·A_w; its level level_w(k) is a bounded 64-bit splitmix64 hash
 *   of (symbol seed, wave id, k) mapped into the closed interval
 *   [-amp_w, +amp_w]. Between anchors the wave is a straight integer line
 *   evaluated at any second s:
 *
 *     coarseWave_w(s) = level_w(k) + floor((level_w(k+1)-level_w(k))·t / A_w)
 *     with k = floor(s/A_w), t = s - k·A_w
 *
 *   The k = 86400 wave is the daily macro drift: its slope
 *   (level(D+1)-level(D))/day derives from (symbol, UTC date) anchor levels
 *   and changes at the 00:00 UTC boundary while the level stays continuous.
 *
 *   The market price at an arbitrary second s ∈ [g, g+60) with g a grid point
 *   is then the linear integer interpolation between the two neighboring
 *   anchor values:
 *
 *     price_raw(s) = F(g) + floor((F(g+60) - F(g))·(s-g) / 60)
 *     price(s)     = floor(price_raw(s) / TICK_PAISE) · TICK_PAISE
 *
 *   Why this structure: every coarse wave is continuous and every 00:00 UTC
 *   boundary is a grid point, so price is continuous across days. Inside a
 *   60 s segment no wave has an interior anchor and the interpolation is
 *   linear, hence price — and any monotone trigger predicate on it — is
 *   monotone there. The first-crossing oracle walks 60 s segments and
 *   binary-searches inside the one segment that brackets the level:
 *   O(segments · log 60), never O(seconds). Per-second motion comes from the
 *   interpolation slope between 60 s anchors; the 5-paise quantization is the
 *   bounded integer micro-noise on top of the multi-scale ramps.
 *
 * Properties: O(1) per tick · integer arithmetic only (no floats, no
 * transcendental functions) · globally continuous · organic multi-scale
 * motion · identical output on every device and every later date.
 *
 * Golden vectors: tests/fixtures/price_vectors.json pins the output; do not
 * change any constant here without bumping MARKET_VERSION in
 * src/config/market.ts and regenerating the vectors.
 */

import { DAY_SECONDS, MARKET_VERSION, SYMBOL_MAP, TICK_PAISE, isSymbol } from "../config/market";
import type { FillTick, OrderTrigger } from "./model";
import { anchorLevel, fnv1a64, floorDiv } from "./math";

const DAY = BigInt(DAY_SECONDS);

/** Coarse waves: spacing seconds + half-range in basis points of the symbol's
 *  scaled base. Every spacing divides the UTC day and is a multiple of 60. */
const COARSE_WAVES = [
  { spacing: 86_400n, waveBp: 120 }, // daily macro drift (per-day slope)
  { spacing: 21_600n, waveBp: 80 }, // 6-hour wave
  { spacing: 3_600n, waveBp: 55 }, // 1-hour wave
  { spacing: 600n, waveBp: 30 }, // 10-minute wave
] as const;

/** Anchor grid spacing (s): coarse-wave anchors all lie on this grid. */
export const ANCHOR_GRID = 60n;

const seedCache = new Map<string, bigint>();
function seedFor(symbol: string): bigint {
  let seed = seedCache.get(symbol);
  if (seed === undefined) {
    seed = fnv1a64(`NSE-${symbol}-v${MARKET_VERSION}`);
    seedCache.set(symbol, seed);
  }
  return seed;
}

/** Amplitude (paise) of one wave for one symbol. Integer, frozen. */
function waveAmp(basePaise: number, volBp: number, waveBp: number): bigint {
  const amp = floorDiv(
    BigInt(basePaise) * BigInt(volBp) * BigInt(waveBp),
    1_000_000n,
  );
  return amp < 1n ? 1n : amp;
}

function waveAt(
  seed: bigint,
  spacing: bigint,
  amp: bigint,
  s: bigint,
): bigint {
  const k = floorDiv(s, spacing);
  const t = s - k * spacing;
  const l0 = anchorLevel(seed, spacing, amp, k);
  const l1 = anchorLevel(seed, spacing, amp, k + 1n);
  return l0 + floorDiv((l1 - l0) * t, spacing);
}

/** Anchor value F at a 60 s grid point: base + all coarse waves. */
function anchorValue(
  symbol: string,
  defBasePaise: number,
  defVolBp: number,
  seed: bigint,
  gridSec: bigint,
): bigint {
  let sum = BigInt(defBasePaise);
  for (const w of COARSE_WAVES) {
    const amp = waveAmp(defBasePaise, defVolBp, w.waveBp);
    sum += waveAt(seed, w.spacing, amp, gridSec);
  }
  return sum;
}

/** Market price for one tick (integer paise, multiple of TICK_PAISE). */
export function pricePaise(symbol: string, epochSec: bigint): bigint {
  const def = SYMBOL_MAP.get(symbol);
  if (!def) {
    throw new Error(`Unknown symbol: ${symbol}`);
  }
  const seed = seedFor(symbol);
  const g = floorDiv(epochSec, ANCHOR_GRID) * ANCHOR_GRID;
  const f0 = anchorValue(symbol, def.basePaise, def.volBp, seed, g);
  const f1 = anchorValue(symbol, def.basePaise, def.volBp, seed, g + ANCHOR_GRID);
  const raw = f0 + floorDiv((f1 - f0) * (epochSec - g), ANCHOR_GRID);
  const tick = BigInt(TICK_PAISE);
  return floorDiv(raw, tick) * tick;
}

/** Alias kept for callers that think in market terms. */
export const marketPrice = pricePaise;

/* ---------------------------------- days --------------------------------- */

/** Start-of-day (00:00:00 UTC) for an epoch second. */
export function dayStartSec(s: bigint): bigint {
  return floorDiv(s, DAY) * DAY;
}

/** First second of the NEXT day (exclusive day end). */
export function dayEndExclusiveSec(s: bigint): bigint {
  return dayStartSec(s) + DAY;
}

/** Last tradable second of the UTC day containing s. */
export function lastTickSecOfDay(s: bigint): bigint {
  return dayEndExclusiveSec(s) - 1n;
}

/* --------------------------------- oracle -------------------------------- */

export type PricePredicate = (p: bigint) => boolean;

/**
 * First integer second s ∈ [fromSec, toSec] (inclusive) with pred(price(s))
 * true, or null. Walks 60 s segments — price is linear (monotone) inside each
 * segment, so a segment only needs work when its endpoints straddle the
 * predicate, resolved by binary search over the actual evaluated price
 * function (never an approximation of it). O(segments · log 60).
 */
export function firstTickWhere(
  symbol: string,
  fromSec: bigint,
  toSec: bigint,
  pred: PricePredicate,
): bigint | null {
  if (toSec < fromSec) return null;
  let segStart = floorDiv(fromSec, ANCHOR_GRID) * ANCHOR_GRID;
  while (segStart <= toSec) {
    const lo = segStart < fromSec ? fromSec : segStart;
    const segEnd = segStart + ANCHOR_GRID - 1n;
    const hi = segEnd < toSec ? segEnd : toSec;
    if (lo <= hi) {
      if (pred(pricePaise(symbol, lo))) return lo;
      if (!pred(pricePaise(symbol, hi))) {
        segStart += ANCHOR_GRID;
        continue;
      }
      let l = lo;
      let r = hi;
      while (l < r) {
        const m = (l + r) >> 1n;
        if (pred(pricePaise(symbol, m))) {
          r = m;
        } else {
          l = m + 1n;
        }
      }
      return l;
    }
    segStart += ANCHOR_GRID;
  }
  return null;
}

/** Trigger predicate factory for an order. */
export function triggerPredicate(o: OrderTrigger): PricePredicate {
  const limit = o.limitPaise ?? null;
  const stop = o.stopPaise ?? null;
  if (o.orderType === "LIMIT") {
    if (limit === null) throw new Error("LIMIT order without limit price");
    return o.side === "BUY" ? (p) => p <= limit : (p) => p >= limit;
  }
  if (o.orderType === "STOP") {
    if (stop === null) throw new Error("STOP order without stop price");
    return o.side === "BUY" ? (p) => p >= stop : (p) => p <= stop;
  }
  // MARKET orders never rest; if one is ever evaluated it fills at spot.
  return () => true;
}

/**
 * Marketable rule: is the trigger condition already satisfied at the given
 * spot price? (limit-buys at/above spot, limit-sells at/below spot, stop
 * orders whose level is already crossed).
 */
export function isMarketable(o: OrderTrigger, spot: bigint): boolean {
  if (o.orderType === "LIMIT") {
    const limit = o.limitPaise ?? null;
    if (limit === null) return false;
    return o.side === "BUY" ? spot <= limit : spot >= limit;
  }
  if (o.orderType === "STOP") {
    const stop = o.stopPaise ?? null;
    if (stop === null) return false;
    return o.side === "BUY" ? spot >= stop : spot <= stop;
  }
  return true;
}

/**
 * Fill-price rule for a resting order once a trigger tick is found:
 * LIMIT fills at the trigger tick's own price (at-or-better); STOP fills at
 * exactly the stop level (guaranteed stop — documented simplification).
 */
export function fillPriceForTrigger(
  o: OrderTrigger,
  tickPrice: bigint,
): bigint {
  if (o.orderType === "STOP") {
    const stop = o.stopPaise ?? null;
    if (stop === null) throw new Error("STOP order without stop price");
    return stop;
  }
  return tickPrice;
}

/**
 * Oracle used by settlement: earliest fill tick of `o` inside the inclusive
 * eligible window [fromSec, toSec]. MARKET is treated as immediately
 * eligible. Returns null when the window holds no trigger.
 */
export function findFillTick(
  symbol: string,
  o: OrderTrigger,
  fromSec: bigint,
  toSec: bigint,
): FillTick | null {
  if (toSec < fromSec) return null;
  if (o.orderType === "MARKET") {
    // Resting MARKET orders are an anomaly (they fill atomically at
    // placement); settle one at the first eligible tick, like a spot fill.
    const p = pricePaise(symbol, fromSec);
    return { sec: Number(fromSec), pricePaise: p };
  }
  const first = firstTickWhere(symbol, fromSec, toSec, triggerPredicate(o));
  if (first === null) return null;
  const tickPrice = pricePaise(symbol, first);
  return {
    sec: Number(first),
    pricePaise: fillPriceForTrigger(o, tickPrice),
  };
}

/* ------------------------------ spot/helpers ------------------------------ */

/** Current spot price (paise) at the given epoch second. */
export function spotAtEpochSec(symbol: string, epochSec: bigint): bigint {
  return pricePaise(symbol, epochSec);
}

/** Valid symbol guard used by RPC argument validation. */
export function assertKnownSymbol(symbol: string): void {
  if (!isSymbol(symbol)) {
    throw new Error(`Unknown symbol: ${symbol}`);
  }
}
