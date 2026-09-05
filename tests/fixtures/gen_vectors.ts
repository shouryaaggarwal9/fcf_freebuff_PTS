/**
 * Golden-vector generator. Prints a JSON array of
 * { symbol, epoch, price } records for a fixed set of epochs covering
 * negative/zero offsets and UTC day boundaries.
 *
 * Regeneration policy: only run this when MARKET_VERSION or the frozen
 * constants legitimately change, and commit the output to
 * tests/fixtures/price_vectors.json. Output must stay byte-identical
 * across machines and runs.
 *
 *   bun run tests/fixtures/gen_vectors.ts > tests/fixtures/price_vectors.json
 */
import { SYMBOLS } from "../../src/config/market";
import { dayStartSec, pricePaise } from "../../src/engine/price";

const T0 = 1_787_500_000n; // fixed modern epoch (UTC)
const day0 = dayStartSec(T0);

// Every symbol at the modern epoch and around the day boundary; a subset at
// negative/zero offsets.
const epochsForAll: bigint[] = [
  T0,
  day0 - 1n, // last tradable second of the previous day
  day0, // exact 00:00:00 UTC boundary
  day0 + 1n,
];
const extraEpochs: bigint[] = [-1n, 0n, 1n, 2_000_000_000n];

const rows: Array<{ symbol: string; epoch: string; price: string }> = [];
for (const def of SYMBOLS) {
  for (const e of epochsForAll) {
    rows.push({
      symbol: def.symbol,
      epoch: e.toString(),
      price: pricePaise(def.symbol, e).toString(),
    });
  }
}
// negative/zero offsets: first four symbols, all extra epochs
for (const def of SYMBOLS.slice(0, 4)) {
  for (const e of extraEpochs) {
    if (!epochsForAll.includes(e)) {
      rows.push({
        symbol: def.symbol,
        epoch: e.toString(),
        price: pricePaise(def.symbol, e).toString(),
      });
    }
  }
}

process.stdout.write(JSON.stringify(rows, null, 0) + "\n");
