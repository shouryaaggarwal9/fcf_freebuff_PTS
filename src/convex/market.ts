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
): Promise<void> {
  await ctx.db.insert("ledger", {
    userId: wallet.userId,
    entryType,
    amountPaise: deltaPaise,
    dayStartSec,
    timeMs,
    ...(extra.orderId ? { orderId: extra.orderId } : {}),
    ...(extra.positionId ? { positionId: extra.positionId } : {}),
  });
  await ctx.db.patch(wallet._id, {
    availableCashPaise: wallet.availableCashPaise + deltaPaise,
    version: wallet.version + 1,
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

async function upsertBuyPosition(
  ctx: import("./_generated/server").MutationCtx,
  userId: Id<"users">,
  symbol: string,
  dayStartSec: number,
  qty: number,
  fillPricePaise: bigint,
  orderId: Id<"orders">,
  nowMs: number,
): Promise<Id<"positions">> {
  const pos = await getPosition(ctx, userId, symbol, dayStartSec);
  if (!pos) {
    return ctx.db.insert("positions", {
      userId,
      symbol,
      dayStartSec,
      qty,
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
    openedOrderId: pos.openedOrderId ?? orderId,
    updatedMs: nowMs,
  });
  return pos._id;
}

/**
 * OCO-lite: after a SELL fill, cancel sibling OPEN sell orders on the same
 * (symbol, day) whose quantity would exceed remaining holdings. Newest-first
 * cancellation gives natural SL+target bracket behaviour: when one leg fills,
 * the other is cancelled in the same transaction.
 */
async function enforceSellAggregate(
  ctx: import("./_generated/server").MutationCtx,
  userId: Id<"users">,
  symbol: string,
  dayStartSec: number,
): Promise<void> {
  const pos = await getPosition(ctx, userId, symbol, dayStartSec);
  const held = pos?.qty ?? 0;
  const siblings = await ctx.db
    .query("orders")
    .withIndex("by_user_symbol_day", (q) =>
      q.eq("userId", userId).eq("symbol", symbol).eq("dayStartSec", dayStartSec),
    )
    .collect();
  siblings.sort((a, b) => b.createdMs - a.createdMs);
  let openQty = 0;
  for (const s of siblings) openQty += s.qty;
  let excess = openQty - held;
  // cancel most recently created first while aggregate still exceeds holdings
  for (const s of siblings) {
    if (excess <= 0) break;
    if (s.status === "OPEN" && s.side === "SELL") {
      await ctx.db.patch(s._id, {
        status: "CANCELLED",
        version: s.version + 1,
      });
      excess -= s.qty;
    }
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

/** Apply a BUY fill: position upsert, wallet cash, ledger, order record. */
async function applyBuyFill(
  ctx: import("./_generated/server").MutationCtx,
  wallet: Doc<"wallets">,
  order: Doc<"orders">,
  fillSec: number,
  fillPricePaise: bigint,
  nowMs: number,
): Promise<void> {
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
 * Apply a SELL fill: realized P&L stored on the order at fill time, cash +
 * proceeds, position reduction (delete at zero), then OCO-lite sibling
 * cancellation.
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
  if (!pos || pos.qty < order.qty) {
    fail("sell exceeds held quantity (invariant violated)");
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
    await ctx.db.patch(pos._id, { qty: remaining, updatedMs: nowMs });
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
  await enforceSellAggregate(ctx, order.userId, order.symbol, order.dayStartSec);
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
    // No trigger: expire orders whose trading day has fully ended.
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

  // Force-sell positions whose day has ended (intraday, every day starts flat).
  const dayEndedPositions = await ctx.db
    .query("positions")
    .withIndex("by_user_day", (q) => q.eq("userId", userId))
    .collect();
  for (const pos of dayEndedPositions) {
    if (pos.dayStartSec + DAY_SECONDS <= nowSec) {
      await forceSellPosition(ctx, wallet, pos, nowMs);
      positionsClosed += 1;
    }
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

async function validateSellCapacity(
  ctx: import("./_generated/server").MutationCtx,
  userId: Id<"users">,
  symbol: string,
  dayStartSec: number,
  extraQty: number,
): Promise<void> {
  const pos = await getPosition(ctx, userId, symbol, dayStartSec);
  const held = pos?.qty ?? 0;
  const openSells = (await ctx.db
    .query("orders")
    .withIndex("by_user_symbol_day", (q) =>
      q.eq("userId", userId).eq("symbol", symbol).eq("dayStartSec", dayStartSec),
    )
    .collect()).filter((s) => s.status === "OPEN" && s.side === "SELL");
  let openSellQty = 0;
  for (const s of openSells) openSellQty += s.qty;
  if (openSellQty + extraQty > held) {
    fail(
      `Sell blocked: open sells ${openSellQty} + ${extraQty} exceed held ${held} on ${symbol} for today`,
    );
  }
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
    const reserved = fillNow ? 0n : BigInt(args.qty) * refPrice;

    if (args.side === "BUY") {
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
    } else if (!fillNow) {
      // Marketable sells (spot already at/through the level) fill at spot
      // right away; only resting sells need the held-quantity check.
      await validateSellCapacity(ctx, userId, args.symbol, dayStart, args.qty);
    }

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
      version: 1,
    });

    // Reservation (resting BUY only): cash reserved, ledger pair entry.
    if (!fillNow && args.side === "BUY") {
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
        const pos = await getPosition(ctx, userId, order.symbol, dayStart);
        if (!pos || pos.qty < qty) fail("Sell blocked: not enough held quantity");
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

    if (order.side === "SELL") {
      await validateSellCapacity(ctx, userId, order.symbol, dayStart, qty);
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
    const newReserved = order.side === "BUY" ? BigInt(qty) * refPrice : 0n;
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
      version: order.version + 1,
    });
    return { status: "OPEN", message: "Order updated" };
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
    let running = GRANT_PAISE;
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
      if (o.status === "FILLED" && o.side === "SELL") {
        realizedPaise += o.realizedPnlPaise ?? 0n;
        sells += 1;
      } else if (o.status === "FILLED" && o.side === "BUY") {
        buys += 1;
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
