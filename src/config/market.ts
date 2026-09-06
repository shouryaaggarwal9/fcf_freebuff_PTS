/**
 * FROZEN MARKET CONFIGURATION — src/config/market.ts
 *
 * The synthetic market's price is a pure function of (symbol, UTC integer
 * second). Every constant below feeds that function (directly or through the
 * engine in src/engine/price.ts).
 *
 * ⚠️  CHANGING ANY CONSTANT BELOW REWRITES PRICE HISTORY FOR EVERY SYMBOL.
 * Treat any change as a brand-new market:
 *   1. bump MARKET_VERSION,
 *   2. settle all open state (expire orders, force-sell positions),
 *   3. regenerate tests/fixtures/price_vectors.json.
 *
 * All money is integer paise (₹1 = 100 paise). No floats anywhere in money,
 * price, P&L or reserves. Quoted/fill prices are multiples of TICK_PAISE.
 */

/**
 * Bump only on a breaking generator/config change. Never silently.
 *
 * v1 → v2 (2026-09-06): refined generator — added 900/300/60/10-second waves
 * and tightened the anchor grid 60 s → 10 s to restore intrabar wicks on 1m/5m
 * charts and decorrelate consecutive candle colors. All open v1 state was
 * settled (positions force-sold, orders expired) before the cutover; every
 * second from the cutover onward is v2 history. Golden vectors regenerated.
 */
export const MARKET_VERSION = 2;

/** Minimum price increment: ₹0.05. All quoted and fill prices are multiples. */
export const TICK_PAISE = 5;

/** Virtual cash granted to every new user: ₹10,00,000 = 100,000,000 paise. */
export const GRANT_PAISE = 100_000_000n;

/** A trading day is one UTC calendar day. */
export const DAY_SECONDS = 86_400;

/** IST is UTC+5:30 with no DST — used for display only; storage is UTC. */
export const IST_OFFSET_SECONDS = 19_800;

/** Synthetic sessions. The market is continuous 24/7 UTC; a "session" spans
 *  the whole UTC day so every day is a complete intraday round trip. */
export const SESSIONS = [
  {
    name: "SYNTH-24x7",
    label: "Continuous synthetic session",
    opensUtcHour: 0,
    closesUtcHour: 24,
  },
] as const;

export interface SymbolDef {
  /** NSE ticker, upper case. */
  symbol: string;
  /** Display name. */
  label: string;
  /**
   * Frozen reference price in paise (the deterministic generator oscillates
   * around this level).
   */
  basePaise: number;
  /**
   * Frozen relative volatility factor in percent of baseline (100 = default).
   * Applied to every wave amplitude, per symbol.
   */
  volBp: number;
}

export const SYMBOLS: readonly SymbolDef[] = [
  { symbol: "RELIANCE", label: "Reliance Industries", basePaise: 290_000, volBp: 90 },
  { symbol: "TCS", label: "Tata Consultancy Svcs", basePaise: 410_000, volBp: 70 },
  { symbol: "HDFCBANK", label: "HDFC Bank", basePaise: 175_000, volBp: 110 },
  { symbol: "INFY", label: "Infosys", basePaise: 190_000, volBp: 120 },
  { symbol: "ICICIBANK", label: "ICICI Bank", basePaise: 128_000, volBp: 100 },
  { symbol: "SBIN", label: "State Bank of India", basePaise: 84_000, volBp: 130 },
  { symbol: "BHARTIARTL", label: "Bharti Airtel", basePaise: 158_000, volBp: 115 },
  { symbol: "ITC", label: "ITC", basePaise: 48_000, volBp: 140 },
  { symbol: "LT", label: "Larsen & Toubro", basePaise: 360_000, volBp: 85 },
  { symbol: "AXISBANK", label: "Axis Bank", basePaise: 118_000, volBp: 105 },
];

const map = new Map<string, SymbolDef>();
for (const def of SYMBOLS) {
  map.set(def.symbol, def);
}
export const SYMBOL_MAP: ReadonlyMap<string, SymbolDef> = map;

export function isSymbol(s: string): boolean {
  return SYMBOL_MAP.has(s);
}
