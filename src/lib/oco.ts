/**
 * OCO (One-Cancels-Other) bracket helpers — pure logic, no I/O.
 *
 * Design: an OCO group is a set of ≥2 OPEN SELL orders on the same
 * (user, symbol, day) that share an ocoId. A group consumes `minQty` of the
 * position once (because at most one leg fills before the engine cancels the
 * siblings), while lone sells consume their full quantity. This lets a
 * stop-loss and a target sell rest together on one holding.
 *
 * These helpers are shared by the Convex settlement engine and the client UI
 * so the capacity rule is computed identically in both places.
 */

export const OCO_MAX_LEGS = 2;

export function isOcoEnabled(legs: number): boolean {
  return legs >= 2;
}

export interface OcoSellRef {
  ocoId?: string | null;
  qty: number;
  /** Server-side grouping keys: a group never spans symbols or days. */
  symbol?: string;
  dayStartSec?: number;
}

/** Group-counted committed quantity: lone orders = qty, groups = min leg qty. */
export function committedQty(sells: OcoSellRef[]): number {
  const groups = new Map<string, number>();
  let total = 0;
  for (const s of sells) {
    if (s.ocoId) {
      const key = `${s.symbol ?? ""}|${s.dayStartSec ?? ""}|${s.ocoId}`;
      const cur = groups.get(key) ?? 0;
      groups.set(key, cur === 0 ? s.qty : Math.min(cur, s.qty));
    } else {
      total += s.qty;
    }
  }
  for (const m of groups.values()) total += m;
  return total;
}

/** Deterministic OCO group id minted by the server (never the client). */
export function ocoGroupId(
  userId: string,
  symbol: string,
  dayStartSec: number,
  createdMs: number,
): string {
  return `oco:${userId}:${symbol}:${dayStartSec}:${createdMs}`;
}

/** Validate that two levels form a sane long-exit bracket around the spot. */
export function validateOcoLevels(
  spotPaise: bigint,
  stopPaise: bigint,
  limitPaise: bigint,
): string | null {
  if (stopPaise >= spotPaise) {
    return "Stop loss must be below the current market price";
  }
  if (limitPaise <= stopPaise) {
    return "Target limit must be above the stop loss level";
  }
  return null;
}
