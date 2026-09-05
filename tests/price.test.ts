import { describe, expect, test } from "bun:test";
import { DAY_SECONDS, MARKET_VERSION, SYMBOLS, TICK_PAISE } from "../src/config/market";
import { buildCandles, candleSeries } from "../src/engine/candles";
import { isMultipleOf } from "../src/engine/math";
import {
  dayEndExclusiveSec,
  dayStartSec,
  pricePaise,
} from "../src/engine/price";
import vectors from "./fixtures/price_vectors.json";

interface Vector {
  symbol: string;
  epoch: string;
  price: string;
}

const fixture = vectors as {
  marketVersion: number;
  vectors: Vector[];
};

describe("golden vectors", () => {
  test("fixture matches current MARKET_VERSION", () => {
    expect(fixture.marketVersion).toBe(MARKET_VERSION);
  });

  test("every vector reproduces exactly (deterministic past)", () => {
    for (const v of fixture.vectors) {
      const actual = pricePaise(v.symbol, BigInt(v.epoch));
      expect(actual.toString(), `${v.symbol}@${v.epoch}`).toBe(v.price);
    }
  });

  test("day-boundary vectors stay continuous (no artificial gap)", () => {
    // The last tick of a day and the first tick of the next day sit on the
    // same interpolation segment grid: the one-second step may never exceed a
    // tiny fraction of a wave amplitude.
    const t = 1_787_500_000n;
    const ds = dayStartSec(t);
    for (const def of SYMBOLS) {
      const prev = pricePaise(def.symbol, ds - 1n);
      const next = pricePaise(def.symbol, ds);
      const gap = prev > next ? prev - next : next - prev;
      expect(gap, `${def.symbol} day-boundary gap`).toBeLessThan(
        BigInt(def.basePaise) / 100n,
      );
    }
  });
});

describe("determinism", () => {
  test("two independent evaluations of a full day are identical", () => {
    const t0 = 1_787_443_200n; // a UTC midnight
    const t1 = t0 + BigInt(DAY_SECONDS) - 1n;
    const a: string[] = [];
    const b: string[] = [];
    let s = t0;
    while (s <= t1) {
      a.push(pricePaise("RELIANCE", s).toString());
      b.push(pricePaise("RELIANCE", s).toString());
      s += 1n;
    }
    expect(a).toEqual(b);
    expect(a.length).toBe(DAY_SECONDS);
  });

  test("two independent candle constructions of the same window match", () => {
    const t0 = 1_787_443_200n; // midnight UTC
    const until = Number(t0) + 2 * 3600 - 1; // 2 hours of 1m bars
    const viaSeries = candleSeries("TCS", until, 60, 120);
    const viaBuild = buildCandles("TCS", Number(t0), until, 60);
    expect(viaSeries).toEqual(viaBuild);
    // OHLC is internally consistent (high >= open/close >= low).
    for (const bar of viaSeries) {
      expect(bar.highPaise >= bar.openPaise).toBe(true);
      expect(bar.highPaise >= bar.closePaise).toBe(true);
      expect(bar.lowPaise <= bar.openPaise).toBe(true);
      expect(bar.lowPaise <= bar.closePaise).toBe(true);
    }
  });
});

describe("tick structure", () => {
  test("all evaluated prices are multiples of TICK_PAISE", () => {
    const t0 = 1_787_000_000n;
    let s = t0;
    for (let i = 0; i < 2000; i += 1) {
      for (const def of SYMBOLS) {
        const p = pricePaise(def.symbol, s);
        expect(isMultipleOf(p, TICK_PAISE), def.symbol).toBe(true);
      }
      s += 1n;
    }
  });

  test("negative, zero and pre-1970 offsets are defined and stable", () => {
    for (const e of [-10n, -1n, 0n, 1n]) {
      for (const def of SYMBOLS.slice(0, 3)) {
        const p = pricePaise(def.symbol, e);
        expect(p).toBe(pricePaise(def.symbol, e));
        expect(p % BigInt(TICK_PAISE)).toBe(0n);
      }
    }
  });

  test("day helpers align to UTC midnights", () => {
    const t = 1_787_500_000n;
    expect(dayStartSec(t) % BigInt(DAY_SECONDS)).toBe(0n);
    expect(dayEndExclusiveSec(t) - dayStartSec(t)).toBe(BigInt(DAY_SECONDS));
  });
});
