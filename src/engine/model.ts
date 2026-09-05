/**
 * Shared trading-model types. Framework-agnostic: imported by the browser
 * engine, the Convex backend and the test suite. All money fields are integer
 * paise (bigint). Times are UTC epoch seconds (bigint-safe integers) or ms
 * numbers where noted.
 */

export const SIDES = ["BUY", "SELL"] as const;
export type Side = (typeof SIDES)[number];

export const ORDER_TYPES = ["MARKET", "LIMIT", "STOP"] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const STATUSES = ["OPEN", "FILLED", "CANCELLED", "EXPIRED"] as const;
export type Status = (typeof STATUSES)[number];

export const REASONS = ["MANUAL", "DAY_END"] as const;
export type Reason = (typeof REASONS)[number];

/** Ledger entry types: cash flows (+/-). Reserve entries are balance-neutral
 *  pairs emitted inside the same transaction as the wallet update. */
export const ENTRY_TYPES = [
  "deposit",
  "buy_fill",
  "sell_fill",
  "reserve",
  "reserve_release",
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

/** A pending order viewed purely as a trigger (server truth + local matcher). */
export interface OrderTrigger {
  side: Side;
  orderType: OrderType;
  limitPaise?: bigint | null;
  stopPaise?: bigint | null;
}

export interface Candle {
  /** UTC epoch second at which the bar opens. */
  time: number;
  openPaise: bigint;
  highPaise: bigint;
  lowPaise: bigint;
  closePaise: bigint;
}

export interface FillTick {
  /** UTC epoch second of the fill. */
  sec: number;
  /** Fill price in paise (multiple of TICK_PAISE). */
  pricePaise: bigint;
}
