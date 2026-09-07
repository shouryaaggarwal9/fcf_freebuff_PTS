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
import { buildCandles, candleSeries, extendLiveSeries } from "../src/engine/candles";
import { depthAt, DEPTH_LEVELS } from "../src/engine/depth";
import { floorDiv } from "../src/engine/math";
import { committedQty, isOcoEnabled, validateOcoLevels } from "../src/lib/oco";
import { pricePaise } from "../src/engine/price";
import {
  applyTrade,
  autoCoverStopPaise,
  coverSettlement,
  ledgerRowFor,
  orderIntent,
} from "../src/lib/position";
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

describe("synthetic depth ladder", () => {
  const T = 1_735_680_123n;

  test("is deterministic and pure for (symbol, second)", () => {
    for (const sym of SYMBOLS.slice(0, 4)) {
      const a = depthAt(sym.symbol, Number(T));
      const b = depthAt(sym.symbol, Number(T));
      expect(a).toEqual(b);
    }
  });

  test("bids strictly decrease, asks strictly increase, all multiples of the tick", () => {
    for (const sym of SYMBOLS) {
      for (let off = 0; off < 300; off += 97) {
        const d = depthAt(sym.symbol, Number(T) + off);
        expect(d.bids.length).toBe(DEPTH_LEVELS);
        expect(d.asks.length).toBe(DEPTH_LEVELS);
        for (let i = 0; i < DEPTH_LEVELS; i++) {
          expect(d.bids[i].pricePaise % TICK).toBe(0n);
          expect(d.asks[i].pricePaise % TICK).toBe(0n);
          if (i > 0) {
            expect(d.bids[i].pricePaise).toBeLessThan(d.bids[i - 1].pricePaise);
            expect(d.asks[i].pricePaise).toBeGreaterThan(d.asks[i - 1].pricePaise);
          }
        }
        expect(d.bids[0].pricePaise).toBeLessThan(d.asks[0].pricePaise);
      }
    }
  });

  test("ladder straddles the spot and sizes are positive", () => {
    for (const sym of SYMBOLS.slice(0, 5)) {
      const s = pricePaise(sym.symbol, T);
      const d = depthAt(sym.symbol, Number(T));
      expect(d.bids[0].pricePaise).toBeLessThan(s);
      expect(d.asks[0].pricePaise).toBeGreaterThan(s);
      for (const lvl of [...d.bids, ...d.asks]) {
        expect(lvl.qty).toBeGreaterThan(0);
        expect(lvl.orders).toBeGreaterThan(0);
      }
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

describe("OCO bracket helpers", () => {
  test("lone sells commit their full quantity", () => {
    expect(
      committedQty([
        { ocoId: null, qty: 10 },
        { ocoId: null, qty: 5 },
      ]),
    ).toBe(15);
  });

  test("a bracket group commits only its minimum leg", () => {
    expect(
      committedQty([
        { ocoId: "g", qty: 10 },
        { ocoId: "g", qty: 10 },
      ]),
    ).toBe(10);
  });

  test("asymmetric legs commit the smaller leg", () => {
    expect(
      committedQty([
        { ocoId: "g", qty: 10 },
        { ocoId: "g", qty: 6 },
      ]),
    ).toBe(6);
  });

  test("mixed groups and lone sells sum correctly", () => {
    expect(
      committedQty([
        { ocoId: "g1", qty: 10 },
        { ocoId: "g1", qty: 4 },
        { ocoId: null, qty: 5 },
      ]),
    ).toBe(9);
  });

  test("separate groups never merge", () => {
    expect(
      committedQty([
        { ocoId: "g1", qty: 10 },
        { ocoId: "g1", qty: 4 },
        { ocoId: "g2", qty: 7 },
        { ocoId: "g2", qty: 7 },
      ]),
    ).toBe(11);
  });

  test("same ocoId on different symbols/days is two independent groups", () => {
    expect(
      committedQty([
        { ocoId: "g", qty: 10, symbol: "A", dayStartSec: 1 },
        { ocoId: "g", qty: 10, symbol: "B", dayStartSec: 1 },
      ]),
    ).toBe(20);
    expect(
      committedQty([
        { ocoId: "g", qty: 10, symbol: "A", dayStartSec: 1 },
        { ocoId: "g", qty: 10, symbol: "A", dayStartSec: 2 },
      ]),
    ).toBe(20);
  });

  test("group capacity never exceeds held quantity — the 1-qty edge", () => {
    // 1 held share with a 2-leg bracket commits exactly 1.
    expect(
      committedQty([
        { ocoId: "g", qty: 1 },
        { ocoId: "g", qty: 1 },
      ]),
    ).toBe(1);
  });

  test("bracket level sanity: stop below spot, target above stop", () => {
    const spot = 100_000n;
    expect(validateOcoLevels(spot, 90_000n, 110_000n)).toBeNull();
    expect(validateOcoLevels(spot, 100_000n, 110_000n)).toMatch(/below/i);
    expect(validateOcoLevels(spot, 110_000n, 110_000n)).toMatch(/below/i);
    expect(validateOcoLevels(spot, 90_000n, 90_000n)).toMatch(/above/i);
  });

  test("brackets require at least two legs", () => {
    expect(isOcoEnabled(1)).toBe(false);
    expect(isOcoEnabled(2)).toBe(true);
  });
});

describe("market realism (v2 generator)", () => {
  const DAY0 = 1_728_000_000n;

  test("1m/5m candles carry wicks on every symbol", () => {
    for (const def of SYMBOLS) {
      for (const tf of [60, 300]) {
        const cs = buildCandles(def.symbol, Number(DAY0), Number(DAY0) + 86_400, tf);
        expect(cs.length).toBeGreaterThan(1000 / (tf / 60));
        let wicky = 0;
        for (const c of cs) {
          const body = c.openPaise > c.closePaise ? c.openPaise : c.closePaise;
          const foot = c.openPaise < c.closePaise ? c.openPaise : c.closePaise;
          if (c.highPaise > body || c.lowPaise < foot) wicky += 1;
        }
        // Interior 10 s curvature makes the overwhelming majority of bars
        // non-monotone. (v1: exactly zero — the bug this pins.)
        expect(wicky, `${def.symbol} ${tf}s`).toBeGreaterThan(cs.length * 3 / 5);
      }
    }
  });

  test("1m candle colors decorrelate across minutes", () => {
    const cs = buildCandles("RELIANCE", Number(DAY0), Number(DAY0) + 86_400 * 3, 60);
    expect(cs.length).toBeGreaterThan(4_000);
    const up = (c: { openPaise: bigint; closePaise: bigint }) =>
      c.closePaise >= c.openPaise;
    let maxRun = 1;
    let run = 1;
    let flips = 0;
    for (let i = 1; i < cs.length; i += 1) {
      if (up(cs[i]) === up(cs[i - 1])) {
        run += 1;
      } else {
        flips += 1;
        if (run > maxRun) maxRun = run;
        run = 1;
      }
    }
    // Independent per-minute anchors: most adjacent candles differ in color,
    // and no streak dominates the day. (v1: max run = 10 by construction.)
    expect(maxRun).toBeLessThanOrEqual(12);
    expect(flips * 2).toBeGreaterThan(cs.length);
  });

  test("price is continuous across the 00:00 UTC day boundary", () => {
    for (const def of SYMBOLS) {
      const a = pricePaise(def.symbol, DAY0 - 1n);
      const b = pricePaise(def.symbol, DAY0);
      const jump = b > a ? b - a : a - b;
      // A boundary tick must not exceed ordinary per-second motion: a few
      // ticks plus the finest wave amplitude headroom.
      const headroom = BigInt(Math.round(def.basePaise * def.volBp * 7 / 1_000_000)) + 25n;
      expect(jump, def.symbol).toBeLessThanOrEqual(headroom);
    }
  });

  test("prices stay multiples of the tick and near their base", () => {
    for (const def of SYMBOLS) {
      for (let d = 0; d < 3; d += 1) {
        const s = DAY0 + BigInt(d * 86_400) + 45_678n;
        const p = pricePaise(def.symbol, s);
        expect(p % BigInt(TICK_PAISE)).toBe(0n);
        // Macro envelope: waves are bounded well inside ±10% of base.
        const base = BigInt(def.basePaise);
        expect(p).toBeGreaterThan(base * 9n / 10n);
        expect(p).toBeLessThan(base * 11n / 10n);
      }
    }
  });
});

describe("short-position state machine", () => {
  const P = 100_000n; // ₹1000.00

  test("FLAT + SELL opens a short with 2× margin", () => {
    const r = applyTrade(null, { side: "SELL", qty: 10, pricePaise: P });
    expect(r.kind).toBe("OPEN");
    if (r.kind !== "OPEN") return;
    expect(r.state.side).toBe("SHORT");
    expect(r.state.qty).toBe(10);
    expect(r.state.avgCostPaise).toBe(P);
    expect(r.state.marginPaise).toBe(20n * P);
  });

  test("adding to a short raises margin and re-averages the entry", () => {
    const o = applyTrade(null, { side: "SELL", qty: 10, pricePaise: P });
    if (o.kind !== "OPEN") throw new Error("unreachable");
    const a = applyTrade(o.state, { side: "SELL", qty: 10, pricePaise: 110_000n });
    expect(a.kind).toBe("ADD");
    if (a.kind !== "ADD") return;
    expect(a.state.qty).toBe(20);
    expect(a.state.avgCostPaise).toBe(105_000n);
    expect(a.state.marginPaise).toBe(20n * P + 22n * 100_000n);
  });

  test("profitable cover releases margin and stores positive P&L", () => {
    const o = applyTrade(null, { side: "SELL", qty: 10, pricePaise: P });
    if (o.kind !== "OPEN") throw new Error("unreachable");
    const c = applyTrade(o.state, { side: "BUY", qty: 10, pricePaise: 90_000n });
    expect(c.kind).toBe("CLOSE");
    if (c.kind !== "CLOSE") return;
    expect(c.realizedPnlPaise).toBe(10n * 10_000n); // (1000 − 900) × 10
    expect(c.marginReleasePaise).toBe(20n * P);
  });

  test("losing cover never exceeds half the margin at the 2× auto-cover", () => {
    const o = applyTrade(null, { side: "SELL", qty: 10, pricePaise: P });
    if (o.kind !== "OPEN") throw new Error("unreachable");
    const c = applyTrade(o.state, {
      side: "BUY",
      qty: 10,
      pricePaise: autoCoverStopPaise(P),
    });
    if (c.kind !== "CLOSE") throw new Error("expected CLOSE");
    expect(c.realizedPnlPaise).toBe(-(10n * P)); // −1× notional = −½ margin
    expect(c.marginReleasePaise).toBe(20n * P); // release ≥ payment
  });

  test("partial cover scales the margin release", () => {
    const o = applyTrade(null, { side: "SELL", qty: 10, pricePaise: P });
    if (o.kind !== "OPEN") throw new Error("unreachable");
    const c = applyTrade(o.state, { side: "BUY", qty: 4, pricePaise: P });
    expect(c.kind).toBe("PARTIAL_CLOSE");
    if (c.kind !== "PARTIAL_CLOSE") return;
    expect(c.state.qty).toBe(6);
    expect(c.marginReleasePaise).toBe(8n * P); // 2×P×10 × 4/10
    expect(c.realizedPnlPaise).toBe(0n);
  });

  test("no flip past zero in either direction", () => {
    const o = applyTrade(null, { side: "SELL", qty: 5, pricePaise: P });
    if (o.kind !== "OPEN") throw new Error("unreachable");
    expect(applyTrade(o.state, { side: "BUY", qty: 6, pricePaise: P }).kind).toBe("BLOCK_FLIP");
    const l = applyTrade(null, { side: "BUY", qty: 5, pricePaise: P });
    if (l.kind !== "OPEN") throw new Error("unreachable");
    expect(applyTrade(l.state, { side: "SELL", qty: 6, pricePaise: P }).kind).toBe("BLOCK_FLIP");
  });

  test("intent mirrors the server's state machine", () => {
    expect(orderIntent(null, "SELL")).toBe("OPEN_SHORT");
    expect(orderIntent(null, "BUY")).toBe("OPEN_LONG");
    expect(orderIntent({ side: "SHORT", qty: 5 }, "BUY")).toBe("COVER_SHORT");
    expect(orderIntent({ side: "SHORT", qty: 5 }, "SELL")).toBe("ADD_SHORT");
    expect(orderIntent({ side: "LONG", qty: 5 }, "SELL")).toBe("EXIT_LONG");
    expect(orderIntent({ side: "LONG", qty: 5 }, "BUY")).toBe("ADD_LONG");
  });

  test("solvency: release + cash always covers the worst-case payment", () => {
    // For any short: margin = 2N. At the 2× stop, payment = 2N, release = N,
    // so the trader's own cash funds at most N — exactly the max loss.
    const qty = 37; // prime to catch floor-division drift
    const o = applyTrade(null, { side: "SELL", qty, pricePaise: P });
    if (o.kind !== "OPEN") throw new Error("unreachable");
    const c = applyTrade(o.state, {
      side: "BUY",
      qty,
      pricePaise: autoCoverStopPaise(P),
    });
    if (c.kind !== "CLOSE") throw new Error("expected CLOSE");
    const payment = BigInt(qty) * autoCoverStopPaise(P);
    // At the 2× stop: release (2N) funds the payment (2N) exactly, so the
    // wallet dips only by the loss (N = ½ margin) — never negative.
    expect(c.marginReleasePaise - payment).toBe(0n);
    expect(c.realizedPnlPaise).toBe(-(BigInt(qty) * P));
  });
});

describe("short round-trip cash accounting (margin sub-account)", () => {
  const S = 2_925_35n; // entry fill (paise) — the deployed-bug screenshot's ₹2,925.35
  const P = 2_924_35n; // cover fill — ₹1 lower
  const qty = 10;

  test("market entry blocks 2× notional; cover nets exactly to realized P&L", () => {
    const block = 2n * S * BigInt(qty); // entry margin: 2 × notional
    // Entry: cash −block. Cover: cash Δ = block + realized; block drains 0.
    const entryCashDelta = -block;
    const realized = (S - P) * BigInt(qty);
    const coverCashDelta = block + realized;
    // Round trip from flat: total cash Δ = realized P&L exactly.
    expect(entryCashDelta + coverCashDelta).toBe(realized);
    expect(realized).toBe(1_000n); // +₹10.00 on the screenshot trade
    // Excluding the collateral return, the settlement is pure P&L.
    expect(coverCashDelta - block).toBe(realized);
  });

  test("worst case — guaranteed 2× stop cover never debits beyond the block", () => {
    const block = 2n * S * BigInt(qty);
    const stopPrice = 2n * S; // auto-cover level
    const realized = (S - stopPrice) * BigInt(qty); // −S × qty
    // Net settlement Δ = block + realized = S × qty ≥ 0: wallet stays whole,
    // max loss is exactly the reserved ½ margin.
    expect(block + realized).toBe(S * BigInt(qty));
    expect(block + realized).toBeGreaterThanOrEqual(0n);
  });

  test("partial cover drains the block proportionally", () => {
    const block = 2n * S * BigInt(qty);
    const half = coverSettlement(block, 5, 10, P);
    expect(half.blockReleasePaise).toBe(S * BigInt(qty)); // 2S×10 × 5/10
    expect(half.paymentPaise).toBe(5n * P);
  });
});

describe("ledger row semantics (amount = total-cash impact)", () => {
  test("margin block is a ₹0-impact earmark carrying the blocked size", () => {
    const margin = 2n * 10n * 289_170n; // ₹57,834
    const row = ledgerRowFor("margin_block", -margin, margin);
    expect(row.amountPaise).toBe(0n);
    expect(row.detailPaise).toBe(margin);
  });

  test("cover settlement nets to realized P&L with the release in detail", () => {
    const release = 578_340n;
    const realized = 1_600n; // ₹16
    const row = ledgerRowFor("cover_settle", release + realized, -release);
    expect(row.amountPaise).toBe(realized);
    expect(row.detailPaise).toBe(release);
  });

  test("order reserves never move the balance", () => {
    const reserve = ledgerRowFor("reserve", -700_000n);
    expect(reserve.amountPaise).toBe(0n);
    expect(reserve.detailPaise).toBe(700_000n);
    const release = ledgerRowFor("reserve_release", 700_000n);
    expect(release.amountPaise).toBe(0n);
    expect(release.detailPaise).toBe(700_000n);
  });

  test("market short round trip: sum of ledger amounts = realized P&L exactly", () => {
    const margin = 2n * 10n * 289_170n; // ₹57,834
    const realized = 1_600n; // (2891.70 − 2890.10) × 10
    const block = ledgerRowFor("margin_block", -margin, margin);
    const settle = ledgerRowFor("cover_settle", margin + realized, -margin);
    expect(block.amountPaise + settle.amountPaise).toBe(realized);
  });

  test("resting short round trip: reserve rows are ₹0, net is still the P&L", () => {
    const margin = 2n * 10n * 289_170n;
    const headroom = 2n * 10n * 100n; // 2 × qty × SLIP
    const realized = 1_600n;
    const amounts = [
      ledgerRowFor("reserve", -(margin + headroom)).amountPaise,
      ledgerRowFor("reserve_release", margin + headroom).amountPaise,
      ledgerRowFor("margin_block", -margin, margin).amountPaise,
      ledgerRowFor("cover_settle", margin + realized, -margin).amountPaise,
    ];
    expect(amounts.reduce((a, b) => a + b, 0n)).toBe(realized);
  });

  test("long fills and deposits are full total-impact rows", () => {
    expect(ledgerRowFor("buy_fill", -289_170n).amountPaise).toBe(-289_170n);
    expect(ledgerRowFor("buy_fill", -289_170n).detailPaise).toBeUndefined();
    expect(ledgerRowFor("sell_fill", 289_330n).amountPaise).toBe(289_330n);
    expect(ledgerRowFor("deposit", 10_000_000_00n).amountPaise).toBe(10_000_000_00n);
  });
});
