import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

/**
 * Paper-trading account model. Mirror of the spec's tables:
 *   profiles · wallets · ledger · orders · positions
 * All money is integer paise stored as bigint. Times are UTC epoch ms
 * (numbers) plus a dayStartSec (UTC start-of-day epoch seconds) for the
 * intraday session each record belongs to.
 */
const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    users: defineTable({
      name: v.optional(v.string()),
      image: v.optional(v.string()),
      email: v.optional(v.string()),
      emailVerificationTime: v.optional(v.number()),
      isAnonymous: v.optional(v.boolean()),
      role: v.optional(roleValidator),
    }).index("email", ["email"]),

    /** One row per auth user, created idempotently by register_and_fund. */
    profiles: defineTable({
      userId: v.id("users"),
      createdAtMs: v.number(),
    }).index("by_user", ["userId"]),

    /** Available cash in integer paise. version guards optimistic flows. */
    wallets: defineTable({
      userId: v.id("users"),
      availableCashPaise: v.bigint(),
      version: v.number(),
      createdAtMs: v.number(),
      updatedMs: v.number(),
    }).index("by_user", ["userId"]),

    /** Append-only cash-flow ledger. Rows are never updated or deleted. */
    ledger: defineTable({
      userId: v.id("users"),
      /** deposit | buy_fill | sell_fill | reserve | reserve_release */
      entryType: v.string(),
      amountPaise: v.bigint(),
      orderId: v.optional(v.id("orders")),
      positionId: v.optional(v.id("positions")),
      /** UTC start-of-day the entry belongs to (display grouping). */
      dayStartSec: v.number(),
      timeMs: v.number(),
    }).index("by_user_time", ["userId", "timeMs"]),

    /**
     * Orders. Status: OPEN | FILLED | CANCELLED | EXPIRED.
     * Reason: MANUAL | DAY_END. Open buy orders reserve cash; open sell
     * orders reserve held quantity. Realized P&L is stored at fill time.
     */
    orders: defineTable({
      userId: v.id("users"),
      symbol: v.string(),
      side: v.string(), // BUY | SELL
      orderType: v.string(), // MARKET | LIMIT | STOP
      status: v.string(), // OPEN | FILLED | CANCELLED | EXPIRED
      qty: v.number(),
      limitPaise: v.optional(v.bigint()),
      stopPaise: v.optional(v.bigint()),
      /** Reference price used for the reservation (limit/stop/spot at placement). */
      refPricePaise: v.bigint(),
      /** Reserved cash for BUY orders (0 for sells and immediate fills). */
      reservedCashPaise: v.bigint(),
      /** UTC start-of-day of the order's trading day. */
      dayStartSec: v.number(),
      createdMs: v.number(),
      fillEpochSec: v.optional(v.number()),
      fillPricePaise: v.optional(v.bigint()),
      filledMs: v.optional(v.number()),
      reason: v.string(), // MANUAL | DAY_END
      /** Stored realized P&L (paise) for SELL fills — never recomputed. */
      realizedPnlPaise: v.optional(v.bigint()),
      /** Average cost of the position sold against (entry price for /pnl). */
      avgCostAtFillPaise: v.optional(v.bigint()),
      version: v.number(),
    })
      .index("by_user_status", ["userId", "status"])
      .index("by_user_day", ["userId", "dayStartSec"])
      .index("by_user_symbol_day", ["userId", "symbol", "dayStartSec"])
      .index("by_user_created", ["userId", "createdMs"]),

    /** Intraday positions: one row per (user, symbol, day) while qty > 0. */
    positions: defineTable({
      userId: v.id("users"),
      symbol: v.string(),
      dayStartSec: v.number(),
      qty: v.number(),
      avgCostPaise: v.bigint(),
      openedOrderId: v.optional(v.id("orders")),
      createdMs: v.number(),
      updatedMs: v.number(),
    })
      .index("by_user_symbol_day", ["userId", "symbol", "dayStartSec"])
      .index("by_user_day", ["userId", "dayStartSec"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
