/**
 * NSE Paper Trade Pro — settlement engine (Convex mutation/query handlers).
 *
 * The server is the SOLE authority for fills. No client-supplied price, time
 * or epoch ever reaches these functions: identity comes from the auth
 * session, time from the Convex server wall clock (Date.now()), and prices
 * from the deterministic generator (src/engine/price.ts) evaluated inside
 * this backend. The browser only requests reconcile/place/cancel/edit; client
 * tick detection is never an assertion.
 *
 * Convex provides serializable transactions, so every wallet-affecting
 * mutation is atomic and concurrent mutations on the same user's wallet
 * document serialize automatically — the platform analogue of the spec's
 * per-user advisory lock.
 *
 * Money: integer paise, bigint end to end.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { DAY_SECONDS, GRANT_PAISE, isSymbol } from "../config/market";
import type { OrderTrigger } from "../engine/model";
import { isMultipleOf } from "../engine/math";
import { committedQty, ocoGroupId } from "../lib/oco";
import { ledgerRowFor } from "../lib/position";
import type { OcoSellRef } from "../lib/oco";
import {
  findFillTick,
  isMarketable,
  lastTickSecOfDay,
  pricePaise,
  spotAtEpochSec,
} from "../engine/price";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";

const DAY = BigInt(DAY_SECONDS);
const MAX_QTY = 1_000_000;
/**
 * Overshoot headroom (paise/unit) for resting short entries: the price can
 * overshoot a resting level by at most ~50p in one second (v2 wave caps),
 * so reserving 2 × qty × 100p on top of the margin guarantees the first-tick
 * fill's margin requirement never exceeds the blocked reserve.
 */
const SHORT_ENTRY_SLIP_PAISE = 100n;

/* --------------------------------- errors -------------------------------- */

function fail(message: string): never {
  throw new ConvexError({ message });
}

/* ------------------------------ time helpers ------------------------------ */

/** UTC start-of-day (epoch seconds) for a wall-clock ms value. */
function dayStartOfMs(ms: number): number {
  return Math.floor(Math.floor(ms / 1000) / DAY_SECONDS) * DAY_SECONDS;
}

/** First tick an order may observe: ceil(created_at epoch). */
function firstEligibleTick(createdMs: number): number {
  const floorSec = Math.floor(createdMs / 1000);
  return createdMs % 1000 === 0 ? floorSec : floorSec + 1;
}

function orderTrigger(o: Doc<"orders">): OrderTrigger {
  return {
    side: o.side as "BUY" | "SELL",
    orderType: o.orderType as "MARKET" | "LIMIT" | "STOP",
    limitPaise: o.limitPaise ?? null,
    stopPaise: o.stopPaise ?? null,
  };
}

/* ------------------------------ wallet/ledger ------------------------------ */

type LedgerExtra = {
  orderId?: Id<"orders">;
  positionId?: Id<"positions">;
};

/** Idempotent registration + funding: profile + wallet + ₹10L deposit. */
async function ensureWallet(
  ctx: import("./_generated/server").MutationCtx,
  userId: Id<"users">,
  nowMs: number,
): Promise<Doc<"wallets">> {
  const existing = await ctx.db
    .query("wallets")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (existing) return existing;

  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (!profile) {
    await ctx.db.insert("profiles", {
      userId,
      createdAtMs: nowMs,
    });
  }
  const walletId = await ctx.db.insert("wallets", {
    userId,
    availableCashPaise: GRANT_PAISE,
    marginBlockPaise: 0n,
    version: 1,
    createdAtMs: nowMs,
    updatedMs: nowMs,
  });
  await ctx.db.insert("ledger", {
    userId,
    entryType: "deposit",
    amountPaise: GRANT_PAISE,
    dayStartSec: dayStartOfMs(nowMs),
    timeMs: nowMs,
  });
  const created = await ctx.db.get(walletId);
  if (!created) fail("wallet creation failed");
  return created;
}

/** Apply a signed cash change with an append-only ledger entry, atomically. */
async function moveCash(
  ctx: import("./_generated/server").MutationCtx,
  wallet: Doc<"wallets">,
  deltaPaise: bigint,
  entryType: string,
  timeMs: number,
  dayStartSec: number,
  extra: LedgerExtra = {},
  /** Simultaneous change to the margin sub-account (block/unblock). */
  marginDeltaPaise: bigint = 0n,
): Promise<void> {
  // Ledger amounts are the impact on TOTAL cash (see ledgerRowFor): earmark
  // events are ₹0 rows with the moved size in detailPaise, so the running
  // balance only moves on deposits, fills and settlements.
  const row = ledgerRowFor(entryType, deltaPaise, marginDeltaPaise);
  await ctx.db.insert("ledger", {
    userId: wallet.userId,
    entryType,
    amountPaise: row.amountPaise,
    ...(row.detailPaise !== undefined ? { detailPaise: row.detailPaise } : {}),
    dayStartSec,
    timeMs,
    ...(extra.orderId ? { orderId: extra.orderId } : {}),
    ...(extra.positionId ? { positionId: extra.positionId } : {}),
  });
  // Mutate the in-memory snapshot too: several moveCash calls can run in one
  // transaction (release → pay), and each must see the previous one's result.
  wallet.availableCashPaise += deltaPaise;
  wallet.marginBlockPaise = (wallet.marginBlockPaise ?? 0n) + marginDeltaPaise;
  wallet.version += 1;
  await ctx.db.patch(wallet._id, {
    availableCashPaise: wallet.availableCashPaise,
    marginBlockPaise: wallet.marginBlockPaise,
    version: wallet.version,
    updatedMs: timeMs,
  });
}

async function getPosition(
  ctx: import("./_generated/server").MutationCtx,
  userId: Id<"users">,
  symbol: string,
  dayStartSec: number,
): Promise<Doc<"positions"> | null> {
  return (
    (await ctx.db
      .query("positions")
      .withIndex("by_user_symbol_day", (q) =>
        q.eq("userId", userId).eq("symbol", symbol).eq("dayStartSec", dayStartSec),
      )
      .first()) ?? null
  );
}

/** Position side of a stored row (absent side = LONG, legacy rows). */
function posSide(pos: Doc<"positions">): "LONG" | "SHORT" {
  return pos.side === "SHORT" ? "SHORT" : "LONG";
}

async function upsertBuyPosition(
  ctx: import("./_generated/server").MutationCtx,
  userId: Id<"users">,
  symbol: string,
  dayStartSec: number,
  qty: number,
  fillPricePaise: bigint,
  orderId: Id<"orders">,
  nowMs: number,
  /** Existing SHORT row when this buy covers a short. */
  shortPos?: Doc<"positions"> | null,
): Promise<Id<"positions">> {
  if (shortPos) {
    // Cover: reduce the short (delete at zero). Realized P&L and margin
    // release are handled by the caller.
    const remaining = shortPos.qty - qty;
    if (remaining === 0) {
      await ctx.db.delete(shortPos._id);
    } else {
      await ctx.db.patch(shortPos._id, { qty: remaining, updatedMs: nowMs });
    }
    return shortPos._id;
  }
  const pos = await getPosition(ctx, userId, symbol, dayStartSec);
  if (!pos) {
    return ctx.db.insert("positions", {
      userId,
      symbol,
      dayStartSec,
      qty,
      side: "LONG",
      marginPaise: BigInt(qty) * fillPricePaise,
      avgCostPaise: fillPricePaise,
      openedOrderId: orderId,
      createdMs: nowMs,
      updatedMs: nowMs,
    });
  }
  const newQty = pos.qty + qty;
  const newAvg = (pos.avgCostPaise * BigInt(pos.qty) + fillPricePaise * BigInt(qty)) / BigInt(newQty);
  await ctx.db.patch(pos._id, {
    qty: newQty,
    avgCostPaise: newAvg,
    marginPaise: (pos.marginPaise ?? 0n) + BigInt(qty) * fillPricePaise,
    openedOrderId: pos.openedOrderId ?? orderId,
    updatedMs: nowMs,
  });
  return pos._id;
}

/**
 * OCO-aware backstop: after a SELL fill, restore the invariant that resting
 * sell commitments never exceed the remaining holding on (symbol, day).
 *
 * Cancels newest-first — lone sells AND OCO legs — recomputing committed
 * quantity after each cancellation (removing one leg of a group changes the
 * group's commit by min-leg semantics, not by that leg's qty). Every
 * reachable over-commit shares one cause: the backing holding disappeared
 * under resting exits (e.g. a manual market exit while a bracket rested), so
 * the resting exits are the casualty, never the ledger. Cancelling all open
 * sells always reaches committed 0 ≤ held, so this terminates in a
 * consistent state without failing the surrounding transaction.
 */
async function enforceSellAggregate(
  ctx: import("./_generated/server").MutationCtx,
  userId: Id<"users">,
  symbol: string,
  dayStartSec: number,
): Promise<void> {
  const pos = await getPosition(ctx, userId, symbol, dayStartSec);
  const held = pos?.qty ?? 0;
  const rows = await ctx.db
    .query("orders")
    .withIndex("by_user_symbol_day", (q) =>
      q.eq("userId", userId).eq("symbol", symbol).eq("dayStartSec", dayStartSec),
    )
    .collect();
  rows.sort((a, b) => b.createdMs - a.createdMs);
  for (;;) {
    // Only long-exit sells are backed by the holding. Short-entry sells are
    // margin-backed (their capacity lives in the margin check) and are never
    // touched by this backstop.
    const openSells = rows.filter(
      (s) =>
        s.status === "OPEN" &&
        s.side === "SELL" &&
        s.intent !== "OPEN_SHORT" &&
        s.intent !== "ADD_SHORT",
    );
    if (
      committedQty(
        openSells.map((s) => ({
          ocoId: s.ocoId ?? null,
          qty: s.qty,
          symbol,
          dayStartSec,
        })),
      ) <= held
    ) {
      break;
    }
    const victim = openSells[0];
    if (!victim) break; // unreachable: an empty book always fits
    await ctx.db.patch(victim._id, {
      status: "CANCELLED",
      version: victim.version + 1,
    });
    // Keep the local copy in sync so the loop re-counts correctly.
    victim.status = "CANCELLED";
  }
}

/** Mark a resting BUY order's cash reservation released and return cash. */
async function releaseReservation(
  ctx: import("./_generated/server").MutationCtx,
  wallet: Doc<"wallets">,
  order: Doc<"orders">,
  nowMs: number,
): Promise<void> {
  const reserved = order.reservedCashPaise;
  if (reserved > 0n) {
    await moveCash(
      ctx,
      wallet,
      reserved,
      "reserve_release",
      nowMs,
      order.dayStartSec,
      { orderId: order._id },
    );
  }
}

/* ------------------------------ fills ------------------------------------- */

/**
 * Apply a BUY fill. Two meanings by state:
 *  - no position / LONG row: open or add to a long (cash out, position up).
 *  - SHORT row: cover the short — release margin, pay for the buy-back,
 *    store realized P&L (avg − fill) × qty on the order, reduce the short.
 * A cover whose quantity exceeds the short is a stale order (state moved
 * after validation); it is retired, never thrown on.
 */
async function applyBuyFill(
  ctx: import("./_generated/server").MutationCtx,
  wallet: Doc<"wallets">,
  order: Doc<"orders">,
  fillSec: number,
  fillPricePaise: bigint,
  nowMs: number,
): Promise<void> {
  const existing = await getPosition(ctx, order.userId, order.symbol, order.dayStartSec);
  const isCover = existing !== null && posSide(existing) === "SHORT";

  if (isCover) {
    const pos = existing;
    if (pos.qty < order.qty) {
      // Stale cover (short already closed elsewhere). Retire; release any
      // resting reserve so the cash is not stranded.
      if (order.reservedCashPaise > 0n) {
        await moveCash(ctx, wallet, order.reservedCashPaise, "reserve_release", nowMs, order.dayStartSec, { orderId: order._id });
      }
      await ctx.db.patch(order._id, {
        status: "CANCELLED",
        reason: "MANUAL",
        version: order.version + 1,
      });
      return;
    }
    const q = BigInt(order.qty);
    const avgCost = pos.avgCostPaise;
    const payment = BigInt(order.qty) * fillPricePaise;
    // Cover accounting (margin sub-account). At entry, 2× notional was
    // blocked: S of collateral + S of sale proceeds parked. The cover:
    //   1. releases the position's block slice (2S × q/Q),
    //   2. pays the fill (P × q),
    //   3. credits the parked sale proceeds (S_avg × q) — the "sale"
    //      completes when the borrowed shares are returned.
    // Net cash Δ = 2S − P + S = realized P&L (S − P) + released collateral.
    // Round trip from flat: (−2S at entry) + (3S − P here) = S − P ✓.
    // Worst case (guaranteed stop at P = 2S): net Δ = +S ≥ 0 — the wallet
    // cannot overdraw; the block drains exactly to 0 at full cover.
    const blockSlice = (pos.marginPaise ?? 2n * avgCost * BigInt(pos.qty)) * q / BigInt(pos.qty);
    const realized = (avgCost - fillPricePaise) * q;
    // A reserve-less (market) cover must be payable out of current cash plus
    // the release arriving in this transaction; resting covers carry their
    // own reserve and release it below.
    if (order.reservedCashPaise === 0n && payment > wallet.availableCashPaise + blockSlice) {
      fail("Cover blocked: payment exceeds available cash (auto-cover stop protects you before 2× entry)");
    }
    if (order.reservedCashPaise > 0n) {
      await moveCash(ctx, wallet, order.reservedCashPaise, "reserve_release", nowMs, order.dayStartSec, { orderId: order._id });
    }
    // Single ledger row: net cash effect = block slice + realized; the
    // margin block falls by the slice, draining to 0 at full cover.
    await moveCash(
      ctx,
      wallet,
      blockSlice + realized,
      "cover_settle",
      nowMs,
      order.dayStartSec,
      { orderId: order._id, positionId: pos._id },
      -blockSlice,
    );
    await upsertBuyPosition(
      ctx,
      order.userId,
      order.symbol,
      order.dayStartSec,
      order.qty,
      fillPricePaise,
      order._id,
      nowMs,
      pos,
    );
    await ctx.db.patch(order._id, {
      status: "FILLED",
      fillEpochSec: fillSec,
      fillPricePaise,
      filledMs: nowMs,
      realizedPnlPaise: (avgCost - fillPricePaise) * q,
      avgCostAtFillPaise: avgCost,
      version: order.version + 1,
    });
    if (pos.qty - order.qty === 0) {
      // Short fully closed: the auto-cover stop has nothing left to protect.
      await cancelAutoCover(ctx, order.userId, order.symbol, order.dayStartSec, wallet, nowMs);
    }
    // Mirror of the sell side: a filled cover kills OCO siblings (e.g. the
    // buy-stop leg of a short exit bracket).
    if (order.ocoId) {
      await cancelOcoSiblings(ctx, order.userId, order.ocoId, order._id);
    }
    return;
  }

  // Long entry / add-to-long (unchanged economics; margin tracked on row).
  const notional = BigInt(order.qty) * fillPricePaise;
  const reserved = order.reservedCashPaise;
  if (reserved > 0n) {
    await moveCash(
      ctx,
      wallet,
      reserved,
      "reserve_release",
      nowMs,
      order.dayStartSec,
      { orderId: order._id },
    );
  }
  await moveCash(
    ctx,
    wallet,
    -notional,
    "buy_fill",
    nowMs,
    order.dayStartSec,
    { orderId: order._id },
  );
  const positionId = await upsertBuyPosition(
    ctx,
    order.userId,
    order.symbol,
    order.dayStartSec,
    order.qty,
    fillPricePaise,
    order._id,
    nowMs,
  );
  await ctx.db.patch(order._id, {
    status: "FILLED",
    fillEpochSec: fillSec,
    fillPricePaise,
    filledMs: nowMs,
    version: order.version + 1,
  });
  void positionId;
}

/**
 * OCO brackets: when one leg of a group fills, cancel every other OPEN leg
 * of the same group in the same transaction. Idempotent — safe to call when
 * the group has already been resolved (non-OPEN siblings are skipped).
 */
async function cancelOcoSiblings(
  ctx: import("./_generated/server").MutationCtx,
  userId: Id<"users">,
  ocoId: string,
  exceptOrderId: Id<"orders">,
): Promise<void> {
  const legs = await ctx.db
    .query("orders")
    .withIndex("by_oco", (q) => q.eq("userId", userId).eq("ocoId", ocoId))
    .collect();
  for (const leg of legs) {
    if (leg._id === exceptOrderId) continue;
    if (leg.status === "OPEN") {
      await ctx.db.patch(leg._id, {
        status: "CANCELLED",
        version: leg.version + 1,
      });
    }
  }
}

/**
 * Apply a SELL fill, side-aware:
 *  - LONG/FLAT row → exit long or OPEN SHORT (per intent). Long exits keep
 *    the old economics; short entries release the blocked margin (reserve)
 *    as `margin` and open/extend a SHORT position row whose margin equals
 *    the settled entry margin (2 × fill notional).
 *  - Unbacked quantity (stale pass) → the order is retired, never thrown.
 */
async function applySellFill(
  ctx: import("./_generated/server").MutationCtx,
  wallet: Doc<"wallets">,
  order: Doc<"orders">,
  fillSec: number,
  fillPricePaise: bigint,
  nowMs: number,
): Promise<void> {
  const pos = await getPosition(ctx, order.userId, order.symbol, order.dayStartSec);
  const isShortEntry = order.intent === "OPEN_SHORT" || order.intent === "ADD_SHORT";

  if (isShortEntry) {
    // Opening/extending a short: margin was reserved at placement (market
    // entries) or is released from the reserve at fill (resting entries).
    // Settled margin = 2 × fill notional. The reserve covers the worst case:
    // 2 × level × qty + 2 × qty × SLIP ≥ 2 × (level ± 50p) × qty.
    if (!pos || posSide(pos) !== "SHORT") {
      if (pos) fail("short entry over an existing long position (invariant violated)");
      // FLAT → open short. A resting entry's reserve (2× level × qty +
      // headroom) was debited at placement and releases here; a market
      // entry never had a reserve (reservedCashPaise = 0). Either way the
      // settled margin is blocked in the wallet's margin sub-account —
      // collateral + parked sale proceeds, released at cover.
      if (order.reservedCashPaise > 0n) {
        await moveCash(ctx, wallet, order.reservedCashPaise, "reserve_release", nowMs, order.dayStartSec, { orderId: order._id });
      }
      const margin = 2n * BigInt(order.qty) * fillPricePaise;
      if (margin > wallet.availableCashPaise) {
        // The overshoot headroom makes this unreachable; guard anyway.
        fail("margin shortfall at short fill (overshoot headroom exceeded)");
      }
      await ctx.db.insert("positions", {
        userId: order.userId,
        symbol: order.symbol,
        dayStartSec: order.dayStartSec,
        qty: order.qty,
        side: "SHORT",
        marginPaise: margin,
        avgCostPaise: fillPricePaise,
        openedOrderId: order._id,
        createdMs: nowMs,
        updatedMs: nowMs,
      });
      await moveCash(ctx, wallet, -margin, "margin_block", nowMs, order.dayStartSec, { orderId: order._id }, margin);
    } else {
      // Extend the short: weighted average entry, margin += 2 × fill notional.
      const q = BigInt(order.qty);
      const newQty = pos.qty + order.qty;
      const avg = (pos.avgCostPaise * BigInt(pos.qty) + fillPricePaise * q) / BigInt(newQty);
      const addMargin = 2n * q * fillPricePaise;
      await ctx.db.patch(pos._id, {
        qty: newQty,
        avgCostPaise: avg,
        marginPaise: (pos.marginPaise ?? 0n) + addMargin,
        updatedMs: nowMs,
      });
      if (order.reservedCashPaise > 0n) {
        await moveCash(ctx, wallet, order.reservedCashPaise, "reserve_release", nowMs, order.dayStartSec, { orderId: order._id });
      }
      await moveCash(ctx, wallet, -addMargin, "margin_block", nowMs, order.dayStartSec, { orderId: order._id }, addMargin);
    }
    await ctx.db.patch(order._id, {
      status: "FILLED",
      fillEpochSec: fillSec,
      fillPricePaise,
      filledMs: nowMs,
      version: order.version + 1,
    });
    if (order.ocoId) {
      await cancelOcoSiblings(ctx, order.userId, order.ocoId, order._id);
    }
    return;
  }

  // Long exit.
  if (!pos || posSide(pos) !== "LONG" || pos.qty < order.qty) {
    // A fill for an unbacked quantity can only happen when state moved after
    // this order was validated (e.g. a stale reconcile pass that predates a
    // sibling's fill). The holding is the invariant; the stale order is the
    // casualty: retire it instead of throwing and wedging reconciliation.
    await ctx.db.patch(order._id, {
      status: "CANCELLED",
      reason: "MANUAL",
      version: order.version + 1,
    });
    return;
  }
  const avgCost = pos.avgCostPaise;
  const proceeds = BigInt(order.qty) * fillPricePaise;
  const realized = (fillPricePaise - avgCost) * BigInt(order.qty);

  await moveCash(
    ctx,
    wallet,
    proceeds,
    "sell_fill",
    nowMs,
    order.dayStartSec,
    { orderId: order._id, positionId: pos._id },
  );
  const remaining = pos.qty - order.qty;
  if (remaining === 0) {
    await ctx.db.delete(pos._id);
  } else {
    await ctx.db.patch(pos._id, {
      qty: remaining,
      marginPaise: (pos.marginPaise ?? BigInt(pos.qty) * avgCost) - (pos.marginPaise ?? BigInt(pos.qty) * avgCost) * BigInt(order.qty) / BigInt(pos.qty),
      updatedMs: nowMs,
    });
  }
  await ctx.db.patch(order._id, {
    status: "FILLED",
    fillEpochSec: fillSec,
    fillPricePaise,
    filledMs: nowMs,
    realizedPnlPaise: realized,
    avgCostAtFillPaise: avgCost,
    version: order.version + 1,
  });
  // OCO brackets: the other leg dies with this fill, releasing its share of
  // the holding before the aggregate backstop re-checks capacity.
  if (order.ocoId) {
    await cancelOcoSiblings(ctx, order.userId, order.ocoId, order._id);
  }
  await enforceSellAggregate(ctx, order.userId, order.symbol, order.dayStartSec);
}

/**
 * Cancel the short's synthetic auto-cover stop (if any) and release its
 * reserve. Called when the short is fully closed before the stop triggers.
 */
async function cancelAutoCover(
  ctx: import("./_generated/server").MutationCtx,
  userId: Id<"users">,
  symbol: string,
  dayStartSec: number,
  wallet: Doc<"wallets">,
  nowMs: number,
): Promise<void> {
  const auto = (
    await ctx.db
      .query("orders")
      .withIndex("by_user_symbol_day", (q) =>
        q.eq("userId", userId).eq("symbol", symbol).eq("dayStartSec", dayStartSec),
      )
      .collect()
  ).find((o) => o.reason === "AUTO" && o.status === "OPEN");
  if (!auto) return;
  if (auto.reservedCashPaise > 0n) {
    await moveCash(ctx, wallet, auto.reservedCashPaise, "reserve_release", nowMs, dayStartSec, { orderId: auto._id });
  }
  await ctx.db.patch(auto._id, {
    status: "CANCELLED",
    reason: "AUTO",
    version: auto.version + 1,
  });
}

/**
 * Day-end force cover of a leftover SHORT at its day's last tick. Realized
 * P&L = (avg − last) × qty; the margin release funds the payment (last tick
 * is bounded well below 2× avg by the v2 wave envelope). Any resting cover
 * orders and the AUTO stop are cancelled with their reserves released.
 */
async function forceCoverPosition(
  ctx: import("./_generated/server").MutationCtx,
  wallet: Doc<"wallets">,
  pos: Doc<"positions">,
  nowMs: number,
): Promise<void> {
  const lastTick = lastTickSecOfDay(BigInt(pos.dayStartSec));
  const fp = pricePaise(pos.symbol, lastTick);
  const payment = BigInt(pos.qty) * fp;
  const realized = (pos.avgCostPaise - fp) * BigInt(pos.qty);
  // Same settlement split as manual covers: net cash Δ = block + realized;
  // the block drains to 0 (guarded: the last tick is bounded far below 2×
  // avg by the v2 wave envelope, so net Δ ≥ 0 always holds).
  const block = pos.marginPaise ?? 2n * pos.avgCostPaise * BigInt(pos.qty);
  if (block + realized < 0n) {
    fail("day-end cover exceeds blocked margin (invariant violated)");
  }
  await moveCash(
    ctx,
    wallet,
    block + realized,
    "cover_settle",
    nowMs,
    pos.dayStartSec,
    { positionId: pos._id },
    -block,
  );
  const orderId = await ctx.db.insert("orders", {
    userId: pos.userId,
    symbol: pos.symbol,
    side: "BUY",
    orderType: "MARKET",
    status: "FILLED",
    qty: pos.qty,
    refPricePaise: fp,
    reservedCashPaise: 0n,
    dayStartSec: pos.dayStartSec,
    createdMs: nowMs,
    fillEpochSec: Number(lastTick),
    fillPricePaise: fp,
    filledMs: nowMs,
    reason: "DAY_END",
    intent: "COVER_SHORT",
    realizedPnlPaise: realized,
    avgCostAtFillPaise: pos.avgCostPaise,
    version: 1,
  });
  void orderId;
  await cancelAutoCover(ctx, pos.userId, pos.symbol, pos.dayStartSec, wallet, nowMs);
  await ctx.db.delete(pos._id);
}

/** Day-end force sale of a leftover position at its day's last tick. */
async function forceSellPosition(
  ctx: import("./_generated/server").MutationCtx,
  wallet: Doc<"wallets">,
  pos: Doc<"positions">,
  nowMs: number,
): Promise<void> {
  const lastTick = lastTickSecOfDay(BigInt(pos.dayStartSec));
  const fp = pricePaise(pos.symbol, lastTick);
  const proceeds = BigInt(pos.qty) * fp;
  const realized = (fp - pos.avgCostPaise) * BigInt(pos.qty);
  const orderId = await ctx.db.insert("orders", {
    userId: pos.userId,
    symbol: pos.symbol,
    side: "SELL",
    orderType: "MARKET",
    status: "FILLED",
    qty: pos.qty,
    refPricePaise: fp,
    reservedCashPaise: 0n,
    dayStartSec: pos.dayStartSec,
    createdMs: nowMs,
    fillEpochSec: Number(lastTick),
    fillPricePaise: fp,
    filledMs: nowMs,
    reason: "DAY_END",
    realizedPnlPaise: realized,
    avgCostAtFillPaise: pos.avgCostPaise,
    version: 1,
  });
  await moveCash(
    ctx,
    wallet,
    proceeds,
    "sell_fill",
    nowMs,
    pos.dayStartSec,
    { orderId, positionId: pos._id },
  );
  await ctx.db.delete(pos._id);
}

/* --------------------------- reconcile (core) ----------------------------- */

/** Idempotent per-user settlement. Safe to call any time. */
export async function reconcileCore(
  ctx: import("./_generated/server").MutationCtx,
  userId: Id<"users">,
  nowMs: number,
): Promise<{ ordersChecked: number; positionsClosed: number }> {
  const wallet = await ensureWallet(ctx, userId, nowMs);
  const nowSec = Math.floor(nowMs / 1000);
  let ordersChecked = 0;
  let positionsClosed = 0;

  const openOrders = await ctx.db
    .query("orders")
    .withIndex("by_user_status", (q) =>
      q.eq("userId", userId).eq("status", "OPEN"),
    )
    .order("asc")
    .collect();

  // Process chronologically so a resting buy that fills before a sibling sell
  // was created is always reflected before that sell is evaluated.
  openOrders.sort((a, b) => a.createdMs - b.createdMs);

  for (const order of openOrders) {
    ordersChecked += 1;
    // An earlier fill in this pass may have cancelled this order (OCO
    // sibling or the aggregate backstop). The snapshot above is stale —
    // trust the database: a cancelled order must never fill.
    const fresh = await ctx.db.get(order._id);
    if (!fresh || fresh.status !== "OPEN") continue;
    const dayEndSec = order.dayStartSec + DAY_SECONDS;
    const fromSec = firstEligibleTick(order.createdMs);
    const windowEnd = Math.min(nowSec, dayEndSec - 1);
    if (windowEnd >= fromSec) {
      const tick = findFillTick(
        order.symbol,
        orderTrigger(order),
        BigInt(fromSec),
        BigInt(windowEnd),
      );
      if (tick !== null) {
        if (order.side === "BUY") {
          await applyBuyFill(ctx, wallet, order, tick.sec, tick.pricePaise, nowMs);
        } else {
          await applySellFill(ctx, wallet, order, tick.sec, tick.pricePaise, nowMs);
        }
        continue;
      }
    }
    // No trigger: expire orders whose trading day has fully ended. The
    // re-fetch above guarantees the row is still OPEN here.
    if (nowSec >= dayEndSec && order.status === "OPEN") {
      if (order.reservedCashPaise > 0n) {
        await releaseReservation(ctx, wallet, order, nowMs);
      }
      await ctx.db.patch(order._id, {
        status: "EXPIRED",
        reason: "DAY_END",
        version: order.version + 1,
      });
    }
  }

  // Auto-cover stops: every SHORT position always has exactly one synthetic
  // STOP buy at 2 × avg entry (reason AUTO). Kept in lockstep here — created
  // when missing, re-pinned when the avg moves (adds), cancelled when the
  // short is gone. It is the solvency guarantee: max loss = ½ margin.
  const allPositions = await ctx.db
    .query("positions")
    .withIndex("by_user_day", (q) => q.eq("userId", userId))
    .collect();
  for (const pos of allPositions) {
    if (pos.dayStartSec + DAY_SECONDS <= nowSec) continue; // settled below
    if (posSide(pos) !== "SHORT" || pos.qty === 0) continue;
    const stopLevel = 2n * pos.avgCostPaise;
    const existingAuto = (
      await ctx.db
        .query("orders")
        .withIndex("by_user_symbol_day", (q) =>
          q.eq("userId", userId).eq("symbol", pos.symbol).eq("dayStartSec", pos.dayStartSec),
        )
        .collect()
    ).find((o) => o.reason === "AUTO" && o.status === "OPEN");
    if (!existingAuto) {
      // No cash reserve: the entry's margin block IS the safety net (the
      // guaranteed stop fills at ≤ 2× avg, where block ≥ payment and the
      // net settlement can never debit cash below zero).
      await ctx.db.insert("orders", {
        userId,
        symbol: pos.symbol,
        side: "BUY",
        orderType: "STOP",
        status: "OPEN",
        qty: pos.qty,
        stopPaise: stopLevel,
        refPricePaise: stopLevel,
        reservedCashPaise: 0n,
        dayStartSec: pos.dayStartSec,
        createdMs: nowMs,
        reason: "AUTO",
        intent: "COVER_SHORT",
        version: 1,
      });
    } else if (existingAuto.stopPaise !== stopLevel || existingAuto.qty !== pos.qty) {
      await ctx.db.patch(existingAuto._id, {
        qty: pos.qty,
        stopPaise: stopLevel,
        refPricePaise: stopLevel,
        version: existingAuto.version + 1,
      });
    }
  }

  // Force-square positions whose day has ended (intraday, every day starts
  // flat): longs sell at the last tick, shorts cover at the last tick.
  for (const pos of allPositions) {
    if (pos.dayStartSec + DAY_SECONDS > nowSec) continue;
    if (posSide(pos) === "SHORT") {
      await forceCoverPosition(ctx, wallet, pos, nowMs);
    } else {
      await forceSellPosition(ctx, wallet, pos, nowMs);
    }
    positionsClosed += 1;
  }

  return { ordersChecked, positionsClosed };
}

/* ------------------------------ RPC handlers ------------------------------ */

/** 1. register_and_fund() — idempotent. Creates profile + wallet + ₹10L. */
export const registerAndFund = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) fail("Not signed in");
    const nowMs = Date.now();
    const wallet = await ensureWallet(ctx, userId, nowMs);
    return { availableCashPaise: wallet.availableCashPaise };
  },
});

/**
 * 2. reconcile_user() — the entire settlement engine. Re-evaluates every
 * OPEN order over its eligible ticks up to the server clock and force-sells
 * ended positions. Takes NO price/time arguments. Idempotent.
 */
export const reconcileUser = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) fail("Not signed in");
    return reconcileCore(ctx, userId, Date.now());
  },
});

function validateQty(qty: number): void {
  if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY) {
    fail("Quantity must be a positive integer");
  }
}

function validateLevel(label: string, value?: bigint): bigint {
  if (value === undefined || value === null || value <= 0n) {
    fail(`${label} price is required`);
  }
  if (!isMultipleOf(value, 5)) {
    fail(`${label} price must be a multiple of 5 paise (₹0.05 tick)`);
  }
  return value;
}

/**
 * Sell capacity, OCO-aware: a bracket group (shared ocoId) commits only its
 * minimum leg quantity because at most one leg can fill — the engine cancels
 * the survivors the moment one leg fills. Lone sells commit their full qty.
 * The `override` re-counts an existing order at a new qty (edit path, whose
 * bracket was dissolved before this check runs).
 */
async function validateSellCapacity(
  ctx: import("./_generated/server").MutationCtx,
  userId: Id<"users">,
  symbol: string,
  dayStartSec: number,
  extraQty: number,
  override?: { orderId: Id<"orders">; qty: number },
): Promise<void> {
  const pos = await getPosition(ctx, userId, symbol, dayStartSec);
  const held = pos?.qty ?? 0;
  const all = (await ctx.db
    .query("orders")
    .withIndex("by_user_symbol_day", (q) =>
      q.eq("userId", userId).eq("symbol", symbol).eq("dayStartSec", dayStartSec),
    )
    .collect()).filter((s) => s.status === "OPEN" && s.side === "SELL");
  const refs: OcoSellRef[] = all
    .filter((s) => !override || s._id !== override.orderId)
    .map((s) => ({ ocoId: s.ocoId ?? null, qty: s.qty, symbol, dayStartSec }));
  if (override && override.qty > 0) {
    refs.push({ ocoId: null, qty: override.qty, symbol, dayStartSec });
  }
  const committed = committedQty(refs);
  if (committed + (override ? 0 : extraQty) > held) {
    fail(
      `Sell blocked: committed ${committed} + ${extraQty} exceed held ${held} on ${symbol} for today`,
    );
  }
}

/**
 * Persist OCO membership: given the first inserted leg and the pending
 * second leg (now validated), stamp a server-minted ocoId on the first and
 * return it for the second's insert.
 */
async function linkOcoSibling(
  ctx: import("./_generated/server").MutationCtx,
  userId: Id<"users">,
  firstLeg: Doc<"orders">,
  createdMs: number,
): Promise<string> {
  const id = ocoGroupId(userId, firstLeg.symbol, firstLeg.dayStartSec, createdMs);
  await ctx.db.patch(firstLeg._id, {
    ocoId: id,
    version: firstLeg.version + 1,
  });
  return id;
}

/**
 * 3. place_order(side, order_type, qty, limit_paise?, stop_paise?)
 * Reconciles first, then: MARKET fills at spot; marketable resting orders
 * fill at spot; everything else rests OPEN with reservations.
 */
export const placeOrder = mutation({
  args: {
    symbol: v.string(),
    side: v.union(v.literal("BUY"), v.literal("SELL")),
    orderType: v.union(v.literal("MARKET"), v.literal("LIMIT"), v.literal("STOP")),
    qty: v.number(),
    limitPaise: v.optional(v.bigint()),
    stopPaise: v.optional(v.bigint()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) fail("Not signed in");
    if (!isSymbol(args.symbol)) fail("Unknown symbol");
    validateQty(args.qty);
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const dayStart = dayStartOfMs(nowMs);

    // reconcile first: overdue fills / day-end settle before placement checks
    await reconcileCore(ctx, userId, nowMs);

    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!wallet) fail("Account not funded");

    let limit: bigint | null = null;
    let stop: bigint | null = null;
    if (args.orderType === "LIMIT") {
      if (args.limitPaise === undefined) fail("LIMIT order requires a limit price");
      limit = validateLevel("Limit", args.limitPaise);
    } else if (args.orderType === "STOP") {
      if (args.stopPaise === undefined) fail("STOP order requires a stop price");
      stop = validateLevel("Stop", args.stopPaise);
    } else if (args.limitPaise !== undefined || args.stopPaise !== undefined) {
      fail("MARKET orders take no price");
    }

    const spot = spotAtEpochSec(args.symbol, BigInt(nowSec));
    const trigger: OrderTrigger = {
      side: args.side,
      orderType: args.orderType,
      limitPaise: limit,
      stopPaise: stop,
    };
    const marketable = isMarketable(trigger, spot);
    const refPrice =
      args.orderType === "LIMIT" ? (limit as bigint)
        : args.orderType === "STOP" ? (stop as bigint)
          : spot;
    const fillNow = args.orderType === "MARKET" || marketable;
    const fillPrice = spot; // marketable fills happen at the current spot

    /* ----------------- state machine: what does this order mean? -------------
     * FLAT  + SELL = short entry (margin 2 × notional)
     * FLAT  + BUY  = long entry (cash check)
     * LONG  + SELL = exit long  (holdings capacity, OCO-aware)
     * LONG  + BUY  = add to long (cash check)
     * SHORT + BUY  = cover short (qty ≤ short, cover capacity, OCO-aware)
     * SHORT + SELL = add to short (margin check)
     * No auto-flip: crossing zero is rejected in every branch.
     */
    const existingPos = await getPosition(ctx, userId, args.symbol, dayStart);
    const state: "FLAT" | "LONG" | "SHORT" =
      existingPos === null ? "FLAT" : posSide(existingPos);

    // OCO pairing: any second UNLINKED resting order on the same
    // (symbol, day, side) becomes this order's bracket sibling — exit
    // brackets (SL+target), cover brackets, and entry brackets all reuse it.
    // The first leg to fill cancels the other in the same transaction.
    let pendingSibling: Doc<"orders"> | null = null;
    if (!fillNow) {
      const candidates = (await ctx.db
        .query("orders")
        .withIndex("by_user_symbol_day", (q) =>
          q.eq("userId", userId).eq("symbol", args.symbol).eq("dayStartSec", dayStart),
        )
        .collect())
        .filter(
          (o) =>
            o.status === "OPEN" &&
            o.side === args.side &&
            o.reason !== "AUTO" &&
            o.createdMs < nowMs &&
            !o.ocoId,
        )
        .sort((a, b) => b.createdMs - a.createdMs);
      pendingSibling = candidates[0] ?? null;
    }

    /** Pairing-aware commitment of same-side resting orders + this one. */
    const committedWith = (rows: Doc<"orders">[], qty: number): number => {
      if (pendingSibling) {
        const rest = rows
          .filter((s) => s._id !== pendingSibling._id)
          .map((s) => ({ ocoId: s.ocoId ?? null, qty: s.qty, symbol: args.symbol, dayStartSec: dayStart }));
        return committedQty(rest) + Math.min(pendingSibling.qty, qty);
      }
      return (
        committedQty(
          rows.map((s) => ({ ocoId: s.ocoId ?? null, qty: s.qty, symbol: args.symbol, dayStartSec: dayStart })),
        ) + qty
      );
    };

    // Default reserve: the standard cash reserve for BUY orders and cover
    // fills at-or-better than the level. Overridden for short entries below.
    let reserved = fillNow ? 0n : BigInt(args.qty) * refPrice;

    if (args.side === "SELL" && state === "LONG") {
      // Exit long: resting sells must fit under the holding (pairing-aware;
      // a bracket group commits min(sibling, this), so SL+target share one
      // slot). Marketable exits fill at spot right away.
      if (fillNow) {
        await validateSellCapacity(ctx, userId, args.symbol, dayStart, args.qty);
      } else {
        const openSells = (await ctx.db
          .query("orders")
          .withIndex("by_user_symbol_day", (q) =>
            q.eq("userId", userId).eq("symbol", args.symbol).eq("dayStartSec", dayStart),
          )
          .collect()).filter((s) => s.status === "OPEN" && s.side === "SELL");
        const committed = committedWith(openSells, args.qty);
        const held = existingPos?.qty ?? 0;
        if (committed > held) {
          fail(
            `Sell blocked: committed ${committed} would exceed held ${held} on ${args.symbol} for today`,
          );
        }
      }
    } else if (args.side === "SELL") {
      // Short entry (FLAT) or add-to-short (SHORT). Margin = 2 × notional.
      // Resting entries additionally reserve a one-tick overshoot headroom
      // (2 × qty × 100p) so the first-tick fill (price can overshoot the
      // level by at most ~50p in one second) can never overdraw the wallet:
      // reserve released ≥ margin blocked at fill, always.
      const notional = BigInt(args.qty) * refPrice;
      const margin = 2n * notional;
      // Market entries block margin at fill in the same transaction — the
      // order row must carry NO reserve (a stamped-but-never-debited reserve
      // would release as phantom income at fill). Resting entries reserve
      // margin + overshoot headroom at placement, released at fill.
      reserved = fillNow ? 0n : margin + 2n * BigInt(args.qty) * SHORT_ENTRY_SLIP_PAISE;
      const cashNeeded = fillNow ? margin : reserved;
      if (cashNeeded > wallet.availableCashPaise) {
        fail(
          `Insufficient margin: shorting ${args.qty} ${args.symbol} blocks ₹${(cashNeeded / 100n).toString()} (2× notional${fillNow ? "" : " + overshoot headroom"})`,
        );
      }
    } else if (args.side === "BUY" && state === "SHORT" && existingPos) {
      // Cover: no flip past the short, capacity mirror of the sell side.
      if (args.qty > existingPos.qty) {
        fail(
          `Cover blocked: short is ${existingPos.qty} ${args.symbol} — buying more would flip the position (not allowed)`,
        );
      }
      const openBuys = (await ctx.db
        .query("orders")
        .withIndex("by_user_symbol_day", (q) =>
          q.eq("userId", userId).eq("symbol", args.symbol).eq("dayStartSec", dayStart),
        )
        .collect()).filter(
          (s) => s.status === "OPEN" && s.side === "BUY" && s.reason !== "AUTO",
        );
      const committed = committedWith(openBuys, args.qty);
      if (committed > existingPos.qty) {
        fail(
          `Cover blocked: committed covers ${committed} would exceed the ${existingPos.qty} short on ${args.symbol} for today`,
        );
      }
      if (fillNow) {
        // Market cover: payment at spot must fit current cash (the margin
        // release arrives in the same transaction and funds the rest).
        const payment = BigInt(args.qty) * fillPrice;
        const release =
          (existingPos.marginPaise ?? 0n) * BigInt(args.qty) / BigInt(existingPos.qty);
        if (payment > wallet.availableCashPaise + release) {
          fail("Insufficient cash for the cover payment");
        }
      } else if (reserved > wallet.availableCashPaise) {
        fail(
          `Insufficient cash: need ₹${(reserved / 100n).toString()} for the ${args.qty} qty cover reservation`,
        );
      }
    } else {
      // Long entry / add-to-long: unchanged cash checks.
      if (fillNow) {
        const notional = BigInt(args.qty) * fillPrice;
        if (notional > wallet.availableCashPaise) {
          fail("Insufficient available cash");
        }
      } else {
        if (reserved > wallet.availableCashPaise) {
          fail(
            `Insufficient cash: need ₹${(reserved / 100n).toString()} for the ${args.qty} qty reservation`,
          );
        }
      }
    }

    // What this order means given the position state — used by the aggregate
    // backstop and the UI to tell long-exit sells from short-entry sells.
    const intent =
      args.side === "BUY"
        ? state === "SHORT" ? "COVER_SHORT" : state === "LONG" ? "ADD_LONG" : "OPEN_LONG"
        : state === "SHORT" ? "ADD_SHORT" : state === "LONG" ? "EXIT_LONG" : "OPEN_SHORT";

    const orderId = await ctx.db.insert("orders", {
      userId,
      symbol: args.symbol,
      side: args.side,
      orderType: args.orderType,
      status: "OPEN",
      qty: args.qty,
      ...(limit !== null ? { limitPaise: limit } : {}),
      ...(stop !== null ? { stopPaise: stop } : {}),
      refPricePaise: refPrice,
      reservedCashPaise: reserved,
      dayStartSec: dayStart,
      createdMs: nowMs,
      reason: "MANUAL",
      intent,
      version: 1,
    });

    // Pair the bracket after all validation passed: stamp both legs with a
    // server-minted group id so they share one slot of the holding.
    if (pendingSibling) {
      const gid = await linkOcoSibling(ctx, userId, pendingSibling, nowMs);
      await ctx.db.patch(orderId, { ocoId: gid, version: 2 });
    }

    // Reservation (resting orders that block cash): BUY orders reserve their
    // level-based cash; resting short entries reserve 2× notional + headroom.
    if (!fillNow && reserved > 0n) {
      await moveCash(
        ctx,
        wallet,
        -reserved,
        "reserve",
        nowMs,
        dayStart,
        { orderId },
      );
    }

    if (!fillNow) {
      return {
        orderId,
        status: "OPEN",
        message: `Order placed: ${args.side} ${args.qty} ${args.symbol}`,
      };
    }

    // Fill immediately at spot.
    const inserted = await ctx.db.get(orderId);
    if (!inserted) fail("order insert failed");
    if (args.side === "BUY") {
      await applyBuyFill(ctx, wallet, inserted, nowSec, fillPrice, nowMs);
    } else {
      await applySellFill(ctx, wallet, inserted, nowSec, fillPrice, nowMs);
    }
    return {
      orderId,
      status: "FILLED",
      message: `Filled ${args.side} ${args.qty} ${args.symbol} @ ₹${(fillPrice / 100n).toString()}`,
      fillPricePaise: fillPrice,
    };
  },
});

/** 4. cancel_order(order_id) — reconcile first; a due fill FILLS instead. */
export const cancelOrder = mutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) fail("Not signed in");
    const nowMs = Date.now();
    await reconcileCore(ctx, userId, nowMs);

    const order = await ctx.db.get(args.orderId);
    if (!order || order.userId !== userId) fail("Order not found");
    if (order.reason === "AUTO") {
      fail("The auto-cover stop protects your short and cannot be cancelled — cover the short to remove it");
    }
    if (order.status !== "OPEN") {
      return {
        status: order.status as string,
        message: `Order already ${order.status.toLowerCase()}; nothing to cancel`,
      };
    }
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!wallet) fail("Account not funded");
    await releaseReservation(ctx, wallet, order, nowMs);
    await ctx.db.patch(order._id, {
      status: "CANCELLED",
      version: order.version + 1,
    });
    // Cancelling one OCO leg tears down the whole bracket: the surviving leg
    // alone is no longer the exit strategy the trader asked for.
    if (order.ocoId) {
      await cancelOcoSiblings(ctx, userId, order.ocoId, order._id);
      return {
        status: "CANCELLED",
        message: "Order cancelled — OCO bracket leg cancelled with it",
      };
    }
    return { status: "CANCELLED", message: "Order cancelled" };
  },
});

/** 5. edit_order(order_id, ...) — reconcile, then mutate only if still OPEN. */
export const editOrder = mutation({
  args: {
    orderId: v.id("orders"),
    qty: v.optional(v.number()),
    limitPaise: v.optional(v.bigint()),
    stopPaise: v.optional(v.bigint()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) fail("Not signed in");
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    await reconcileCore(ctx, userId, nowMs);

    const order = await ctx.db.get(args.orderId);
    if (!order || order.userId !== userId) fail("Order not found");
    if (order.reason === "AUTO") {
      fail("The auto-cover stop is managed by the engine and cannot be edited");
    }
    if (order.status !== "OPEN") {
      fail(`Cannot edit a ${order.status.toLowerCase()} order`);
    }
    const dayStart = order.dayStartSec;

    const qty = args.qty ?? order.qty;
    validateQty(qty);
    let limit = order.limitPaise ?? null;
    let stop = order.stopPaise ?? null;
    if (order.orderType === "LIMIT") {
      limit = args.limitPaise === undefined ? limit : validateLevel("Limit", args.limitPaise);
      if (limit === null) fail("LIMIT order requires a limit price");
    } else if (order.orderType === "STOP") {
      stop = args.stopPaise === undefined ? stop : validateLevel("Stop", args.stopPaise);
      if (stop === null) fail("STOP order requires a stop price");
    }

    const spot = spotAtEpochSec(order.symbol, BigInt(nowSec));
    const trigger: OrderTrigger = {
      side: order.side as "BUY" | "SELL",
      orderType: order.orderType as "MARKET" | "LIMIT" | "STOP",
      limitPaise: limit,
      stopPaise: stop,
    };

    // If the edited order is due at the current spot, it fills instead.
    if (isMarketable(trigger, spot)) {
      const wallet = await ctx.db
        .query("wallets")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first();
      if (!wallet) fail("Account not funded");
      if (order.side === "BUY") {
        // The old reservation is still sitting in the wallet and will be
        // released by applyBuyFill, so the fill only needs the DIFFERENCE
        // between the new notional and the amount already reserved. Using
        // the edited qty here is essential — checking the old qty lets a
        // quantity increase overdraw the wallet.
        const notional = BigInt(qty) * spot;
        const alreadyReserved = order.reservedCashPaise;
        if (notional - alreadyReserved > wallet.availableCashPaise) {
          fail("Insufficient available cash");
        }
        await ctx.db.patch(order._id, {
          qty,
          ...(limit !== null ? { limitPaise: limit } : {}),
          ...(stop !== null ? { stopPaise: stop } : {}),
          version: order.version + 1,
        });
        const updated = await ctx.db.get(order._id);
        if (!updated) fail("order not found");
        await applyBuyFill(ctx, wallet, updated, nowSec, spot, nowMs);
      } else {
        const wallet2 = await ctx.db
          .query("wallets")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .first();
        if (!wallet2) fail("Account not funded");
        const isShortEntry =
          order.intent === "OPEN_SHORT" || order.intent === "ADD_SHORT";
        if (isShortEntry) {
          // Editing a resting short entry that is now marketable: it opens/
          // extends the short at spot — margin, not holdings, is the gate.
          const margin = 2n * BigInt(qty) * spot;
          const alreadyReserved = order.reservedCashPaise;
          if (margin - alreadyReserved > wallet2.availableCashPaise) {
            fail("Insufficient margin for the updated short entry");
          }
        } else {
          const pos = await getPosition(ctx, userId, order.symbol, dayStart);
          if (!pos || pos.qty < qty) fail("Sell blocked: not enough held quantity");
        }
        await ctx.db.patch(order._id, {
          qty,
          version: order.version + 1,
        });
        const updated = await ctx.db.get(order._id);
        if (!updated) fail("order not found");
        await applySellFill(ctx, wallet2, updated, nowSec, spot, nowMs);
      }
      return { status: "FILLED", message: "Edited order was due — filled at spot" };
    }

    // Editing an OCO leg breaks the bracket — the sibling is cancelled and
    // this order becomes a lone sell, so capacity is re-checked WITHOUT the
    // OCO group discount (with the sibling removed via the override).
    if (order.ocoId) {
      await cancelOcoSiblings(ctx, userId, order.ocoId, order._id);
    }
    const editOpensShort =
      order.side === "SELL" &&
      (order.intent === "OPEN_SHORT" || order.intent === "ADD_SHORT");
    if (order.side === "SELL" && !editOpensShort) {
      await validateSellCapacity(ctx, userId, order.symbol, dayStart, qty, {
        orderId: order._id,
        qty,
      });
    }

    // Mutate with re-run reservation (BUY cash reserve re-balanced).
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!wallet) fail("Account not funded");

    const refPrice =
      order.orderType === "LIMIT" ? (limit as bigint)
        : order.orderType === "STOP" ? (stop as bigint)
          : spot;
    // Short entries keep their margin reserve semantics on edit (2× notional
    // + overshoot headroom); BUY reserves its level notional; long-exit
    // sells reserve nothing.
    const newReserved = order.side === "BUY"
      ? BigInt(qty) * refPrice
      : editOpensShort
        ? 2n * BigInt(qty) * refPrice + 2n * BigInt(qty) * SHORT_ENTRY_SLIP_PAISE
        : 0n;
    const oldReserved = order.reservedCashPaise;
    const delta = newReserved - oldReserved;
    if (delta > 0n && delta > wallet.availableCashPaise) {
      fail("Insufficient cash for the updated reservation");
    }
    if (delta !== 0n) {
      await moveCash(
        ctx,
        wallet,
        -delta,
        delta > 0n ? "reserve" : "reserve_release",
        nowMs,
        dayStart,
        { orderId: order._id },
      );
    }
    await ctx.db.patch(order._id, {
      qty,
      ...(limit !== null ? { limitPaise: limit } : {}),
      ...(stop !== null ? { stopPaise: stop } : {}),
      reservedCashPaise: newReserved,
      // The bracket was dissolved above — clear the stale group id so this
      // order counts (and can pair again) as a lone sell.
      ...(order.ocoId ? { ocoId: undefined } : {}),
      version: order.version + 1,
    });
    return {
      status: "OPEN",
      message: order.ocoId
        ? "Order updated — OCO bracket dissolved, sibling cancelled"
        : "Order updated",
    };
  },
});

/* ------------------------------- queries ---------------------------------- */

export const getAccount = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!wallet) return null;
    return {
      userId,
      availableCashPaise: wallet.availableCashPaise,
      marginBlockedPaise: wallet.marginBlockPaise ?? 0n,
      updatedMs: wallet.updatedMs,
      grantPaise: GRANT_PAISE,
    };
  },
});

export const getPositions = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const today = dayStartOfMs(Date.now());
    const rows = await ctx.db
      .query("positions")
      .withIndex("by_user_day", (q) => q.eq("userId", userId))
      .collect();
    return rows.filter((p) => p.qty > 0 && p.dayStartSec === today);
  },
});

export const getOrders = query({
  args: {
    status: v.optional(v.string()),
    orderType: v.optional(v.string()),
    reason: v.optional(v.string()),
    symbol: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const rows = await ctx.db
      .query("orders")
      .withIndex("by_user_created", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
    return rows.filter((o) => {
      if (args.status && o.status !== args.status) return false;
      if (args.orderType && o.orderType !== args.orderType) return false;
      if (args.reason && o.reason !== args.reason) return false;
      if (args.symbol && o.symbol !== args.symbol) return false;
      return true;
    });
  },
});

/** Filled sell orders (realized P&L read from stored values only). */
export const getRealizedTrades = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const rows = await ctx.db
      .query("orders")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", userId).eq("status", "FILLED"),
      )
      .collect();
    return rows
      .filter((o) => o.side === "SELL")
      .sort((a, b) => (b.fillEpochSec ?? 0) - (a.fillEpochSec ?? 0));
  },
});

/** Append-only cash feed with a server-computed running balance. */
export const getLedger = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const rows = await ctx.db
      .query("ledger")
      .withIndex("by_user_time", (q) => q.eq("userId", userId))
      .order("asc")
      .collect();
    // Running balance starts at 0: the ₹10L grant is itself the first ledger
    // row (deposit), so seeding the sum with GRANT_PAISE double-counted it.
    let running = 0n;
    const out: Array<
      Doc<"ledger"> & { runningBalancePaise: bigint }
    > = [];
    for (const row of rows) {
      running += row.amountPaise;
      out.push({ ...row, runningBalancePaise: running });
    }
    return out;
  },
});

/** Today's dashboard summary (realized P&L read from stored values). */
export const getDaySummary = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const nowMs = Date.now();
    const today = dayStartOfMs(nowMs);
    const todayOrders = await ctx.db
      .query("orders")
      .withIndex("by_user_day", (q) => q.eq("userId", userId).eq("dayStartSec", today))
      .collect();
    let realizedPaise = 0n;
    let sells = 0;
    let buys = 0;
    for (const o of todayOrders) {
      if (o.status === "FILLED") {
        // Realized P&L lives on long-exit SELL fills AND short-cover BUY
        // fills (both store it at fill time).
        realizedPaise += o.realizedPnlPaise ?? 0n;
        if (o.side === "SELL") sells += 1;
        else buys += 1;
      }
    }
    return {
      todayDayStartSec: today,
      realizedPaise,
      sells,
      buys,
      openOrders: todayOrders.filter((o) => o.status === "OPEN").length,
    };
  },
});

/* ------------------------------- analytics -------------------------------- */

/**
 * 6. get_analytics() — automated trade analytics over the ledger and stored
 * realized P&L. Money aggregates are integer paise; only statistical RATIOS
 * (Sharpe) use float math, and never on a money value itself. Equity curve:
 * the ledger running balance at each UTC day end — correct because the
 * intraday model force-sells everything by day end, so closing cash equals
 * closing equity. Today's entry is live: cash + open positions at LTP.
 */
export const getAnalytics = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const nowMs = Date.now();
    const today = dayStartOfMs(nowMs);

    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    const cash = wallet?.availableCashPaise ?? 0n;

    /* --------------------- daily equity from the ledger --------------------- */
    const ledger = await ctx.db
      .query("ledger")
      .withIndex("by_user_time", (q) => q.eq("userId", userId))
      .order("asc")
      .collect();

    const days: { dayStartSec: number; equityPaise: bigint }[] = [];
    let running = 0n; // start at 0: the grant is itself the first ledger row
    let prevDay: number | null = null;
    let dayEndBalance = 0n;
    for (const row of ledger) {
      running += row.amountPaise;
      if (prevDay !== null && row.dayStartSec !== prevDay) {
        days.push({ dayStartSec: prevDay, equityPaise: dayEndBalance });
      }
      prevDay = row.dayStartSec;
      dayEndBalance = running;
    }

    // Live MTM for open positions (display-only float-free: qty × LTP).
    const openPositions = await ctx.db
      .query("positions")
      .withIndex("by_user_day", (q) => q.eq("userId", userId))
      .collect();
    let holdingsValue = 0n;
    for (const p of openPositions) {
      if (p.dayStartSec !== today) continue;
      const ltp = pricePaise(p.symbol, BigInt(Math.floor(nowMs / 1000)));
      // LONG adds the asset value; SHORT adds margin minus the buy-back
      // liability (margin is blocked cash, so it counts toward equity).
      holdingsValue +=
        p.side === "SHORT"
          ? (p.marginPaise ?? 2n * p.avgCostPaise * BigInt(p.qty)) -
            BigInt(p.qty) * ltp
          : BigInt(p.qty) * ltp;
    }
    const currentEquity = cash + holdingsValue;

    // Today's live equity replaces/extends the ledger-derived tail.
    if (prevDay !== null && prevDay === today) {
      days[days.length - 1] = { dayStartSec: today, equityPaise: currentEquity };
    } else {
      days.push({ dayStartSec: today, equityPaise: currentEquity });
    }

    const start = GRANT_PAISE; // literal nonzero constant — no zero guard needed
    const totalReturnBp = ((currentEquity - start) * 10_000n) / start;

    // Max drawdown in basis points of the running peak — integer arithmetic.
    let peak = start;
    let maxDrawdownBp = 0n;
    for (const d of days) {
      if (d.equityPaise > peak) peak = d.equityPaise;
      if (peak > 0n) {
        const dd = ((peak - d.equityPaise) * 10_000n) / peak;
        if (dd > maxDrawdownBp) maxDrawdownBp = dd;
      }
    }

    // Daily returns for Sharpe (float allowed: statistic, not money).
    const rets: number[] = [];
    for (let i = 1; i < days.length; i++) {
      const prev = days[i - 1].equityPaise;
      if (prev > 0n) rets.push(Number(days[i].equityPaise - prev) / Number(prev));
    }
    let sharpe: number | null = null;
    if (rets.length >= 2) {
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const variance =
        rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
        (rets.length - 1);
      const sd = Math.sqrt(variance);
      if (sd > 1e-12) {
        sharpe = (mean / sd) * Math.sqrt(252); // annualized, daily returns
      }
    }

    // Day P&L extremes from the equity series.
    let bestDay = 0n;
    let worstDay = 0n;
    for (let i = 1; i < days.length; i++) {
      const delta = days[i].equityPaise - days[i - 1].equityPaise;
      if (delta > bestDay) bestDay = delta;
      if (delta < worstDay) worstDay = delta;
    }

    /* -------------- round trips from stored realized P&L (SELLs) ------------ */
    const filledSells = await ctx.db
      .query("orders")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", userId).eq("status", "FILLED"),
      )
      .collect();

    // One round trip per (symbol, day): partial exits aggregate into it.
    const trips = new Map<
      string,
      { symbol: string; dayStartSec: number; qty: number; pnlPaise: bigint }
    >();
    for (const o of filledSells) {
      if (o.side !== "SELL") continue;
      const key = `${o.symbol}:${o.dayStartSec}`;
      const cur = trips.get(key);
      if (cur) {
        cur.qty += o.qty;
        cur.pnlPaise += o.realizedPnlPaise ?? 0n;
      } else {
        trips.set(key, {
          symbol: o.symbol,
          dayStartSec: o.dayStartSec,
          qty: o.qty,
          pnlPaise: o.realizedPnlPaise ?? 0n,
        });
      }
    }
    const tradeList = [...trips.values()].sort(
      (a, b) => b.dayStartSec - a.dayStartSec,
    );

    let wins = 0;
    let losses = 0;
    let flats = 0;
    let grossProfit = 0n;
    let grossLoss = 0n;
    let largestWin = 0n;
    let largestLoss = 0n;
    for (const t of tradeList) {
      if (t.pnlPaise > 0n) {
        wins += 1;
        grossProfit += t.pnlPaise;
        if (t.pnlPaise > largestWin) largestWin = t.pnlPaise;
      } else if (t.pnlPaise < 0n) {
        losses += 1;
        grossLoss += -t.pnlPaise;
        if (-t.pnlPaise > largestLoss) largestLoss = -t.pnlPaise;
      } else {
        flats += 1;
      }
    }
    const closed = wins + losses + flats;
    const winRateBp = closed === 0 ? 0n : (BigInt(wins) * 10_000n) / BigInt(closed);
    const avgWin = wins === 0 ? 0n : grossProfit / BigInt(wins);
    const avgLoss = losses === 0 ? 0n : grossLoss / BigInt(losses);

    return {
      grantPaise: start,
      currentEquityPaise: currentEquity,
      totalReturnPctBp: totalReturnBp,
      maxDrawdownPctBp: maxDrawdownBp,
      sharpe,
      days,
      nDays: days.length,
      bestDayPaise: bestDay,
      worstDayPaise: worstDay,
      trades: tradeList,
      nTrades: closed,
      wins,
      losses,
      flats,
      winRatePctBp: winRateBp,
      grossProfitPaise: grossProfit,
      grossLossPaise: grossLoss,
      avgWinPaise: avgWin,
      avgLossPaise: avgLoss,
      largestWinPaise: largestWin,
      largestLossPaise: largestLoss,
    };
  },
});

/** Daily sweep backstop: settle every funded account once per day (crons.ts). */
export const reconcileAllUsers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const nowMs = Date.now();
    let scanned = 0;
    let settled = 0;
    // Demo-scale: a full scan of funded wallets per day is small (each wallet
    // is one row per account). If this ever grows, switch to cursor pagination
    // over the wallets table.
    const wallets = await ctx.db.query("wallets").collect();
    scanned = wallets.length;
    for (const w of wallets) {
      await reconcileCore(ctx, w.userId, nowMs);
      settled += 1;
    }
    return { scanned, settled };
  },
});
