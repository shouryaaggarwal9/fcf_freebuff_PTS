/**
 * SYNTHETIC DEPTH OF MARKET — src/engine/depth.ts
 *
 * Market depth (order book ladder) as a pure function of
 * (symbol, UTC integer second). Same discipline as the price generator:
 *
 *  - O(1) per evaluation, stateless, no stored data.
 *  - Integer arithmetic only (bigint + 64-bit hashing) — bit-identical on
 *    every device and every later date, portable to any backend.
 *  - Never influences fills: the settlement engine prices everything off
 *    pricePaise(); the ladder is display-only realism.
 *
 * Shape: a ±(LEVELS)-deep ladder around the deterministic spot with a
 * per-symbol price-proportional ladder step, per-(level, second) hashed
 * sizes and sub-step price jitter. The jitter is bounded at step/4 so bid
 * prices stay strictly decreasing and ask prices strictly increasing.
 */

import { SYMBOL_MAP, TICK_PAISE } from "../config/market";
import { MASK64, fnv1a64, floorDiv, splitmix64 } from "./math";
import { pricePaise } from "./price";

export const DEPTH_LEVELS = 8;

export interface DepthLevel {
  /** Integer paise, multiple of the tick. */
  pricePaise: bigint;
  /** Synthetic resting quantity in shares (1..~350). */
  qty: number;
  /** Number of synthetic orders aggregated into this level (display). */
  orders: number;
}

export interface DepthSnapshot {
  symbol: string;
  epochSec: number;
  /** Ladder step (paise) between consecutive levels before jitter. */
  stepPaise: bigint;
  bids: DepthLevel[]; // best (highest) first
  asks: DepthLevel[]; // best (lowest) first
}

/** Bounded jitter in [-j, j] for a (symbol, second, side, level) tuple. */
function jitterFor(
  symbolSeed: bigint,
  sec: bigint,
  sideBit: bigint,
  level: bigint,
  j: bigint,
): bigint {
  const mixed = splitmix64(
    symbolSeed ^
      splitmix64(sec * 0x9e3779b97f4a7c15n) ^
      splitmix64((sideBit * 0x517cc1b727220a95n + level * 0xbf58476d1ce4e5b9n) & MASK64),
  );
  const span = 2n * j + 1n;
  const m = ((mixed % span) + span) % span;
  return m - j;
}

/** Size hash → shares for a level, decaying with depth. */
function qtyFor(
  symbolSeed: bigint,
  sec: bigint,
  sideBit: bigint,
  level: bigint,
): number {
  const mixed = splitmix64(
    symbolSeed ^
      splitmix64(sec * 0xbf58476d1ce4e5b9n) ^
      splitmix64((sideBit * 0x9e3779b97f4a7c15n + level * 0x517cc1b727220a95n) & MASK64),
  );
  const spread = BigInt(34 * (DEPTH_LEVELS - Number(level)));
  const q = 4n + (((mixed % spread) + spread) % spread);
  return Number(q);
}

/** Integer-paise ladder step for a symbol at a given spot level. */
function stepFor(spot: bigint): bigint {
  // ~2 basis points of spot, floored to the tick: ₹2900 → ₹0.58,
  // ₹480 → ₹0.10. Keeps the ladder visually proportionate per symbol.
  const raw = floorDiv(spot * 2n, 10_000n);
  const tick = BigInt(TICK_PAISE);
  return raw < tick ? tick : floorDiv(raw, tick) * tick;
}

/**
 * Depth snapshot at one second. Deterministic: identical output on every
 * device and every later date (pure function of symbol + second).
 */
export function depthAt(symbol: string, epochSec: number): DepthSnapshot {
  const def = SYMBOL_MAP.get(symbol);
  if (!def) throw new Error(`Unknown symbol: ${symbol}`);
  const seed = fnv1a64(`NSE-DEPTH-${symbol}-v1`);
  const s = BigInt(epochSec);
  const spot = pricePaise(symbol, s);
  const tick = BigInt(TICK_PAISE);
  const step = stepFor(spot);
  const jit = step / 4n; // bounded so ordering can never invert

  const bids: DepthLevel[] = [];
  const asks: DepthLevel[] = [];
  for (let i = 0; i < DEPTH_LEVELS; i++) {
    const level = BigInt(i);
    const bidJ = jitterFor(seed, s, 0n, level, jit);
    const askJ = jitterFor(seed, s, 1n, level, jit);
    const bidPrice = spot - tick - (level + 1n) * step + bidJ;
    const askPrice = spot + tick + (level + 1n) * step + askJ;
    const bidQty = qtyFor(seed, s, 0n, level);
    const askQty = qtyFor(seed, s, 1n, level);
    bids.push({
      pricePaise: floorDiv(bidPrice, tick) * tick,
      qty: bidQty,
      orders: 1 + (bidQty % 7),
    });
    asks.push({
      pricePaise: floorDiv(askPrice, tick) * tick,
      qty: askQty,
      orders: 1 + (askQty % 7),
    });
  }
  // Quantization can collapse two adjacent levels onto one tick when the
  // ladder step is small (e.g. a ₹480 stock at a 5-paise step). Enforce a
  // strict one-tick minimum gap, deterministically, deepest-first so the
  // jitter still shows and ordering never inverts.
  for (let i = 1; i < bids.length; i++) {
    if (bids[i].pricePaise >= bids[i - 1].pricePaise) {
      bids[i].pricePaise = bids[i - 1].pricePaise - tick;
    }
  }
  for (let i = 1; i < asks.length; i++) {
    if (asks[i].pricePaise <= asks[i - 1].pricePaise) {
      asks[i].pricePaise = asks[i - 1].pricePaise + tick;
    }
  }
  return { symbol, epochSec, stepPaise: step, bids, asks };
}
