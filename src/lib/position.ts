/**
 * Position state machine — pure logic for long/short intraday positions.
 *
 * The Convex settlement engine maps these results onto the database inside
 * one transaction; this module holds the arithmetic and the policy so it can
 * be unit-tested without I/O.
 *
 * Policy (locked for wave 5):
 *  - No auto-flip: a trade that would cross zero quantity is rejected.
 *  - Full-notional margins: a LONG entry blocks qty × price (the purchase
 *    itself); a SHORT entry blocks 2 × (qty × price) — entry notional plus a
 *    max-loss buffer. The auto-cover stop sits at exactly 2 × avg entry, so
 *    the margin release always fully funds the cover payment and the wallet
 *    can never go negative: max loss = ½ margin, release = margin ≥ payment.
 *  - Realized P&L: LONG exits (fill − avg) × qty; SHORT covers
 *    (avg − fill) × qty. Stored on the closing order at fill time.
 *  - Margin is released proportionally on partial closes:
 *    floor(margin × closed / posQty).
 */

export type PositionSide = "LONG" | "SHORT";

export interface PositionState {
  side: PositionSide;
  qty: number;
  avgCostPaise: bigint;
  /** Blocked margin in paise. LONG: total notional. SHORT: 2 × notional. */
  marginPaise: bigint;
}

export interface TradeIntent {
  side: "BUY" | "SELL";
  qty: number;
  pricePaise: bigint;
}

export type ApplyResult =
  | { kind: "OPEN"; state: PositionState }
  | { kind: "ADD"; state: PositionState }
  | {
      kind: "PARTIAL_CLOSE";
      state: PositionState; // the remaining position
      marginReleasePaise: bigint;
      realizedPnlPaise: bigint; // signed; negative = loss
    }
  | { kind: "CLOSE"; marginReleasePaise: bigint; realizedPnlPaise: bigint }
  | { kind: "BLOCK_FLIP"; heldQty: number; tradeSide: "BUY" | "SELL" };

/** Margin blocked by an entry of qty at pricePaise for the given side. */
export function entryMargin(
  side: PositionSide,
  qty: number,
  pricePaise: bigint,
): bigint {
  const n = BigInt(qty) * pricePaise;
  return side === "SHORT" ? 2n * n : n;
}

export function applyTrade(
  state: PositionState | null,
  trade: TradeIntent,
): ApplyResult {
  const q = BigInt(trade.qty);
  const p = trade.pricePaise;

  if (state === null || state.qty === 0) {
    const side: PositionSide = trade.side === "BUY" ? "LONG" : "SHORT";
    return {
      kind: "OPEN",
      state: {
        side,
        qty: trade.qty,
        avgCostPaise: p,
        marginPaise: entryMargin(side, trade.qty, p),
      },
    };
  }

  const entering: "BUY" | "SELL" = state.side === "LONG" ? "BUY" : "SELL";

  if (trade.side === entering) {
    // Add to the position in the same direction.
    const newQty = state.qty + trade.qty;
    const avg =
      (state.avgCostPaise * BigInt(state.qty) + p * q) / BigInt(newQty);
    const margin =
      state.marginPaise + entryMargin(state.side, trade.qty, p);
    return {
      kind: "ADD",
      state: { side: state.side, qty: newQty, avgCostPaise: avg, marginPaise: margin },
    };
  }

  // Closing trade: would it cross zero (flip)? Block it.
  if (trade.qty > state.qty) {
    return { kind: "BLOCK_FLIP", heldQty: state.qty, tradeSide: trade.side };
  }

  const posQ = BigInt(state.qty);
  const realized =
    state.side === "LONG" ? (p - state.avgCostPaise) * q : (state.avgCostPaise - p) * q;
  const release = (state.marginPaise * q) / posQ; // proportional, floor

  if (trade.qty === state.qty) {
    return { kind: "CLOSE", marginReleasePaise: release, realizedPnlPaise: realized };
  }
  const remaining = state.qty - trade.qty;
  return {
    kind: "PARTIAL_CLOSE",
    state: {
      side: state.side,
      qty: remaining,
      avgCostPaise: state.avgCostPaise,
      marginPaise: state.marginPaise - release,
    },
    marginReleasePaise: release,
    realizedPnlPaise: realized,
  };
}

/**
 * Cover settlement splits for a short cover fill: the proportional
 * margin-block release and the cash payment. Used by every cover path
 * (manual covers, brackets, the auto-cover stop, day-end force-cover) so
 * the wallet identity holds everywhere: cash delta = release − payment.
 */
export function coverSettlement(
  marginBlockPaise: bigint,
  qty: number,
  posQty: number,
  fillPricePaise: bigint,
): { blockReleasePaise: bigint; paymentPaise: bigint } {
  const q = BigInt(qty);
  return {
    blockReleasePaise: (marginBlockPaise * q) / BigInt(posQty),
    paymentPaise: q * fillPricePaise,
  };
}

/** Mark-to-market in paise (signed; negative = losing). */
export function positionMtm(
  state: { side?: PositionSide | string | null; qty: number; avgCostPaise: bigint },
  ltpPaise: bigint,
): bigint {
  return state.side === "SHORT"
    ? (state.avgCostPaise - ltpPaise) * BigInt(state.qty)
    : (ltpPaise - state.avgCostPaise) * BigInt(state.qty);
}

/** Human placement-time meaning, mirroring the server's intent field. */
export function orderIntent(
  state: { side: PositionSide | string | null; qty: number } | null,
  tradeSide: "BUY" | "SELL",
): string {
  if (state === null || state.qty === 0) {
    return tradeSide === "BUY" ? "OPEN_LONG" : "OPEN_SHORT";
  }
  if (state.side === "SHORT") {
    return tradeSide === "BUY" ? "COVER_SHORT" : "ADD_SHORT";
  }
  return tradeSide === "SELL" ? "EXIT_LONG" : "ADD_LONG";
}

/**
 * Auto-cover stop level: exactly 2 × avg entry. Loss at that level is
 * exactly half the blocked margin, and the release fully funds the payment.
 */
export function autoCoverStopPaise(avgCostPaise: bigint): bigint {
  return 2n * avgCostPaise;
}

/**
 * Ledger row math shared by every cash-movement call site. `amountPaise` is
 * the row's impact on TOTAL cash (available + blocked margin + order
 * reserves). Earmark events — margin blocks and order reserves — merely
 * move money between the trader's own pockets, so their amount is ₹0 and
 * the moved size rides in `detailPaise` for display. Only deposits, fills
 * and settlements change the running balance, which makes the invariant
 * provable: the sum of ledger amounts over a round trip = realized P&L.
 */
export function ledgerRowFor(
  entryType: string,
  deltaPaise: bigint,
  marginDeltaPaise: bigint = 0n,
): { amountPaise: bigint; detailPaise?: bigint } {
  const abs = (x: bigint): bigint => (x < 0n ? -x : x);
  const isEarmark =
    entryType === "reserve" || entryType === "reserve_release" || entryType === "margin_block";
  const detailPaise =
    entryType === "reserve" || entryType === "reserve_release"
      ? abs(deltaPaise)
      : entryType === "margin_block"
        ? marginDeltaPaise
        : entryType === "cover_settle"
          ? abs(marginDeltaPaise)
          : undefined;
  return {
    amountPaise: isEarmark ? 0n : deltaPaise + marginDeltaPaise,
    ...(detailPaise !== undefined ? { detailPaise } : {}),
  };
}
