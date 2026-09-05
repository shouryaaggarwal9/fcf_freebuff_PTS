/**
 * Golden price-vector generator for the deterministic market engine.
 *
 * Pins price(symbol, epochSec) → integer paise so any change to the engine
 * or src/config/market.ts is caught by tests/verify_price.ts instead of
 * silently rewriting history. When MARKET_VERSION is bumped (new market),
 * regenerate the fixture:
 *
 *   bun tests/generate_vectors.ts  (prints JSON to stdout)
 *
 * …then commit the output as tests/fixtures/price_vectors.json.
 */
import { MARKET_VERSION, SYMBOLS } from "../src/config/market";
import { pricePaise } from "../src/engine/price";

/** A UTC start-of-day: 1_728_000_000 = 20_000 × 86_400 exactly. */
const DAY0 = 1_728_000_000n;

/**
 * Probe seconds chosen to stress every engine path: epoch 0, segment
 * interiors (1, 59, 60), an hour, the 00:00 UTC boundary (DAY0-1 → DAY0),
 * mid-day, the last second of the day, and a few arbitrary real-world
 * epochs.
 */
const SECS: bigint[] = [
  0n,
  1n,
  59n,
  60n,
  3_600n,
  DAY0 - 1n,
  DAY0,
  DAY0 + 59n,
  DAY0 + 60n,
  DAY0 + 43_200n,
  DAY0 + 86_399n,
  1_700_000_000n,
  1_700_000_059n,
  1_900_000_000n,
];

const vectors = SYMBOLS.flatMap((def) =>
  SECS.map((sec) => ({
    symbol: def.symbol,
    sec: Number(sec),
    pricePaise: Number(pricePaise(def.symbol, sec)),
  })),
);

console.log(
  JSON.stringify(
    {
      marketVersion: MARKET_VERSION,
      generatedAtUtc: new Date().toISOString(),
      note: "Pinned output of src/engine/price.ts. Regenerate with bun tests/generate_vectors.ts when MARKET_VERSION is bumped.",
      vectors,
    },
    null,
    2,
  ),
);