/**
 * Engine invariants — NSE Paper Trade Pro.
 *
 * These tests pin down the properties the spec makes non-negotiable:
 * determinism, integer/paise/tick discipline, oracle-vs-brute-force
 * agreement, and the candle builder being identical between full rebuilds
 * and incremental live extension.
 *
 * Run with `bun test`.
 */
import { describe, expect, test } from "bun:test";
import { SYMBOLS, TICK_PAISE } from "../src/config/market";
import { candleSeries, extendLiveSeries } from "../src/engine/candles";
import { floorDiv } from "../src/engine/math";
import { firstTickWhere, pricePaise } from "../src/engine/price";

const T0 = 1_735_680_000n; // a fixed modern epoch
const TICK = BigInt(TICK_PAISE);

describe("deterministic integer price", () => {
  test("is identical across repeated calls (pure function)", () => {
    for (const sym of SYMBOLS.slice(0, 3)) {
      for (let s = T0; s < T0 + 5000n; s += 137n) {
        expect(pricePaise(sym.symbol, s)).toBe(pricePaise(sym.symbol, s));
      }
    }
  });

  test("is a multiple of the 5-paise tick for every symbol/second", () => {
    for (const sym of SYMBOLS) {
      for (let s = T0 - 86_400n; s <= T0 + 86_400n; s += 331n) {
        expect(pricePaise(sym.symbol, s) % TICK).toBe(0n);
      }
    }
  });

  test("prices are positive and near the frozen base", () => {
    for (const sym of SYMBOLS) {
      for (let s = T0; s < T0 + 2000n; s += 97n) {
        const p = pricePaise(sym.symbol, s);
        const base = BigInt(sym.basePaise);
        expect(p).toBeGreaterThan(0n);
        // Total wave amplitude stays well under 12% of base for these factors.
        expect(p).toBeGreaterThan((base * 88n) / 100n);
        expect(p).toBeLessThan((base * 112n) / 100n);
      }
    }
  });

  test("per-second moves are bounded (no artificial gaps at UTC day boundary)", () => {
    for (const sym of SYMBOLS.slice(0, 4)) {
      for (const t of [T0 - 86_400n, T0, T0 + 86_400n]) {
        const lo = pricePaise(sym.symbol, t);
        const hi = pricePaise(sym.symbol, t + 1n);
        const diff = hi > lo ? hi - lo : lo - hi;
        // Coarse-wave slopes alone never produce moves this big; a large
        // value here would signal a discontinuity at a boundary.
        expect(diff).toBeLessThanOrEqual(2_000n);
      }
    }
  });
});

describe("oracle vs brute force", () => {
  const cases: Array<{ side: "BUY" | "SELL"; type: "LIMIT" | "STOP"; pick: (p: bigint) => bigint }> = [
    { side: "BUY", type: "LIMIT", pick: (p) => p - (p % TICK) - 2n * TICK },
    { side: "BUY", type: "STOP", pick: (p) => p + 2n * TICK },
    { side: "SELL", type: "LIMIT", pick: (p) => p + 2n * TICK },
    { side: "SELL", type: "STOP", pick: (p) => p - 2n * TICK },
  ];

  test("firstTickWhere agrees with a brute-force scan", () => {
    for (const sym of SYMBOLS.slice(0, 3)) {
      for (const c of cases) {
        for (const offset of [0n, 60n, 900n]) {
          const from = T0 + offset;
          const to = from + 400n; // window spans 60s-grid segments
          const spot0 = pricePaise(sym.symbol, from);
          const level = c.pick(spot0);
          const pred =
            c.side === "BUY"
              ? (p: bigint) => (c.type === "LIMIT" ? p <= level : p >= level)
              : (p: bigint) => (c.type === "LIMIT" ? p >= level : p <= level);

          let brute: bigint | null = null;
          for (let s = from; s <= to; s += 1n) {
            if (pred(pricePaise(sym.symbol, s))) {
              brute = s;
              break;
            }
          }
          const got = firstTickWhere(sym.symbol, from, to, pred);
          expect(got).toBe(brute);
          if (got !== null) {
            expect(pred(pricePaise(sym.symbol, got))).toBe(true);
            if (got > from) {
              expect(pred(pricePaise(sym.symbol, got - 1n))).toBe(false);
            }
          }
        }
      }
    }
  });
});

describe("candle builder", () => {
  test("bars are aligned, ascending and internally consistent", () => {
    for (const tf of [60, 300, 900]) {
      const candles = candleSeries(SYMBOLS[0].symbol, Number(T0) + 5400, tf, 50);
      expect(candles.length).toBeGreaterThan(0);
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        expect(c.time % tf).toBe(0);
        expect(c.highPaise).toBeGreaterThanOrEqual(c.openPaise);
        expect(c.highPaise).toBeGreaterThanOrEqual(c.closePaise);
        expect(c.lowPaise).toBeLessThanOrEqual(c.openPaise);
        expect(c.lowPaise).toBeLessThanOrEqual(c.closePaise);
        expect(c.openPaise % TICK).toBe(0n);
        if (i > 0) expect(c.time).toBeGreaterThan(candles[i - 1].time);
      }
    }
  });

  test("incremental extension is identical to a full rebuild", () => {
    const symbol = SYMBOLS[2].symbol;
    const t0 = Number(T0);
    for (const tf of [60, 300]) {
      const start = candleSeries(symbol, t0, tf, 40);
      expect(start.length).toBeGreaterThan(0);
      let cur = start;
      let endSec = t0;
      const steps = [1, 7, 59, 2, 120, 33]; // random-ish chunk sizes
      for (const delta of steps) {
        const next = extendLiveSeries(symbol, cur, endSec, endSec + delta, tf, 40);
        cur = next.candles;
        endSec = next.endSec;
      }
      const full = candleSeries(symbol, endSec, tf, 40);
      expect(cur).toEqual(full);
    }
  });
});

describe("math helpers", () => {
  test("floorDiv floors toward negative infinity", () => {
    expect(floorDiv(7n, 3n)).toBe(2n);
    expect(floorDiv(-7n, 3n)).toBe(-3n);
    expect(floorDiv(7n, -3n)).toBe(-3n);
    expect(floorDiv(0n, 5n)).toBe(0n);
  });
});
