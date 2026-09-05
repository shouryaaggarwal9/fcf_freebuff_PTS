import { describe, expect, test } from "bun:test";
import {
  SYMBOLS,
} from "../src/config/market";
import type { OrderTrigger } from "../src/engine/model";
import {
  dayStartSec,
  fillPriceForTrigger,
  findFillTick,
  isMarketable,
  pricePaise,
} from "../src/engine/price";

/** Brute-force reference: scan every second (test-only; never O(seconds) in
 *  production). Returns the same shape as the oracle or null. */
function bruteForce(
  symbol: string,
  o: OrderTrigger,
  fromSec: bigint,
  toSec: bigint,
) {
  if (toSec < fromSec) return null;
  for (let s = fromSec; s <= toSec; s += 1n) {
    const p = pricePaise(symbol, s);
    const hit =
      o.orderType === "MARKET"
        ? true
        : o.orderType === "LIMIT"
          ? o.side === "BUY"
            ? p <= (o.limitPaise as bigint)
            : p >= (o.limitPaise as bigint)
          : o.side === "BUY"
            ? p >= (o.stopPaise as bigint)
            : p <= (o.stopPaise as bigint);
    if (hit) {
      const price =
        o.orderType === "STOP" ? (o.stopPaise as bigint) : p;
      return { sec: Number(s), pricePaise: price };
    }
  }
  return null;
}

// Deterministic probe windows (epoch seconds) — no randomness in tests.
const WINDOWS: Array<{ symbol: string; from: bigint; to: bigint }> = [];
{
  const base = dayStartSec(1_787_500_000n);
  for (const sym of ["RELIANCE", "TCS", "ITC", "SBIN", "HDFCBANK", "LT"]) {
    for (let k = 0; k < 6; k += 1) {
      const off = BigInt(97 + k * 641);
      WINDOWS.push({ symbol: sym, from: base + off, to: base + off + 500n });
    }
    // window straddling the day boundary
    WINDOWS.push({ symbol: sym, from: base - 250n, to: base + 250n });
  }
}

function probeLevels(symbol: string, from: bigint, to: bigint): bigint[] {
  const levels: bigint[] = [];
  for (let i = 0; i < 8; i += 1) {
    levels.push(pricePaise(symbol, from + BigInt(i * 53)));
  }
  return levels;
}

describe("findFillTick vs brute force", () => {
  test("limit buys and sells agree on every probe window", () => {
    for (const w of WINDOWS) {
      for (const level of probeLevels(w.symbol, w.from, w.to)) {
        const buy: OrderTrigger = {
          side: "BUY",
          orderType: "LIMIT",
          limitPaise: level,
        };
        const sell: OrderTrigger = {
          side: "SELL",
          orderType: "LIMIT",
          limitPaise: level,
        };
        expect(
          findFillTick(w.symbol, buy, w.from, w.to),
          `${w.symbol} BUY ${level} [${w.from},${w.to}]`,
        ).toEqual(bruteForce(w.symbol, buy, w.from, w.to));
        expect(
          findFillTick(w.symbol, sell, w.from, w.to),
          `${w.symbol} SELL ${level} [${w.from},${w.to}]`,
        ).toEqual(bruteForce(w.symbol, sell, w.from, w.to));
      }
    }
  });

  test("stop orders agree on every probe window (fill at stop level)", () => {
    for (const w of WINDOWS) {
      for (const level of probeLevels(w.symbol, w.from, w.to)) {
        const stopBuy: OrderTrigger = {
          side: "BUY",
          orderType: "STOP",
          stopPaise: level,
        };
        const stopSell: OrderTrigger = {
          side: "SELL",
          orderType: "STOP",
          stopPaise: level,
        };
        expect(
          findFillTick(w.symbol, stopBuy, w.from, w.to),
          `${w.symbol} SB ${level} [${w.from},${w.to}]`,
        ).toEqual(bruteForce(w.symbol, stopBuy, w.from, w.to));
        expect(
          findFillTick(w.symbol, stopSell, w.from, w.to),
          `${w.symbol} SS ${level} [${w.from},${w.to}]`,
        ).toEqual(bruteForce(w.symbol, stopSell, w.from, w.to));
      }
    }
  });

  test("impossible levels return null", () => {
    for (const sym of SYMBOLS.slice(0, 3)) {
      const spot = pricePaise(sym.symbol, 1_787_500_000n);
      const farBelow: OrderTrigger = {
        side: "BUY",
        orderType: "LIMIT",
        limitPaise: 1n, // impossible floor
      };
      const farAbove: OrderTrigger = {
        side: "SELL",
        orderType: "LIMIT",
        limitPaise: spot * 2n,
      };
      const ds = dayStartSec(1_787_500_000n);
      expect(
        findFillTick(sym.symbol, farBelow, ds, ds + 120n),
      ).toBeNull();
      expect(
        findFillTick(sym.symbol, farAbove, ds, ds + 120n),
      ).toBeNull();
    }
  });

  test("empty/inverted windows never fill", () => {
    const t = 1_787_500_000n;
    const o: OrderTrigger = { side: "BUY", orderType: "LIMIT", limitPaise: 1_000_000n };
    expect(findFillTick("RELIANCE", o, t + 10n, t + 9n)).toBeNull();
  });

  test("marketable rule: trigger already satisfied at spot fills at spot", () => {
    const ds = dayStartSec(1_787_500_000n);
    const spot = pricePaise("RELIANCE", ds + 500n);
    const tickUp = pricePaise("RELIANCE", ds + 500n) + 5n;
    const tickDown = pricePaise("RELIANCE", ds + 500n) - 5n;
    expect(
      isMarketable({ side: "BUY", orderType: "LIMIT", limitPaise: tickUp }, spot),
    ).toBe(true);
    expect(
      isMarketable({ side: "SELL", orderType: "LIMIT", limitPaise: tickDown }, spot),
    ).toBe(true);
    expect(
      isMarketable({ side: "BUY", orderType: "STOP", stopPaise: tickDown }, spot),
    ).toBe(true);
    expect(
      isMarketable({ side: "SELL", orderType: "STOP", stopPaise: tickUp }, spot),
    ).toBe(true);
    expect(
      isMarketable({ side: "BUY", orderType: "MARKET" }, spot),
    ).toBe(true);
    // Not marketable:
    expect(
      isMarketable({ side: "BUY", orderType: "LIMIT", limitPaise: tickDown }, spot),
    ).toBe(false);
  });

  test("fill price rule: stops fill exactly at the stop level", () => {
    const level = 100_000n;
    const stopSell: OrderTrigger = { side: "SELL", orderType: "STOP", stopPaise: level };
    const stopBuy: OrderTrigger = { side: "BUY", orderType: "STOP", stopPaise: level };
    expect(fillPriceForTrigger(stopSell, level - 37n)).toBe(level);
    expect(fillPriceForTrigger(stopBuy, level + 22n)).toBe(level);
    const lim: OrderTrigger = { side: "BUY", orderType: "LIMIT", limitPaise: 200_000n };
    expect(fillPriceForTrigger(lim, 199_995n)).toBe(199_995n);
  });

  test("first eligible tick semantics: a later window start never yields an earlier fill", () => {
    const ds = dayStartSec(1_787_500_000n);
    for (const sym of ["RELIANCE", "SBIN"]) {
      const from = ds + 60n;
      const to = ds + 10_000n;
      // A level that does cross inside the window: scan for one cheaply.
      let level: bigint | null = null;
      for (let k = 0; k < 40; k += 1) {
        const p = pricePaise(sym, ds + BigInt(200 + k * 200));
        const probe: OrderTrigger = { side: "BUY", orderType: "LIMIT", limitPaise: p - 5n };
        if (bruteForce(sym, probe, from, to)) {
          level = p - 5n;
          break;
        }
      }
      if (level === null) continue;
      const order: OrderTrigger = { side: "BUY", orderType: "LIMIT", limitPaise: level };
      const full = findFillTick(sym, order, from, to);
      expect(full).not.toBeNull();
      const later = findFillTick(sym, order, BigInt((full as { sec: number }).sec) + 1n, to);
      if (later !== null) {
        expect(later.sec).toBeGreaterThan((full as { sec: number }).sec);
      }
    }
  });
});
